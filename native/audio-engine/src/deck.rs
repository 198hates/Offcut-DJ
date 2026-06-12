//! DeckEngine — lock-free playback state shared between the audio callback
//! and the N-API / control thread.
//!
//! Design constraints:
//!   • The cpal audio callback is **real-time**: no heap allocation, no blocking.
//!   • All hot-path state is accessed via atomics or lock-free structures.
//!   • The `PcmBuffer` (decoded audio data) is swapped in atomically via
//!     `arc-swap`; the callback always sees a valid (or absent) buffer.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use arc_swap::{ArcSwap, ArcSwapOption};
use crossbeam_channel::{bounded, Receiver, Sender};

// ── PcmBuffer ─────────────────────────────────────────────────────────────────

/// Decoded audio in interleaved 32-bit float, ready for the output callback.
pub struct PcmBuffer {
    /// Interleaved float samples (left, right, left, right, …).
    pub data:        Vec<f32>,
    /// Source sample rate in Hz (e.g. 44100).
    pub sample_rate: u32,
    /// Number of channels in `data` (1 or 2).
    pub channels:    usize,
    /// Total number of frames (= data.len() / channels).
    pub num_frames:  u64,
}

/// Four decoded stem buffers (drums / bass / vocals / other) that replace the
/// single mix when loaded. All four share sample rate, channel count and length
/// (Demucs output), so one set of frame geometry indexes all of them.
pub struct StemSet {
    /// Interleaved float PCM per stem, indexed by `STEM_*`.
    pub data:        [Vec<f32>; STEM_COUNT],
    pub sample_rate: u32,
    pub channels:    usize,
    /// Shortest stem length in frames (clamped so indexing is always in-bounds).
    pub num_frames:  u64,
}

// ── Event channels ────────────────────────────────────────────────────────────

/// Events pushed from the audio callback to the JS-dispatch thread.
pub enum AudioEvent {
    TimeUpdate(f64), // playback position in seconds
    Ended,
}

// ── Stem indices ─────────────────────────────────────────────────────────────

/// Index of each stem bus in the atomic arrays.
pub const STEM_DRUMS:  usize = 0;
pub const STEM_BASS:   usize = 1;
pub const STEM_VOCALS: usize = 2;
pub const STEM_OTHER:  usize = 3;
pub const STEM_COUNT:  usize = 4;

// ── DeckEngine ────────────────────────────────────────────────────────────────

/// All state for one playback deck.  All fields that are touched from the
/// audio callback are atomics or lock-free; only `stream` uses a mutex (it is
/// not accessed from the hot path).
pub struct DeckEngine {
    // ── Audio data ─────────────────────────────────────────────────────────
    /// Atomically swappable PCM buffer.  `None` = no track loaded.
    pub pcm: ArcSwap<Option<PcmBuffer>>,
    /// Atomically swappable stem set.  `Some` = play 4 stem buses instead of `pcm`.
    pub stems: ArcSwap<Option<StemSet>>,

    // ── Playback state (atomics, lock-free from audio callback) ────────────
    /// Whether the deck is currently playing.
    pub is_playing:    AtomicBool,
    /// Cursor into the source PCM buffer (in frames), stored as f64 bits so
    /// sub-frame precision is preserved across calls.
    pub cursor_f64:    AtomicU64,   // stores f64::to_bits()
    /// One-shot seek request: the audio callback adopts `seek_target` (f64 frame
    /// bits) at the next block boundary and clears the flag. This guarantees a
    /// seek is never lost to the callback's own cursor commit — essential for
    /// smooth scrubbing, where seeks arrive faster than blocks complete.
    pub seek_pending:  AtomicBool,
    pub seek_target:   AtomicU64,   // stores f64::to_bits() (frames)
    /// Playback rate multiplier (1.0 = normal), stored as f32 bits.
    pub rate:          AtomicU32,   // stores f32::to_bits()
    /// Channel fader volume (0.0–1.0), stored as f32 bits.
    pub volume:        AtomicU32,   // stores f32::to_bits()
    /// Keylock enabled.  Audio effect stubbed — reserved for rubberband-rs Phase 2.
    pub keylock:       AtomicBool,
    /// Scrub mode: render audio while the transport is paused, following the
    /// seeked (hand) position at hand velocity — vinyl-style needle search.
    pub scrubbing:     AtomicBool,

    // ── Loop ──────────────────────────────────────────────────────────────
    pub looping:            AtomicBool,
    pub loop_start_frames:  AtomicU64,
    pub loop_end_frames:    AtomicU64,

    // ── EQ (stored as i32 = dB × 100, range −2400..=600) ─────────────────
    pub eq_high_db100: AtomicU32,  // f32 bits
    pub eq_mid_db100:  AtomicU32,
    pub eq_low_db100:  AtomicU32,

    // ── Stems (gain in dB, muted flag, per bus) ───────────────────────────
    /// Gain for each stem bus, stored as f32 bits.
    pub stem_gain:   [AtomicU32;  STEM_COUNT],
    /// Mute flag per stem bus.
    pub stem_muted:  [AtomicBool; STEM_COUNT],
    /// Solo flag per stem bus.
    pub stem_soloed: [AtomicBool; STEM_COUNT],

    // ── Sync (shared clock: this deck follows `sync_master`'s transport) ──
    /// Whether this deck is slaved to a master deck.
    pub synced:      AtomicBool,
    /// The master deck's engine (None when free-running). Set only from the
    /// control thread; read lock-free from the audio callback.
    pub sync_master: ArcSwapOption<DeckEngine>,
    /// Tempo ratio master→slave (masterBPM / slaveBPM), f32 bits.
    pub sync_ratio:  AtomicU32,
    /// Phase offset in seconds applied after the ratio, f32 bits.
    pub sync_phase:  AtomicU32,

    // ── VU meter (post-fader RMS, updated by audio callback) ─────────────
    pub level_f32: AtomicU32,   // stores f32::to_bits()

    /// Latency (seconds, f32 bits) between the committed cursor and what is
    /// audible — nonzero only while the keylock time-stretcher is engaged.
    /// Written by the audio callback; subtracted from reported positions so
    /// the playhead/beat phase track the audible audio, not the read head.
    pub report_latency_secs: AtomicU32,

    // ── Event dispatch ────────────────────────────────────────────────────
    pub event_tx: Sender<AudioEvent>,
    pub event_rx: Receiver<AudioEvent>,
}

impl DeckEngine {
    pub fn new() -> Arc<Self> {
        let (tx, rx) = bounded(256);

        // Initialise stem_gain / stem_muted / stem_soloed arrays.
        // `AtomicU32` / `AtomicBool` are not `Copy`, so we use `Default` via
        // `std::array::from_fn`.
        let stem_gain: [AtomicU32; STEM_COUNT] = std::array::from_fn(|_| AtomicU32::new(f32::to_bits(0.0)));
        let stem_muted:  [AtomicBool; STEM_COUNT] = std::array::from_fn(|_| AtomicBool::new(false));
        let stem_soloed: [AtomicBool; STEM_COUNT] = std::array::from_fn(|_| AtomicBool::new(false));

        Arc::new(Self {
            pcm:           ArcSwap::new(Arc::new(None)),
            stems:         ArcSwap::new(Arc::new(None)),
            is_playing:    AtomicBool::new(false),
            cursor_f64:    AtomicU64::new(f64::to_bits(0.0)),
            seek_pending:  AtomicBool::new(false),
            seek_target:   AtomicU64::new(f64::to_bits(0.0)),
            rate:          AtomicU32::new(f32::to_bits(1.0)),
            volume:        AtomicU32::new(f32::to_bits(0.8)),
            keylock:       AtomicBool::new(false),
            scrubbing:     AtomicBool::new(false),
            looping:       AtomicBool::new(false),
            loop_start_frames: AtomicU64::new(0),
            loop_end_frames:   AtomicU64::new(0),
            eq_high_db100: AtomicU32::new(f32::to_bits(0.0)),
            eq_mid_db100:  AtomicU32::new(f32::to_bits(0.0)),
            eq_low_db100:  AtomicU32::new(f32::to_bits(0.0)),
            stem_gain,
            stem_muted,
            stem_soloed,
            synced:      AtomicBool::new(false),
            sync_master: ArcSwapOption::empty(),
            sync_ratio:  AtomicU32::new(f32::to_bits(1.0)),
            sync_phase:  AtomicU32::new(f32::to_bits(0.0)),
            level_f32:   AtomicU32::new(f32::to_bits(0.0)),
            report_latency_secs: AtomicU32::new(f32::to_bits(0.0)),
            event_tx:    tx,
            event_rx:    rx,
        })
    }

    // ── Atomic float helpers ──────────────────────────────────────────────

    pub fn get_rate(&self)   -> f32 { f32::from_bits(self.rate.load(Ordering::Relaxed))   }
    pub fn get_volume(&self) -> f32 { f32::from_bits(self.volume.load(Ordering::Relaxed)) }
    pub fn get_cursor(&self) -> f64 { f64::from_bits(self.cursor_f64.load(Ordering::Relaxed)) }
    pub fn get_level(&self)  -> f32 { f32::from_bits(self.level_f32.load(Ordering::Relaxed)) }

    pub fn set_rate(&self, r: f32) {
        self.rate.store(f32::to_bits(r.clamp(0.5, 2.0)), Ordering::Relaxed);
    }
    pub fn set_volume(&self, v: f32) {
        self.volume.store(f32::to_bits(v.clamp(0.0, 1.0)), Ordering::Relaxed);
    }
    pub fn set_cursor(&self, c: f64) {
        self.cursor_f64.store(f64::to_bits(c.max(0.0)), Ordering::Release);
    }

    /// Request a seek to `frames`. Updates the cursor immediately (so getTime and
    /// the paused position are correct) AND flags the audio callback to adopt it
    /// at the next block boundary, so the seek can't be lost to the callback's
    /// own cursor commit (which is what broke scrubbing).
    pub fn request_seek(&self, frames: f64) {
        let f = frames.max(0.0);
        self.seek_target.store(f64::to_bits(f), Ordering::Relaxed);
        self.set_cursor(f);
        self.seek_pending.store(true, Ordering::Release);
    }

    /// Consume a pending seek request (if any), returning its target in frames.
    /// Called once per audio block.
    pub fn take_seek_request(&self) -> Option<f64> {
        if self.seek_pending.swap(false, Ordering::Acquire) {
            Some(f64::from_bits(self.seek_target.load(Ordering::Relaxed)))
        } else {
            None
        }
    }

    // ── Derived position / duration ───────────────────────────────────────

    /// Sample rate of the active source (stems take precedence over the mix).
    fn active_sample_rate(&self) -> Option<u32> {
        if let Some(s) = self.stems.load().as_ref() {
            return Some(s.sample_rate);
        }
        // Two `as_ref()`s: `Guard`→`&Option` (Arc's AsRef), then `Option<&_>`.
        self.pcm.load().as_ref().as_ref().map(|p| p.sample_rate)
    }

    /// Sample rate and frame count of the active source (stems take precedence
    /// over the mix). The cursor lives on the active source's timeline, so all
    /// ms→frame conversions must use this — not `pcm`'s rate — or seeks and
    /// loop points land off by the SR ratio whenever stems differ from the mix.
    pub fn active_geometry(&self) -> Option<(u32, u64)> {
        if let Some(s) = self.stems.load().as_ref() {
            return Some((s.sample_rate, s.num_frames));
        }
        self.pcm.load().as_ref().as_ref().map(|p| (p.sample_rate, p.num_frames))
    }

    /// Current keylock output latency in seconds (0 when not stretching).
    /// Positions are reported in AUDIBLE coordinates (cursor − latency);
    /// inversely, any externally requested position must add this back when
    /// converting to a cursor value, or seeks land early by the latency.
    pub fn report_latency(&self) -> f64 {
        f32::from_bits(self.report_latency_secs.load(Ordering::Relaxed)) as f64
    }

    /// Current playback position in seconds (reads the atomic cursor),
    /// compensated for the keylock stretcher's output latency so it reflects
    /// what is audible.
    pub fn position_secs(&self) -> f64 {
        match self.active_sample_rate() {
            Some(sr) => (self.get_cursor() / sr as f64 - self.report_latency()).max(0.0),
            None => 0.0,
        }
    }

    /// Duration of the loaded track in seconds.
    pub fn duration_secs(&self) -> f64 {
        if let Some(s) = self.stems.load().as_ref() {
            return s.num_frames as f64 / s.sample_rate as f64;
        }
        match self.pcm.load().as_ref() {
            Some(pcm) => pcm.num_frames as f64 / pcm.sample_rate as f64,
            None      => 0.0,
        }
    }

    /// True when four stem buses are loaded and driving playback.
    pub fn has_stems(&self) -> bool {
        self.stems.load().is_some()
    }

    // ── Stem helpers ──────────────────────────────────────────────────────

    pub fn stem_index(kind: &str) -> Option<usize> {
        match kind {
            "drums"  => Some(STEM_DRUMS),
            "bass"   => Some(STEM_BASS),
            "vocals" => Some(STEM_VOCALS),
            "other"  => Some(STEM_OTHER),
            _        => None,
        }
    }

    /// Effective linear gain for each stem bus, folding in mute, solo and trim.
    /// A muted bus (or any non-soloed bus while another is soloed) yields 0.
    /// Computed once per audio buffer — never per sample.
    pub fn stem_linear_gains(&self) -> [f32; STEM_COUNT] {
        let any_soloed = (0..STEM_COUNT).any(|i| self.stem_soloed[i].load(Ordering::Relaxed));
        std::array::from_fn(|i| {
            let muted  = self.stem_muted[i].load(Ordering::Relaxed);
            let soloed = self.stem_soloed[i].load(Ordering::Relaxed);
            if !muted && (!any_soloed || soloed) {
                let db = f32::from_bits(self.stem_gain[i].load(Ordering::Relaxed));
                10f32.powf(db / 20.0)
            } else {
                0.0
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    #[test]
    fn default_stem_gains_are_unity() {
        let e = DeckEngine::new();
        assert!(e.stem_linear_gains().iter().all(|&x| approx(x, 1.0)));
    }

    #[test]
    fn mute_zeroes_only_that_bus() {
        let e = DeckEngine::new();
        e.stem_muted[STEM_DRUMS].store(true, Ordering::Relaxed);
        let g = e.stem_linear_gains();
        assert!(approx(g[STEM_DRUMS], 0.0));
        assert!(approx(g[STEM_BASS], 1.0));
        assert!(approx(g[STEM_VOCALS], 1.0));
    }

    #[test]
    fn solo_silences_every_other_bus() {
        let e = DeckEngine::new();
        e.stem_soloed[STEM_VOCALS].store(true, Ordering::Relaxed);
        let g = e.stem_linear_gains();
        assert!(approx(g[STEM_VOCALS], 1.0));
        assert!(approx(g[STEM_DRUMS], 0.0));
        assert!(approx(g[STEM_BASS], 0.0));
        assert!(approx(g[STEM_OTHER], 0.0));
    }

    #[test]
    fn trim_applies_decibels() {
        let e = DeckEngine::new();
        e.stem_gain[STEM_BASS].store(f32::to_bits(6.0), Ordering::Relaxed);
        assert!(approx(e.stem_linear_gains()[STEM_BASS], 10f32.powf(6.0 / 20.0)));
    }

    #[test]
    fn mute_wins_over_solo_on_same_bus() {
        let e = DeckEngine::new();
        e.stem_soloed[STEM_VOCALS].store(true, Ordering::Relaxed);
        e.stem_muted[STEM_VOCALS].store(true, Ordering::Relaxed);
        assert!(approx(e.stem_linear_gains()[STEM_VOCALS], 0.0));
    }

    #[test]
    fn has_stems_false_before_load() {
        assert!(!DeckEngine::new().has_stems());
    }
}
