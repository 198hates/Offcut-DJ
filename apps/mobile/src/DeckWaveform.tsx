// Deck-style waveform, ported from the desktop Canvas renderer (components/
// Waveform.tsx) to React Native Skia: a zoomed, centre-mirrored 3-band waveform
// that scrolls under a fixed centre playhead, bright ahead / dimmed behind, with
// hot-cue markers. Tap to seek.
//
// Data is PeaksData (0–255 band arrays) + an optional compact grid (bpm +
// firstBeatMs + downbeats) so we can draw beat / downbeat lines like the desktop.

import { useEffect, useMemo, useRef, useState } from 'react'
import { LayoutChangeEvent, Pressable, View } from 'react-native'
import { Canvas, Group, Path, Rect, Skia, rect, type SkPath } from '@shopify/react-native-skia'
import { WAVE } from './theme'
import type { CompactGrid, CuePoint, PeaksData } from './sync-types'

const BAR_W = 3 // base px per bucket at zoom 1 (≈90 px/s at ~30 buckets/s)
const SCALE = 0.92 // matches the desktop peak scaling

function buildBandPath(band: number[], n: number, half: number, barW: number): SkPath {
  const p = Skia.Path.Make()
  for (let i = 0; i < n; i++) {
    const v = (band[i] ?? 0) / 255
    const h = v * half * SCALE
    if (h <= 0.5) continue
    p.addRect(rect(i * barW, half - h, barW, h * 2)) // mirrored around centre
  }
  return p
}

/** Vertical beat + downbeat lines in track space (1px each). */
function buildGridPaths(grid: CompactGrid, bucketDur: number, durSec: number, height: number, barW: number): { beat: SkPath; down: SkPath } {
  const beat = Skia.Path.Make()
  const down = Skia.Path.Make()
  const xOf = (ms: number): number => (ms / 1000 / bucketDur) * barW
  const beatMs = grid.bpm > 0 ? 60000 / grid.bpm : 0
  if (beatMs > 0) {
    const count = Math.floor((durSec * 1000 - grid.firstBeatMs) / beatMs)
    if (count > 0 && count <= 6000) {
      for (let k = 0; k <= count; k++) beat.addRect(rect(xOf(grid.firstBeatMs + k * beatMs) - 0.5, 0, 1, height))
    }
  }
  for (const ms of grid.downbeats) down.addRect(rect(xOf(ms) - 0.5, 0, 1, height))
  return { beat, down }
}

export function DeckWaveform({
  data,
  currentTime,
  duration,
  playing,
  cues,
  onSeek,
  height = 112,
  zoom = 1
}: {
  data: PeaksData
  currentTime: number
  duration: number
  playing: boolean
  cues: CuePoint[]
  onSeek?: (sec: number) => void
  height?: number
  zoom?: number
}): JSX.Element {
  const [width, setWidth] = useState(0)
  const onLayout = (e: LayoutChangeEvent): void => setWidth(e.nativeEvent.layout.width)

  const n = data.peaks.length
  const dur = duration > 0 ? duration : data.durationSec || 1
  const bucketDur = dur / n // seconds per bucket
  const barW = BAR_W * zoom
  const half = height / 2
  const centerX = width / 2

  const paths = useMemo(
    () => ({
      low: buildBandPath(data.low, n, half, barW),
      mid: buildBandPath(data.mid, n, half, barW),
      high: buildBandPath(data.high, n, half, barW)
    }),
    [data, n, half, barW]
  )

  const grid = useMemo(
    () => (data.grid ? buildGridPaths(data.grid, bucketDur, dur, height, barW) : null),
    [data.grid, bucketDur, dur, height, barW]
  )

  // Smooth playhead: estimate time between status updates with a RAF clock.
  const [pos, setPos] = useState(currentTime)
  const base = useRef({ t: currentTime, at: Date.now(), playing })
  useEffect(() => {
    base.current = { t: currentTime, at: Date.now(), playing }
  }, [currentTime, playing])
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      const b = base.current
      const est = b.playing ? b.t + (Date.now() - b.at) / 1000 : b.t
      setPos(Math.max(0, Math.min(dur, est)))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [dur])

  // Scroll so the current bucket sits under the centre playhead.
  const translateX = centerX - (pos / bucketDur) * barW
  const scroll = [{ translateX }]

  const tap = (x: number): void => {
    if (!onSeek || width <= 0) return
    const delta = ((x - centerX) / barW) * bucketDur
    onSeek(Math.max(0, Math.min(dur, pos + delta)))
  }

  return (
    <View onLayout={onLayout} style={{ height }}>
      {width > 0 && (
        <Pressable onPress={(e) => tap(e.nativeEvent.locationX)} style={{ flex: 1 }}>
          <Canvas style={{ width, height }}>
            {/* centre baseline */}
            <Rect x={0} y={half - 0.5} width={width} height={1} color={WAVE.baseline} />

            {/* played (left of playhead) — dimmed */}
            <Group clip={rect(0, 0, centerX, height)}>
              <Group transform={scroll}>
                <Path path={paths.low} color={WAVE.past.low} />
                <Path path={paths.mid} color={WAVE.past.mid} />
                <Path path={paths.high} color={WAVE.past.high} />
              </Group>
            </Group>

            {/* upcoming (right of playhead) — bright */}
            <Group clip={rect(centerX, 0, width - centerX, height)}>
              <Group transform={scroll}>
                <Path path={paths.low} color={WAVE.future.low} />
                <Path path={paths.mid} color={WAVE.future.mid} />
                <Path path={paths.high} color={WAVE.future.high} />
              </Group>
            </Group>

            {/* beat / downbeat lines (scroll with the waveform) */}
            {grid && (
              <Group transform={scroll}>
                <Path path={grid.beat} color="rgba(255,255,255,0.13)" />
                <Path path={grid.down} color="rgba(255,255,255,0.5)" />
              </Group>
            )}

            {/* hot-cue markers (scroll with the waveform): full-height line + top flag */}
            <Group transform={scroll}>
              {cues
                .filter((c) => c.type === 'hotcue')
                .map((c) => {
                  const x = (c.positionMs / 1000 / bucketDur) * barW
                  const col = c.color || '#D86A4A'
                  return (
                    <Group key={c.index}>
                      <Rect x={x - 1} y={0} width={2} height={height} color={col} />
                      <Rect x={x - 1} y={0} width={9} height={7} color={col} />
                    </Group>
                  )
                })}
            </Group>

            {/* fixed centre playhead — glow, mid, needle */}
            <Rect x={centerX - 6} y={0} width={12} height={height} color={WAVE.playheadGlow} />
            <Rect x={centerX - 3} y={0} width={6} height={height} color={WAVE.playheadMid} />
            <Rect x={centerX - 1} y={0} width={2} height={height} color={WAVE.playhead} />
          </Canvas>
        </Pressable>
      )}
    </View>
  )
}
