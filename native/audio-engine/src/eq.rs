//! Three-band DJ EQ — RBJ audio-EQ-cookbook biquads.
//!
//! Each band is a second-order IIR filter evaluated in Transposed Direct Form II
//! (good numerical behaviour, one multiply-add chain per sample). Coefficients are
//! recomputed only when a band's gain changes — never per sample — so the audio
//! callback only pays for the per-sample `process()` (a handful of mul-adds).
//!
//! Band layout matches the renderer contract (`audioEngineContract.ts`):
//!   • low  — low shelf  @ 200 Hz
//!   • mid  — peaking    @ 1 kHz (Q ≈ 0.9)
//!   • high — high shelf @ 8 kHz
//!
//! Reference: Robert Bristow-Johnson, "Cookbook formulae for audio EQ biquad
//! filter coefficients."

use std::f32::consts::{PI, SQRT_2};

/// Centre / corner frequencies for the three bands (Hz).
const LOW_FREQ:  f32 = 200.0;
const MID_FREQ:  f32 = 1_000.0;
const HIGH_FREQ: f32 = 8_000.0;
/// Q of the mid peaking band.
const MID_Q:     f32 = 0.9;

/// Normalised biquad coefficients (a0 folded in).
#[derive(Clone, Copy)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
}

/// Per-channel delay-line state for one biquad (Transposed Direct Form II).
#[derive(Clone, Copy, Default)]
pub struct BiquadState {
    z1: f32,
    z2: f32,
}

impl Biquad {
    /// Identity filter — passes the signal through unchanged.
    pub const fn unity() -> Self {
        Self { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0 }
    }

    /// Process one sample, advancing `state`. Real-time safe (no allocation).
    #[inline(always)]
    pub fn process(&self, state: &mut BiquadState, x: f32) -> f32 {
        let y = self.b0 * x + state.z1;
        state.z1 = self.b1 * x - self.a1 * y + state.z2;
        state.z2 = self.b2 * x - self.a2 * y;
        y
    }

    /// Fold a0 into the other coefficients so `process()` needs no division.
    fn normalized(b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) -> Self {
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }

    /// Low-shelf filter (shelf slope S = 1).
    pub fn low_shelf(f0: f32, fs: f32, gain_db: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * PI * f0 / fs;
        let (sin_w0, cos_w0) = w0.sin_cos();
        let alpha = sin_w0 / 2.0 * SQRT_2; // S = 1
        let beta = 2.0 * a.sqrt() * alpha;

        let b0 = a * ((a + 1.0) - (a - 1.0) * cos_w0 + beta);
        let b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w0);
        let b2 = a * ((a + 1.0) - (a - 1.0) * cos_w0 - beta);
        let a0 = (a + 1.0) + (a - 1.0) * cos_w0 + beta;
        let a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cos_w0);
        let a2 = (a + 1.0) + (a - 1.0) * cos_w0 - beta;
        Self::normalized(b0, b1, b2, a0, a1, a2)
    }

    /// High-shelf filter (shelf slope S = 1).
    pub fn high_shelf(f0: f32, fs: f32, gain_db: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * PI * f0 / fs;
        let (sin_w0, cos_w0) = w0.sin_cos();
        let alpha = sin_w0 / 2.0 * SQRT_2; // S = 1
        let beta = 2.0 * a.sqrt() * alpha;

        let b0 = a * ((a + 1.0) + (a - 1.0) * cos_w0 + beta);
        let b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0);
        let b2 = a * ((a + 1.0) + (a - 1.0) * cos_w0 - beta);
        let a0 = (a + 1.0) - (a - 1.0) * cos_w0 + beta;
        let a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cos_w0);
        let a2 = (a + 1.0) - (a - 1.0) * cos_w0 - beta;
        Self::normalized(b0, b1, b2, a0, a1, a2)
    }

    /// Peaking (bell) filter at `f0` with quality factor `q`.
    pub fn peaking(f0: f32, fs: f32, q: f32, gain_db: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * PI * f0 / fs;
        let (sin_w0, cos_w0) = w0.sin_cos();
        let alpha = sin_w0 / (2.0 * q);

        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cos_w0;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1 = -2.0 * cos_w0;
        let a2 = 1.0 - alpha / a;
        Self::normalized(b0, b1, b2, a0, a1, a2)
    }
}

/// Build the three-band coefficient set for a given output sample rate.
/// Gains are in dB; 0 dB yields a (near-)flat response.
pub fn build_bands(fs: f32, low_db: f32, mid_db: f32, high_db: f32) -> [Biquad; 3] {
    [
        Biquad::low_shelf(LOW_FREQ, fs, low_db),
        Biquad::peaking(MID_FREQ, fs, MID_Q, mid_db),
        Biquad::high_shelf(HIGH_FREQ, fs, high_db),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f32 = 44_100.0;

    /// Steady-state gain of a filter at DC (z = 1): H(1) = Σb / Σa.
    fn dc_gain(f: &Biquad) -> f32 {
        (f.b0 + f.b1 + f.b2) / (1.0 + f.a1 + f.a2)
    }

    /// Run a constant input through the filter until it settles, return output.
    fn settled_dc(f: &Biquad) -> f32 {
        let mut st = BiquadState::default();
        let mut y = 0.0;
        for _ in 0..20_000 {
            y = f.process(&mut st, 1.0);
        }
        y
    }

    #[test]
    fn flat_eq_is_exact_passthrough() {
        // At 0 dB every band is mathematically identity (numerator == denominator),
        // so a signal must pass through sample-for-sample.
        let bands = build_bands(FS, 0.0, 0.0, 0.0);
        let input = [0.0, 0.7, -0.3, 0.95, -0.95, 0.1, 0.0, -0.5];
        for band in &bands {
            let mut st = BiquadState::default();
            for &x in &input {
                let y = band.process(&mut st, x);
                assert!((y - x).abs() < 1e-6, "0 dB band altered the signal: {x} -> {y}");
            }
        }
    }

    #[test]
    fn low_shelf_dc_gain_matches_db() {
        // A low shelf's DC gain equals the linear gain (10^(dB/20)).
        for &db in &[-12.0_f32, -6.0, 6.0] {
            let f = Biquad::low_shelf(LOW_FREQ, FS, db);
            let expected = 10f32.powf(db / 20.0);
            assert!((dc_gain(&f) - expected).abs() < 1e-3, "low shelf {db} dB: H(1)");
            assert!((settled_dc(&f) - expected).abs() < 1e-2, "low shelf {db} dB: settled");
        }
    }

    #[test]
    fn high_shelf_is_flat_at_dc() {
        // A high shelf leaves low frequencies (DC) untouched regardless of gain.
        for &db in &[-12.0_f32, 6.0] {
            let f = Biquad::high_shelf(HIGH_FREQ, FS, db);
            assert!((dc_gain(&f) - 1.0).abs() < 1e-3, "high shelf {db} dB should be unity at DC");
        }
    }

    #[test]
    fn peaking_is_flat_at_dc() {
        // A peaking filter only affects its band; DC passes at unity gain.
        let f = Biquad::peaking(MID_FREQ, FS, MID_Q, 9.0);
        assert!((dc_gain(&f) - 1.0).abs() < 1e-3, "peaking should be unity at DC");
    }

    #[test]
    fn filters_are_stable() {
        // Poles inside the unit circle ⇒ |a2| < 1 (necessary stability condition).
        for &db in &[-24.0_f32, -12.0, 0.0, 6.0] {
            assert!(Biquad::low_shelf(LOW_FREQ, FS, db).a2.abs() < 1.0);
            assert!(Biquad::high_shelf(HIGH_FREQ, FS, db).a2.abs() < 1.0);
            assert!(Biquad::peaking(MID_FREQ, FS, MID_Q, db).a2.abs() < 1.0);
        }
    }
}
