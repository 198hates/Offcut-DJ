import { useThemeStore } from '../store/themeStore'

// Map a Camelot key string (e.g. '7A', '3B') to a [1..12, 'A'|'B'] tuple
function parseKey(key: string | null): [number, 'A' | 'B'] | null {
  if (!key) return null
  const m = key.match(/^(\d{1,2})([AB])$/i)
  if (!m) return null
  return [parseInt(m[1]), m[2].toUpperCase() as 'A' | 'B']
}

// Keys that mix well with the given key
function compatibleKeys(num: number, band: 'A' | 'B'): Array<[number, 'A' | 'B']> {
  const wrap = (n: number): number => ((n - 1 + 12) % 12) + 1
  return [
    [wrap(num - 1), band],   // adjacent −1
    [wrap(num + 1), band],   // adjacent +1
    [num, band === 'A' ? 'B' : 'A']  // relative major/minor
  ]
}

// Field Unit — muted functional palette (one stable hue per Camelot position).
const SEGMENT_COLORS: Record<number, string> = {
  1: '#4E7090', 2: '#8A6EA8', 3: '#B86E72',
  4: '#B07A4E', 5: '#C24E4E', 6: '#4E9A8E',
  7: '#6E8059', 8: '#C9A02C', 9: '#A9C23E',
  10: '#C2683E', 11: '#5E7E9E', 12: '#9A7EB0'
}

interface Props {
  currentKey: string | null
  size?: number
}

export function CamelotWheel({ currentKey, size = 220 }: Props): JSX.Element {
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'

  const parsed = parseKey(currentKey)
  const compat = parsed ? compatibleKeys(parsed[0], parsed[1]) : []

  const cx = size / 2, cy = size / 2
  const rOuter = size * 0.48, rMid = size * 0.33, rInner = size * 0.19, rHub = size * 0.07

  const segOff    = isDark ? '#1A1612' : '#F4EFE0'
  const segAOff   = isDark ? '#14110D' : '#ECE5D3'
  const segStroke = isDark ? '#2E2820' : '#BDB6A4'
  const txtOff    = isDark ? '#6A6457' : '#3A352D'
  const hubBg     = isDark ? '#221D17' : '#14110E'

  function polar(angle: number, r: number): [number, number] {
    const a = (angle - 90) * Math.PI / 180
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  }

  function arc(r1: number, r2: number, a1: number, a2: number): string {
    const [x1, y1] = polar(a1, r2)
    const [x2, y2] = polar(a2, r2)
    const [x3, y3] = polar(a2, r1)
    const [x4, y4] = polar(a1, r1)
    const large = a2 - a1 > 180 ? 1 : 0
    return `M${x1},${y1} A${r2},${r2} 0 ${large} 1 ${x2},${y2} L${x3},${y3} A${r1},${r1} 0 ${large} 0 ${x4},${y4} Z`
  }

  const segments: JSX.Element[] = []

  for (let i = 0; i < 12; i++) {
    const num = i + 1
    const a1 = i * 30 - 15
    const a2 = (i + 1) * 30 - 15
    const midA = (a1 + a2) / 2

    const isCurrent = parsed?.[0] === num
    const bIsComp = compat.some(([n, b]) => n === num && b === 'B')
    const aIsComp = compat.some(([n, b]) => n === num && b === 'A')
    const bIsActive = isCurrent && parsed?.[1] === 'B'
    const aIsActive = isCurrent && parsed?.[1] === 'A'

    const segColor = SEGMENT_COLORS[num]
    const bFill = bIsActive ? segColor : bIsComp ? `${segColor}55` : segOff
    const aFill = aIsActive ? segColor : aIsComp ? `${segColor}55` : segAOff
    const bTxt  = bIsActive || bIsComp ? (isDark ? '#ECE5D3' : '#14110E') : txtOff
    const aTxt  = aIsActive || aIsComp ? (isDark ? '#ECE5D3' : '#14110E') : txtOff

    const [bx, by] = polar(midA, (rMid + rOuter) / 2)
    const [ax, ay] = polar(midA, (rInner + rMid) / 2)
    const fSize = size * 0.042

    segments.push(
      <g key={num}>
        <path d={arc(rMid, rOuter, a1, a2)} fill={bFill} stroke={segStroke} strokeWidth="0.8" />
        <text x={bx} y={by + fSize * 0.35} textAnchor="middle" fontSize={fSize} fontWeight="700"
              fontFamily="'JetBrains Mono', monospace" fill={bTxt}>{num}B</text>
        <path d={arc(rInner, rMid, a1, a2)} fill={aFill} stroke={segStroke} strokeWidth="0.8" />
        <text x={ax} y={ay + fSize * 0.3} textAnchor="middle" fontSize={fSize * 0.9} fontWeight="700"
              fontFamily="'JetBrains Mono', monospace" fill={aTxt}>{num}A</text>
      </g>
    )
  }

  const hubAccent = parsed ? SEGMENT_COLORS[parsed[0]] : (isDark ? '#D86A4A' : '#B84A2B')

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {segments}
      <circle cx={cx} cy={cy} r={rHub} fill={hubBg} />
      {currentKey ? (
        <>
          <text x={cx} y={cy + size * 0.018} textAnchor="middle"
                fontSize={size * 0.052} fontWeight="700"
                fontFamily="'JetBrains Mono', monospace" fill={hubAccent}>
            {currentKey.toUpperCase()}
          </text>
          <text x={cx} y={cy + size * 0.052} textAnchor="middle"
                fontSize={size * 0.032}
                fontFamily="'JetBrains Mono', monospace" fill={isDark ? '#6A6457' : '#8A8474'}
                letterSpacing="1">
            NOW
          </text>
        </>
      ) : (
        <text x={cx} y={cy + size * 0.025} textAnchor="middle"
              fontSize={size * 0.038}
              fontFamily="'JetBrains Mono', monospace" fill={txtOff}>—</text>
      )}
    </svg>
  )
}

// Returns a blip colour for a given key (for use in library rows)
export function keyBlipColor(key: string | null): string {
  if (!key) return '#8A8474'
  const p = parseKey(key)
  if (!p) return '#8A8474'
  return SEGMENT_COLORS[p[0]] ?? '#8A8474'
}
