// Waveform overview from /media/peaks — plain RN views (no Skia dep). Bars are
// coloured by blending the 3 frequency bands, roughly matching the desktop's
// 3-band waveform. Downsamples to a phone-friendly column count.

import { useMemo } from 'react'
import { View } from 'react-native'
import type { PeaksData } from './sync-types'

const COLUMNS = 150
// Band colours (low → warm brown, mid → terracotta, high → cream), à la desktop.
const LOW = [0x6b, 0x5a, 0x3e]
const MID = [0xc2, 0x68, 0x3e]
const HIGH = [0xec, 0xe3, 0xcc]

interface Bar {
  h: number // 0..1
  color: string
}

function blend(low: number, mid: number, high: number): string {
  const sum = low + mid + high || 1
  const r = Math.round((LOW[0] * low + MID[0] * mid + HIGH[0] * high) / sum)
  const g = Math.round((LOW[1] * low + MID[1] * mid + HIGH[1] * high) / sum)
  const b = Math.round((LOW[2] * low + MID[2] * mid + HIGH[2] * high) / sum)
  return `rgb(${r},${g},${b})`
}

export function Waveform({ data, height = 96 }: { data: PeaksData; height?: number }): JSX.Element {
  const bars = useMemo<Bar[]>(() => {
    const n = data.peaks.length
    if (n === 0) return []
    const step = Math.max(1, Math.ceil(n / COLUMNS))
    const out: Bar[] = []
    for (let i = 0; i < n; i += step) {
      let peak = 0
      let lo = 0
      let mi = 0
      let hi = 0
      let c = 0
      for (let j = i; j < Math.min(i + step, n); j++) {
        peak = Math.max(peak, data.peaks[j])
        lo += data.low[j] ?? 0
        mi += data.mid[j] ?? 0
        hi += data.high[j] ?? 0
        c++
      }
      out.push({ h: peak / 255, color: blend(lo / c, mi / c, hi / c) })
    }
    return out
  }, [data])

  return (
    <View style={{ height, flexDirection: 'row', alignItems: 'center', gap: 1 }}>
      {bars.map((b, i) => (
        <View
          key={i}
          style={{
            flex: 1,
            height: Math.max(2, b.h * height),
            backgroundColor: b.color,
            borderRadius: 1
          }}
        />
      ))}
    </View>
  )
}
