import { useDeckAStore, useDeckBStore } from '../store/playerStore'
import { Deck } from './Deck'
import { Mixer } from './Mixer'

export function Player(): JSX.Element {
  return (
    // The player section is always dark regardless of app theme
    <div
      className="flex shrink-0 border-t border-border/20"
      style={{ height: 310, background: 'var(--panel-deep)' }}
    >
      <Deck useStore={useDeckAStore} label="A" keyMod="none" />
      <Mixer />
      <Deck useStore={useDeckBStore} label="B" keyMod="alt" />
    </div>
  )
}
