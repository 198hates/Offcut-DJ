// Mobile deck transport — the desktop player's controls that actually work on a
// streamed-file audition (no engine DSP): cue, hot-cue pads, beat jump, beat
// loops, tempo (with keylock) and volume. EQ/filter/FX/sync/crossfader/stems are
// deck-engine features and intentionally absent.

import { useEffect, useRef, useState } from 'react'
import { LayoutChangeEvent, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native'
import type { AudioPlayer } from 'expo-audio'
import { C, MONO, MONO_BOLD } from './theme'
import { hotCueAt, setHotCue, removeHotCue } from './edits'
import type { CompactGrid, CuePoint, Track } from './sync-types'

interface Status {
  playing: boolean
  currentTime: number
  duration: number
  isLoaded: boolean
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))

function mmss(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const s = Math.floor(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function TransportControls({
  track,
  player,
  status,
  cues,
  onCommitCues,
  grid
}: {
  track: Track
  player: AudioPlayer
  status: Status
  cues: CuePoint[]
  onCommitCues: (next: CuePoint[]) => void
  grid?: CompactGrid | null
}): JSX.Element {
  const dur = status.duration || track.durationSeconds || 0
  // Prefer the analysed grid's BPM so loop lengths line up with the beat lines.
  const bpm = grid && grid.bpm > 0 ? grid.bpm : track.bpm && track.bpm > 0 ? track.bpm : 0
  const beatLen = bpm > 0 ? 60 / bpm : 0
  const seek = (t: number): void => void player.seekTo(Math.max(0, Math.min(dur || t, t)))

  // ── quantize (snap to the nearest beat; needs the grid) ──
  const [quantize, setQuantize] = useState(false)
  const snap = (sec: number): number => {
    if (!quantize || !grid || grid.bpm <= 0) return sec
    const beatSec = 60 / grid.bpm
    const first = grid.firstBeatMs / 1000
    return Math.max(0, first + Math.round((sec - first) / beatSec) * beatSec)
  }

  // ── main cue (ephemeral) ──
  const [mainCue, setMainCue] = useState<number | null>(null)
  useEffect(() => setMainCue(null), [track.id])
  const pressCue = (): void => {
    if (mainCue == null) { setMainCue(status.currentTime); return }
    if (status.playing) { seek(mainCue); player.pause() }
    else if (Math.abs(status.currentTime - mainCue) < 0.1) player.play()
    else seek(mainCue)
  }

  // ── tempo + keylock ──
  const [rate, setRate] = useState(1)
  const [keylock, setKeylock] = useState(true)
  const [range, setRange] = useState(8) // ±%
  useEffect(() => setRate(1), [track.id])
  useEffect(() => {
    player.shouldCorrectPitch = keylock
    player.setPlaybackRate(rate, keylock ? 'high' : 'low')
  }, [rate, keylock, player])

  // ── volume ──
  const [vol, setVol] = useState(1)
  useEffect(() => { player.volume = vol }, [vol, player])

  // ── loop (enforced by watching the clock — no engine region loop) ──
  const [loop, setLoop] = useState<{ s: number; e: number } | null>(null)
  useEffect(() => setLoop(null), [track.id])
  useEffect(() => {
    if (loop && status.playing && status.currentTime >= loop.e) seek(loop.s)
  }) // runs each status tick
  const beatLoop = (bars: number): void => {
    if (!beatLen) return
    const s = snap(status.currentTime)
    setLoop({ s, e: s + bars * beatLen * 4 })
    // Jump to the (snapped) start so the loop plays the grid-aligned region from
    // the top, rather than continuing from where you tapped until the first wrap.
    if (Math.abs(s - status.currentTime) > 0.02) seek(s)
  }
  const loopIn = (): void => setLoop((l) => ({ s: snap(status.currentTime), e: l?.e ?? snap(status.currentTime) + beatLen * 4 }))
  const loopOut = (): void => setLoop((l) => (l ? { ...l, e: status.currentTime } : null))

  // ── hot cues ──
  const onPad = (i: number): void => {
    const c = hotCueAt(cues, i)
    if (c) seek(c.positionMs / 1000)
    else onCommitCues(setHotCue(cues, i, snap(status.currentTime) * 1000))
  }
  const onPadLong = (i: number): void => {
    if (hotCueAt(cues, i)) onCommitCues(removeHotCue(cues, i))
  }

  const rateToVal = (r: number): number => clamp01((r - 1) / (range / 100) / 2 + 0.5)
  const valToRate = (v: number): number => 1 + (v - 0.5) * 2 * (range / 100)
  const ratePct = `${rate >= 1 ? '+' : ''}${((rate - 1) * 100).toFixed(1)}%`

  // ── which lower panel is showing (rekordbox-style mode bar) ──
  const [mode, setMode] = useState<Mode>('cues')
  // tap the time to flip elapsed ↔ remaining (remaining shows red, like rekordbox)
  const [showRemaining, setShowRemaining] = useState(false)

  return (
    <View style={styles.wrap}>
      {/* transport — centred circular CUE + PLAY, time left, QUANT right */}
      <View style={styles.transport}>
        <Pressable style={styles.time} onPress={() => setShowRemaining((r) => !r)} hitSlop={8}>
          <Text style={[styles.timeMain, showRemaining && styles.timeRemain]}>
            {showRemaining ? `-${mmss(Math.max(0, dur - status.currentTime))}` : mmss(status.currentTime)}
          </Text>
          <Text style={styles.timeTotal}>{mmss(dur)}</Text>
        </Pressable>
        <View style={styles.transCenter}>
          <Pressable style={styles.cueCircle} onPress={pressCue} onLongPress={() => setMainCue(status.currentTime)}>
            <Text style={styles.cueTxt}>CUE</Text>
          </Pressable>
          <Pressable style={styles.playCircle} onPress={() => (status.playing ? player.pause() : player.play())} disabled={!status.isLoaded}>
            {status.playing ? (
              <View style={styles.pauseRow}>
                <View style={styles.pauseBar} />
                <View style={styles.pauseBar} />
              </View>
            ) : (
              <View style={styles.playTriangle} />
            )}
          </Pressable>
        </View>
        <View style={styles.transRight}>
          <Pressable
            style={[styles.miniBtn, quantize && styles.miniOn, !grid && styles.faded]}
            disabled={!grid}
            onPress={() => setQuantize((q) => !q)}
          >
            <Text style={[styles.miniTxt, quantize && styles.miniTxtOn]}>QUANT</Text>
          </Pressable>
        </View>
      </View>

      {/* mode bar */}
      <View style={styles.tabs}>
        {(['cues', 'loop', 'tempo'] as Mode[]).map((m) => (
          <Pressable key={m} style={[styles.tab, mode === m && styles.tabOn]} onPress={() => setMode(m)}>
            <Text style={[styles.tabTxt, mode === m && styles.tabTxtOn]}>{MODE_LABELS[m]}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.panel}>
        {mode === 'cues' && (
          <>
            <View style={styles.pads}>
              {Array.from({ length: 8 }, (_, i) => {
                const c = hotCueAt(cues, i)
                return (
                  <Pressable
                    key={i}
                    style={[styles.pad, c ? { backgroundColor: c.color, borderColor: c.color } : null]}
                    onPress={() => onPad(i)}
                    onLongPress={() => onPadLong(i)}
                    disabled={!status.isLoaded}
                  >
                    <Text style={[styles.padLabel, c ? styles.padLabelOn : null]}>{'ABCDEFGH'[i]}</Text>
                    {c && <Text style={styles.padTime}>{mmss(c.positionMs / 1000)}</Text>}
                  </Pressable>
                )
              })}
            </View>
            <Text style={styles.hint}>tap empty = set · tap filled = jump · hold = clear</Text>
            <View style={[styles.groupHead, { marginTop: 6 }]}>
              <Text style={styles.groupLabel}>{beatLen ? 'BEAT JUMP' : 'BEAT JUMP · no BPM'}</Text>
            </View>
            <View style={styles.btnRow}>
              {[-4, -1, 1, 4].map((b) => (
                <Pressable key={b} style={styles.jumpBtn} disabled={!beatLen} onPress={() => seek(status.currentTime + b * beatLen)}>
                  <Text style={[styles.jumpTxt, !beatLen && styles.disabled]}>{b > 0 ? `+${b}` : b}</Text>
                </Pressable>
              ))}
            </View>
          </>
        )}

        {mode === 'loop' && (
          <>
            <View style={styles.groupHead}>
              <Text style={styles.groupLabel}>LOOP {loop ? '· active' : ''}</Text>
            </View>
            <View style={styles.btnRow}>
              <Pressable style={[styles.loopBtn, loop && styles.loopOn]} onPress={loopIn}><Text style={styles.loopTxt}>IN</Text></Pressable>
              <Pressable style={[styles.loopBtn, loop && styles.loopOn]} onPress={loopOut}><Text style={styles.loopTxt}>OUT</Text></Pressable>
              {[1, 2, 4].map((bars) => (
                <Pressable key={bars} style={styles.loopBtn} disabled={!beatLen} onPress={() => beatLoop(bars)}>
                  <Text style={[styles.loopTxt, !beatLen && styles.disabled]}>{bars}</Text>
                </Pressable>
              ))}
              <Pressable style={[styles.loopBtn, !loop && styles.faded]} disabled={!loop} onPress={() => setLoop(null)}>
                <Text style={styles.loopTxt}>✕</Text>
              </Pressable>
            </View>
            <Text style={styles.hint}>IN/OUT = manual · 1/2/4 = bar loops{quantize ? ' · quantised' : ''}</Text>
          </>
        )}

        {mode === 'tempo' && (
          <>
            <Group label="TEMPO" value={ratePct}>
              <View style={styles.faderRow}>
                <Fader value={rateToVal(rate)} onChange={(v) => setRate(+valToRate(v).toFixed(3))} fill="#4E7090" />
                <Pressable style={styles.miniBtn} onPress={() => setRange((r) => (r === 8 ? 16 : r === 16 ? 50 : r === 50 ? 4 : 8))}>
                  <Text style={styles.miniTxt}>±{range}</Text>
                </Pressable>
                <Pressable style={[styles.miniBtn, keylock && styles.miniOn]} onPress={() => setKeylock((k) => !k)}>
                  <Text style={[styles.miniTxt, keylock && styles.miniTxtOn]}>KEY</Text>
                </Pressable>
                <Pressable style={styles.miniBtn} onPress={() => setRate(1)}>
                  <Text style={styles.miniTxt}>0</Text>
                </Pressable>
              </View>
            </Group>
            <Group label="VOLUME" value={`${Math.round(vol * 100)}%`}>
              <Fader value={vol} onChange={setVol} fill={C.accent} />
            </Group>
          </>
        )}
      </View>
    </View>
  )
}

type Mode = 'cues' | 'loop' | 'tempo'
const MODE_LABELS: Record<Mode, string> = { cues: 'HOT CUES', loop: 'LOOP', tempo: 'TEMPO' }

function Group({ label, value, children }: { label: string; value?: string; children: React.ReactNode }): JSX.Element {
  return (
    <View style={styles.group}>
      <View style={styles.groupHead}>
        <Text style={styles.groupLabel}>{label}</Text>
        {value !== undefined && <Text style={styles.groupValue}>{value}</Text>}
      </View>
      {children}
    </View>
  )
}

function Fader({ value, onChange, fill = C.accent }: { value: number; onChange: (v: number) => void; fill?: string }): JSX.Element {
  const wRef = useRef(0)
  const cbRef = useRef(onChange)
  cbRef.current = onChange
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => { const w = wRef.current; if (w > 0) cbRef.current(clamp01(e.nativeEvent.locationX / w)) },
      onPanResponderMove: (e) => { const w = wRef.current; if (w > 0) cbRef.current(clamp01(e.nativeEvent.locationX / w)) }
    })
  ).current
  const onLayout = (e: LayoutChangeEvent): void => { wRef.current = e.nativeEvent.layout.width }
  return (
    <View style={styles.fader} onLayout={onLayout} {...pan.panHandlers}>
      <View style={styles.faderTrackLine} />
      <View style={[styles.faderFill, { width: `${value * 100}%`, backgroundColor: fill }]} />
      <View style={[styles.faderThumb, { left: `${value * 100}%` }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },

  // transport
  transport: { flexDirection: 'row', alignItems: 'center' },
  time: { width: 92 },
  timeMain: { color: C.ink, fontFamily: MONO_BOLD, fontSize: 15, fontVariant: ['tabular-nums'] },
  timeRemain: { color: C.rec },
  timeTotal: { color: C.muted, fontFamily: MONO, fontSize: 11, fontVariant: ['tabular-nums'], marginTop: 1 },
  transCenter: { flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 20 },
  transRight: { width: 92, alignItems: 'flex-end' },
  cueCircle: { width: 56, height: 56, borderRadius: 28, borderWidth: 1.5, borderColor: '#C9A02C', alignItems: 'center', justifyContent: 'center' },
  cueTxt: { color: '#C9A02C', fontFamily: MONO_BOLD, fontSize: 12, letterSpacing: 1 },
  playCircle: { width: 64, height: 64, borderRadius: 32, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  playTriangle: {
    width: 0, height: 0, marginLeft: 5,
    borderTopWidth: 12, borderBottomWidth: 12, borderLeftWidth: 20,
    borderTopColor: 'transparent', borderBottomColor: 'transparent', borderLeftColor: C.bg
  },
  pauseRow: { flexDirection: 'row', gap: 6 },
  pauseBar: { width: 6, height: 22, borderRadius: 1, backgroundColor: C.bg },

  // mode bar + panel
  tabs: { flexDirection: 'row', backgroundColor: C.deckPanel, borderRadius: 8, padding: 3, gap: 3 },
  tab: { flex: 1, paddingVertical: 8, borderRadius: 6, alignItems: 'center' },
  tabOn: { backgroundColor: C.panel },
  tabTxt: { color: C.muted, fontFamily: MONO, fontSize: 11, letterSpacing: 1 },
  tabTxtOn: { color: C.accent },
  panel: { minHeight: 150, gap: 10 },

  group: { gap: 8 },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  groupLabel: { color: C.muted, fontFamily: MONO, fontSize: 9, letterSpacing: 1.6, flex: 1 },
  groupValue: { color: C.accent, fontFamily: MONO_BOLD, fontSize: 11, fontVariant: ['tabular-nums'] },

  pads: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pad: {
    width: '23%', flexGrow: 1, height: 46, borderRadius: 6, borderWidth: 1, borderColor: C.border,
    backgroundColor: C.paper, alignItems: 'center', justifyContent: 'center'
  },
  padLabel: { color: C.muted, fontFamily: MONO_BOLD, fontSize: 15 },
  padLabelOn: { color: C.bg },
  padTime: { color: C.bg, fontFamily: MONO, fontSize: 9, marginTop: 1, opacity: 0.8 },
  hint: { color: C.muted, fontFamily: MONO, fontSize: 9, opacity: 0.7 },

  btnRow: { flexDirection: 'row', gap: 6 },
  jumpBtn: { flex: 1, height: 38, borderRadius: 6, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  jumpTxt: { color: C.ink, fontFamily: MONO, fontSize: 13 },
  loopBtn: { flex: 1, height: 38, borderRadius: 6, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  loopOn: { borderColor: '#B84A2B' },
  loopTxt: { color: C.ink, fontFamily: MONO, fontSize: 13 },
  faded: { opacity: 0.4 },
  disabled: { color: C.border },

  faderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fader: { flex: 1, height: 30, justifyContent: 'center' },
  faderTrackLine: { position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 2, backgroundColor: C.border },
  faderFill: { position: 'absolute', left: 0, height: 4, borderRadius: 2 },
  faderThumb: { position: 'absolute', width: 14, height: 22, borderRadius: 4, marginLeft: -7, backgroundColor: C.ink },
  miniBtn: { paddingHorizontal: 10, height: 30, borderRadius: 6, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  miniOn: { backgroundColor: '#D86A4A22', borderColor: C.accent },
  miniTxt: { color: C.muted, fontFamily: MONO, fontSize: 11 },
  miniTxtOn: { color: C.accent }
})
