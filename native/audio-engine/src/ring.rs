//! Minimal lock-free single-producer / single-consumer float ring buffer.
//!
//! Producer = the real-time audio callback (`push_slice` never blocks or
//! allocates; excess samples are dropped). Consumer = the recording writer
//! thread. Capacity is rounded up to a power of two so index wrapping is a
//! mask.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::cell::UnsafeCell;

pub struct SpscRing {
    buf:  Box<[UnsafeCell<f32>]>,
    mask: usize,
    /// Next write index (monotonic, wrapped via `mask`). Producer-owned.
    head: AtomicUsize,
    /// Next read index. Consumer-owned.
    tail: AtomicUsize,
}

// SAFETY: head is only advanced by the single producer, tail only by the
// single consumer; each side reads the other's index with Acquire and writes
// its own with Release, so a slot is never read and written concurrently.
unsafe impl Sync for SpscRing {}
unsafe impl Send for SpscRing {}

impl SpscRing {
    pub fn new(min_capacity: usize) -> Self {
        let cap = min_capacity.next_power_of_two();
        let buf: Vec<UnsafeCell<f32>> = (0..cap).map(|_| UnsafeCell::new(0.0)).collect();
        Self {
            buf: buf.into_boxed_slice(),
            mask: cap - 1,
            head: AtomicUsize::new(0),
            tail: AtomicUsize::new(0),
        }
    }

    /// Push samples from the audio callback. Never blocks; returns how many
    /// were written (the rest are dropped if the consumer fell behind).
    pub fn push_slice(&self, data: &[f32]) -> usize {
        let head = self.head.load(Ordering::Relaxed);
        let tail = self.tail.load(Ordering::Acquire);
        let free = self.buf.len() - (head - tail);
        let n = data.len().min(free);
        for (i, &s) in data[..n].iter().enumerate() {
            // SAFETY: slots in [head, head+free) are exclusively the producer's.
            unsafe { *self.buf[(head + i) & self.mask].get() = s; }
        }
        self.head.store(head + n, Ordering::Release);
        n
    }

    /// Pop up to `out.len()` samples; returns how many were read.
    pub fn pop_slice(&self, out: &mut [f32]) -> usize {
        let tail = self.tail.load(Ordering::Relaxed);
        let head = self.head.load(Ordering::Acquire);
        let avail = head - tail;
        let n = out.len().min(avail);
        for (i, slot) in out[..n].iter_mut().enumerate() {
            // SAFETY: slots in [tail, head) are exclusively the consumer's.
            *slot = unsafe { *self.buf[(tail + i) & self.mask].get() };
        }
        self.tail.store(tail + n, Ordering::Release);
        n
    }

    /// Samples currently buffered (diagnostics/tests).
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.head.load(Ordering::Acquire) - self.tail.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn roundtrips_in_order() {
        let r = SpscRing::new(8);
        assert_eq!(r.push_slice(&[1.0, 2.0, 3.0]), 3);
        let mut out = [0.0f32; 2];
        assert_eq!(r.pop_slice(&mut out), 2);
        assert_eq!(out, [1.0, 2.0]);
        assert_eq!(r.push_slice(&[4.0, 5.0]), 2);
        let mut rest = [0.0f32; 8];
        assert_eq!(r.pop_slice(&mut rest), 3);
        assert_eq!(&rest[..3], &[3.0, 4.0, 5.0]);
    }

    #[test]
    fn drops_when_full_never_blocks() {
        let r = SpscRing::new(4); // capacity 4
        assert_eq!(r.push_slice(&[1.0; 10]), 4);
        assert_eq!(r.len(), 4);
        assert_eq!(r.push_slice(&[2.0]), 0);
    }

    #[test]
    fn concurrent_producer_consumer_preserves_sequence() {
        let r = Arc::new(SpscRing::new(1024));
        let total = 100_000usize;
        let producer = {
            let r = r.clone();
            std::thread::spawn(move || {
                let mut i = 0usize;
                while i < total {
                    let chunk: Vec<f32> = (i..(i + 64).min(total)).map(|v| v as f32).collect();
                    let n = r.push_slice(&chunk);
                    i += n;
                    if n == 0 { std::thread::yield_now(); }
                }
            })
        };
        let mut expected = 0usize;
        let mut buf = [0.0f32; 128];
        while expected < total {
            let n = r.pop_slice(&mut buf);
            for &s in &buf[..n] {
                assert_eq!(s, expected as f32);
                expected += 1;
            }
            if n == 0 { std::thread::yield_now(); }
        }
        producer.join().unwrap();
    }
}
