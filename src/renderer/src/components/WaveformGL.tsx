// GPU-accelerated waveform — drop-in replacement for Waveform.tsx.
// Strategy:
//   WebGL canvas  → waveform bars (expensive per-pixel work, single draw call)
//   Canvas 2D     → beat grid numbers, cue markers, loop brackets, playhead
//
// The waveform bars used to be a ~5 000-iteration JS loop per frame.
// The fragment shader processes every pixel in parallel on the GPU.

import { useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react'
import type { CuePoint, BeatgridMarker } from '@shared/types'
import type { WaveformStyle } from '../store/waveformStore'

// ── GLSL shaders ──────────────────────────────────────────────────────────────

const VERT = `#version 300 es
void main() {
  // Full-screen triangle — avoid indexing a local array with gl_VertexID
  // as that can fail on strict WebGL2 implementations (e.g. Metal on macOS).
  vec2 pos;
  if      (gl_VertexID == 0) pos = vec2(-1.0, -1.0);
  else if (gl_VertexID == 1) pos = vec2( 3.0, -1.0);
  else                        pos = vec2(-1.0,  3.0);
  gl_Position = vec4(pos, 0.0, 1.0);
}`

// Fragment shader — draws waveform bars only.
// All other elements (beat grid text, cue markers, playhead) are drawn by the
// Canvas 2D overlay that sits on top.
const FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D u_bands;      // RGBA float: R=low G=mid B=high A=unused
uniform float u_dur;            // track duration (seconds)
uniform float u_start;          // leftmost visible time (seconds)
uniform float u_visDur;         // visible window duration (seconds)
uniform vec2  u_res;            // physical canvas size (px, DPR-scaled)
uniform float u_ct;             // current time (seconds)
uniform int   u_style;          // 0=gradient 1=three-band 2=rgb

out vec4 outColor;

// CDJ spectral gradient — matches the Canvas 2D colour stops exactly.
// In WebGL, gl_FragCoord.y = 0 at the bottom, so the gradient is mirrored.
vec4 cdj(float yFrac, bool past) {
  float t = 1.0 - abs(yFrac - 0.5) * 2.0;  // 0 at edges, 1 at centre
  // Initialise to avoid "use of uninitialized variable" on strict drivers
  vec3 col = vec3(0.0);
  if (past) {
    if      (t < 0.18) col = vec3(0.00, 0.35, 0.51);
    else if (t < 0.36) col = vec3(0.08, 0.43, 0.63);
    else if (t < 0.46) col = vec3(0.31, 0.39, 0.51);
    else if (t < 0.54) col = vec3(0.47, 0.31, 0.16);
    else if (t < 0.64) col = vec3(0.31, 0.39, 0.51);
    else if (t < 0.82) col = vec3(0.08, 0.43, 0.63);
    else               col = vec3(0.00, 0.35, 0.51);
    return vec4(col * 0.55, 1.0);
  } else {
    if      (t < 0.18) col = vec3(0.08, 0.75, 1.00);
    else if (t < 0.36) col = vec3(1.00, 1.00, 1.00);
    else if (t < 0.46) col = vec3(1.00, 0.75, 0.08);
    else if (t < 0.54) col = vec3(1.00, 0.29, 0.04);
    else if (t < 0.64) col = vec3(1.00, 0.75, 0.08);
    else if (t < 0.82) col = vec3(1.00, 1.00, 1.00);
    else               col = vec3(0.08, 0.75, 1.00);
    return vec4(col, 1.0);
  }
}

void main() {
  float xFrac = gl_FragCoord.x / u_res.x;
  float yFrac = gl_FragCoord.y / u_res.y;  // 0=bottom, 1=top
  float t     = u_start + xFrac * u_visDur;

  outColor = vec4(0.0);

  if (t < 0.0 || t > u_dur) return;

  float tc   = t / u_dur;
  vec4  smp  = texture(u_bands, vec2(tc, 0.5));
  float low  = smp.r;
  float mid  = smp.g;
  float high = smp.b;
  bool  past = t < u_ct;

  // Distance from vertical centre, 0=centre 1=edge
  float dist = abs(yFrac - 0.5) * 2.0;
  const float SC = 0.92;

  if (u_style == 1) {
    // Three-band: blue highs, orange mids, cream lows
    vec4 col = vec4(0.0);
    if (dist < high * SC) col = past ? vec4(0.06,0.27,0.57,0.38) : vec4(0.10,0.53,1.00,0.90);
    if (dist < mid  * SC) col = past ? vec4(0.39,0.20,0.05,0.40) : vec4(0.84,0.46,0.11,0.94);
    if (dist < low  * SC) col = past ? vec4(0.51,0.45,0.33,0.42) : vec4(0.97,0.91,0.76,0.98);
    if (col.a > 0.0) outColor = col;
  } else if (u_style == 2) {
    // RGB: red bass, green mids, blue highs
    vec4 col = vec4(0.0);
    if (dist < high * SC) col = past ? vec4(0.07,0.07,0.59,0.38) : vec4(0.14,0.49,1.00,0.92);
    if (dist < mid  * SC) col = past ? vec4(0.07,0.45,0.07,0.38) : vec4(0.14,0.84,0.22,0.92);
    if (dist < low  * SC) col = past ? vec4(0.59,0.07,0.07,0.38) : vec4(1.00,0.14,0.14,0.92);
    if (col.a > 0.0) outColor = col;
  } else {
    // CDJ spectral gradient
    float overall = (low + mid + high) / 3.0;
    if (dist < overall * 0.88) outColor = cdj(yFrac, past);
  }
}`

// ── WebGL helpers ─────────────────────────────────────────────────────────────

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s) ?? 'shader error')
  return s
}

function buildProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const p = gl.createProgram()!
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER,   VERT))
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(p) ?? 'link error')
  return p
}

function uploadTexture(
  gl: WebGL2RenderingContext,
  tex: WebGLTexture,
  low: Float32Array,
  mid: Float32Array,
  high: Float32Array,
): void {
  const N = low.length
  const data = new Float32Array(N * 4)
  for (let i = 0; i < N; i++) {
    data[i * 4]     = low[i]
    data[i * 4 + 1] = mid[i]
    data[i * 4 + 2] = high[i]
    data[i * 4 + 3] = 1.0
  }
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, N, 1, 0, gl.RGBA, gl.FLOAT, data)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  peaks: Float32Array | null
  detailPeaks?: Float32Array | null
  lowPeaks: Float32Array | null
  midPeaks: Float32Array | null
  highPeaks: Float32Array | null
  waveformStyle: WaveformStyle
  duration: number
  currentTime: number
  isPlaying?: boolean
  playbackRate?: number
  cuePoints: CuePoint[]
  mainCueTime: number | null
  beatgrid?: BeatgridMarker[]
  loopStart?: number | null
  loopEnd?: number | null
  isLooping?: boolean
  onSeek: (time: number) => void
  isLoading?: boolean
}

const DEFAULT_PPS = 100
const STYLE_MAP: Record<WaveformStyle, number> = { gradient: 0, 'three-band': 1, rgb: 2 }

export function WaveformGL({
  peaks, lowPeaks, midPeaks, highPeaks, waveformStyle,
  duration, currentTime, isPlaying = false, playbackRate: pbRate = 1,
  cuePoints, mainCueTime, beatgrid,
  loopStart, loopEnd, isLooping,
  onSeek, isLoading,
}: Props): JSX.Element {
  const glCanvasRef  = useRef<HTMLCanvasElement>(null)
  const ovCanvasRef  = useRef<HTMLCanvasElement>(null)
  const sizeRef      = useRef({ w: 0, h: 0, dpr: 1 })
  const ctRef        = useRef(currentTime)
  const glRef        = useRef<WebGL2RenderingContext | null>(null)
  const progRef      = useRef<WebGLProgram | null>(null)
  const texRef       = useRef<WebGLTexture | null>(null)
  const vaoRef       = useRef<WebGLVertexArrayObject | null>(null)
  // Anchor: lets drawOverlay interpolate position smoothly between audio-engine ticks
  const anchorRef    = useRef<{ pos: number; wall: number } | null>(null)
  const playbackRate = useRef(pbRate)
  const [pps, setPps] = useState(DEFAULT_PPS)

  // Keep playbackRate ref in sync without triggering callbacks
  useLayoutEffect(() => { playbackRate.current = pbRate }, [pbRate])

  // On each new currentTime from the engine: reset the anchor so interpolation
  // starts fresh from this exact position.
  useLayoutEffect(() => {
    ctRef.current = currentTime
    if (isPlaying) {
      anchorRef.current = { pos: currentTime, wall: performance.now() }
    } else {
      anchorRef.current = null
    }
  })

  // ── Initialise canvas sizes ───────────────────────────────────────────────
  const initSizes = useCallback(() => {
    const gc = glCanvasRef.current
    const oc = ovCanvasRef.current
    if (!gc || !oc) return
    const dpr = window.devicePixelRatio || 1
    const w = gc.offsetWidth
    const h = gc.offsetHeight
    if (!w || !h) return
    gc.width = oc.width  = w * dpr
    gc.height = oc.height = h * dpr
    sizeRef.current = { w, h, dpr }
    const gl = glRef.current
    if (gl) gl.viewport(0, 0, w * dpr, h * dpr)
  }, [])

  useLayoutEffect(() => { initSizes() }, [initSizes])

  useEffect(() => {
    const el = glCanvasRef.current?.parentElement
    if (!el) return
    const ro = new ResizeObserver(initSizes)
    ro.observe(el)
    return () => ro.disconnect()
  }, [initSizes])

  // ── Set up WebGL ──────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = glCanvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl2')
    if (!gl) { console.warn('[WaveformGL] WebGL2 not available'); return }
    // Enable linear filtering for float textures (not guaranteed in base WebGL2)
    gl.getExtension('OES_texture_float_linear')
    glRef.current  = gl
    try {
      progRef.current = buildProgram(gl)
    } catch (e) {
      console.error('[WaveformGL] shader compile failed:', e)
      return
    }
    texRef.current  = gl.createTexture()
    // WebGL2 requires a VAO to be bound even with no vertex attributes
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    vaoRef.current = vao
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  }, [])

  // ── Upload peak texture when bands change ─────────────────────────────────
  useEffect(() => {
    const gl = glRef.current
    const tex = texRef.current
    if (!gl || !tex) return

    if (lowPeaks && midPeaks && highPeaks) {
      uploadTexture(gl, tex, lowPeaks, midPeaks, highPeaks)
    } else if (peaks) {
      // Fallback: fill all channels with overall peaks
      uploadTexture(gl, tex, peaks, peaks, peaks)
    }
  }, [lowPeaks, midPeaks, highPeaks, peaks])

  // ── GL draw ───────────────────────────────────────────────────────────────
  const drawGL = useCallback(() => {
    const gl   = glRef.current
    const prog = progRef.current
    const tex  = texRef.current
    const vao  = vaoRef.current
    if (!gl || !prog || !tex || !vao) return
    if (!peaks && !lowPeaks) return

    const { w, h, dpr } = sizeRef.current
    if (!w || !h) return

    const ct = ctRef.current
    const pw           = w * dpr
    const ph           = h * dpr
    const ppsScaled    = pps * dpr
    const visDur       = pw / ppsScaled
    const startTime    = ct - visDur / 2

    gl.viewport(0, 0, pw, ph)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.bindVertexArray(vao)
    gl.useProgram(prog)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)

    const u = (name: string) => gl.getUniformLocation(prog, name)
    gl.uniform1i(u('u_bands'),  0)
    gl.uniform1f(u('u_dur'),    duration)
    gl.uniform1f(u('u_start'),  startTime)
    gl.uniform1f(u('u_visDur'), visDur)
    gl.uniform2f(u('u_res'),    pw, ph)
    gl.uniform1f(u('u_ct'),     ct)
    gl.uniform1i(u('u_style'),  STYLE_MAP[waveformStyle] ?? 0)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }, [peaks, lowPeaks, waveformStyle, duration, pps])

  // ── Canvas 2D overlay — beat grid, cues, loop, playhead ──────────────────
  const drawOverlay = useCallback(() => {
    const canvas = ovCanvasRef.current
    if (!canvas) return
    const { w, h, dpr } = sizeRef.current
    if (!w || !h) return
    const ctx = canvas.getContext('2d')!
    const cw = w * dpr
    const ch = h * dpr
    const mid = ch / 2
    ctx.clearRect(0, 0, cw, ch)
    if (!duration) return

    const anchor    = anchorRef.current
    const ct        = anchor
      ? Math.min(duration, anchor.pos + (performance.now() - anchor.wall) / 1000 * playbackRate.current)
      : ctRef.current
    const ppsScaled = pps * dpr
    const visDur    = cw / ppsScaled
    const startTime = ct - visDur / 2

    // Loop region
    if (loopStart != null && loopEnd != null && loopEnd > loopStart) {
      const lx1 = ((loopStart - startTime) / visDur) * cw
      const lx2 = ((loopEnd   - startTime) / visDur) * cw
      ctx.fillStyle = isLooping ? 'rgba(184,74,43,0.18)' : 'rgba(184,74,43,0.08)'
      ctx.fillRect(lx1, 0, lx2 - lx1, ch)
      ctx.fillStyle = isLooping ? 'rgba(184,74,43,0.90)' : 'rgba(184,74,43,0.50)'
      ctx.fillRect(lx1, 0, 2, ch);        ctx.fillRect(lx2 - 2, 0, 2, ch)
      ctx.fillRect(lx1, 0, 8, 2);         ctx.fillRect(lx1, ch - 2, 8, 2)
      ctx.fillRect(lx2 - 8, 0, 8, 2);    ctx.fillRect(lx2 - 8, ch - 2, 8, 2)
    }

    // Beat grid — bar numbers + hairlines (same as Canvas 2D Waveform)
    if (beatgrid && beatgrid.length > 0) {
      let barCount = 1
      const barNums = new Map<number, number>()
      for (const m of beatgrid) { if (m.isDownbeat) barNums.set(m.positionMs, barCount++) }

      const lw = Math.round(dpr)
      ctx.fillStyle = 'rgba(255,255,255,0.14)'
      for (const m of beatgrid) {
        if (m.isDownbeat) continue
        const t = m.positionMs / 1000
        if (t < startTime - 0.05 || t > startTime + visDur + 0.05) continue
        ctx.fillRect(Math.round(((t - startTime) / visDur) * cw), 0, lw, ch)
      }
      ctx.font = `${Math.round(7.5 * dpr)}px 'JetBrains Mono', monospace`
      ctx.textAlign = 'center'
      for (const m of beatgrid) {
        if (!m.isDownbeat) continue
        const t = m.positionMs / 1000
        if (t < startTime - 0.05 || t > startTime + visDur + 0.05) continue
        const x = Math.round(((t - startTime) / visDur) * cw)
        ctx.fillStyle = 'rgba(255,255,255,0.52)'; ctx.fillRect(x, 0, lw, ch)
        const bn = barNums.get(m.positionMs)
        if (bn !== undefined) {
          ctx.fillStyle = 'rgba(255,255,255,0.60)'
          ctx.fillText(String(bn), x, Math.round(8.5 * dpr))
        }
      }
    }

    // Cue markers
    for (const cue of cuePoints) {
      const t = cue.positionMs / 1000
      if (t < startTime || t > startTime + visDur) continue
      const x = ((t - startTime) / visDur) * cw
      const color = cue.color || '#ff8c00'
      ctx.fillStyle = color
      ctx.fillRect(x - 1, 0, 2, ch)
      ctx.beginPath()
      ctx.moveTo(x - 5 * dpr, 0); ctx.lineTo(x + 5 * dpr, 0); ctx.lineTo(x, 8 * dpr)
      ctx.closePath(); ctx.fill()
      if (cue.label) {
        ctx.font = `bold ${10 * dpr}px monospace`
        ctx.fillStyle = color
        ctx.fillText(cue.label, x + 4 * dpr, 14 * dpr)
      }
    }

    // Main CUE
    if (mainCueTime !== null && mainCueTime >= startTime && mainCueTime <= startTime + visDur) {
      const x = ((mainCueTime - startTime) / visDur) * cw
      ctx.fillStyle = '#00ff88'
      ctx.fillRect(x - 1, 0, 2, ch)
      ctx.beginPath()
      ctx.moveTo(x - 5 * dpr, ch); ctx.lineTo(x + 5 * dpr, ch); ctx.lineTo(x, ch - 8 * dpr)
      ctx.closePath(); ctx.fill()
    }

    // Center baseline
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(0, mid - 0.5, cw, 1)

    // Playhead
    const cx = cw / 2
    ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(cx - 6 * dpr, 0, 12 * dpr, ch)
    ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(cx - 3 * dpr, 0,  6 * dpr, ch)
    ctx.fillStyle = 'rgba(255,255,255,0.97)'; ctx.fillRect(cx - dpr,     0,  2 * dpr, ch)
  }, [duration, cuePoints, mainCueTime, beatgrid, loopStart, loopEnd, isLooping, pps])

  // ── RAF loop ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let raf: number
    const loop = () => { drawGL(); drawOverlay(); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [drawGL, drawOverlay])

  // ── Drag-to-scrub (Rekordbox style) ──────────────────────────────────────
  const dragRef     = useRef<{ startX: number; startTime: number } | null>(null)
  const pendingSeek = useRef<number | null>(null)

  const visDurAt = useCallback((canvasWidth: number) => {
    const { dpr } = sizeRef.current
    return (canvasWidth * dpr) / (pps * dpr)
  }, [pps])

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!duration) return
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startTime: ctRef.current }
    e.currentTarget.style.cursor = 'grabbing'
  }, [duration])  // ctRef is a stable ref, no dep needed

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (!drag || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const visDur = visDurAt(rect.width)
    const dt = -((e.clientX - drag.startX) / rect.width) * visDur
    const target = Math.max(0, Math.min(duration, drag.startTime + dt))
    // Update visual position immediately via ref
    ctRef.current = target
    // Throttle audio seek to one per animation frame
    if (pendingSeek.current === null) {
      pendingSeek.current = requestAnimationFrame(() => {
        pendingSeek.current = null
        onSeek(ctRef.current)
      })
    }
  }, [duration, visDurAt, onSeek])

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current) {
      if (pendingSeek.current !== null) {
        cancelAnimationFrame(pendingSeek.current)
        pendingSeek.current = null
      }
      onSeek(ctRef.current)  // ensure final position is committed
    }
    dragRef.current = null
    e.currentTarget.style.cursor = 'grab'
  }, [onSeek])

  // Cancel drag if pointer leaves the window
  useEffect(() => {
    const up = () => {
      if (dragRef.current) onSeek(ctRef.current)
      dragRef.current = null
      if (pendingSeek.current !== null) {
        cancelAnimationFrame(pendingSeek.current)
        pendingSeek.current = null
      }
      if (ovCanvasRef.current) ovCanvasRef.current.style.cursor = 'grab'
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [onSeek])

  return (
    <div className="relative flex-1 min-w-0 bg-black/40 rounded overflow-hidden">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center text-white/30 text-xs pointer-events-none z-10">
          Analysing…
        </div>
      )}
      {!peaks && !isLoading && (
        <div className="absolute inset-0 flex items-center justify-center text-white/15 text-xs pointer-events-none">
          Load a track
        </div>
      )}
      {/* WebGL canvas — waveform bars */}
      <canvas ref={glCanvasRef}  className="absolute inset-0 w-full h-full block" />
      {/* Canvas 2D overlay — beat grid, cues, playhead (pointer events here) */}
      <canvas
        ref={ovCanvasRef}
        className="absolute inset-0 w-full h-full block"
        style={{ cursor: 'grab' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      />
      <div className="absolute bottom-1 right-1 flex gap-0.5 z-10">
        <button onClick={() => setPps((p) => Math.max(p / 2, 25))}  className="w-5 h-5 rounded bg-black/50 text-white/50 hover:text-white text-xs flex items-center justify-center">−</button>
        <button onClick={() => setPps((p) => Math.min(p * 2, 1600))} className="w-5 h-5 rounded bg-black/50 text-white/50 hover:text-white text-xs flex items-center justify-center">+</button>
      </div>
    </div>
  )
}
