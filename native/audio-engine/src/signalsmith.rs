//! Keylock time-stretcher backed by Signalsmith Stretch (vendored C++, MIT).
//!
//! Pitch-preserving tempo change with proper transient handling — replaces the
//! earlier in-house WSOLA, which flammed transients on large tempo shifts. The
//! C++ library is compiled into the addon by `build.rs` (no system dependency).
//!
//! It is driven block-by-block from the audio callback: to produce `out_frames`
//! of output at tempo `rate`, we feed it `round(out_frames * rate)` input frames
//! (read from the source via a closure, so sample-rate conversion and stem
//! mixing happen upstream), and it time-compresses/expands to fill the block.

use std::os::raw::c_void;

extern "C" {
    fn sms_create() -> *mut c_void;
    fn sms_destroy(p: *mut c_void);
    fn sms_preset_default(p: *mut c_void, channels: i32, sample_rate: f32);
    fn sms_reset(p: *mut c_void);
    fn sms_output_latency(p: *mut c_void) -> i32;
    fn sms_process(
        p: *mut c_void,
        inputs: *const *const f32,
        in_samples: i32,
        outputs: *const *mut f32,
        out_samples: i32,
    );
    fn sms_seek(p: *mut c_void, inputs: *const *const f32, in_samples: i32, playback_rate: f64);
}

/// Largest output block we size the scratch buffers for (cpal callbacks are far
/// smaller in practice; this is a safe ceiling so `process` never allocates).
const MAX_OUT: usize = 8192;
/// Playback rate is clamped to ≤ 2.0, so input never exceeds 2× the output.
const MAX_IN: usize = MAX_OUT * 2 + 16;

pub struct SignalsmithStretcher {
    ptr:      *mut c_void,
    channels: usize,
    in_buf:   Vec<Vec<f32>>,   // planar input scratch  [ch][MAX_IN]
    out_buf:  Vec<Vec<f32>>,   // planar output scratch [ch][MAX_OUT]
    in_ptrs:  Vec<*const f32>, // stable pointers into in_buf
    out_ptrs: Vec<*mut f32>,   // stable pointers into out_buf
    in_pos:   f64,             // source read position, in output-rate frames
    /// Fractional input frames owed from previous blocks. Feeding
    /// `round(out × rate)` whole frames per block biases the effective tempo
    /// by up to ~0.05 % (the rounding error has a constant sign for a fixed
    /// block size); carrying the remainder keeps the long-run average exact.
    carry:    f64,
}

// SAFETY: used only from a single deck's audio thread; never shared. The raw
// pointers are owned by this struct and stay valid for its lifetime.
unsafe impl Send for SignalsmithStretcher {}

impl SignalsmithStretcher {
    pub fn new(channels: usize, sample_rate: f64) -> Self {
        let channels = channels.clamp(1, 2);
        let ptr = unsafe { sms_create() };
        unsafe { sms_preset_default(ptr, channels as i32, sample_rate as f32) };

        let in_buf: Vec<Vec<f32>> = (0..channels).map(|_| vec![0.0; MAX_IN]).collect();
        let mut out_buf: Vec<Vec<f32>> = (0..channels).map(|_| vec![0.0; MAX_OUT]).collect();
        let in_ptrs = in_buf.iter().map(|b| b.as_ptr()).collect();
        let out_ptrs = out_buf.iter_mut().map(|b| b.as_mut_ptr()).collect();

        Self { ptr, channels, in_buf, out_buf, in_ptrs, out_ptrs, in_pos: 0.0, carry: 0.0 }
    }

    /// Source read position, in output-rate frames.
    pub fn in_pos(&self) -> f64 {
        self.in_pos
    }

    /// Output latency in output-rate frames — how far the audible output lags
    /// the input read position. Used to compensate reported playhead positions.
    pub fn output_latency_frames(&self) -> i32 {
        unsafe { sms_output_latency(self.ptr) }
    }

    /// Flush internal state and re-anchor WITHOUT priming (silent ramp-in).
    /// Prefer [`reset_primed`] anywhere source audio is available.
    #[allow(dead_code)]
    pub fn reset(&mut self, in_pos: f64) {
        unsafe { sms_reset(self.ptr) };
        self.in_pos = in_pos;
        self.carry = 0.0;
    }

    /// Flush internal state, re-anchor at output-rate position `in_pos`, and
    /// prime the stretcher with the audio *preceding* the anchor via
    /// `sms_seek`, so output starts fully formed instead of ramping in from a
    /// zeroed window (the audible dropout/flam on keylock engage, seek, and
    /// loop wrap). `read(output_rate_pos, channel)` must return 0.0 for
    /// out-of-range positions (it already does in the audio callback).
    pub fn reset_primed<F: FnMut(f64, usize) -> f32>(&mut self, in_pos: f64, rate: f64, mut read: F) {
        unsafe { sms_reset(self.ptr) };
        self.in_pos = in_pos;
        self.carry = 0.0;

        // The wrapper exposes output latency only; for the default preset the
        // input latency is the same order, and Signalsmith accepts any
        // reasonable history length here.
        let prime = (unsafe { sms_output_latency(self.ptr) }.max(0) as usize).min(MAX_IN);
        if prime == 0 {
            return;
        }
        let start = in_pos - prime as f64;
        for c in 0..self.channels {
            let buf = &mut self.in_buf[c];
            for (i, slot) in buf.iter_mut().take(prime).enumerate() {
                *slot = read(start + i as f64, c);
            }
        }
        unsafe { sms_seek(self.ptr, self.in_ptrs.as_ptr(), prime as i32, rate) };
    }

    /// Time-stretch a block: produce `out_frames` output frames at tempo `rate`,
    /// pulling source samples via `read(output_rate_pos, channel)`. Read the
    /// result back per frame with [`out_sample`].
    pub fn process<F: FnMut(f64, usize) -> f32>(&mut self, out_frames: usize, rate: f64, mut read: F) {
        let out_frames = out_frames.min(MAX_OUT);
        // Whole input frames this block, carrying the fractional remainder so
        // the long-run input/output ratio equals `rate` exactly.
        let exact = (out_frames as f64) * rate + self.carry;
        let in_frames = (exact.floor() as usize).min(MAX_IN);
        self.carry = if in_frames == MAX_IN { 0.0 } else { exact - in_frames as f64 };

        for c in 0..self.channels {
            let buf = &mut self.in_buf[c];
            for (i, slot) in buf.iter_mut().take(in_frames).enumerate() {
                *slot = read(self.in_pos + i as f64, c);
            }
        }

        unsafe {
            sms_process(
                self.ptr,
                self.in_ptrs.as_ptr(),
                in_frames as i32,
                self.out_ptrs.as_ptr(),
                out_frames as i32,
            );
        }

        self.in_pos += in_frames as f64;
    }

    /// One processed output sample (call after [`process`]).
    #[inline(always)]
    pub fn out_sample(&self, ch: usize, i: usize) -> f32 {
        self.out_buf[ch.min(self.channels - 1)][i]
    }
}

impl Drop for SignalsmithStretcher {
    fn drop(&mut self) {
        unsafe { sms_destroy(self.ptr) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fractional_carry_keeps_long_run_tempo_exact() {
        // 512-frame blocks at rate 1.06: round() per block would consume
        // 543 frames/block (effective 1.0605…); the carry must keep the
        // total consumed input within 1 frame of the exact product.
        let mut s = SignalsmithStretcher::new(2, 48_000.0);
        s.reset(0.0);
        let blocks = 500;
        let rate = 1.06;
        for _ in 0..blocks {
            s.process(512, rate, |_pos, _ch| 0.0);
        }
        let expected = 512.0 * rate * blocks as f64;
        assert!(
            (s.in_pos() - expected).abs() < 1.0,
            "in_pos {} vs exact {}",
            s.in_pos(),
            expected
        );
    }
}
