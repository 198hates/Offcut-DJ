import { useState, useEffect, useRef } from 'react'
import { useDeckAStore, useDeckBStore } from '../store/playerStore'

export function Mixer(): JSX.Element {
  const [xfade, setXfade] = useState(0.5)
  const [volA, setVolA] = useState(0.8)
  const [volB, setVolB] = useState(0.8)

  const setVolumeA = useDeckAStore((s) => s.setVolume)
  const setVolumeB = useDeckBStore((s) => s.setVolume)

  // Apply crossfader + channel faders to engine volumes
  useEffect(() => {
    // Linear crossfader: centre = both at full, edges cut the opposite channel
    const xA = xfade <= 0.5 ? 1 : 1 - (xfade - 0.5) * 2
    const xB = xfade >= 0.5 ? 1 : xfade * 2
    setVolumeA(volA * xA)
    setVolumeB(volB * xB)
  }, [xfade, volA, volB, setVolumeA, setVolumeB])

  return (
    <div className="w-20 shrink-0 flex flex-col items-center justify-between py-2 border-x border-white/[0.05] bg-black/30 gap-2">
      <p className="text-[9px] font-bold tracking-widest text-white/20 uppercase">MIX</p>

      {/* Channel A fader */}
      <div className="flex flex-col items-center gap-1 flex-1 justify-center">
        <p className="text-[9px] text-white/25">A</p>
        <VerticalFader value={volA} onChange={setVolA} />
      </div>

      {/* Crossfader (horizontal) */}
      <div className="w-full px-2">
        <input
          type="range" min={0} max={1} step={0.005}
          value={xfade}
          onChange={(e) => setXfade(parseFloat(e.target.value))}
          className="w-full h-1 cursor-pointer accent-accent"
          title="Crossfader — A left, B right"
        />
        <div className="flex justify-between text-[9px] text-white/25 mt-0.5 px-0.5">
          <span>A</span><span>B</span>
        </div>
      </div>

      {/* Channel B fader */}
      <div className="flex flex-col items-center gap-1 flex-1 justify-center">
        <p className="text-[9px] text-white/25">B</p>
        <VerticalFader value={volB} onChange={setVolB} />
      </div>
    </div>
  )
}

function VerticalFader({ value, onChange }: { value: number; onChange: (v: number) => void }): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const calcValue = (clientY: number): number => {
    const rect = trackRef.current!.getBoundingClientRect()
    const frac = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    return Math.round(frac * 100) / 100
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    dragging.current = true
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    onChange(calcValue(e.clientY))
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (dragging.current) onChange(calcValue(e.clientY))
  }
  const onPointerUp = (): void => { dragging.current = false }

  const filled = `${(1 - value) * 100}%` // from top (100% = bottom of track = 0 vol)

  return (
    <div
      ref={trackRef}
      className="relative w-3 rounded-full bg-white/10 cursor-pointer"
      style={{ height: 70 }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* Filled region */}
      <div
        className="absolute bottom-0 left-0 right-0 rounded-full bg-accent/60"
        style={{ top: filled }}
      />
      {/* Fader knob */}
      <div
        className="absolute left-1/2 -translate-x-1/2 w-5 h-2.5 bg-white/80 rounded-sm shadow-md"
        style={{ top: `calc(${filled} - 5px)` }}
      />
    </div>
  )
}
