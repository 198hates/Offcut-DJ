/**
 * Automix execution — an auto-DJ that plays through a running order, blending
 * each track into the next via the native engine's beat-sync + the crossfader.
 *
 * This is pure renderer orchestration: the Rust engine already does beat-aligned
 * sync (deck.toggleSync → engine.syncTo with a JS-computed phase) and the mixer
 * runs outside React (lib/mixBus applies xfade). The controller just sequences
 * load → start → sync → crossfade-sweep → swap, deck A ↔ B, down the queue.
 *
 * Timing/curve maths live in lib/automixPlan.ts (pure, unit-tested); this file
 * holds the imperative loop and the small reactive state the UI shows.
 */

import { create } from 'zustand'
import type { Track } from '@shared/types'
import { useDeckAStore, useDeckBStore, type DeckStore } from './playerStore'
import { useMixerStore } from './mixerStore'
import { scoreTransition } from '../lib/automix'
import {
  transitionBarsForBand,
  barsToMs,
  crossfadeAt,
  xfadeForDeck,
  entryCueMs
} from '../lib/automixPlan'

type AutomixPhase = 'idle' | 'playing' | 'transition'

interface AutomixState {
  active: boolean
  phase: AutomixPhase
  master: 'A' | 'B'
  queue: Track[]
  /** Index of the track currently playing on the master deck. */
  index: number
  /** Default blend length in bars for a clean ("auto") transition. */
  baseBars: number
  nextTitle: string | null
  /**
   * Start auto-mixing a queue of tracks from `startIndex`. Loads the first track
   * on deck A and blends forward. `baseBars` sets the clean-blend length.
   */
  start: (queue: Track[], startIndex?: number, baseBars?: number) => Promise<void>
  stop: () => void
}

// Module-level handles for the live loop (one automix runs at a time).
let _unsub: (() => void) | null = null
let _raf: number | null = null
let _transitioning = false

export const useAutomixStore = create<AutomixState>((set, get) => {
  const api = (d: 'A' | 'B'): DeckStore => (d === 'A' ? useDeckAStore : useDeckBStore).getState()
  const otherDeck = (d: 'A' | 'B'): 'A' | 'B' => (d === 'A' ? 'B' : 'A')

  const cleanup = (): void => {
    if (_unsub) { _unsub(); _unsub = null }
    if (_raf != null) { cancelAnimationFrame(_raf); _raf = null }
    _transitioning = false
  }

  // Re-point the per-tick watcher at whichever deck is currently master.
  const watchMaster = (): void => {
    if (_unsub) { _unsub(); _unsub = null }
    const store = get().master === 'A' ? useDeckAStore : useDeckBStore
    _unsub = store.subscribe((s) => onTick(s.currentTime, s.duration))
  }

  const onTick = (currentTime: number, duration: number): void => {
    if (!get().active || _transitioning || !duration || duration <= 0) return
    const { queue, index, baseBars } = get()
    const masterTrack = queue[index]
    const next = queue[index + 1]
    const remainingSec = duration - currentTime
    if (!masterTrack) return
    if (!next) {
      // Last track — end the session when it finishes.
      if (remainingSec <= 0.3) get().stop()
      return
    }
    const decision = scoreTransition(masterTrack, next)
    const bars = transitionBarsForBand(decision.band, baseBars)
    const leadMs = barsToMs(bars, masterTrack.bpm)
    if (remainingSec * 1000 <= leadMs) void beginTransition(bars)
  }

  const beginTransition = async (bars: number): Promise<void> => {
    if (_transitioning) return
    _transitioning = true
    set({ phase: 'transition' })
    const master = get().master
    const slave = otherDeck(master)
    const { queue, index } = get()
    const masterTrack = queue[index]
    const nextTrack = queue[index + 1]
    const durMs = barsToMs(bars, masterTrack.bpm)
    try {
      // Prep the incoming deck at its entry cue, paused; then start + beat-sync
      // it to the master so the two run phase-locked through the blend.
      await api(slave).loadTrack(nextTrack, { autoplay: false, startAtMs: entryCueMs(nextTrack) })
      if (!get().active) { _transitioning = false; return }
      api(slave).togglePlay() // paused → playing
      api(slave).toggleSync() // slave → master (beat-aligned)

      const fromX = xfadeForDeck(master)
      const toX = xfadeForDeck(slave)
      const t0 = performance.now()
      const step = (): void => {
        if (!get().active) return
        const elapsed = performance.now() - t0
        useMixerStore.getState().setXfade(crossfadeAt(elapsed, durMs, fromX, toX))
        if (elapsed >= durMs) { finishTransition(slave); return }
        _raf = requestAnimationFrame(step)
      }
      _raf = requestAnimationFrame(step)
    } catch {
      _transitioning = false
      set({ phase: 'playing' })
    }
  }

  const finishTransition = (slave: 'A' | 'B'): void => {
    const master = get().master
    // Outgoing deck stops; incoming deck releases sync and free-runs as the new
    // master (its matched rate is retained), and the crossfader rests fully on it.
    if (api(master).isPlaying) api(master).togglePlay()
    if (api(slave).synced) api(slave).toggleSync()
    useMixerStore.getState().setXfade(xfadeForDeck(slave))
    const index = get().index + 1
    _transitioning = false
    set({
      master: slave,
      index,
      phase: 'playing',
      nextTitle: get().queue[index + 1]?.title ?? null
    })
    watchMaster()
  }

  return {
    active: false,
    phase: 'idle',
    master: 'A',
    queue: [],
    index: 0,
    baseBars: 16,
    nextTitle: null,

    start: async (queue, startIndex = 0, baseBars = 16) => {
      if (!queue.length) return
      cleanup()
      const master: 'A' | 'B' = 'A'
      const mx = useMixerStore.getState()
      mx.setXfade(xfadeForDeck(master))
      set({
        active: true,
        phase: 'playing',
        master,
        queue,
        index: startIndex,
        baseBars,
        nextTitle: queue[startIndex + 1]?.title ?? null
      })
      await api(master).loadTrack(queue[startIndex], { autoplay: true })
      watchMaster()
    },

    stop: () => {
      cleanup()
      set({ active: false, phase: 'idle', nextTitle: null })
    }
  }
})
