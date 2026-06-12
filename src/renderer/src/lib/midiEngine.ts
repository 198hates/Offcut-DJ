/**
 * MIDI Engine — Web MIDI API singleton.
 *
 * Reads mappings from useMidiStore and dispatches incoming MIDI messages
 * to the correct player / mixer store actions.
 *
 * Usage (call once in App.tsx):
 *   import { midiEngine } from './lib/midiEngine'
 *   midiEngine.init()
 */

import { useMidiStore, type MidiMapping } from '../store/midiStore'
import { useDeckAStore, useDeckBStore } from '../store/playerStore'
import { useMixerStore } from '../store/mixerStore'

// ── Value helpers ─────────────────────────────────────────────────────────────

/** Continuous control → 0.0–1.0. Handles 7-bit CC (0-127) and 14-bit
 *  pitchbend (0-16383) — hardware pitch faders usually send pitchbend. */
const toUnit = (v: number) => Math.max(0, Math.min(1, v > 127 ? v / 16383 : v / 127))

/** 0–1 → EQ dB, centre-split: 0.5 = 0 dB, 0 = −24 dB, 1 = +6 dB */
function unitToEqDb(u: number): number {
  return u <= 0.5 ? u * 2 * 24 - 24 : (u - 0.5) * 2 * 6
}

/** 0–1 → playback rate within the deck's pitch range (centre = 1.0).
 *  Mapping the full 0.5–2.0 contract range here made ~84% of a hardware
 *  fader's travel dead — setPlaybackRate clamps to ±pitchRange%. */
function unitToPitch(u: number, rangePct: number): number {
  const limit = rangePct / 100
  return u <= 0.5 ? 1 - (1 - u * 2) * limit : 1 + (u - 0.5) * 2 * limit
}

// ── Action dispatch ───────────────────────────────────────────────────────────

function dispatch(actionId: string, rawValue: number): void {
  // rawValue: 0-127 for note/CC, 0-16383 for pitchbend

  // ── Deck A ──────────────────────────────────────────────────────────────────
  if (actionId.startsWith('deck-A-')) {
    const sub = actionId.slice('deck-A-'.length)
    const storeA = useDeckAStore.getState()

    if (sub === 'play'       && rawValue > 0) { storeA.togglePlay(); return }
    if (sub === 'cue'        && rawValue > 0) { storeA.pressCue(); return }
    if (sub === 'loop-in'    && rawValue > 0) { storeA.setLoopIn(); return }
    if (sub === 'loop-out'   && rawValue > 0) { storeA.setLoopOut(); return }
    if (sub === 'loop-toggle'&& rawValue > 0) { storeA.toggleLoop(); return }
    if (sub === 'beatloop-1' && rawValue > 0) { storeA.beatLoop(1); return }
    if (sub === 'beatloop-2' && rawValue > 0) { storeA.beatLoop(2); return }
    if (sub === 'beatloop-4' && rawValue > 0) { storeA.beatLoop(4); return }
    if (sub === 'beatloop-8' && rawValue > 0) { storeA.beatLoop(8); return }
    if (sub === 'volume')                     { useMixerStore.getState().setVolA(toUnit(rawValue)); return }
    if (sub === 'eq-high')                    { storeA.setEq('high', unitToEqDb(toUnit(rawValue))); return }
    if (sub === 'eq-mid')                     { storeA.setEq('mid',  unitToEqDb(toUnit(rawValue))); return }
    if (sub === 'eq-low')                     { storeA.setEq('low',  unitToEqDb(toUnit(rawValue))); return }
    if (sub === 'pitch')                      { storeA.setPlaybackRate(unitToPitch(toUnit(rawValue), storeA.pitchRange)); return }

    // Hot cues deck-A-hotcue-N
    const hcMatch = sub.match(/^hotcue-(\d)$/)
    if (hcMatch && rawValue > 0) { storeA.jumpToCue(parseInt(hcMatch[1])); return }
  }

  // ── Deck B ──────────────────────────────────────────────────────────────────
  if (actionId.startsWith('deck-B-')) {
    const sub = actionId.slice('deck-B-'.length)
    const storeB = useDeckBStore.getState()

    if (sub === 'play'       && rawValue > 0) { storeB.togglePlay(); return }
    if (sub === 'cue'        && rawValue > 0) { storeB.pressCue(); return }
    if (sub === 'loop-in'    && rawValue > 0) { storeB.setLoopIn(); return }
    if (sub === 'loop-out'   && rawValue > 0) { storeB.setLoopOut(); return }
    if (sub === 'loop-toggle'&& rawValue > 0) { storeB.toggleLoop(); return }
    if (sub === 'beatloop-1' && rawValue > 0) { storeB.beatLoop(1); return }
    if (sub === 'beatloop-2' && rawValue > 0) { storeB.beatLoop(2); return }
    if (sub === 'beatloop-4' && rawValue > 0) { storeB.beatLoop(4); return }
    if (sub === 'beatloop-8' && rawValue > 0) { storeB.beatLoop(8); return }
    if (sub === 'volume')                     { useMixerStore.getState().setVolB(toUnit(rawValue)); return }
    if (sub === 'eq-high')                    { storeB.setEq('high', unitToEqDb(toUnit(rawValue))); return }
    if (sub === 'eq-mid')                     { storeB.setEq('mid',  unitToEqDb(toUnit(rawValue))); return }
    if (sub === 'eq-low')                     { storeB.setEq('low',  unitToEqDb(toUnit(rawValue))); return }
    if (sub === 'pitch')                      { storeB.setPlaybackRate(unitToPitch(toUnit(rawValue), storeB.pitchRange)); return }

    const hcMatch = sub.match(/^hotcue-(\d)$/)
    if (hcMatch && rawValue > 0) { storeB.jumpToCue(parseInt(hcMatch[1])); return }
  }

  // ── Mixer ────────────────────────────────────────────────────────────────────
  if (actionId === 'mixer-xfade') {
    useMixerStore.getState().setXfade(toUnit(rawValue))
  }
}

// ── Key builders (for mapping lookup) ────────────────────────────────────────

function mappingKey(m: MidiMapping): string {
  if (m.messageType === 'pitchbend') return `pb:${m.channel}`
  return `${m.messageType}:${m.channel}:${m.number}`
}

function messageKey(status: number, data1: number): string {
  const type = (status >> 4)
  const ch   = status & 0x0F
  if (type === 0xE) return `pb:${ch}`
  if (type === 0xB) return `cc:${ch}:${data1}`
  if (type === 0x9 || type === 0x8) return `note:${ch}:${data1}`
  return `${type}:${ch}:${data1}`
}

// ── MIDI Engine class ─────────────────────────────────────────────────────────

class MidiEngine {
  private access: MIDIAccess | null = null
  /** messageKey → actionId for fast lookup */
  private index: Map<string, string> = new Map()

  async init(): Promise<void> {
    if (typeof navigator === 'undefined' || !('requestMIDIAccess' in navigator)) {
      console.warn('[MIDI] Web MIDI not available in this environment')
      return
    }
    try {
      this.access = await (navigator as Navigator & {
        requestMIDIAccess: (opts?: MIDIOptions) => Promise<MIDIAccess>
      }).requestMIDIAccess({ sysex: false })

      this.access.onstatechange = () => this._refreshInputs()
      this._refreshInputs()

      // Rebuild index whenever mappings change
      useMidiStore.subscribe((state) => {
        this._rebuildIndex(state.mappings)
      })

      // Build initial index
      this._rebuildIndex(useMidiStore.getState().mappings)
    } catch (err) {
      console.warn('[MIDI] Could not obtain MIDI access:', err)
    }
  }

  private _refreshInputs(): void {
    if (!this.access) return
    const names: string[] = []
    for (const input of this.access.inputs.values()) {
      names.push(input.name ?? `Device ${input.id}`)
      input.onmidimessage = (e) => this._handleMessage(e)
    }
    useMidiStore.getState().setConnectedDevices(names)
  }

  private _rebuildIndex(mappings: Record<string, MidiMapping>): void {
    this.index.clear()
    for (const [actionId, m] of Object.entries(mappings)) {
      this.index.set(mappingKey(m), actionId)
    }
  }

  private _handleMessage(e: MIDIMessageEvent): void {
    const data = e.data
    if (!data || data.length < 2) return

    const [status, data1, data2 = 0] = data
    const msgType = (status >> 4)

    // Ignore active sensing / clock / sysex
    if (status >= 0xF0) return

    // ── Learn mode ───────────────────────────────────────────────────────────
    const { learningActionId, setMapping, stopLearning } = useMidiStore.getState()
    if (learningActionId) {
      // Only capture meaningful events (not note-off with velocity 0 from prior state)
      const isNoteOff = (msgType === 0x8) || (msgType === 0x9 && data2 === 0)
      if (!isNoteOff) {
        const ch = status & 0x0F
        let messageType: MidiMapping['messageType']
        let number = data1

        if (msgType === 0x9 || msgType === 0x8) { messageType = 'note' }
        else if (msgType === 0xB)               { messageType = 'cc'   }
        else if (msgType === 0xE)               { messageType = 'pitchbend'; number = 0 }
        else return  // unrecognised message type; keep waiting

        // The event's target is the MIDIInput that delivered the message.
        const deviceName = (e.target as MIDIInput | null)?.name ?? undefined

        setMapping(learningActionId, { channel: ch, messageType, number, deviceName })
        stopLearning()
      }
      return
    }

    // ── Normal dispatch ───────────────────────────────────────────────────────
    const { enabled } = useMidiStore.getState()
    if (!enabled) return

    const key = messageKey(status, data1)
    const actionId = this.index.get(key)
    if (!actionId) return

    // Compute the raw value for dispatch
    let rawValue: number
    if (msgType === 0xE) {
      // Pitch bend: 14-bit value, LSB in data1, MSB in data2
      rawValue = ((data2 & 0x7F) << 7) | (data1 & 0x7F)
    } else if (msgType === 0x8 || (msgType === 0x9 && data2 === 0)) {
      // Note off → value 0 (so button actions check > 0 and won't fire)
      rawValue = 0
    } else {
      rawValue = data2   // velocity for note-on, or CC value
    }

    dispatch(actionId, rawValue)
  }
}

export const midiEngine = new MidiEngine()
