//! Per-deck DJ filter — a single "filter knob" that sweeps a resonant low-pass
//! to the left and a resonant high-pass to the right, transparent at centre.
//!
//! Implemented as a topology-preserving-transform (TPT) state-variable filter
//! (Zavalishin / Cytomic "SVF"). Unlike a direct-form biquad, the TPT SVF stays
//! stable when its cutoff is modulated every block, which is exactly what a
//! swept DJ filter does — so we can rebuild coefficients per block without
//! zipper noise or blow-ups.
//!
//! Knob mapping (−1..+1):
//!   • |knob| < DEADZONE  → Off (bypass, sample-for-sample transparent)
//!   • knob > 0           → high-pass, cutoff 20 Hz → ~18 kHz (cuts lows)
//!   • knob < 0           → low-pass,  cutoff ~18 kHz → 200 Hz (cuts highs)

use std::f32::consts::PI;

/// Below this absolute knob value the filter is bypassed (treated transparent).
pub const FILTER_DEADZONE: f32 = 0.02;

/// Fixed resonance (Q) — a touch above Butterworth for a little DJ "bite"
/// near the cutoff without ringing harshly.
const FILTER_Q: f32 = 0.9;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FilterMode {
    Off,
    LowPass,
    HighPass,
}

/// TPT-SVF coefficients, recomputed per block from the smoothed knob.
#[derive(Clone, Copy)]
pub struct SvfCoeffs {
    k: f32,
    a1: f32,
    a2: f32,
    a3: f32,
}

/// Per-channel SVF integrator state.
#[derive(Clone, Copy, Default)]
pub struct SvfState {
    ic1eq: f32,
    ic2eq: f32,
}

impl SvfCoeffs {
    /// Identity placeholder (used before the first real coefficient build).
    pub const fn bypass() -> Self {
        Self { k: 2.0, a1: 0.0, a2: 0.0, a3: 0.0 }
    }

    /// Build from a cutoff (Hz) and the fixed Q, for sample rate `fs`.
    pub fn new(cutoff_hz: f32, fs: f32) -> Self {
        // Pre-warp; clamp cutoff below Nyquist so tan() stays finite.
        let fc = cutoff_hz.clamp(20.0, fs * 0.45);
        let g = (PI * fc / fs).tan();
        let k = 1.0 / FILTER_Q;
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;
        Self { k, a1, a2, a3 }
    }

    /// Process one sample for `mode`, advancing `state`. Real-time safe.
    #[inline(always)]
    pub fn process(&self, state: &mut SvfState, mode: FilterMode, x: f32) -> f32 {
        let v3 = x - state.ic2eq;
        let v1 = self.a1 * state.ic1eq + self.a2 * v3;
        let v2 = state.ic2eq + self.a2 * state.ic1eq + self.a3 * v3;
        state.ic1eq = 2.0 * v1 - state.ic1eq;
        state.ic2eq = 2.0 * v2 - state.ic2eq;
        match mode {
            FilterMode::LowPass => v2,
            FilterMode::HighPass => x - self.k * v1 - v2,
            FilterMode::Off => x,
        }
    }
}

/// Map the filter knob (−1..+1) to a mode + cutoff frequency (Hz).
/// At the centre the chosen cutoff is effectively transparent for that mode
/// (HP at 20 Hz / LP near Nyquist), so engaging the filter from a smoothed knob
/// sweeps in gracefully.
pub fn knob_to_filter(knob: f32, fs: f32) -> (FilterMode, f32) {
    if knob.abs() < FILTER_DEADZONE {
        return (FilterMode::Off, 0.0);
    }
    if knob > 0.0 {
        // High-pass: 20 Hz (transparent) → ~18 kHz (only air left).
        let cutoff = 20.0 * 900f32.powf(knob.min(1.0));
        (FilterMode::HighPass, cutoff)
    } else {
        // Low-pass: ~18 kHz (transparent) → 200 Hz (only bass left).
        let top = (fs * 0.45).min(18_000.0);
        let cutoff = top * (200.0 / top).powf((-knob).min(1.0));
        (FilterMode::LowPass, cutoff)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f32 = 48_000.0;

    fn run(coeffs: &SvfCoeffs, mode: FilterMode, input: &[f32]) -> Vec<f32> {
        let mut st = SvfState::default();
        input.iter().map(|&x| coeffs.process(&mut st, mode, x)).collect()
    }

    /// DC (a constant) passes a low-pass and is blocked by a high-pass.
    #[test]
    fn lp_passes_dc_hp_blocks_dc() {
        let lp = SvfCoeffs::new(1_000.0, FS);
        let hp = SvfCoeffs::new(1_000.0, FS);
        let dc = vec![1.0f32; 4000];
        let lp_out = *run(&lp, FilterMode::LowPass, &dc).last().unwrap();
        let hp_out = *run(&hp, FilterMode::HighPass, &dc).last().unwrap();
        assert!((lp_out - 1.0).abs() < 1e-2, "LP should pass DC, got {lp_out}");
        assert!(hp_out.abs() < 1e-2, "HP should block DC, got {hp_out}");
    }

    /// The filter is stable: a unit impulse decays toward zero, never diverges.
    #[test]
    fn impulse_response_is_stable() {
        for &mode in &[FilterMode::LowPass, FilterMode::HighPass] {
            let c = SvfCoeffs::new(500.0, FS);
            let mut x = vec![0.0f32; 8000];
            x[0] = 1.0;
            let out = run(&c, mode, &x);
            let tail: f32 = out[7000..].iter().map(|v| v.abs()).sum();
            assert!(tail < 1e-3, "{:?} tail energy too high: {tail}", mode as u8);
            assert!(out.iter().all(|v| v.is_finite()), "non-finite sample");
        }
    }

    #[test]
    fn knob_maps_to_expected_modes() {
        assert!(matches!(knob_to_filter(0.0, FS).0, FilterMode::Off));
        assert!(matches!(knob_to_filter(0.01, FS).0, FilterMode::Off));
        assert!(matches!(knob_to_filter(0.5, FS).0, FilterMode::HighPass));
        assert!(matches!(knob_to_filter(-0.5, FS).0, FilterMode::LowPass));
        // Toward the extremes the cutoff moves the expected direction.
        assert!(knob_to_filter(1.0, FS).1 > knob_to_filter(0.3, FS).1, "HP cutoff rises with knob");
        assert!(knob_to_filter(-1.0, FS).1 < knob_to_filter(-0.3, FS).1, "LP cutoff falls with knob");
    }
}
