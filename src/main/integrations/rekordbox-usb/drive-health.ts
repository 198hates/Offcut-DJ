// USB pre-flight: measure a stick's real speed, capacity and filesystem before
// an export, so the UI can estimate how long the copy will take and warn about
// drives that will fail on a CDJ (too slow / wrong filesystem / not enough room).
//
// The speed test writes an incompressible temp file to the stick, fsyncs it to
// force it past the OS cache to the actual flash, then reads it back. Sequential
// write throughput is what governs export time, so that's what drives the ETA
// and the speed class. All work is async so the main event loop stays responsive.

import { statfsSync, readFileSync } from 'fs'
import { open, rm } from 'fs/promises'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { performance } from 'perf_hooks'
import type { UsbPreflight } from '../../../shared/types'

export interface DriveBenchmark {
  writeMBps: number
  readMBps: number
}

/** Default speed-test payload. Big enough to swamp small caches, small enough to stay quick. */
const TEST_BYTES = 32 * 1024 * 1024

/**
 * Write an incompressible blob to the stick and read it back, returning real
 * MB/s for each direction. fsync forces the write to the device before we stop
 * the clock, so the number reflects the flash, not the OS write cache.
 */
export async function benchmarkDrive(usbRoot: string, testBytes = TEST_BYTES): Promise<DriveBenchmark> {
  const tmp = join(usbRoot, `.offcut-speedtest-${process.pid}-${Date.now()}.tmp`)
  const buf = randomBytes(testBytes) // random → incompressible, defeats transparent compression
  const mb = testBytes / 1e6
  try {
    const t0 = performance.now()
    const fh = await open(tmp, 'w')
    try {
      await fh.write(buf, 0, buf.length, 0)
      await fh.sync()
    } finally {
      await fh.close()
    }
    const writeSecs = (performance.now() - t0) / 1000

    const t1 = performance.now()
    const fhr = await open(tmp, 'r')
    try {
      const rbuf = Buffer.allocUnsafe(testBytes)
      await fhr.read(rbuf, 0, testBytes, 0)
    } finally {
      await fhr.close()
    }
    const readSecs = (performance.now() - t1) / 1000

    return {
      writeMBps: writeSecs > 0 ? mb / writeSecs : 0,
      readMBps: readSecs > 0 ? mb / readSecs : 0
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

/** Bucket a sequential write speed into a class the UI can colour. */
export function classifySpeed(writeMBps: number): 'fast' | 'adequate' | 'slow' {
  if (writeMBps >= 40) return 'fast'
  if (writeMBps >= 10) return 'adequate'
  return 'slow'
}

/** Total/free bytes of the volume, via statfs. Null if it can't be read. */
export function volumeStats(usbRoot: string): { capacityBytes: number; freeBytes: number } | null {
  try {
    const s = statfsSync(usbRoot)
    return { capacityBytes: s.bsize * s.blocks, freeBytes: s.bsize * s.bavail }
  } catch {
    return null
  }
}

/** Best-effort, cross-platform filesystem label (lowercased), e.g. 'msdos', 'exfat', 'hfs', 'ntfs'. */
export function detectFilesystem(usbRoot: string): string | null {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('diskutil', ['info', usbRoot], { encoding: 'utf8', timeout: 4000 })
      const m = out.match(/Type \(Bundle\):\s*(.+)/) ?? out.match(/File System Personality:\s*(.+)/)
      return m ? m[1].trim().toLowerCase() : null
    }
    if (process.platform === 'win32') {
      const drive = usbRoot.replace(/\\+$/, '') // 'D:'
      const out = execFileSync('wmic', ['logicaldisk', 'where', `DeviceID='${drive}'`, 'get', 'FileSystem'], {
        encoding: 'utf8',
        timeout: 4000
      })
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      // lines[0] is the 'FileSystem' header; the value follows.
      return lines[1] ? lines[1].toLowerCase() : null
    }
    // Linux: match the longest mountpoint prefix in /proc/mounts.
    const mounts = readFileSync('/proc/mounts', 'utf8').split('\n')
    let best: { mp: string; fs: string } | null = null
    for (const line of mounts) {
      const parts = line.split(/\s+/)
      if (parts.length < 3) continue
      const mp = parts[1].replace(/\\040/g, ' ')
      const prefix = mp.endsWith('/') ? mp : `${mp}/`
      if (usbRoot === mp || usbRoot.startsWith(prefix)) {
        if (!best || mp.length > best.mp.length) best = { mp, fs: parts[2] }
      }
    }
    return best ? best.fs.toLowerCase() : null
  } catch {
    return null
  }
}

// CDJs read FAT32, exFAT and HFS+; they cannot read NTFS or APFS.
const CDJ_OK = ['exfat', 'msdos', 'fat32', 'vfat', 'fat', 'hfsplus', 'hfs+', 'hfs', 'apple_hfs']
const CDJ_BAD = ['ntfs', 'apfs']

/** Can a CDJ read this filesystem? null = unknown. */
export function fsCompatible(fs: string | null): boolean | null {
  if (!fs) return null
  const f = fs.toLowerCase()
  if (CDJ_BAD.some((x) => f.includes(x))) return false
  if (CDJ_OK.some((x) => f.includes(x))) return true
  return null
}

/**
 * Assemble a full pre-flight report. Capacity + filesystem are instant; the
 * speed benchmark only runs when `benchmark` is set (it writes to the stick).
 */
export async function usbPreflight(usbRoot: string, opts: { benchmark: boolean }): Promise<UsbPreflight> {
  const stats = volumeStats(usbRoot)
  const fs = detectFilesystem(usbRoot)
  let bench: DriveBenchmark | null = null
  if (opts.benchmark) {
    try {
      bench = await benchmarkDrive(usbRoot)
    } catch {
      bench = null
    }
  }
  return {
    root: usbRoot,
    capacityBytes: stats?.capacityBytes ?? null,
    freeBytes: stats?.freeBytes ?? null,
    filesystem: fs,
    fsCompatible: fsCompatible(fs),
    writeMBps: bench?.writeMBps ?? null,
    readMBps: bench?.readMBps ?? null,
    speedClass: bench ? classifySpeed(bench.writeMBps) : null
  }
}
