/**
 * Automix execution — an auto-DJ that blends each track into the next via the
 * native engine's beat-sync + the crossfader.
 *
 * Two modes:
 *   - ordered:     play a fixed queue (a running order) in sequence.
 *   - auto-select: play one seed track, then pick each following track itself
 *                  from a candidate pool by transition compatibility.
 *
 * This is pure renderer orchestration: the Rust engine already does beat-aligned
 * sync (deck.toggleSync → engine.syncTo with a JS-computed phase) and the mixer
 * runs outside React (lib/mixBus applies xfade). The controller just sequences
 * load → start → sync → crossfade-sweep → swap, deck A ↔ B.
 *
 * Timing/curve/selection maths live in lib/automixPlan.ts (pure, unit-tested);
 * this file holds the imperative loop and the small reactive state the UI shows.
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
  entryCueMs,
  pickNextTrack
} from '../lib/automixPlan'

type AutomixPhase = 'idle' | 'playing' | 'transition'

interface AutomixStartOptions {
  /** Pick each next track from `pool` by compatibility instead of stepping a queue. */
  autoSelect?: boolean
  /** Candidate library for auto-select mode. */
  pool?: Track[]
}

interface AutomixState {
  active: boolean
  phase: AutomixPhase
  master: 'A' | 'B'
  /** History of tracks played this session (the seed, then each pick/step). */
  queue: Track[]
  /** Index of the track currently playing on the master deck. */
  index: number
  /** True when the controller chooses its own tracks from the pool. */
  autoSelect: boolean
  /** Default blend length in bars for a clean ("auto") transition. */
  baseBars: number
  nextTitle: string | null
  /**
   * Start auto-mixing. In ordered mode `queue` is the full running order and
   * `startIndex` the first track. In auto-select mode (`opts.autoSelect`),
   * `queue[startIndex]` is the seed and `opts.pool` the candidate library.
   */
  start: (queue: Track[], startIndex?: number, baseBars?: number, opts?: AutomixStartOptions) => Promise<void>
  stop: () => void
}

// Module-level handles for the live loop (one automix runs at a time).
let _unsub: (() => void) | null = null
let _raf: number | null = null
let _transitioning = false
// Auto-select working set: candidate pool, what's already played, and the
// pre-computed next pick (computed once per track, not per tick).
let _pool: Track[] = []
let _played: Set<string> = new Set()
let _plannedNext: Track | null = null

export const useAutomixStore = create<AutomixState>((set, get) => {
  const api = (d: 'A' | 'B'): DeckStore => (d === 'A' ? useDeckAStore : useDeckBStore).getState()
  const otherDeck = (d: 'A' | 'B'): 'A' | 'B' => (d === 'A' ? 'B' : 'A')

  const cleanup = (): void => {
    if (_unsub) { _unsub(); _unsub = null }
    if (_raf != null) { cancelAnimationFrame(_raf); _raf = null }
    _transitioning = false
    _plannedNext = null
  }

  // Compute the next track for `masterTrack` (once per track, not per tick) and
  // reflect it in the UI. Auto-select picks from the pool; ordered reads the queue.
  const planNext = (masterTrack: Track): void => {
    if (get().autoSelect) {
      _plannedNext = pickNextTrack(masterTrack, _pool, _played)
    } else {
      const { queue, index } = get()
      _plannedNext = queue[index + 1] ?? null
    }
    set({ nextTitle: _plannedNext?.title ?? null })
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
    const next = _plannedNext
    const remainingSec = duration - currentTime
    if (!masterTrack) return
    if (!next) {
      // No next track (queue done, or pool exhausted) — end when this one finishes.
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
    const nextTrack = _plannedNext
    if (!nextTrack) { _transitioning = false; set({ phase: 'playing' }); return }
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

    const incoming = _plannedNext
    // Auto-select grows the history with the track we just brought in; ordered
    // mode already has it at index+1.
    const queue = get().autoSelect && incoming ? [...get().queue, incoming] : get().queue
    const index = get().index + 1
    _transitioning = false
    set({ master: slave, index, queue, phase: 'playing' })

    const newMaster = queue[index]
    if (newMaster) {
      _played.add(newMaster.id) // never pick a track that's already playing
      planNext(newMaster)
    }
    watchMaster()
  }

  return {
    active: false,
    phase: 'idle',
    master: 'A',
    queue: [],
    index: 0,
    autoSelect: false,
    baseBars: 16,
    nextTitle: null,

    start: async (queue, startIndex = 0, baseBars = 16, opts) => {
      const seed = queue[startIndex]
      if (!seed) return
      cleanup()
      const autoSelect = !!opts?.autoSelect
      _pool = autoSelect ? (opts?.pool ?? []) : []
      _played = new Set([seed.id])
      const master: 'A' | 'B' = 'A'
      useMixerStore.getState().setXfade(xfadeForDeck(master))
      // Auto-select tracks only history (starts with the seed); ordered uses the
      // full queue with its own start index.
      set({
        active: true,
        phase: 'playing',
        master,
        queue: autoSelect ? [seed] : queue,
        index: autoSelect ? 0 : startIndex,
        autoSelect,
        baseBars,
        nextTitle: null
      })
      await api(master).loadTrack(seed, { autoplay: true })
      planNext(get().queue[get().index])
      watchMaster()
    },

    stop: () => {
      cleanup()
      _pool = []
      _played = new Set()
      set({ active: false, phase: 'idle', nextTitle: null })
    }
  }
})
