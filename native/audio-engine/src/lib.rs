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
mod output;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::thread;

use napi::bindgen_prelude::*;
use napi::{JsFunction, Result as NapiResult};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, ErrorStrategy};
use napi_derive::napi;

use deck::{AudioEvent, DeckEngine};
use decoder::{decode_file, compute_peaks, compute_band_peaks};
use output::{build_stream, find_output_device, list_output_devices as list_devices};

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
    deck_id:  String,
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
            engine.set_cursor(0.0);
            engine.looping.store(false, Ordering::Relaxed);
            engine.pcm.store(Arc::new(Some(pcm)));

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
        .map_err(|e| napi::Error::from_reason(e))?;

        Ok(result)
    }

    // ── Playback ─────────────────────────────────────────────────────────────

    #[napi]
    pub fn play(&self, from_ms: Option<f64>) {
        if let Some(ms) = from_ms {
            let pcm_guard = self.engine.pcm.load();
            if let Some(pcm) = pcm_guard.as_ref() {
                let cursor = (ms / 1000.0) * pcm.sample_rate as f64;
                self.engine.set_cursor(cursor);
            }
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
        self.engine.set_cursor(0.0);
    }

    #[napi]
    pub fn seek(&self, ms: f64) {
        let pcm_guard = self.engine.pcm.load();
        if let Some(pcm) = pcm_guard.as_ref() {
            let cursor = (ms / 1000.0) * pcm.sample_rate as f64;
            self.engine.set_cursor(cursor.max(0.0).min(pcm.num_frames as f64));
        }
    }

    // ── Loop ─────────────────────────────────────────────────────────────────

    #[napi]
    pub fn set_loop(&self, start_ms: f64, end_ms: f64) {
        let pcm_guard = self.engine.pcm.load();
        if let Some(pcm) = pcm_guard.as_ref() {
            let sr = pcm.sample_rate as f64;
            let start_frames = ((start_ms / 1000.0) * sr) as u64;
            let end_frames   = ((end_ms   / 1000.0) * sr) as u64;
            self.engine.loop_start_frames.store(start_frames, Ordering::Relaxed);
            self.engine.loop_end_frames.store(end_frames, Ordering::Relaxed);
            self.engine.looping.store(true, Ordering::Relaxed);
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
        // Phase 2: wire to rubberband-rs here.
        // For now, store the flag — the audio callback will check it when rubberband is wired.
        self.engine.keylock.store(enabled, Ordering::Relaxed);
    }

    #[napi]
    pub fn set_eq_gain(&self, band: String, _db: f64) {
        // TODO (Phase 2): implement a biquad EQ filter in the audio callback.
        // For now, log and no-op so the UI can wire up without crashing.
        let _ = band;
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

    // ── Output device ─────────────────────────────────────────────────────────

    /// Re-route this deck's output to a different audio device.
    /// Tears down the old stream and builds a new one on the new device.
    #[napi]
    pub async fn set_output_device(&self, device_id: String) -> NapiResult<()> {
        let engine = self.engine.clone();
        tokio::task::spawn_blocking(move || {
            let device = find_output_device(&device_id)
                .map_err(|e| napi::Error::from_reason(e))?;
            let stream = build_stream(engine.clone(), &device)
                .map_err(|e| napi::Error::from_reason(e))?;
            *engine.stream.lock() = Some(stream);
            Ok(())
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
    /// The callback is called from a dedicated dispatch thread — not the audio thread.
    #[napi]
    pub fn on_time_update(&self, #[napi(ts_arg_type = "(ms: number) => void")] callback: JsFunction) -> NapiResult<()> {
        let tsfn: ThreadsafeFunction<f64, ErrorStrategy::Fatal> =
            callback.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?;

        let engine = self.engine.clone();
        let rx = engine.event_rx.clone();

        thread::Builder::new()
            .name(format!("audio-event-{}", self.deck_id))
            .spawn(move || {
                for event in &rx {
                    match event {
                        AudioEvent::TimeUpdate(secs) => {
                            tsfn.call(secs * 1000.0, ThreadsafeFunctionCallMode::NonBlocking);
                        }
                        AudioEvent::Ended => {
                            // handled by on_ended — nothing to do here
                        }
                    }
                }
            })
            .map_err(|e| napi::Error::from_reason(format!("thread spawn: {e}")))?;

        Ok(())
    }

    /// Register a callback fired once when the track naturally reaches its end.
    #[napi]
    pub fn on_ended(&self, #[napi(ts_arg_type = "() => void")] callback: JsFunction) -> NapiResult<()> {
        let tsfn: ThreadsafeFunction<(), ErrorStrategy::Fatal> =
            callback.create_threadsafe_function(0, |_ctx| Ok(vec![]))?;

        let engine = self.engine.clone();
        let rx = engine.event_rx.clone();

        thread::Builder::new()
            .name(format!("audio-ended-{}", self.deck_id))
            .spawn(move || {
                for event in &rx {
                    if let AudioEvent::Ended = event {
                        tsfn.call((), ThreadsafeFunctionCallMode::NonBlocking);
                    }
                }
            })
            .map_err(|e| napi::Error::from_reason(format!("thread spawn: {e}")))?;

        Ok(())
    }
}

// ── Module-level exports ──────────────────────────────────────────────────────

/// Create a new deck engine instance.
/// `deck_id` is an arbitrary label (e.g. "A", "B") used for logging.
/// `output_device` is an optional device name string; defaults to system default.
#[napi]
pub fn create_deck(deck_id: String, output_device: Option<String>) -> NapiResult<DeckHandle> {
    let engine = DeckEngine::new();

    // Open the audio output stream immediately.
    let device_name = output_device.unwrap_or_default();
    let device = find_output_device(&device_name)
        .map_err(|e| napi::Error::from_reason(e))?;

    let stream = build_stream(engine.clone(), &device)
        .map_err(|e| napi::Error::from_reason(e))?;

    *engine.stream.lock() = Some(stream);

    Ok(DeckHandle { engine, deck_id })
}

/// Enumerate available audio output devices by name.
#[napi]
pub fn list_output_devices() -> Vec<String> {
    list_devices()
}
