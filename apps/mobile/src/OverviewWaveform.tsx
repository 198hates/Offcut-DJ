// Full-track overview strip (the rekordbox "minimap"): the whole song squeezed
// to the screen width, dim behind the play position and bright ahead, with a
// position cursor and hot-cue ticks. Tap or drag anywhere to seek across the
// entire track. Pairs with DeckWaveform (the zoomed, scrolling detail view).

import { useEffect, useMemo, useRef, useState } from 'react'
import { LayoutChangeEvent, PanResponder, View } from 'react-native'
import { Canvas, Group, Path, Rect, Skia, rect, type SkPath } from '@shopify/react-native-skia'
import { C, WAVE } from './theme'
import type { CuePoint, PeaksData } from './sync-types'

const SCALE = 0.86
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

/** Down-sample the per-bucket peaks to one mirrored bar per screen column. */
function buildOverviewPath(peaks: number[], cols: number, half: number): SkPath {
  const p = Skia.Path.Make()
  const n = peaks.length
  if (n === 0 || cols <= 0) return p
  for (let c = 0; c < cols; c++) {
    const a = Math.floor((c / cols) * n)
    const b = Math.max(a + 1, Math.floor(((c + 1) / cols) * n))
    let max = 0
    for (let i = a; i < b && i < n; i++) if (peaks[i] > max) max = peaks[i]
    const h = (max / 255) * half * SCALE
    if (h <= 0.4) continue
    p.addRect(rect(c, half - h, 1, h * 2))
  }
  return p
}

export function OverviewWaveform({
  data,
  currentTime,
  duration,
  playing,
  cues,
  onSeek,
  height = 38
}: {
  data: PeaksData
  currentTime: number
  duration: number
  playing: boolean
  cues: CuePoint[]
  onSeek?: (sec: number) => void
  height?: number
}): JSX.Element {
  const [width, setWidth] = useState(0)
  const onLayout = (e: LayoutChangeEvent): void => setWidth(e.nativeEvent.layout.width)
  const dur = duration > 0 ? duration : data.durationSec || 1
  const half = height / 2
  const cols = Math.max(1, Math.floor(width))

  const path = useMemo(() => buildOverviewPath(data.peaks, cols, half), [data.peaks, cols, half])

  // Downbeat ticks (one per bar) baked into a single path so the per-frame cursor
  // re-render stays cheap. Skipped when the track has no analysed grid.
  const downPath = useMemo(() => {
    const p = Skia.Path.Make()
    if (data.grid && width > 0) {
      for (const ms of data.grid.downbeats) p.addRect(rect((ms / 1000 / dur) * width, 0, 1, height))
    }
    return p
  }, [data.grid, width, dur, height])

  // Smooth cursor between status ticks (same RAF estimate as the detail view).
  const [pos, setPos] = useState(currentTime)
  const base = useRef({ t: currentTime, at: Date.now(), playing })
  useEffect(() => { base.current = { t: currentTime, at: Date.now(), playing } }, [currentTime, playing])
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      const b = base.current
      const est = b.playing ? b.t + (Date.now() - b.at) / 1000 : b.t
      setPos(clamp(est, 0, dur))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [dur])

  const cursorX = width > 0 ? (pos / dur) * width : 0

  const seekRef = useRef(onSeek)
  seekRef.current = onSeek
  const wRef = useRef(width)
  wRef.current = width
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => { const w = wRef.current; if (w > 0) seekRef.current?.(clamp(e.nativeEvent.locationX / w, 0, 1) * dur) },
      onPanResponderMove: (e) => { const w = wRef.current; if (w > 0) seekRef.current?.(clamp(e.nativeEvent.locationX / w, 0, 1) * dur) }
    })
  ).current

  return (
    <View onLayout={onLayout} style={{ height }} {...pan.panHandlers}>
      {width > 0 && (
        <Canvas style={{ width, height }}>
          <Rect x={0} y={half - 0.5} width={width} height={1} color={WAVE.baseline} />
          {/* played (dim) */}
          <Group clip={rect(0, 0, cursorX, height)}>
            <Path path={path} color={WAVE.past.low} />
          </Group>
          {/* upcoming (bright cream) */}
          <Group clip={rect(cursorX, 0, width - cursorX, height)}>
            <Path path={path} color={WAVE.future.low} />
          </Group>
          {/* downbeat ticks */}
          <Path path={downPath} color="rgba(255,255,255,0.10)" />
          {/* hot-cue ticks */}
          {cues
            .filter((c) => c.type === 'hotcue')
            .map((c) => {
              const x = (c.positionMs / 1000 / dur) * width
              return <Rect key={c.index} x={x - 0.5} y={0} width={1.5} height={height} color={c.color || C.accent} />
            })}
          {/* position cursor */}
          <Rect x={cursorX - 1} y={0} width={2} height={height} color={WAVE.playhead} />
        </Canvas>
      )}
    </View>
  )
}
