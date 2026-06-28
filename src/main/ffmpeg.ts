import ffmpegStatic from 'ffmpeg-static'

/**
 * Absolute path to the bundled ffmpeg binary, corrected for asar packaging.
 *
 * `ffmpeg-static` computes its path as `join(__dirname, 'ffmpeg')`, which in a
 * packaged build resolves *inside* `app.asar`. But the binary is asarUnpacked
 * (see `electron-builder.cjs`), so it physically lives under
 * `app.asar.unpacked/…`. Spawning the in-asar path fails with ENOENT, which is
 * why every main-process ffmpeg call (audio embeddings, ReplayGain tags, Cast
 * HLS, artwork, USB transcode) silently failed in the packaged app while
 * working in `npm run dev` (no asar there).
 *
 * Rewrite `app.asar` → `app.asar.unpacked`. The negative lookahead avoids
 * double-rewriting an already-unpacked path; in dev there is no `app.asar`
 * segment, so this is a no-op.
 */
export const ffmpegBinary: string | null = ffmpegStatic
  ? (ffmpegStatic as unknown as string).replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked')
  : null
