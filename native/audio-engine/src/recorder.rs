//! Master-bus recorder — taps the mixed output into a WAV file.
//!
//! The audio callback pushes post-mix samples into a lock-free ring
//! (`SpscRing`, never blocks); a writer thread drains the ring and streams
//! 16-bit PCM to disk, finalising the RIFF header sizes on stop.

use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use parking_lot::Mutex;

use crate::ring::SpscRing;

/// ~3 s of stereo at 48 kHz — generous slack for a slow disk.
const RING_CAPACITY: usize = 1 << 19;

pub struct Recorder {
    pub ring: SpscRing,
    /// True while the audio callback should push samples.
    pub active: AtomicBool,
    /// Stream format, set when the master stream is (re)built.
    pub sample_rate: AtomicU32,
    pub channels: AtomicU32,
    writer: Mutex<Option<(JoinHandle<std::io::Result<u64>>, PathBuf)>>,
}

impl Recorder {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            ring: SpscRing::new(RING_CAPACITY),
            active: AtomicBool::new(false),
            sample_rate: AtomicU32::new(0),
            channels: AtomicU32::new(0),
            writer: Mutex::new(None),
        })
    }

    pub fn is_recording(&self) -> bool {
        self.active.load(Ordering::Relaxed)
    }

    /// Begin recording to `path`. Errors if already recording or no stream
    /// format is known yet (master stream not built).
    pub fn start(self: &Arc<Self>, path: PathBuf) -> Result<(), String> {
        let mut writer = self.writer.lock();
        if writer.is_some() {
            return Err("Already recording".into());
        }
        let sample_rate = self.sample_rate.load(Ordering::Relaxed);
        let channels = self.channels.load(Ordering::Relaxed);
        if sample_rate == 0 || channels == 0 {
            return Err("Audio stream not running".into());
        }

        let mut file = File::create(&path).map_err(|e| format!("create {:?}: {e}", path))?;
        write_wav_header(&mut file, sample_rate, channels as u16, 0)
            .map_err(|e| format!("write header: {e}"))?;

        // Drain anything stale left from a previous run before going live.
        let mut scratch = vec![0.0f32; 4096];
        while self.ring.pop_slice(&mut scratch) > 0 {}

        self.active.store(true, Ordering::Release);

        let me = self.clone();
        let handle = std::thread::Builder::new()
            .name("offcut-recorder".into())
            .spawn(move || -> std::io::Result<u64> {
                let mut float_buf = vec![0.0f32; 8192];
                let mut pcm_buf: Vec<u8> = Vec::with_capacity(8192 * 2);
                let mut data_bytes: u64 = 0;
                loop {
                    let n = me.ring.pop_slice(&mut float_buf);
                    if n == 0 {
                        if !me.active.load(Ordering::Acquire) {
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(5));
                        continue;
                    }
                    pcm_buf.clear();
                    for &s in &float_buf[..n] {
                        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                        pcm_buf.extend_from_slice(&v.to_le_bytes());
                    }
                    file.write_all(&pcm_buf)?;
                    data_bytes += pcm_buf.len() as u64;
                }
                // Finalise the RIFF/data chunk sizes.
                let data = data_bytes.min(u32::MAX as u64) as u32;
                file.seek(SeekFrom::Start(4))?;
                file.write_all(&(36 + data).to_le_bytes())?;
                file.seek(SeekFrom::Start(40))?;
                file.write_all(&data.to_le_bytes())?;
                file.flush()?;
                Ok(data_bytes)
            })
            .map_err(|e| format!("spawn writer: {e}"))?;

        *writer = Some((handle, path));
        Ok(())
    }

    /// Stop recording; waits for the writer to drain and finalise the file.
    /// Returns (path, recorded seconds).
    pub fn stop(&self) -> Result<(String, f64), String> {
        let taken = self.writer.lock().take();
        let (handle, path) = taken.ok_or("Not recording")?;
        self.active.store(false, Ordering::Release);
        let data_bytes = handle
            .join()
            .map_err(|_| "writer thread panicked".to_string())?
            .map_err(|e| format!("write failed: {e}"))?;
        let sr = self.sample_rate.load(Ordering::Relaxed).max(1) as f64;
        let ch = self.channels.load(Ordering::Relaxed).max(1) as f64;
        let secs = data_bytes as f64 / 2.0 / ch / sr;
        Ok((path.to_string_lossy().into_owned(), secs))
    }
}

fn write_wav_header(f: &mut File, sample_rate: u32, channels: u16, data_len: u32) -> std::io::Result<()> {
    let byte_rate = sample_rate * channels as u32 * 2;
    let block_align = channels * 2;
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + data_len).to_le_bytes())?;
    f.write_all(b"WAVE")?;
    f.write_all(b"fmt ")?;
    f.write_all(&16u32.to_le_bytes())?;
    f.write_all(&1u16.to_le_bytes())?; // PCM
    f.write_all(&channels.to_le_bytes())?;
    f.write_all(&sample_rate.to_le_bytes())?;
    f.write_all(&byte_rate.to_le_bytes())?;
    f.write_all(&block_align.to_le_bytes())?;
    f.write_all(&16u16.to_le_bytes())?; // bits per sample
    f.write_all(b"data")?;
    f.write_all(&data_len.to_le_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_pushed_samples_to_a_valid_wav() {
        let rec = Recorder::new();
        rec.sample_rate.store(48_000, Ordering::Relaxed);
        rec.channels.store(2, Ordering::Relaxed);

        let dir = std::env::temp_dir().join("offcut-rec-test.wav");
        rec.start(dir.clone()).unwrap();

        // Simulate the audio callback: 0.5 s of full-scale square-ish signal.
        let chunk: Vec<f32> = (0..9600).map(|i| if i % 2 == 0 { 0.5 } else { -0.5 }).collect();
        for _ in 0..5 {
            rec.ring.push_slice(&chunk);
            std::thread::sleep(std::time::Duration::from_millis(15));
        }

        let (path, secs) = rec.stop().unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        let data_len = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
        assert_eq!(data_len, bytes.len() - 44, "data chunk size matches file");
        assert_eq!(data_len, 9600 * 5 * 2, "every pushed sample written");
        assert!((secs - 0.5).abs() < 0.01, "duration ≈ 0.5 s, got {secs}");
        // Samples round-trip (0.5 → 16383).
        let s0 = i16::from_le_bytes(bytes[44..46].try_into().unwrap());
        assert_eq!(s0, 16383);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn start_twice_errors_and_stop_without_start_errors() {
        let rec = Recorder::new();
        rec.sample_rate.store(44_100, Ordering::Relaxed);
        rec.channels.store(2, Ordering::Relaxed);
        assert!(rec.stop().is_err());
        let p = std::env::temp_dir().join("offcut-rec-test2.wav");
        rec.start(p.clone()).unwrap();
        assert!(rec.start(p.clone()).is_err());
        rec.stop().unwrap();
        std::fs::remove_file(p).ok();
    }
}
