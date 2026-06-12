import { useState } from 'react'
import { useDeckAStore, useDeckBStore } from '../store/playerStore'
import { Deck } from './Deck'
import { Mixer } from './Mixer'

/** Which decks the working surface shows. Solo views give one deck the full
 *  width (prep/listening); the mixer column stays for level/EQ/REC. */
type DeckView = 'A' | 'both' | 'B'

const VIEW_KEY = 'offcut.deckView'

export function Player(): JSX.Element {
  const [view, setView] = useState<DeckView>(() => {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'A' || v === 'B' ? v : 'both'
  })
  const select = (v: DeckView): void => {
    setView(v)
    localStorage.setItem(VIEW_KEY, v)
  }

  return (
    // deck-zone is always dark — sealed working surface
    <div className="deck-zone flex flex-col shrink-0" style={{ height: 310 }}>
      {/* Zone label strip — centred title, view switch on the right */}
      <div
        className="shrink-0 relative flex items-center justify-center"
        style={{ height: 18, borderBottom: '1px solid var(--deck-rule)' }}
      >
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 7, fontWeight: 700,
          letterSpacing: '0.2em', textTransform: 'uppercase',
          color: 'var(--deck-spot)',
        }}>
          working surface · {view === 'both' ? 'the decks' : `deck ${view}`}
        </span>

        {/* View switch: solo A · dual · solo B */}
        <div className="absolute right-2 top-0 bottom-0 flex items-center gap-px">
          {(['A', 'both', 'B'] as const).map((v) => (
            <button
              key={v}
              onClick={() => select(v)}
              title={v === 'both' ? 'Show both decks' : `Solo deck ${v} (full width)`}
              className="h-[14px] px-1.5 rounded-sm font-mono font-bold uppercase transition-colors"
              style={{
                fontSize: 8,
                letterSpacing: '0.12em',
                color: view === v ? 'var(--deck-bg)' : 'var(--deck-mute)',
                background: view === v ? 'var(--deck-spot)' : 'transparent',
              }}
            >
              {v === 'both' ? 'A·B' : v}
            </button>
          ))}
        </div>
      </div>

      {/* Deck A  ·  Mixer  ·  Deck B (solo views drop the other deck) */}
      <div className="flex flex-1 min-h-0">
        {view !== 'B' && <Deck useStore={useDeckAStore} label="A" keyMod="none" />}
        <Mixer />
        {view !== 'A' && <Deck useStore={useDeckBStore} label="B" keyMod="alt" />}
      </div>
    </div>
  )
}
