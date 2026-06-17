// Prep-edit panel (slice 3): rating, energy, mood, colour, tags, comment and
// hot cues — pushed to the desktop via /sync/push (last-writer-wins). Hot cues
// hook into the audition player: "set at playhead" captures the current time,
// tapping a cue seeks there.

import { useEffect, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import type { AudioPlayer } from 'expo-audio'
import {
  TRACK_COLORS,
  MOOD_STEPS,
  draftFromTrack,
  buildPatch,
  patchAsTrackFields,
  hotCues,
  addHotCue,
  removeHotCue,
  type Draft
} from './edits'
import type { SyncClient } from './syncClient'
import type { Track } from './sync-types'

function mmss(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const s = Math.floor(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const MOOD_LABELS: Record<string, string> = { '-1': 'dark', '-0.5': '', '0': 'neutral', '0.5': '', '1': 'uplift' }

export function TrackEditor({
  track,
  client,
  player,
  playheadSec,
  onPatched
}: {
  track: Track
  client: SyncClient
  player: AudioPlayer
  playheadSec: number
  onPatched: (id: string, fields: Partial<Track>) => void
}): JSX.Element {
  // `baseline` is what the desktop last confirmed; `draft` is the live edit.
  const [baseline, setBaseline] = useState<Track>(track)
  const [draft, setDraft] = useState<Draft>(() => draftFromTrack(track))
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // New track selected → reset both.
  useEffect(() => {
    setBaseline(track)
    setDraft(draftFromTrack(track))
    setMsg(null)
  }, [track.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const patch = useMemo(() => buildPatch(baseline, draft, 'probe'), [baseline, draft])
  const dirty = patch !== null

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }))
    setMsg(null)
  }

  const save = async (): Promise<void> => {
    const p = buildPatch(baseline, draft, new Date().toISOString())
    if (!p) return
    setSaving(true)
    setMsg(null)
    try {
      const res = await client.push({ tracks: [p] })
      if (res.appliedTracks > 0) {
        const fields = patchAsTrackFields(p)
        onPatched(track.id, fields)
        setBaseline((b) => ({ ...b, ...fields }))
        setMsg('Saved to desktop ✓')
      } else {
        setMsg('Desktop has newer changes — go back and pull to refresh.')
      }
    } catch (e) {
      setMsg(`Couldn't save — ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const cues = hotCues(draft.cuePoints)

  return (
    <View style={styles.wrap}>
      {/* Rating */}
      <Field label="RATING">
        <View style={styles.row}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Pressable key={n} hitSlop={6} onPress={() => set('rating', draft.rating === n ? 0 : n)}>
              <Text style={[styles.star, n <= draft.rating && styles.starOn]}>★</Text>
            </Pressable>
          ))}
        </View>
      </Field>

      {/* Energy 1–10 */}
      <Field label="ENERGY">
        <View style={styles.cells}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <Pressable
              key={n}
              style={[styles.cell, draft.energy === n && styles.cellOn]}
              onPress={() => set('energy', draft.energy === n ? null : n)}
            >
              <Text style={[styles.cellTxt, draft.energy === n && styles.cellTxtOn]}>{n}</Text>
            </Pressable>
          ))}
        </View>
      </Field>

      {/* Mood −1 → +1 */}
      <Field label="MOOD">
        <View style={styles.row}>
          {MOOD_STEPS.map((m) => {
            const on = draft.mood !== null && Math.abs(draft.mood - m) < 0.01
            return (
              <Pressable
                key={m}
                style={[styles.moodCell, on && styles.cellOn]}
                onPress={() => set('mood', on ? null : m)}
              >
                <Text style={[styles.cellTxt, on && styles.cellTxtOn]}>
                  {MOOD_LABELS[String(m)] || (m > 0 ? '+' : '−')}
                </Text>
              </Pressable>
            )
          })}
        </View>
      </Field>

      {/* Colour */}
      <Field label="COLOUR">
        <View style={styles.row}>
          <Pressable
            style={[styles.swatch, styles.swatchNone, draft.color === '' && styles.swatchOn]}
            onPress={() => set('color', '')}
          >
            <Text style={styles.noneX}>✕</Text>
          </Pressable>
          {TRACK_COLORS.map((c) => (
            <Pressable
              key={c}
              style={[styles.swatch, { backgroundColor: c }, draft.color === c && styles.swatchOn]}
              onPress={() => set('color', c)}
            />
          ))}
        </View>
      </Field>

      {/* Tags */}
      <Field label="TAGS">
        <TagEditor tags={draft.tags} onChange={(t) => set('tags', t)} />
      </Field>

      {/* Comment */}
      <Field label="COMMENT">
        <TextInput
          style={styles.comment}
          placeholder="Notes for this track…"
          placeholderTextColor="#6a6253"
          multiline
          value={draft.comment}
          onChangeText={(t) => set('comment', t)}
        />
      </Field>

      {/* Hot cues */}
      <Field label="HOT CUES">
        <View style={{ gap: 6 }}>
          {cues.length === 0 && <Text style={styles.dim}>No hot cues yet.</Text>}
          {cues.map((c) => (
            <View key={c.index} style={styles.cueRow}>
              <Pressable
                style={styles.cueMain}
                onPress={() => void player.seekTo(c.positionMs / 1000)}
              >
                <View style={[styles.cueDot, { backgroundColor: c.color || '#D86A4A' }]}>
                  <Text style={styles.cueLabel}>{c.label}</Text>
                </View>
                <Text style={styles.cueTime}>{mmss(c.positionMs / 1000)}</Text>
                <Text style={styles.cueGo}>tap to jump</Text>
              </Pressable>
              <Pressable hitSlop={8} onPress={() => set('cuePoints', removeHotCue(draft.cuePoints, c.index))}>
                <Text style={styles.cueDel}>✕</Text>
              </Pressable>
            </View>
          ))}
          {cues.length < 8 && (
            <Pressable
              style={styles.setCue}
              onPress={() => set('cuePoints', addHotCue(draft.cuePoints, playheadSec * 1000))}
            >
              <Text style={styles.setCueTxt}>＋ Set cue at {mmss(playheadSec)}</Text>
            </Pressable>
          )}
        </View>
      </Field>

      {/* Save */}
      <Pressable
        style={[styles.save, (!dirty || saving) && styles.saveDisabled]}
        disabled={!dirty || saving}
        onPress={save}
      >
        <Text style={styles.saveTxt}>{saving ? 'Saving…' : 'Save to desktop'}</Text>
      </Pressable>
      {msg && <Text style={styles.msg}>{msg}</Text>}
    </View>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  )
}

function TagEditor({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }): JSX.Element {
  const [entry, setEntry] = useState('')
  const add = (): void => {
    const fresh = entry
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !tags.includes(s))
    if (fresh.length) onChange([...tags, ...fresh])
    setEntry('')
  }
  return (
    <View>
      <View style={styles.chips}>
        {tags.map((t) => (
          <Pressable key={t} style={styles.chip} onPress={() => onChange(tags.filter((x) => x !== t))}>
            <Text style={styles.chipTxt}>{t} ✕</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.tagAddRow}>
        <TextInput
          style={styles.tagInput}
          placeholder="Add a tag"
          placeholderTextColor="#6a6253"
          autoCapitalize="none"
          autoCorrect={false}
          value={entry}
          onChangeText={setEntry}
          onSubmitEditing={add}
          returnKeyType="done"
        />
        <Pressable style={styles.tagAdd} onPress={add}>
          <Text style={styles.tagAddTxt}>Add</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 16, marginTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#2a261d', paddingTop: 18 },
  field: { gap: 8 },
  fieldLabel: { color: '#7a7264', fontSize: 10, letterSpacing: 1.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  star: { color: '#3a352b', fontSize: 28 },
  starOn: { color: '#C9A02C' },
  cells: { flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  cell: { width: 30, height: 34, borderRadius: 6, borderWidth: 1, borderColor: '#3a352b', alignItems: 'center', justifyContent: 'center' },
  moodCell: { paddingHorizontal: 12, height: 34, borderRadius: 6, borderWidth: 1, borderColor: '#3a352b', alignItems: 'center', justifyContent: 'center' },
  cellOn: { backgroundColor: '#D86A4A22', borderColor: '#D86A4A' },
  cellTxt: { color: '#a59a82', fontSize: 13 },
  cellTxtOn: { color: '#D86A4A', fontWeight: '700' },
  swatch: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: 'transparent' },
  swatchNone: { backgroundColor: '#1f1c15', alignItems: 'center', justifyContent: 'center' },
  swatchOn: { borderColor: '#ECE3CC' },
  noneX: { color: '#7a7264', fontSize: 13 },
  comment: {
    minHeight: 60,
    borderWidth: 1,
    borderColor: '#3a352b',
    borderRadius: 8,
    color: '#ECE3CC',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    textAlignVertical: 'top'
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  chip: { backgroundColor: '#2a261d', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  chipTxt: { color: '#ECE3CC', fontSize: 12 },
  tagAddRow: { flexDirection: 'row', gap: 8 },
  tagInput: { flex: 1, borderWidth: 1, borderColor: '#3a352b', borderRadius: 8, color: '#ECE3CC', paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  tagAdd: { backgroundColor: '#2a261d', borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
  tagAddTxt: { color: '#ECE3CC', fontSize: 13, fontWeight: '600' },
  dim: { color: '#7a7264', fontSize: 12 },
  cueRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cueMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  cueDot: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  cueLabel: { color: '#17150f', fontSize: 12, fontWeight: '800' },
  cueTime: { color: '#ECE3CC', fontSize: 14, fontVariant: ['tabular-nums'] },
  cueGo: { color: '#7a7264', fontSize: 11 },
  cueDel: { color: '#8c8270', fontSize: 16, paddingHorizontal: 4 },
  setCue: { borderWidth: 1, borderColor: '#3a352b', borderRadius: 8, paddingVertical: 10, alignItems: 'center', marginTop: 2 },
  setCueTxt: { color: '#D86A4A', fontSize: 13, fontWeight: '600' },
  save: { backgroundColor: '#D86A4A', borderRadius: 8, paddingVertical: 13, alignItems: 'center', marginTop: 6 },
  saveDisabled: { backgroundColor: '#2a261d' },
  saveTxt: { color: '#17150f', fontSize: 15, fontWeight: '700' },
  msg: { color: '#a59a82', fontSize: 12, textAlign: 'center' }
})
