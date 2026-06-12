//! Master-bus audio output — ONE cpal stream renders every deck.
//!
//! Architecture (Phase 3): each `DeckEngine` is rendered by a `DeckRenderer`
//! (per-deck DSP state: EQ, keylock stretcher, gain smoothing, splice fades,
//! sync PLL) into a scratch buffer; the master callback sums the decks,
//! applies a peak limiter, and taps the mix into the recording ring.
//! Compared to the old stream-per-deck design this gives a shared sample
//! clock (sync reads the master deck's cursor committed in the SAME callback),
//! a recording tap, and a master limiter.
//!
//! The callback is called by the OS audio driver at hardware sample rate.
//! Every branch inside must be wait-free: no mutex, no allocation, no syscall.
//! (Exception: a one-time, tiny `Vec` push when a deck is first registered.)
//!
//! Rate changes:
//!   The cursor advances at `rate` source frames per output frame, with 4-point
//!   Hermite interpolation between source frames. This changes pitch when
//!   keylock is off. With keylock on (and tempo ≠ 1×) the Signalsmith
//!   time-stretcher renders pitch-preserving tempo; its output latency is
//!   published to `report_latency_secs` so reported positions track the
//!   audible audio.
//!
//! Click-free behaviour:
//!   • channel gain is one-pole smoothed per sample (fader moves don't zipper);
//!   • pause renders a one-block linear fade-out tail instead of gating;
//!   • seeks, loop wraps and sync snaps splice with a short crossfade;
//!   • EQ gains glide per block before coefficients are rebuilt.
//!
//! Sync runs as a PLL: the slave hard-snaps only on engage (or a large error,
//! e.g. the master seeked); afterwards the phase error is corrected in the
//! rate domain (bounded nudge). With a paused master the slave free-runs at
//! the synced tempo and re-anchors the phase when the master resumes.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use arc_swap::ArcSwap;
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, SampleFormat, Stream, StreamConfig,
};

use crate::deck::{AudioEvent, DeckEngine, STEM_COUNT};
use crate::eq::{build_bands, Biquad, BiquadState};
use crate::recorder::Recorder;
use crate::signalsmith::SignalsmithStretcher;

/// `Send`-asserting wrapper around a cpal `Stream`.
///
/// cpal marks `Stream` `!Send` on macOS because CoreAudio handles are nominally
/// thread-affine. We only ever build, replace, or drop the master stream from a
/// single place at a time (the N-API thread on create, or a tokio blocking
/// task on device change), serialised behind a mutex — never concurrently — so
/// moving the handle between those threads is sound.
// The field is never read — the stream is held solely to keep audio running and
// is torn down on drop (RAII), so suppress the dead-code lint.
pub struct StreamHandle(#[allow(dead_code)] pub Stream);
// SAFETY: see the type-level doc comment — access is serialised, never shared.
unsafe impl Send for StreamHandle {}

/// How many output frames between time-update events per deck.
/// At 44 100 Hz, 512 frames ≈ 11.6 ms → ~86 updates/sec.
const TIME_UPDATE_INTERVAL_FRAMES: u64 = 512;

/// Splice crossfade length for seeks / loop wraps / sync snaps, in output
/// frames (~3 ms at 48 kHz).
const XFADE_FRAMES: usize = 144;

/// One-pole time constant for the channel gain (fader) smoothing, seconds.
const AMP_TAU_SECS: f32 = 0.006;

/// One-pole time constant for EQ gain glides, seconds.
const EQ_TAU_SECS: f32 = 0.03;

/// At or below this dB an EQ band is treated as a kill (full cut).
const EQ_KILL_DB: f32 = -23.9;
const EQ_KILL_TARGET_DB: f32 = -40.0;

/// Sync PLL tuning — see module docs.
const SYNC_DEADBAND_SECS: f64 = 0.0005;
const SYNC_SNAP_SECS: f64 = 0.05;
const SYNC_MAX_CORR: f64 = 0.002;
const SYNC_TAU_SECS: f64 = 0.5;

/// Tiny DC bias injected ahead of the IIR filters so their state never decays
/// into denormals (CPU spikes) during silence. ~−360 dBFS — inaudible.
const ANTI_DENORMAL: f32 = 1e-18;

/// Largest block (frames) the master scratch buffers are sized for; larger
/// driver blocks are processed in chunks of this size.
const MAX_BLOCK: usize = 8192;

/// Master limiter: instant attack, ~80 ms release, just below full scale.
const LIMITER_CEILING: f32 = 0.98;
const LIMITER_RELEASE_SECS: f32 = 0.08;

/// 4-point, 3rd-order Hermite interpolation (Catmull-Rom): sample between
/// `x0` and `x1` at fraction `t`, using one neighbour on each side.
#[inline(always)]
fn hermite4(xm1: f32, x0: f32, x1: f32, x2: f32, t: f32) -> f32 {
    let c = (x1 - xm1) * 0.5;
    let v = x0 - x1;
    let w = c + v;
    let a = w + v + (x2 - x0) * 0.5;
    let b_neg = w + a;
    (((a * t) - b_neg) * t + c) * t + x0
}

// ── Master peak limiter ───────────────────────────────────────────────────────

struct Limiter {
    env: f32,
    release_coef: f32,
}

impl Limiter {
    fn new(sample_rate: f32) -> Self {
        Self {
            env: 0.0,
            release_coef: (-1.0 / (LIMITER_RELEASE_SECS * sample_rate)).exp(),
        }
    }

    /// Instant-attack peak limiter: keeps the summed decks below the ceiling
    /// without hard clipping; unity gain whenever the mix is under the ceiling.
    fn process(&mut self, buf: &mut [f32], chs: usize) {
        for frame in buf.chunks_mut(chs) {
            let mut peak = 0.0f32;
            for s in frame.iter() {
                peak = peak.max(s.abs());
            }
            self.env = peak.max(self.env * self.release_coef);
            if self.env > LIMITER_CEILING {
                let g = LIMITER_CEILING / self.env;
                for s in frame.iter_mut() {
                    *s *= g;
                }
            }
        }
    }
}

// ── Per-deck renderer ─────────────────────────────────────────────────────────

/// All per-deck DSP state that used to live in the deck's own stream callback.
/// `render` fills `out` (interleaved, `out_chs` channels) from the deck's
/// engine state — the master callback sums the results.
pub struct DeckRenderer {
    out_chs: usize,
    out_rate: f64,
    out_rate_f32: f32,
    amp_coef: f32,

    eq_states: Vec<[BiquadState; 3]>,
    eq_coeffs: [Biquad; 3],
    /// Smoothed EQ gains (dB, [low, mid, high]) gliding toward their targets.
    eq_current: [f32; 3],

    stretcher: SignalsmithStretcher,
    prev_use_stretch: bool,

    scrub_last: f64,
    prev_scrubbing: bool,

    /// Smoothed channel gain. Starts silent → first play fades in over ~6 ms.
    amp: f32,
    /// Source cursor at the end of the last audible block (splice fade origin).
    last_rendered: f64,
    xfade_from: f64,
    xfade_left: usize,

    prev_synced: bool,
    sync_had_ref: bool,

    frames_since_update: u64,
}

impl DeckRenderer {
    pub fn new(out_chs: usize, out_rate: f64) -> Self {
        Self {
            out_chs,
            out_rate,
            out_rate_f32: out_rate as f32,
            amp_coef: 1.0 - (-1.0 / (AMP_TAU_SECS * out_rate as f32)).exp(),
            eq_states: vec![[BiquadState::default(); 3]; out_chs],
            eq_coeffs: [Biquad::unity(); 3],
            eq_current: [0.0; 3],
            stretcher: SignalsmithStretcher::new(out_chs.min(2), out_rate),
            prev_use_stretch: false,
            scrub_last: 0.0,
            prev_scrubbing: false,
            amp: 0.0,
            last_rendered: 0.0,
            xfade_from: 0.0,
            xfade_left: 0,
            prev_synced: false,
            sync_had_ref: false,
            frames_since_update: 0,
        }
    }

    /// Render one block for this deck into `out` (fully overwritten).
    pub fn render(&mut self, engine: &DeckEngine, out: &mut [f32]) {
        let out_chs = self.out_chs;
        let frame_count = out.len() / out_chs;

        let playing   = engine.is_playing.load(Ordering::Relaxed);
        let scrubbing = engine.scrubbing.load(Ordering::Relaxed);
        if !playing && !scrubbing && self.amp < 1e-4 {
            self.amp = 0.0;
            for s in out.iter_mut() { *s = 0.0; }
            engine.level_f32.store(f32::to_bits(0.0), Ordering::Relaxed);
            self.prev_synced = false;
            self.sync_had_ref = false;
            self.prev_scrubbing = false;
            return;
        }

        // Load both possible sources — lock-free Arc clones. A loaded stem set
        // takes precedence over the single mix.
        let stems_arc = engine.stems.load();
        let pcm_arc   = engine.pcm.load();
        let stems = stems_arc.as_ref().as_ref();
        let pcm   = pcm_arc.as_ref().as_ref();

        let (src_rate, num_frames_u, src_chs) = if let Some(s) = stems {
            (s.sample_rate as f64, s.num_frames as usize, s.channels)
        } else if let Some(p) = pcm {
            (p.sample_rate as f64, p.num_frames as usize, p.channels)
        } else {
            self.amp = 0.0;
            for s in out.iter_mut() { *s = 0.0; }
            engine.level_f32.store(f32::to_bits(0.0), Ordering::Relaxed);
            return;
        };

        let volume   = engine.get_volume();
        let raw_rate = engine.get_rate();

        let looping           = engine.looping.load(Ordering::Relaxed);
        let loop_start_frames = engine.loop_start_frames.load(Ordering::Relaxed) as f64;
        let loop_end_frames   = engine.loop_end_frames.load(Ordering::Relaxed) as f64;

        let num_frames = num_frames_u as f64;
        let last_frame = num_frames_u.saturating_sub(1);
        // Keylock latency as of the previous block (seconds) — translates
        // audible-coordinate targets into cursor coordinates.
        let lat = engine.report_latency();

        // Adopt a pending seek (scrub-safe) over the committed cursor.
        // While audible, splice-crossfade from where we actually were.
        let mut cursor = match engine.take_seek_request() {
            Some(target) => {
                if playing && self.amp > 1e-3 && (target - self.last_rendered).abs() > XFADE_FRAMES as f64 {
                    self.xfade_from = self.last_rendered;
                    self.xfade_left = XFADE_FRAMES;
                }
                target
            }
            None => engine.get_cursor(),
        };

        // ── Sync (PLL) — see module docs ─────────────────────────────────────
        let mut eff_rate = raw_rate;
        if playing && engine.synced.load(Ordering::Acquire) {
            let master_guard = engine.sync_master.load();
            if let Some(master) = &*master_guard {
                let ratio = f32::from_bits(engine.sync_ratio.load(Ordering::Relaxed)) as f64;
                let base  = ratio * master.get_rate() as f64;
                if master.is_playing.load(Ordering::Relaxed) {
                    let cur_aud = cursor / src_rate - lat;
                    if self.prev_synced && !self.sync_had_ref {
                        // Master just resumed while we free-ran: re-anchor the
                        // phase so neither deck jumps ("lock from here" on
                        // resume — press SYNC again to re-beat-align).
                        let new_phase = cur_aud - master.position_secs() * ratio;
                        engine.sync_phase.store(f32::to_bits(new_phase as f32), Ordering::Relaxed);
                        eff_rate = base as f32;
                    } else {
                        let phase = f32::from_bits(engine.sync_phase.load(Ordering::Relaxed)) as f64;
                        let target = master.position_secs() * ratio + phase;
                        let err = target - cur_aud;
                        if !self.prev_synced || err.abs() > SYNC_SNAP_SECS {
                            if self.amp > 1e-3 && self.xfade_left == 0 {
                                self.xfade_from = self.last_rendered;
                                self.xfade_left = XFADE_FRAMES;
                            }
                            cursor = ((target + lat) * src_rate).clamp(0.0, num_frames);
                            eff_rate = base as f32;
                        } else if err.abs() > SYNC_DEADBAND_SECS {
                            let corr = (err / SYNC_TAU_SECS).clamp(-SYNC_MAX_CORR, SYNC_MAX_CORR);
                            eff_rate = (base * (1.0 + corr)) as f32;
                        } else {
                            eff_rate = base as f32;
                        }
                    }
                    self.sync_had_ref = true;
                    self.prev_synced = true;
                } else {
                    // Master paused → no phase reference. Free-run at the synced
                    // tempo; the lock re-anchors when the master resumes.
                    eff_rate = base as f32;
                    self.sync_had_ref = false;
                    self.prev_synced = true;
                }
            } else {
                self.prev_synced = false;
                self.sync_had_ref = false;
            }
        } else {
            self.prev_synced = false;
            self.sync_had_ref = false;
        }

        // Source frames advanced per output frame.
        let step: f64 = (src_rate / self.out_rate) * eff_rate as f64;

        // Per-stem linear gains (mute / solo / trim), once per block.
        let stem_gains = if stems.is_some() {
            engine.stem_linear_gains()
        } else {
            [0.0; STEM_COUNT]
        };

        // ── EQ: kill-mapped targets glide per block ──────────────────────────
        let eq_target = {
            let mut t = [
                f32::from_bits(engine.eq_low_db100.load(Ordering::Relaxed)),
                f32::from_bits(engine.eq_mid_db100.load(Ordering::Relaxed)),
                f32::from_bits(engine.eq_high_db100.load(Ordering::Relaxed)),
            ];
            for v in t.iter_mut() {
                if *v <= EQ_KILL_DB { *v = EQ_KILL_TARGET_DB; }
            }
            t
        };
        let k_eq = 1.0 - (-(frame_count as f32) / (EQ_TAU_SECS * self.out_rate_f32)).exp();
        let mut eq_dirty = false;
        for (i, &target) in eq_target.iter().enumerate() {
            let d = target - self.eq_current[i];
            if d.abs() > 0.01 {
                self.eq_current[i] += d * k_eq;
                eq_dirty = true;
            } else if d != 0.0 {
                self.eq_current[i] = target;
                eq_dirty = true;
            }
        }
        if eq_dirty {
            self.eq_coeffs = build_bands(
                self.out_rate_f32,
                self.eq_current[0],
                self.eq_current[1],
                self.eq_current[2],
            );
        }

        // ── Source reader: 4-point Hermite, stem-summed or single mix ───────
        let read_frame = |sp: f64, out_ch: usize| -> f32 {
            if sp < 0.0 { return 0.0; }
            let idx = sp as usize;
            if idx > last_frame { return 0.0; }
            let t   = (sp - idx as f64) as f32;
            let sc  = out_ch.min(src_chs - 1);
            let im1 = idx.saturating_sub(1);
            let i1  = (idx + 1).min(last_frame);
            let i2  = (idx + 2).min(last_frame);
            let v = if let Some(s) = stems {
                let mut acc = 0.0f32;
                for (buf, &g) in s.data.iter().zip(stem_gains.iter()) {
                    acc += hermite4(
                        buf[im1 * src_chs + sc],
                        buf[idx * src_chs + sc],
                        buf[i1  * src_chs + sc],
                        buf[i2  * src_chs + sc],
                        t,
                    ) * g;
                }
                acc
            } else {
                let p = pcm.unwrap();
                hermite4(
                    p.data[im1 * src_chs + sc],
                    p.data[idx * src_chs + sc],
                    p.data[i1  * src_chs + sc],
                    p.data[i2  * src_chs + sc],
                    t,
                )
            };
            v + ANTI_DENORMAL
        };

        let mut ended = false;

        if !playing && scrubbing {
            // ── Scrub (needle search while paused) ──────────────────────────
            engine.report_latency_secs.store(f32::to_bits(0.0), Ordering::Relaxed);
            self.xfade_left = 0;
            if !self.prev_scrubbing { self.scrub_last = cursor; }
            let start = self.scrub_last.clamp(0.0, num_frames);
            let end   = cursor.clamp(0.0, num_frames);
            let span  = end - start;
            if span.abs() < 0.5 {
                for s in out.iter_mut() { *s = 0.0; }
                self.amp *= (1.0 - self.amp_coef).powi(frame_count as i32);
            } else {
                let vel = span / frame_count as f64;
                for i in 0..frame_count {
                    let pos = (start + vel * i as f64).clamp(0.0, last_frame as f64);
                    self.amp += (volume - self.amp) * self.amp_coef;
                    for out_ch in 0..out_chs {
                        let mut sample = read_frame(pos, out_ch);
                        let state = &mut self.eq_states[out_ch];
                        sample = self.eq_coeffs[0].process(&mut state[0], sample);
                        sample = self.eq_coeffs[1].process(&mut state[1], sample);
                        sample = self.eq_coeffs[2].process(&mut state[2], sample);
                        out[i * out_chs + out_ch] = sample * self.amp;
                    }
                }
            }
            self.scrub_last = end;
            cursor = end;
        } else if !playing {
            // ── One-block fade-out tail after pause/stop ────────────────────
            // Keep rendering forward from a LOCAL cursor (never committed)
            // while ramping linearly to silence, so pausing can't truncate the
            // waveform mid-sample. Next block takes the idle fast path.
            let amp_start = self.amp;
            let mut c = cursor;
            for i in 0..frame_count {
                let a = amp_start * (1.0 - (i as f32 + 1.0) / frame_count as f32);
                for out_ch in 0..out_chs {
                    let mut sample = read_frame(c, out_ch);
                    let state = &mut self.eq_states[out_ch];
                    sample = self.eq_coeffs[0].process(&mut state[0], sample);
                    sample = self.eq_coeffs[1].process(&mut state[1], sample);
                    sample = self.eq_coeffs[2].process(&mut state[2], sample);
                    out[i * out_chs + out_ch] = sample * a;
                }
                c += step;
            }
            self.amp = 0.0;
            self.xfade_left = 0;
            self.prev_scrubbing = false;
            let rms = {
                let sum: f32 = out.iter().map(|&s| s * s).sum();
                (sum / out.len() as f32).sqrt()
            };
            engine.level_f32.store(f32::to_bits(rms), Ordering::Relaxed);
            return;
        } else {
            // Keylock: pitch-preserving tempo, engaged only when tempo ≠ 1×.
            let use_stretch = engine.keylock.load(Ordering::Relaxed)
                && (eff_rate as f64 - 1.0).abs() > 1e-3;
            let src_per_out = src_rate / self.out_rate;

            // Publish the stretcher's output latency so reported positions
            // reflect what is audible.
            let lat_secs = if use_stretch {
                self.stretcher.output_latency_frames().max(0) as f64 / self.out_rate
            } else {
                0.0
            };
            engine.report_latency_secs.store(f32::to_bits(lat_secs as f32), Ordering::Relaxed);

            if use_stretch {
                // The stretcher's primed resets already splice smoothly.
                self.xfade_left = 0;

                let read = |pos: f64, c: usize| read_frame(pos * src_per_out, c);

                // (Re)anchor on keylock engage, external seek, or loop wrap —
                // primed with the preceding audio (sms_seek), so output starts
                // fully formed instead of flamming in from a zeroed window.
                let anchor = cursor / src_per_out; // output-rate frames
                let mut anchored = false;
                if !self.prev_use_stretch || (anchor - self.stretcher.in_pos()).abs() > 2.0 {
                    self.stretcher.reset_primed(anchor, eff_rate as f64, &read);
                    anchored = true;
                }
                if !anchored
                    && looping
                    && self.stretcher.in_pos() * src_per_out >= loop_end_frames
                    && loop_end_frames > loop_start_frames
                {
                    self.stretcher.reset_primed(loop_start_frames / src_per_out, eff_rate as f64, &read);
                }

                self.stretcher.process(frame_count, eff_rate as f64, &read);
                for i in 0..frame_count {
                    self.amp += (volume - self.amp) * self.amp_coef;
                    for out_ch in 0..out_chs {
                        let mut sample = self.stretcher.out_sample(out_ch, i);
                        let state = &mut self.eq_states[out_ch];
                        sample = self.eq_coeffs[0].process(&mut state[0], sample);
                        sample = self.eq_coeffs[1].process(&mut state[1], sample);
                        sample = self.eq_coeffs[2].process(&mut state[2], sample);
                        out[i * out_chs + out_ch] = sample * self.amp;
                    }
                }

                cursor = self.stretcher.in_pos() * src_per_out;
                if cursor >= num_frames && !ended {
                    ended = true;
                    let _ = engine.event_tx.try_send(AudioEvent::Ended);
                }
            } else {
                // ── Straight playback (no keylock, or tempo == 1×) ──────────
                for i in 0..frame_count {
                    // Loop wrap — splice-crossfaded like a seek.
                    if looping && cursor >= loop_end_frames && loop_end_frames > loop_start_frames {
                        if self.xfade_left == 0 {
                            self.xfade_from = cursor;
                            self.xfade_left = XFADE_FRAMES;
                        }
                        cursor = loop_start_frames + (cursor - loop_end_frames);
                    }

                    // Track end
                    if cursor >= num_frames {
                        for j in 0..out_chs { out[i * out_chs + j] = 0.0; }
                        if !ended {
                            ended = true;
                            let _ = engine.event_tx.try_send(AudioEvent::Ended);
                        }
                        continue;
                    }

                    self.amp += (volume - self.amp) * self.amp_coef;
                    let xf = if self.xfade_left > 0 {
                        Some(1.0 - self.xfade_left as f32 / XFADE_FRAMES as f32)
                    } else {
                        None
                    };

                    for out_ch in 0..out_chs {
                        let mut sample = read_frame(cursor, out_ch);
                        if let Some(t) = xf {
                            let old = read_frame(self.xfade_from, out_ch);
                            sample = old + (sample - old) * t;
                        }
                        let state = &mut self.eq_states[out_ch];
                        sample = self.eq_coeffs[0].process(&mut state[0], sample);
                        sample = self.eq_coeffs[1].process(&mut state[1], sample);
                        sample = self.eq_coeffs[2].process(&mut state[2], sample);
                        out[i * out_chs + out_ch] = sample * self.amp;
                    }

                    if self.xfade_left > 0 {
                        self.xfade_left -= 1;
                        self.xfade_from += step;
                    }
                    cursor += step;
                }
            }
            self.prev_use_stretch = use_stretch;
        }
        self.prev_scrubbing = scrubbing;

        // Commit the cursor and mark ended.
        engine.set_cursor(cursor);
        self.last_rendered = cursor;
        if ended {
            engine.is_playing.store(false, Ordering::Release);
        }

        // ── Per-deck VU meter (post-fader, pre-master RMS) ───────────────────
        let rms = {
            let sum: f32 = out.iter().map(|&s| s * s).sum();
            (sum / out.len() as f32).sqrt()
        };
        engine.level_f32.store(f32::to_bits(rms), Ordering::Relaxed);

        // ── Time-update event (throttled, per deck) ──────────────────────────
        self.frames_since_update += frame_count as u64;
        if self.frames_since_update >= TIME_UPDATE_INTERVAL_FRAMES {
            self.frames_since_update = 0;
            let lat_now = engine.report_latency();
            let pos_secs = (cursor / src_rate - lat_now).max(0.0);
            let _ = engine.event_tx.try_send(AudioEvent::TimeUpdate(pos_secs));
        }
    }
}

// ── Master stream ─────────────────────────────────────────────────────────────

/// Build and start the master cpal output stream that renders every deck in
/// `active`, sums them, limits, and (while recording) taps the mix into the
/// recorder's ring. Also publishes the stream format to the recorder.
pub fn build_master_stream(
    active: Arc<ArcSwap<Vec<Arc<DeckEngine>>>>,
    recorder: Arc<Recorder>,
    device: &Device,
) -> Result<Stream, String> {
    let config = device
        .default_output_config()
        .map_err(|e| format!("Default output config error: {}", e))?;

    let sample_format = config.sample_format();
    let config: StreamConfig = config.into();

    match sample_format {
        SampleFormat::F32 | SampleFormat::I16 | SampleFormat::U16 => {
            build_master_f32(active, recorder, device, &config)
        }
        _ => Err(format!("Unsupported sample format: {:?}", sample_format)),
    }
}

fn build_master_f32(
    active: Arc<ArcSwap<Vec<Arc<DeckEngine>>>>,
    recorder: Arc<Recorder>,
    device: &Device,
    config: &StreamConfig,
) -> Result<Stream, String> {
    let out_rate = config.sample_rate.0 as f64;
    let out_chs  = config.channels as usize;

    recorder.sample_rate.store(config.sample_rate.0, Ordering::Relaxed);
    recorder.channels.store(config.channels as u32, Ordering::Relaxed);

    // Per-deck renderers, keyed by engine pointer. A new deck costs one Vec
    // push on first sight (decks register at app start, before playback).
    let mut renderers: Vec<(usize, DeckRenderer)> = Vec::with_capacity(4);
    let mut scratch: Vec<f32> = vec![0.0; MAX_BLOCK * out_chs];
    let mut limiter = Limiter::new(out_rate as f32);

    let stream = device
        .build_output_stream(
            config,
            move |output: &mut [f32], _info: &cpal::OutputCallbackInfo| {
                for s in output.iter_mut() { *s = 0.0; }
                let decks = active.load();

                // Process in chunks if the driver hands us a giant block.
                let mut offset = 0usize;
                while offset < output.len() {
                    let chunk_len = (output.len() - offset).min(MAX_BLOCK * out_chs);
                    let out_chunk = &mut output[offset..offset + chunk_len];

                    for engine in decks.iter() {
                        let key = Arc::as_ptr(engine) as usize;
                        let idx = match renderers.iter().position(|(k, _)| *k == key) {
                            Some(i) => i,
                            None => {
                                renderers.push((key, DeckRenderer::new(out_chs, out_rate)));
                                renderers.len() - 1
                            }
                        };
                        let deck_out = &mut scratch[..chunk_len];
                        renderers[idx].1.render(engine, deck_out);
                        for (o, s) in out_chunk.iter_mut().zip(deck_out.iter()) {
                            *o += *s;
                        }
                    }

                    limiter.process(out_chunk, out_chs);

                    if recorder.active.load(Ordering::Relaxed) {
                        recorder.ring.push_slice(out_chunk);
                    }

                    offset += chunk_len;
                }
            },
            move |err| {
                eprintln!("[audio] master stream error: {err}");
            },
            None, // timeout
        )
        .map_err(|e| format!("build_output_stream failed: {e}"))?;

    stream.play().map_err(|e| format!("stream.play() failed: {e}"))?;
    Ok(stream)
}

// ── Device enumeration ────────────────────────────────────────────────────────

/// List available output device names via the default cpal host.
pub fn list_output_devices() -> Vec<String> {
    let host = cpal::default_host();
    host.output_devices()
        .map(|devices| {
            devices
                .filter_map(|d| d.name().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Find a device by (partial) name, or return the default.
pub fn find_output_device(name: &str) -> Result<Device, String> {
    let host = cpal::default_host();
    if name.is_empty() {
        return host.default_output_device()
            .ok_or_else(|| "No default output device".to_string());
    }
    host.output_devices()
        .map_err(|e| e.to_string())?
        .find(|d| d.name().map(|n| n.contains(name)).unwrap_or(false))
        .ok_or_else(|| format!("Output device containing '{}' not found", name))
}

#[cfg(test)]
mod tests {
    use super::{hermite4, Limiter, LIMITER_CEILING};

    #[test]
    fn hermite_hits_endpoints() {
        assert_eq!(hermite4(0.0, 1.0, 2.0, 3.0, 0.0), 1.0);
        assert_eq!(hermite4(0.0, 1.0, 2.0, 3.0, 1.0), 2.0);
    }

    #[test]
    fn hermite_reproduces_straight_lines_exactly() {
        for &t in &[0.0f32, 0.25, 0.5, 0.75, 1.0] {
            let y = hermite4(1.0, 2.0, 3.0, 4.0, t);
            assert!((y - (2.0 + t)).abs() < 1e-6, "t={t}: {y}");
        }
    }

    #[test]
    fn hermite_stays_smooth_on_curves() {
        for &t in &[0.25f32, 0.5, 0.75] {
            let y = hermite4(1.0, 0.0, 1.0, 4.0, t);
            assert!((y - t * t).abs() < 0.26, "t={t}: {y} vs {}", t * t);
        }
    }

    #[test]
    fn limiter_caps_hot_signal_and_passes_quiet_signal() {
        let mut l = Limiter::new(48_000.0);
        // Two full-scale decks summed → 1.6 peaks must come out ≤ ceiling.
        let mut hot: Vec<f32> = (0..960).map(|i| if i % 2 == 0 { 1.6 } else { -1.6 }).collect();
        l.process(&mut hot, 2);
        assert!(hot.iter().all(|s| s.abs() <= LIMITER_CEILING + 1e-4));

        // A quiet signal after release passes (nearly) untouched.
        let mut l2 = Limiter::new(48_000.0);
        let mut quiet: Vec<f32> = (0..960).map(|_| 0.25f32).collect();
        l2.process(&mut quiet, 2);
        assert!(quiet.iter().all(|&s| (s - 0.25).abs() < 1e-4));
    }
}
