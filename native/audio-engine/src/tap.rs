//! Master stream tap — a second consumer of the post-mix master output, used to
//! stream the live mix out of the engine (e.g. to Google Cast).
//!
//! Same lock-free SPSC ring as the recorder: the audio callback pushes the
//! summed+limited master block when `active`; the control (main JS) thread
//! drains it via napi and pumps the PCM into an encoder. Producer = audio
//! thread, consumer = main thread (start/drain are both main-thread, so the
//! single-consumer invariant holds).

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use crate::ring::SpscRing;

/// ~2 s of stereo @ 48 kHz — enough slack that a slow drain never starves the
/// encoder, small enough that latency stays bounded if the consumer stalls.
const TAP_CAPACITY: usize = 48_000 * 2 * 2;

pub struct StreamTap {
    pub ring: SpscRing,
    pub active: AtomicBool,
    pub sample_rate: AtomicU32,
    pub channels: AtomicU32,
}

impl StreamTap {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            ring: SpscRing::new(TAP_CAPACITY),
            active: AtomicBool::new(false),
            sample_rate: AtomicU32::new(48_000),
            channels: AtomicU32::new(2),
        })
    }

    /// Begin tapping. Drains any stale samples first so the stream starts clean
    /// (called from the main thread, same as `drain`, so SPSC is preserved).
    pub fn start(&self) {
        let mut scratch = [0.0f32; 4096];
        while self.ring.pop_slice(&mut scratch) > 0 {}
        self.active.store(true, Ordering::Release);
    }

    pub fn stop(&self) {
        self.active.store(false, Ordering::Release);
    }

    /// Pop up to `out.len()` interleaved samples, returning how many were copied.
    pub fn drain(&self, out: &mut [f32]) -> usize {
        self.ring.pop_slice(out)
    }
}
