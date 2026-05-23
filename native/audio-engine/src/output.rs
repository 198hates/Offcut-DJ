//! cpal audio output stream — real-time callback that reads from `DeckEngine`.
//!
//! The callback is called by the OS audio driver at hardware sample rate.
//! Every branch inside must be wait-free: no mutex, no allocation, no syscall.
//!
//! Rate changes:
//!   The cursor advances at `rate` source frames per output frame, with linear
//!   interpolation between source frames. This changes pitch when keylock is off.
//!   Keylock (pitch-preserving) is stubbed — the flag is stored and will be
//!   wired to rubberband-rs in Phase 2.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, Host, SampleFormat, Stream, StreamConfig,
};

use crate::deck::{AudioEvent, DeckEngine};

/// How many output frames between time-update events.
/// At 44 100 Hz, 512 frames ≈ 11.6 ms → ~86 updates/sec.
const TIME_UPDATE_INTERVAL_FRAMES: u64 = 512;

/// Build and start a cpal output stream for one deck.
/// Returns the `Stream` handle (must be kept alive to keep audio running).
pub fn build_stream(engine: Arc<DeckEngine>, device: &Device) -> Result<Stream, String> {
    let config = device
        .default_output_config()
        .map_err(|e| format!("Default output config error: {}", e))?;

    let sample_format = config.sample_format();
    let config: StreamConfig = config.into();

    match sample_format {
        SampleFormat::F32 => build_f32_stream(engine, device, &config),
        SampleFormat::I16 => build_f32_stream(engine, device, &config), // cpal converts
        SampleFormat::U16 => build_f32_stream(engine, device, &config),
        _ => Err(format!("Unsupported sample format: {:?}", sample_format)),
    }
}

fn build_f32_stream(
    engine: Arc<DeckEngine>,
    device: &Device,
    config: &StreamConfig,
) -> Result<Stream, String> {
    let out_rate   = config.sample_rate.0 as f64;
    let out_chs    = config.channels as usize;
    let engine_cb  = engine.clone();
    let engine_err = engine.clone();
    let mut frames_since_update: u64 = 0;

    let stream = device
        .build_output_stream(
            config,
            // ── Audio callback (must be real-time safe) ───────────────────
            move |output: &mut [f32], _info: &cpal::OutputCallbackInfo| {
                let frame_count = output.len() / out_chs;

                // Atomic reads — no locks
                if !engine_cb.is_playing.load(Ordering::Relaxed) {
                    for s in output.iter_mut() { *s = 0.0; }
                    return;
                }

                // Load the PCM buffer reference — lock-free Arc clone
                let pcm_arc = engine_cb.pcm.load();
                let pcm = match pcm_arc.as_ref() {
                    Some(p) => p,
                    None    => {
                        for s in output.iter_mut() { *s = 0.0; }
                        return;
                    }
                };

                let volume      = engine_cb.get_volume();
                let rate        = engine_cb.get_rate();
                let src_rate    = pcm.sample_rate as f64;
                // Rate at which we advance the source cursor per output frame.
                // out_rate / src_rate handles sample-rate mismatch; * rate adds tempo shift.
                let step: f64   = (src_rate / out_rate) * rate as f64;

                let looping           = engine_cb.looping.load(Ordering::Relaxed);
                let loop_start_frames = engine_cb.loop_start_frames.load(Ordering::Relaxed) as f64;
                let loop_end_frames   = engine_cb.loop_end_frames.load(Ordering::Relaxed) as f64;

                let num_frames = pcm.num_frames as f64;
                let src_chs    = pcm.channels;
                let mut cursor = engine_cb.get_cursor();
                let mut ended  = false;

                // Stem mix gain (approximation pre-demucs)
                let stem_gain = engine_cb.effective_mix_gain();
                let master_gain = volume * stem_gain;

                // ── Per-frame rendering loop ─────────────────────────────────
                for i in 0..frame_count {
                    // Loop point handling
                    if looping && cursor >= loop_end_frames && loop_end_frames > loop_start_frames {
                        cursor = loop_start_frames + (cursor - loop_end_frames);
                    }

                    // Track end
                    if cursor >= num_frames {
                        for j in 0..out_chs {
                            output[i * out_chs + j] = 0.0;
                        }
                        if !ended {
                            ended = true;
                            // Signal ended event (try_send: non-blocking, bounded channel)
                            let _ = engine_cb.event_tx.try_send(AudioEvent::Ended);
                        }
                        continue;
                    }

                    // Linear interpolation between adjacent source frames
                    let frame_idx = cursor as usize;
                    let frac      = (cursor - frame_idx as f64) as f32;
                    let frame_next = (frame_idx + 1).min(pcm.num_frames as usize - 1);

                    for out_ch in 0..out_chs {
                        let src_ch = out_ch.min(src_chs - 1);
                        let s0 = pcm.data[frame_idx  * src_chs + src_ch];
                        let s1 = pcm.data[frame_next * src_chs + src_ch];
                        output[i * out_chs + out_ch] = (s0 + frac * (s1 - s0)) * master_gain;
                    }

                    cursor += step;
                }

                // Commit the cursor and mark ended
                engine_cb.set_cursor(cursor);
                if ended {
                    engine_cb.is_playing.store(false, Ordering::Release);
                }

                // ── VU meter (RMS of this buffer) ────────────────────────────
                let rms = {
                    let sum: f32 = output.iter().map(|&s| s * s).sum();
                    (sum / output.len() as f32).sqrt()
                };
                engine_cb.level_f32.store(f32::to_bits(rms), Ordering::Relaxed);

                // ── Time-update event (throttled) ────────────────────────────
                frames_since_update += frame_count as u64;
                if frames_since_update >= TIME_UPDATE_INTERVAL_FRAMES {
                    frames_since_update = 0;
                    let pos_secs = cursor / src_rate;
                    let _ = engine_cb.event_tx.try_send(AudioEvent::TimeUpdate(pos_secs));
                }
            },
            // ── Error callback ────────────────────────────────────────────────
            move |err| {
                eprintln!("[audio] stream error (deck): {err}");
                engine_err.is_playing.store(false, Ordering::Relaxed);
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
