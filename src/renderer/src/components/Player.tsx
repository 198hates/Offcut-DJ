import { useDeckAStore, useDeckBStore } from '../store/playerStore'
import { Deck } from './Deck'
import { Mixer } from './Mixer'

export function Player(): JSX.Element {
  return (
    <div
      className="flex shrink-0 bg-surface-900 border-t border-white/[0.06]"
      style={{ height: 260 }}
    >
      <Deck useStore={useDeckAStore} label="A" keyMod="none" />
      <Mixer />
      <Deck useStore={useDeckBStore} label="B" keyMod="alt" />
    </div>
  )
}
