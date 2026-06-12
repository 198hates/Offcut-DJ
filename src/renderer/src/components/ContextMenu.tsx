import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface ContextAction {
  label: string
  shortcut?: string
  action?: () => void
  danger?: boolean
  disabled?: boolean
  submenu?: { label: string; action: () => void }[]
}

export interface ContextSection {
  items: ContextAction[]
}

interface Props {
  x: number
  y: number
  sections: ContextSection[]
  onClose: () => void
}

export function ContextMenu({ x, y, sections, onClose }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Keep menu within viewport
  const W = 180
  const ax = Math.min(x, window.innerWidth  - W - 8)
  const ay = Math.min(y, window.innerHeight - 300)

  return createPortal(
    <div
      ref={ref}
      style={{ position: 'fixed', top: ay, left: ax, zIndex: 9999, width: W }}
      className="bg-paper border border-border/40 rounded shadow-2xl py-1 select-none"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {sections.map((section, si) => (
        <div key={si}>
          {si > 0 && <div className="border-t border-border/20 my-1" />}
          {section.items.map((item, ii) => {
            const key = `${si}-${ii}`
            const hasSub = !!item.submenu?.length
            return (
              <div
                key={key}
                className="relative"
                onMouseEnter={() => setActiveSubmenu(hasSub ? key : null)}
                onMouseLeave={() => hasSub && setActiveSubmenu(null)}
              >
                <button
                  onClick={() => {
                    if (item.disabled || hasSub) return
                    item.action?.()
                    onClose()
                  }}
                  disabled={item.disabled}
                  className={`
                    w-full text-left px-3 py-[5px] font-mono text-[13px]
                    flex items-center justify-between gap-4
                    transition-colors
                    ${item.disabled
                      ? 'opacity-35 cursor-default text-muted'
                      : item.danger
                      ? 'cursor-pointer text-red-500 hover:bg-red-500/10'
                      : 'cursor-pointer text-ink-soft hover:bg-ink/[0.06] hover:text-ink'}
                  `}
                >
                  <span>{item.label}</span>
                  <span className="text-[12px] text-muted shrink-0 tabular-nums">
                    {hasSub ? '›' : (item.shortcut ?? '')}
                  </span>
                </button>

                {hasSub && activeSubmenu === key && (
                  <div
                    className="absolute left-full top-0 ml-0.5 bg-paper border border-border/40 rounded shadow-2xl py-1 z-[10000]"
                    style={{ minWidth: 150 }}
                    onMouseEnter={() => setActiveSubmenu(key)}
                    onMouseLeave={() => setActiveSubmenu(null)}
                  >
                    {item.submenu!.map((sub, subi) => (
                      <button
                        key={subi}
                        onClick={() => { sub.action(); onClose() }}
                        className="w-full text-left px-3 py-[5px] font-mono text-[13px] text-ink-soft hover:bg-ink/[0.06] hover:text-ink transition-colors truncate"
                      >
                        {sub.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>,
    document.body
  )
}
