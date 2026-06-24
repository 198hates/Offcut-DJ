/**
 * On-demand installer for the self-contained Demucs stem-separation pack.
 *
 * Bundling the ~600 MB PyInstaller pack into every installer would triple their
 * size, so instead we ship lean and let the user pull the correct per-platform
 * pack once, on demand. It downloads to userData/stems-engine and from then on
 * `bundledDemucs()` in ./index resolves it exactly like a shipped bundle — no
 * Python required.
 *
 * Pack layout (one .tar.gz per platform, hosted as a GitHub Release asset):
 *   offcut-demucs-<key>.tar.gz
 *     └── offcut-demucs/
 *         ├── offcut-demucs            (the PyInstaller binary; .exe on Windows)
 *         └── torch-home/…             (model weights — TORCH_HOME)
 */

import { createWriteStream, existsSync, mkdirSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import https from 'node:https'
import { stemsEngineDir, demucsBinName, demucsPackInstalled } from './index'

// Base URL the per-platform packs are hosted at (a GitHub Release works well —
// asset size limit is 2 GB). Override at runtime with OFFCUT_STEMS_PACK_BASE to
// point at a staging host without rebuilding. Fill in the real release tag once
// the packs are built + uploaded.
const DEFAULT_PACK_BASE = 'https://github.com/198hates/Offcut-DJ/releases/download/stems-pack-v1'

function packBase(): string {
  return (process.env.OFFCUT_STEMS_PACK_BASE || DEFAULT_PACK_BASE).replace(/\/+$/, '')
}

/** darwin-arm64 / darwin-x64 / win32-x64 → the pack key, or null if unsupported. */
export function packKey(): string | null {
  const p = process.platform
  const a = process.arch
  if (p === 'darwin' && a === 'arm64') return 'mac-arm64'
  if (p === 'darwin' && a === 'x64') return 'mac-x64'
  if (p === 'win32' && a === 'x64') return 'win-x64'
  return null // Linux etc. — use system Python (`pip install demucs`).
}

export function packUrl(): string | null {
  const key = packKey()
  return key ? `${packBase()}/offcut-demucs-${key}.tar.gz` : null
}

export interface StemsPackStatus {
  installed: boolean
  /** Whether a downloadable pack exists for this platform/arch. */
  downloadable: boolean
  url: string | null
  platform: string
}

export function packStatus(): StemsPackStatus {
  return {
    installed: demucsPackInstalled(),
    downloadable: packKey() !== null,
    url: packUrl(),
    platform: `${process.platform}-${process.arch}`
  }
}

export function removePack(): void {
  try {
    rmSync(stemsEngineDir(), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

/** Download `url` to `dest`, following redirects, reporting 0..1 fractional progress. */
function download(url: string, dest: string, onFrac: (frac: number) => void, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'))
    const req = https.get(url, (res) => {
      const status = res.statusCode ?? 0
      // GitHub asset URLs 302-redirect to a signed object store URL.
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        download(next, dest, onFrac, redirects + 1).then(resolve, reject)
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`download failed (HTTP ${status}) — is the stems pack published yet?`))
        return
      }
      const total = Number(res.headers['content-length'] || 0)
      let got = 0
      const out = createWriteStream(dest)
      res.on('data', (chunk: Buffer) => {
        got += chunk.length
        if (total > 0) onFrac(got / total)
      })
      res.pipe(out)
      out.on('finish', () => out.close(() => resolve()))
      out.on('error', reject)
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

/** Extract a .tar.gz with the system `tar` (bsdtar on macOS + Windows 10+). */
function extractTarGz(archive: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-xzf', archive, '-C', destDir])
    let err = ''
    proc.stderr.on('data', (b: Buffer) => (err += b.toString()))
    proc.on('error', (e) => reject(new Error(`couldn't run tar: ${e.message}`)))
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar failed (exit ${code}). ${err.trim()}`))
    )
  })
}

/**
 * Download + install the stem-engine pack for this platform. `onProgress`
 * streams percent 0..100 with a label. Resolves to the resolved binary path.
 */
export async function installPack(onProgress?: (percent: number, label: string) => void): Promise<string> {
  const url = packUrl()
  if (!url) {
    throw new Error(
      `No prebuilt stem engine for ${process.platform}-${process.arch}. Install Demucs in Python instead (pip install demucs soundfile).`
    )
  }
  if (demucsPackInstalled()) return join(stemsEngineDir(), 'offcut-demucs', demucsBinName())

  const dir = stemsEngineDir()
  mkdirSync(dir, { recursive: true })
  const tmp = join(tmpdir(), `offcut-demucs-${process.pid}.tar.gz`)

  try {
    onProgress?.(0, 'downloading stem engine…')
    // Download = 0..90 %, extract = 90..100 %.
    await download(url, tmp, (frac) => onProgress?.(Math.round(frac * 90), 'downloading stem engine…'))

    onProgress?.(90, 'extracting…')
    await extractTarGz(tmp, dir)

    const bin = join(dir, 'offcut-demucs', demucsBinName())
    if (!existsSync(bin)) {
      throw new Error('pack extracted but the offcut-demucs binary was not found — bad archive layout.')
    }
    if (process.platform !== 'win32') {
      try {
        chmodSync(bin, 0o755)
      } catch {
        /* best effort */
      }
    }
    if (process.platform === 'darwin') {
      // The pack is unsigned; strip the quarantine flag so Gatekeeper doesn't
      // block the binary + its bundled dylibs from launching. Best-effort —
      // programmatic downloads usually aren't quarantined, but belt-and-braces.
      await new Promise<void>((res) => {
        const p = spawn('xattr', ['-dr', 'com.apple.quarantine', join(dir, 'offcut-demucs')])
        p.on('close', () => res())
        p.on('error', () => res())
      })
    }
    onProgress?.(100, 'installed')
    return bin
  } catch (err) {
    // Don't leave a half-extracted pack that would read as "installed".
    if (!demucsPackInstalled()) removePack()
    throw err
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
  }
}
