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
use arc_swap::ArcSwap;
use crossbeam_channel::{bounded, Receiver, Sender};
use parking_lot::Mutex;
use cpal::Stream;

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

    // ── Playback state (atomics, lock-free from audio callback) ────────────
    /// Whether the deck is currently playing.
    pub is_playing:    AtomicBool,
    /// Cursor into the source PCM buffer (in frames), stored as f64 bits so
    /// sub-frame precision is preserved across calls.
    pub cursor_f64:    AtomicU64,   // stores f64::to_bits()
    /// Playback rate multiplier (1.0 = normal), stored as f32 bits.
    pub rate:          AtomicU32,   // stores f32::to_bits()
    /// Channel fader volume (0.0–1.0), stored as f32 bits.
    pub volume:        AtomicU32,   // stores f32::to_bits()
    /// Keylock enabled.  Audio effect stubbed — reserved for rubberband-rs Phase 2.
    pub keylock:       AtomicBool,

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

    // ── VU meter (post-fader RMS, updated by audio callback) ─────────────
    pub level_f32: AtomicU32,   // stores f32::to_bits()

    // ── Event dispatch ────────────────────────────────────────────────────
    pub event_tx: Sender<AudioEvent>,
    pub event_rx: Receiver<AudioEvent>,

    // ── cpal stream (keeps stream alive; not accessed from hot path) ──────
    pub stream: Mutex<Option<Stream>>,
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
            is_playing:    AtomicBool::new(false),
            cursor_f64:    AtomicU64::new(f64::to_bits(0.0)),
            rate:          AtomicU32::new(f32::to_bits(1.0)),
            volume:        AtomicU32::new(f32::to_bits(0.8)),
            keylock:       AtomicBool::new(false),
            looping:       AtomicBool::new(false),
            loop_start_frames: AtomicU64::new(0),
            loop_end_frames:   AtomicU64::new(0),
            eq_high_db100: AtomicU32::new(f32::to_bits(0.0)),
            eq_mid_db100:  AtomicU32::new(f32::to_bits(0.0)),
            eq_low_db100:  AtomicU32::new(f32::to_bits(0.0)),
            stem_gain,
            stem_muted,
            stem_soloed,
            level_f32:   AtomicU32::new(f32::to_bits(0.0)),
            event_tx:    tx,
            event_rx:    rx,
            stream:      Mutex::new(None),
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

    // ── Derived position / duration ───────────────────────────────────────

    /// Current playback position in seconds (reads the atomic cursor).
    pub fn position_secs(&self) -> f64 {
        let pcm_guard = self.pcm.load();
        match pcm_guard.as_ref() {
            Some(pcm) => self.get_cursor() / pcm.sample_rate as f64,
            None      => 0.0,
        }
    }

    /// Duration of the loaded track in seconds.
    pub fn duration_secs(&self) -> f64 {
        let pcm_guard = self.pcm.load();
        match pcm_guard.as_ref() {
            Some(pcm) => pcm.num_frames as f64 / pcm.sample_rate as f64,
            None      => 0.0,
        }
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

    /// Effective gain multiplier for the main mix, accounting for stem mute/solo.
    /// Pre-demucs: approximates the mix level when stems are being muted.
    pub fn effective_mix_gain(&self) -> f32 {
        let any_soloed = (0..STEM_COUNT).any(|i| self.stem_soloed[i].load(Ordering::Relaxed));
        let active_stems: usize = (0..STEM_COUNT).filter(|&i| {
            let muted  = self.stem_muted[i].load(Ordering::Relaxed);
            let soloed = self.stem_soloed[i].load(Ordering::Relaxed);
            !muted && (!any_soloed || soloed)
        }).count();
        // Treat each stem as contributing ¼ of the mix.
        active_stems as f32 / STEM_COUNT as f32
    }
}
