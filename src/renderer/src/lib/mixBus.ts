/**
 * Mix bus — the single owner of each deck's effective engine volume.
 *
 *   engine.volume = trim (per-track auto-gain) × channel fader × crossfader leg
 *
 * Subscribed at module level (imported for side effects from App.tsx) so:
 *  - faders/crossfader keep working when the Mixer UI is unmounted;
 *  - auto-gain is a real trim stage instead of being multiplied into the fader
 *    value (the old approach compounded across loads and was silently wiped by
 *    the next fader move);
 *  - an engine swap (Web Audio → native) immediately receives the current mix
 *    state instead of starting from its 0.8 default.
 */
import { useMixerStore } from '../store/mixerStore'
import { useDeckAStore, useDeckBStore, type DeckStore } from '../store/playerStore'

/** Dipless transition crossfader: both legs at unity in the centre. */
function xfadeLegs(x: number): [number, number] {
  const a = x <= 0.5 ? 1 : 1 - (x - 0.5) * 2
  const b = x >= 0.5 ? 1 : x * 2
  return [a, b]
}

export function applyMixBus(): void {
  const { volA, volB, xfade } = useMixerStore.getState()
  const [xA, xB] = xfadeLegs(xfade)
  const a = useDeckAStore.getState()
  const b = useDeckBStore.getState()
  a._engine.volume = Math.max(0, Math.min(1, a.trimGain * volA * xA))
  b._engine.volume = Math.max(0, Math.min(1, b.trimGain * volB * xB))
}

useMixerStore.subscribe(applyMixBus)

const onDeckChange = (s: DeckStore, prev: DeckStore): void => {
  if (s.trimGain !== prev.trimGain || s._engine !== prev._engine) applyMixBus()
}
useDeckAStore.subscribe(onDeckChange)
useDeckBStore.subscribe(onDeckChange)

applyMixBus()
