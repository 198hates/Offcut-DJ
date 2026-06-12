//! Audio file decoder — uses Symphonia for pure-Rust, format-agnostic decoding.
//!
//! Supported formats (via the `all` Symphonia feature):
//!   MP3, AAC/M4A, FLAC, WAV, OGG/Vorbis, OGG/Opus, AIFF, WavPack, CAF
//!
//! The decoder normalises all output to interleaved f32 stereo (or mono if the
//! source is mono).  Sample rate is preserved — resampling to the output device
//! rate happens in the audio callback.

use std::path::Path;
use symphonia::core::audio::{AudioBuffer, Signal};
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::deck::PcmBuffer;

/// Decode an audio file at `path` into a `PcmBuffer`.
/// Runs on a thread pool (called from an async napi Task).
pub fn decode_file(path: &Path) -> Result<PcmBuffer, String> {
    // Open the file
    let file = std::fs::File::open(path)
        .map_err(|e| format!("Cannot open {:?}: {}", path, e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    // Probe the format
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    // enable_gapless trims MP3/AAC encoder delay + padding. Without it every
    // decoded position carries a ~26 ms lead-in, systematically misaligning
    // beatgrids/cues against what Rekordbox/Serato show for the same file.
    let fmt_opts = FormatOptions { enable_gapless: true, ..Default::default() };
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &fmt_opts, &MetadataOptions::default())
        .map_err(|e| format!("Probe failed for {:?}: {}", path, e))?;

    let mut format = probed.format;

    // Pick the default audio track
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or_else(|| format!("No decodable audio track in {:?}", path))?;

    let track_id   = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    // Channel count is taken from the first decoded buffer's spec below, not the
    // (sometimes-absent) codec params, so this header hint is unused.
    let _channels  = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);

    // Create the decoder
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Codec init failed: {}", e))?;

    // Decode all packets into a flat f32 buffer
    let mut pcm_data: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p)  => p,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(symphonia::core::errors::Error::ResetRequired) => continue,
            Err(e) => return Err(format!("Packet error: {}", e)),
        };

        if packet.track_id() != track_id { continue; }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                // Convert to F32 planar, then interleave
                let mut f32_buf: AudioBuffer<f32> =
                    AudioBuffer::new(decoded.capacity() as u64, *decoded.spec());
                decoded.convert(&mut f32_buf);

                let ch_count = f32_buf.spec().channels.count();
                let frames   = f32_buf.frames();

                // Clamp to stereo (extra channels dropped, mono duplicated below)
                let read_ch = ch_count.min(2);

                for frame in 0..frames {
                    if read_ch == 1 {
                        // Mono → duplicate to stereo
                        let s = f32_buf.chan(0)[frame];
                        pcm_data.push(s);
                        pcm_data.push(s);
                    } else {
                        // Stereo (or first two channels of surround)
                        pcm_data.push(f32_buf.chan(0)[frame]);
                        pcm_data.push(f32_buf.chan(1)[frame]);
                    }
                }
            }
            Err(symphonia::core::errors::Error::DecodeError(e)) => {
                // Non-fatal decode errors (e.g. corrupt frame) — skip and continue.
                eprintln!("[decoder] decode error (skipping frame): {}", e);
                continue;
            }
            Err(e) => return Err(format!("Decode error: {}", e)),
        }
    }

    if pcm_data.is_empty() {
        return Err(format!("No audio decoded from {:?}", path));
    }

    let out_channels = 2usize; // always stereo output
    let num_frames   = (pcm_data.len() / out_channels) as u64;

    Ok(PcmBuffer {
        data:        pcm_data,
        sample_rate,
        channels:    out_channels,
        num_frames,
    })
}

// ── f32 conversion shim ───────────────────────────────────────────────────────

// Symphonia's AudioBuffer<f32>::convert() requires that T implements IntoSample<f32>.
// The impl for f32 → f32 is identity, which is what we want.
// The trait is already in scope via the use statement above.

// ── Peak computation ──────────────────────────────────────────────────────────

/// Pre-compute peak (max absolute) amplitude per bucket.
/// Used to build the waveform display arrays returned from `engine:load`.
pub fn compute_peaks(pcm: &PcmBuffer, buckets: usize) -> Vec<f32> {
    let mut peaks = vec![0.0f32; buckets];
    let total_frames = pcm.num_frames as usize;
    if total_frames == 0 { return peaks; }

    let spb = total_frames as f64 / buckets as f64;  // source frames per bucket

    for (i, peak) in peaks.iter_mut().enumerate() {
        let start = (i as f64 * spb) as usize;
        let end   = ((i + 1) as f64 * spb) as usize;
        let end   = end.min(total_frames);

        let mut max = 0.0f32;
        for frame in start..end {
            // Mix to mono for peak: average L+R
            let l = pcm.data[frame * pcm.channels];
            let r = if pcm.channels > 1 { pcm.data[frame * pcm.channels + 1] } else { l };
            let amp = ((l.abs() + r.abs()) * 0.5).max(l.abs()).max(r.abs());
            if amp > max { max = amp; }
        }
        *peak = max;
    }

    peaks
}

/// Pre-compute bass / mid / high band peak arrays using IIR envelope followers.
/// Same algorithm as the Web Audio engine's `computeBandPeaks()` — O(N) pass.
pub struct BandPeaks {
    pub low:  Vec<f32>,   // bass (< ~300 Hz)
    pub mid:  Vec<f32>,   // mids (~300 Hz – ~3 kHz)
    pub high: Vec<f32>,   // highs (> ~3 kHz)
}

pub fn compute_band_peaks(pcm: &PcmBuffer, buckets: usize) -> BandPeaks {
    let sr = pcm.sample_rate as f64;
    let a_low  = 1.0 - (-2.0 * std::f64::consts::PI * 300.0  / sr).exp();
    let a_high = 1.0 - (-2.0 * std::f64::consts::PI * 3000.0 / sr).exp();
    let b_low  = 1.0 - a_low;
    let b_high = 1.0 - a_high;

    let total_frames = pcm.num_frames as usize;
    let mut low_buf  = vec![0.0f32; buckets];
    let mut mid_buf  = vec![0.0f32; buckets];
    let mut high_buf = vec![0.0f32; buckets];

    if total_frames == 0 {
        return BandPeaks { low: low_buf, mid: mid_buf, high: high_buf };
    }

    let spb = total_frames as f64 / buckets as f64;
    let mut y_low  = 0.0f64;
    let mut y_high = 0.0f64;

    for frame in 0..total_frames {
        // Mono mix
        let l = pcm.data[frame * pcm.channels] as f64;
        let r = if pcm.channels > 1 { pcm.data[frame * pcm.channels + 1] as f64 } else { l };
        let x = ((l + r) * 0.5).abs();

        y_low  = a_low  * x + b_low  * y_low;
        y_high = a_high * x + b_high * y_high;

        let b     = ((frame as f64 / spb) as usize).min(buckets - 1);
        let bass  = y_low  as f32;
        let mids  = (y_high - y_low).max(0.0) as f32;
        let highs = (x - y_high).max(0.0) as f32;

        if bass  > low_buf[b]  { low_buf[b]  = bass;  }
        if mids  > mid_buf[b]  { mid_buf[b]  = mids;  }
        if highs > high_buf[b] { high_buf[b] = highs; }
    }

    // Normalise each band 0–1
    fn normalise(v: &mut [f32]) {
        let max = v.iter().cloned().fold(0.0f32, f32::max);
        if max > 0.0 { for s in v.iter_mut() { *s /= max; } }
    }
    normalise(&mut low_buf);
    normalise(&mut mid_buf);
    normalise(&mut high_buf);

    BandPeaks { low: low_buf, mid: mid_buf, high: high_buf }
}
