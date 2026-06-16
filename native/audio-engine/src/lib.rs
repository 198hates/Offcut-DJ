//! crate-audio-engine — N-API entry point.
//!
//! Exports two things to Node.js:
//!   `createDeck(deckId, outputDevice?)` → DeckHandle
//!   `listOutputDevices()`              → string[]
//!
//! The DeckHandle class wraps `Arc<DeckEngine>` and exposes all control methods
//! plus async `load()` and threadsafe-function callbacks for time/ended events.

#![deny(clippy::all)]

mod deck;
mod decoder;
mod eq;
mod filter;
mod output;
mod recorder;
mod ring;
mod signalsmith;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::sync::LazyLock;
use std::thread;

use arc_swap::ArcSwap;
use napi::{JsFunction, Result as NapiResult};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, ErrorStrategy};
use napi_derive::napi;
use parking_lot::Mutex;

use deck::{AudioEvent, DeckEngine, StemSet, STEM_COUNT};
use decoder::{decode_file, compute_peaks, compute_band_peaks};
use output::{build_master_stream, find_output_device, list_output_devices as list_devices, StreamHandle};
use recorder::Recorder;

/// Registry of live deck engines keyed by deck id ("A" / "B"), so a deck can be
/// slaved to another by id (the shared-clock sync). Touched only on
/// create/sync — never from the audio callback.
static DECK_REGISTRY: LazyLock<Mutex<HashMap<String, Arc<DeckEngine>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

// ── Master bus ────────────────────────────────────────────────────────────────

/// The single output stream all decks render into (Phase 3 architecture).
/// `active` is the lock-free deck list the audio callback iterates; the
/// recorder taps the summed mix.
struct MasterBus {
    active:   Arc<ArcSwap<Vec<Arc<DeckEngine>>>>,
    stream:   Mutex<Option<StreamHandle>>,
    recorder: Arc<Recorder>,
}

static MASTER: LazyLock<MasterBus> = LazyLock::new(|| MasterBus {
    active:   Arc::new(ArcSwap::new(Arc::new(Vec::new()))),
    stream:   Mutex::new(None),
    recorder: Recorder::new(),
});

/// (Re)build the master stream on `device_name` (empty = system default).
/// Replacing the slot drops the previous stream on this same thread.
fn rebuild_master_stream(device_name: &str) -> Result<(), String> {
    let device = find_output_device(device_name)?;
    let stream = build_master_stream(MASTER.active.clone(), MASTER.recorder.clone(), &device)?;
    *MASTER.stream.lock() = Some(StreamHandle(stream));
    Ok(())
}

/// Publish the registry to the audio callback in stable id order, so the
/// usual sync master ("A") renders before its slave within each block.
fn publish_active_decks() {
    let reg = DECK_REGISTRY.lock();
    let mut pairs: Vec<(String, Arc<DeckEngine>)> =
        reg.iter().map(|(k, e)| (k.clone(), e.clone())).collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    MASTER.active.store(Arc::new(pairs.into_iter().map(|(_, e)| e).collect()));
}

// ── Event sinks ───────────────────────────────────────────────────────────────

/// Callback slots filled by `on_time_update` / `on_ended`. A single dispatcher
/// thread (spawned in `create_deck`) drains the deck's event channel and fans
/// each event out to whichever slots are installed. The channel is MPMC
/// work-stealing — each event goes to exactly one consumer — so it must only
/// ever have ONE consuming thread, or Ended events get stolen and dropped by
/// the time-update consumer.
#[derive(Default)]
struct EventSinks {
    time:  Mutex<Option<ThreadsafeFunction<f64, ErrorStrategy::Fatal>>>,
    ended: Mutex<Option<ThreadsafeFunction<(), ErrorStrategy::Fatal>>>,
}

// ── LoadResult (returned from DeckHandle::load) ───────────────────────────────

#[napi(object)]
pub struct NativeLoadResult {
    pub duration_ms:   f64,
    pub peaks:         Vec<f64>,
    pub detail_peaks:  Vec<f64>,
    pub low_peaks:     Vec<f64>,
    pub mid_peaks:     Vec<f64>,
    pub high_peaks:    Vec<f64>,
    pub sample_rate:   u32,
}

// ── DeckHandle ────────────────────────────────────────────────────────────────

/// One playback deck.  Created via `createDeck()`.
#[napi]
pub struct DeckHandle {
    engine:   Arc<DeckEngine>,
    /// Kept for debugging/registry identity (the dispatch thread is named from
    /// it at creation; nothing reads it afterwards).
    #[allow(dead_code)]
    deck_id:  String,
    /// JS callback slots serviced by the deck's single event-dispatch thread.
    sinks:    Arc<EventSinks>,
}

#[napi]
impl DeckHandle {
    // ── Load (async) ─────────────────────────────────────────────────────────

    /// Decode an audio file at `file_path` and prepare it for playback.
    /// Returns waveform peak data at multiple resolutions alongside duration.
    /// Runs on the libuv thread pool — does not block the JS event loop.
    #[napi]
    pub async fn load(&self, file_path: String) -> NapiResult<NativeLoadResult> {
        let path = std::path::PathBuf::from(&file_path);
        let engine = self.engine.clone();

        // Decode on a blocking thread (symphonia is synchronous).
        let result = tokio::task::spawn_blocking(move || {
            let pcm = decode_file(&path)?;

            // Pre-compute all peak arrays
            let peaks        = compute_peaks(&pcm, 1000);
            let detail_peaks = compute_peaks(&pcm, 8000);
            let bands        = compute_band_peaks(&pcm, 8000);

            let duration_ms  = pcm.num_frames as f64 / pcm.sample_rate as f64 * 1000.0;
            let sample_rate  = pcm.sample_rate;

            // Swap in the new PCM buffer atomically.
            // The audio callback will pick it up on its next cycle.
            engine.is_playing.store(false, Ordering::Release);
            engine.looping.store(false, Ordering::Relaxed);
            // A new track replaces any loaded stems — the callback gives stems
            // precedence, so leaving them in place keeps playing the OLD track.
            engine.stems.store(Arc::new(None));
            // Tempo resets on load (matches the Web engine and the deck store,
            // which both reset the pitch slider to 1.0 for a fresh track).
            engine.set_rate(1.0);
            engine.pcm.store(Arc::new(Some(pcm)));
            // request_seek (not set_cursor): if the callback is mid-block, its
            // end-of-block commit would overwrite a bare cursor write.
            engine.request_seek(0.0);

            Ok::<NativeLoadResult, String>(NativeLoadResult {
                duration_ms,
                peaks:        peaks.into_iter().map(|v| v as f64).collect(),
                detail_peaks: detail_peaks.into_iter().map(|v| v as f64).collect(),
                low_peaks:    bands.low.into_iter().map(|v| v as f64).collect(),
                mid_peaks:    bands.mid.into_iter().map(|v| v as f64).collect(),
                high_peaks:   bands.high.into_iter().map(|v| v as f64).collect(),
                sample_rate,
            })
        })
        .await
        .map_err(|e| napi::Error::from_reason(format!("spawn_blocking panicked: {}", e)))?
        .map_err(napi::Error::from_reason)?;

        Ok(result)
    }

    // ── Playback ─────────────────────────────────────────────────────────────

    /// Seek to `ms` on the ACTIVE source's timeline (stems take precedence —
    /// using `pcm`'s rate here mispositions seeks whenever stems differ).
    /// When slaved to a master, re-anchor the sync phase to the new position;
    /// otherwise the next block's sync snap would instantly undo the seek
    /// (beat-jump / hot-cues were dead on a synced deck).
    fn seek_to_ms(&self, ms: f64) {
        if let Some((sr, frames)) = self.engine.active_geometry() {
            let secs = (ms / 1000.0).max(0.0);
            // `secs` is an AUDIBLE-coordinate target (the UI shows
            // latency-compensated positions); the cursor is an input-side read
            // head, so add the keylock latency back or the seek lands early —
            // under sync that error re-bakes into the phase on every jump.
            let cursor = ((secs + self.engine.report_latency()) * sr as f64).min(frames as f64);
            if self.engine.synced.load(Ordering::Acquire) {
                if let Some(master) = &*self.engine.sync_master.load() {
                    let ratio = f32::from_bits(self.engine.sync_ratio.load(Ordering::Relaxed)) as f64;
                    let phase = secs - master.position_secs() * ratio;
                    self.engine.sync_phase.store(f32::to_bits(phase as f32), Ordering::Relaxed);
                }
            }
            self.engine.request_seek(cursor);
        }
    }

    #[napi]
    pub fn play(&self, from_ms: Option<f64>) {
        if let Some(ms) = from_ms {
            self.seek_to_ms(ms);
        }
        self.engine.is_playing.store(true, Ordering::Release);
    }

    #[napi]
    pub fn pause(&self) {
        self.engine.is_playing.store(false, Ordering::Release);
    }

    #[napi]
    pub fn stop(&self) {
        self.engine.is_playing.store(false, Ordering::Release);
        // request_seek so a mid-block callback commit can't overwrite the rewind.
        self.engine.request_seek(0.0);
    }

    #[napi]
    pub fn seek(&self, ms: f64) {
        self.seek_to_ms(ms);
    }

    // ── Loop ─────────────────────────────────────────────────────────────────

    #[napi]
    pub fn set_loop(&self, start_ms: f64, end_ms: f64) {
        // Loop points live on the active source's timeline (stems-aware).
        if let Some((sr, _)) = self.engine.active_geometry() {
            let sr = sr as f64;
            let start_frames = ((start_ms / 1000.0) * sr) as u64;
            let end_frames   = ((end_ms   / 1000.0) * sr) as u64;
            self.engine.loop_start_frames.store(start_frames, Ordering::Relaxed);
            self.engine.loop_end_frames.store(end_frames, Ordering::Relaxed);
            self.engine.looping.store(true, Ordering::Release);
        }
    }

    #[napi]
    pub fn clear_loop(&self) {
        self.engine.looping.store(false, Ordering::Relaxed);
    }

    // ── Settings ─────────────────────────────────────────────────────────────

    #[napi]
    pub fn set_volume(&self, v: f64) {
        self.engine.set_volume(v as f32);
    }

    #[napi]
    pub fn set_rate(&self, r: f64) {
        self.engine.set_rate(r as f32);
    }

    #[napi]
    pub fn set_keylock(&self, enabled: bool) {
        // The audio callback engages the Signalsmith time-stretcher while this
        // is set and the tempo differs from 1×.
        self.engine.keylock.store(enabled, Ordering::Relaxed);
    }

    #[napi]
    pub fn set_eq_gain(&self, band: String, db: f64) {
        // Clamp to the renderer contract's range (−24 … +6 dB). The audio
        // callback reads these atomics and rebuilds its biquads on change.
        let db = (db as f32).clamp(-24.0, 6.0);
        let bits = f32::to_bits(db);
        match band.as_str() {
            "low"  => self.engine.eq_low_db100.store(bits, Ordering::Relaxed),
            "mid"  => self.engine.eq_mid_db100.store(bits, Ordering::Relaxed),
            "high" => self.engine.eq_high_db100.store(bits, Ordering::Relaxed),
            _      => {}
        }
    }

    // ── Filter / Delay (per-deck FX) ────────────────────────────────────────

    /// DJ filter knob: −1 = full low-pass sweep, 0 = off, +1 = full high-pass.
    #[napi]
    pub fn set_filter(&self, knob: f64) {
        let knob = (knob as f32).clamp(-1.0, 1.0);
        self.engine.filter_knob.store(f32::to_bits(knob), Ordering::Relaxed);
    }

    /// Beat-synced delay/echo send. `time_ms` is the delay time (JS computes it
    /// from BPM/rate); `feedback` recirculates the tail; `mix` is the wet amount.
    /// Disabling fades the wet to zero and the tail rings out, then clears.
    #[napi]
    pub fn set_delay(&self, time_ms: f64, feedback: f64, mix: f64, enabled: bool) {
        self.engine.delay_time_ms.store(
            f32::to_bits((time_ms as f32).clamp(1.0, 2000.0)), Ordering::Relaxed);
        self.engine.delay_feedback.store(
            f32::to_bits((feedback as f32).clamp(0.0, 0.95)), Ordering::Relaxed);
        self.engine.delay_mix.store(
            f32::to_bits((mix as f32).clamp(0.0, 1.0)), Ordering::Relaxed);
        self.engine.delay_enabled.store(enabled, Ordering::Relaxed);
    }

    // ── Stems ─────────────────────────────────────────────────────────────────

    #[napi]
    pub fn set_stem_gain(&self, kind: String, db: f64) {
        if let Some(idx) = DeckEngine::stem_index(&kind) {
            self.engine.stem_gain[idx].store(f32::to_bits(db as f32), Ordering::Relaxed);
        }
    }

    #[napi]
    pub fn set_stem_muted(&self, kind: String, muted: bool) {
        if let Some(idx) = DeckEngine::stem_index(&kind) {
            self.engine.stem_muted[idx].store(muted, Ordering::Relaxed);
        }
    }

    #[napi]
    pub fn set_stem_soloed(&self, kind: String, soloed: bool) {
        if let Some(idx) = DeckEngine::stem_index(&kind) {
            self.engine.stem_soloed[idx].store(soloed, Ordering::Relaxed);
        }
    }

    /// Decode four stem WAVs (drums / bass / vocals / other) and play them on
    /// independent buses in place of the single mix. Decoding runs on a blocking
    /// thread. The four files share format & length (Demucs output); length is
    /// clamped to the shortest. Playback continues from the current position.
    #[napi]
    pub async fn load_stems(
        &self,
        drums: String,
        bass: String,
        vocals: String,
        other: String,
    ) -> NapiResult<()> {
        let engine = self.engine.clone();
        tokio::task::spawn_blocking(move || {
            let paths = [drums, bass, vocals, other];
            let mut decoded = Vec::with_capacity(STEM_COUNT);
            for p in &paths {
                decoded.push(
                    decode_file(&std::path::PathBuf::from(p)).map_err(napi::Error::from_reason)?,
                );
            }

            // All stems share sample rate / channels; clamp length to the shortest
            // so every per-frame index stays in bounds.
            let sample_rate = decoded[0].sample_rate;
            let channels    = decoded.iter().map(|d| d.channels).min().unwrap_or(2).max(1);
            let num_frames  = decoded.iter().map(|d| d.num_frames).min().unwrap_or(0);

            let data: [Vec<f32>; STEM_COUNT] = [
                std::mem::take(&mut decoded[0].data),
                std::mem::take(&mut decoded[1].data),
                std::mem::take(&mut decoded[2].data),
                std::mem::take(&mut decoded[3].data),
            ];

            // Re-anchor the cursor onto the stem timeline (matters when the
            // stems' sample rate differs from the mix, e.g. 44.1k Demucs stems
            // for a 48k source). request_seek so the callback's end-of-block
            // commit can't discard the re-anchor.
            let pos = engine.position_secs();
            engine.stems.store(Arc::new(Some(StemSet {
                data,
                sample_rate,
                channels,
                num_frames,
            })));
            engine.request_seek(pos * sample_rate as f64);
            Ok(())
        })
        .await
        .map_err(|e| napi::Error::from_reason(format!("{e}")))?
    }

    /// Drop the stem buses and revert to single-mix playback.
    #[napi]
    pub fn unload_stems(&self) {
        let pos = self.engine.position_secs();
        self.engine.stems.store(Arc::new(None));
        // Re-anchor the cursor onto the mix timeline (request_seek — see load_stems).
        if let Some(p) = self.engine.pcm.load().as_ref() {
            self.engine.request_seek(pos * p.sample_rate as f64);
        }
    }

    /// True when four stem buses are loaded and driving playback.
    #[napi]
    pub fn has_stems(&self) -> bool {
        self.engine.has_stems()
    }

    // ── Sync (shared clock) ────────────────────────────────────────────────────

    /// Slave this deck to `master_deck_id`'s transport. `ratio` is masterBPM /
    /// slaveBPM (the tempo this deck will run at); `phase_secs` offsets the beat
    /// alignment. The audio callback then derives this deck's position from the
    /// master's every block, so they stay phase-locked without drift.
    #[napi]
    pub fn sync_to(&self, master_deck_id: String, ratio: f64, phase_secs: f64) {
        let master = DECK_REGISTRY.lock().get(&master_deck_id).cloned();
        if let Some(master) = master {
            self.engine.sync_ratio.store(f32::to_bits(ratio as f32), Ordering::Relaxed);
            self.engine.sync_phase.store(f32::to_bits(phase_secs as f32), Ordering::Relaxed);
            self.engine.sync_master.store(Some(master));
            self.engine.synced.store(true, Ordering::Release);
        }
    }

    /// Update the tempo ratio / phase offset of an already-active sync (e.g. when
    /// the master's tempo changes), without re-linking.
    #[napi]
    pub fn update_sync(&self, ratio: f64, phase_secs: f64) {
        self.engine.sync_ratio.store(f32::to_bits(ratio as f32), Ordering::Relaxed);
        self.engine.sync_phase.store(f32::to_bits(phase_secs as f32), Ordering::Relaxed);
    }

    /// Release the sync and return to free-running playback.
    #[napi]
    pub fn clear_sync(&self) {
        self.engine.synced.store(false, Ordering::Release);
        self.engine.sync_master.store(None);
    }

    /// True while this deck is slaved to a master.
    #[napi]
    pub fn is_synced(&self) -> bool {
        self.engine.synced.load(Ordering::Relaxed)
    }

    // ── Scrub (needle search while paused) ──────────────────────────────────────

    /// Enter scrub mode: while paused, the audio callback renders sound that
    /// follows the seeked position at hand velocity (forward or reverse). Pair
    /// each call with `scrub_end`. No effect on a playing deck (it already
    /// scrubs through normal playback).
    #[napi]
    pub fn scrub_begin(&self) {
        self.engine.scrubbing.store(true, Ordering::Release);
    }

    /// Leave scrub mode, returning to the prior (paused) state at the current
    /// position.
    #[napi]
    pub fn scrub_end(&self) {
        self.engine.scrubbing.store(false, Ordering::Release);
    }

    // ── Output device ─────────────────────────────────────────────────────────

    /// Re-route audio output to a different device. All decks share the master
    /// bus, so this rebuilds the single master stream (per-deck routing — e.g.
    /// a separate cue output — is a future cue-bus feature).
    #[napi]
    pub async fn set_output_device(&self, device_id: String) -> NapiResult<()> {
        tokio::task::spawn_blocking(move || {
            rebuild_master_stream(&device_id).map_err(napi::Error::from_reason)
        })
        .await
        .map_err(|e| napi::Error::from_reason(format!("{e}")))?
    }

    // ── Getters ───────────────────────────────────────────────────────────────

    /// Current playback position in milliseconds.
    #[napi]
    pub fn get_time_ms(&self) -> f64 {
        self.engine.position_secs() * 1000.0
    }

    /// Total track duration in milliseconds.
    #[napi]
    pub fn get_duration_ms(&self) -> f64 {
        self.engine.duration_secs() * 1000.0
    }

    /// Post-fader RMS level (0.0–1.0).
    #[napi]
    pub fn get_level(&self) -> f64 {
        self.engine.get_level() as f64
    }

    // ── Event callbacks (threadsafe functions) ────────────────────────────────

    /// Register a callback invoked ~86×/sec with the current position (seconds).
    /// The callback is called from the deck's event-dispatch thread — not the
    /// audio thread. Installing a new callback replaces the previous one.
    #[napi]
    pub fn on_time_update(&self, #[napi(ts_arg_type = "(ms: number) => void")] callback: JsFunction) -> NapiResult<()> {
        let tsfn: ThreadsafeFunction<f64, ErrorStrategy::Fatal> =
            callback.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?;
        *self.sinks.time.lock() = Some(tsfn);
        Ok(())
    }

    /// Register a callback fired once when the track naturally reaches its end.
    /// Installing a new callback replaces the previous one.
    #[napi]
    pub fn on_ended(&self, #[napi(ts_arg_type = "() => void")] callback: JsFunction) -> NapiResult<()> {
        // Empty arg list → the JS `() => void` callback is invoked with no args.
        // The concrete element type (f64) is only needed to satisfy inference.
        let tsfn: ThreadsafeFunction<(), ErrorStrategy::Fatal> =
            callback.create_threadsafe_function(0, |_ctx| Ok(Vec::<f64>::new()))?;
        *self.sinks.ended.lock() = Some(tsfn);
        Ok(())
    }
}

// ── Module-level exports ──────────────────────────────────────────────────────

/// Create a new deck engine instance and register it with the master bus.
/// `deck_id` is an arbitrary label (e.g. "A", "B").
/// `output_device` selects the master output device on first creation.
#[napi]
pub fn create_deck(deck_id: String, output_device: Option<String>) -> NapiResult<DeckHandle> {
    let engine = DeckEngine::new();

    // Ensure the shared master stream is running (first deck creates it).
    if MASTER.stream.lock().is_none() {
        rebuild_master_stream(&output_device.unwrap_or_default())
            .map_err(napi::Error::from_reason)?;
    }

    // Register so other decks can slave to this one by id (shared-clock sync),
    // then publish the deck list to the master callback.
    DECK_REGISTRY.lock().insert(deck_id.clone(), engine.clone());
    publish_active_decks();

    // Single event-dispatch thread — the ONLY consumer of this deck's event
    // channel (see `EventSinks`). Fans out to whichever JS callbacks are set.
    let sinks: Arc<EventSinks> = Arc::new(EventSinks::default());
    {
        let sinks = sinks.clone();
        let rx = engine.event_rx.clone();
        thread::Builder::new()
            .name(format!("audio-events-{}", deck_id))
            .spawn(move || {
                for event in &rx {
                    match event {
                        AudioEvent::TimeUpdate(secs) => {
                            if let Some(tsfn) = &*sinks.time.lock() {
                                tsfn.call(secs * 1000.0, ThreadsafeFunctionCallMode::NonBlocking);
                            }
                        }
                        AudioEvent::Ended => {
                            if let Some(tsfn) = &*sinks.ended.lock() {
                                tsfn.call((), ThreadsafeFunctionCallMode::NonBlocking);
                            }
                        }
                    }
                }
            })
            .map_err(|e| napi::Error::from_reason(format!("event thread spawn: {e}")))?;
    }

    Ok(DeckHandle {
        engine,
        deck_id,
        sinks,
    })
}

/// Enumerate available audio output devices by name.
#[napi]
pub fn list_output_devices() -> Vec<String> {
    list_devices()
}

// ── Master-bus recording ──────────────────────────────────────────────────────

#[napi(object)]
pub struct RecordingResult {
    pub path:    String,
    pub seconds: f64,
}

/// Start recording the master mix to a 16-bit PCM WAV at `path`.
/// Errors if already recording or the master stream isn't running.
#[napi]
pub fn start_recording(path: String) -> NapiResult<()> {
    MASTER
        .recorder
        .start(PathBuf::from(path))
        .map_err(napi::Error::from_reason)
}

/// Stop recording; drains and finalises the WAV. Returns the file path and
/// the recorded duration in seconds.
#[napi]
pub fn stop_recording() -> NapiResult<RecordingResult> {
    let (path, seconds) = MASTER.recorder.stop().map_err(napi::Error::from_reason)?;
    Ok(RecordingResult { path, seconds })
}

/// True while the master mix is being recorded.
#[napi]
pub fn is_recording() -> bool {
    MASTER.recorder.is_recording()
}
