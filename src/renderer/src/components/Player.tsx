import { useDeckAStore, useDeckBStore } from '../store/playerStore'
import { Deck } from './Deck'
import { Mixer } from './Mixer'

export function Player(): JSX.Element {
  return (
    // deck-zone is always dark — sealed working surface
    <div className="deck-zone flex flex-col shrink-0" style={{ height: 310 }}>
      {/* Zone label — inline strip, never overlaps deck content */}
      <div
        className="shrink-0 flex items-center justify-center"
        style={{ height: 14, borderBottom: '1px solid var(--deck-rule)' }}
      >
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 7, fontWeight: 700,
          letterSpacing: '0.2em', textTransform: 'uppercase',
          color: 'var(--deck-spot)',
        }}>
          working surface · the decks
        </span>
      </div>
      {/* Deck A  ·  Mixer  ·  Deck B */}
      <div className="flex flex-1 min-h-0">
        <Deck useStore={useDeckAStore} label="A" keyMod="none" />
        <Mixer />
        <Deck useStore={useDeckBStore} label="B" keyMod="alt" />
      </div>
    </div>
  )
}
