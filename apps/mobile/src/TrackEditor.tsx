// Prep-metadata editor, styled to match the desktop TrackDetail inspector:
// JetBrains Mono labels, terracotta accent, energy ramp cells, a mood gradient
// slider, accent tag chips. Pushes to the desktop via /sync/push. Hot cues live
// in the transport (see TransportControls), not here.

import { useEffect, useMemo, useState } from 'react'
import { LayoutChangeEvent, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { draftFromTrack, buildPatch, patchAsTrackFields, type Draft } from './edits'
import { C, MONO, MONO_BOLD, TRACK_COLORS, MOOD_GRADIENT, MOOD_LABELS, energyFill } from './theme'
import type { Track, SyncPushPayload, SyncPushResult } from './sync-types'

type Push = (payload: SyncPushPayload) => Promise<SyncPushResult | null>

export function TrackEditor({
  track,
  push,
  onPatched
}: {
  track: Track
  push: Push
  onPatched: (id: string, fields: Partial<Track>) => void
}): JSX.Element {
  const [baseline, setBaseline] = useState<Track>(track)
  const [draft, setDraft] = useState<Draft>(() => draftFromTrack(track))
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

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
      const res = await push({ tracks: [p] })
      const applyLocal = (): void => {
        const fields = patchAsTrackFields(p)
        onPatched(track.id, fields)
        setBaseline((b) => ({ ...b, ...fields }))
      }
      if (res === null) {
        applyLocal()
        setMsg('SAVED OFFLINE — WILL SYNC')
      } else if (res.appliedTracks > 0) {
        applyLocal()
        setMsg('SAVED TO DESKTOP')
      } else {
        setMsg('DESKTOP HAS NEWER — PULL TO REFRESH')
      }
    } catch (e) {
      setMsg(`COULDN'T SAVE — ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <View style={styles.wrap}>
      <Field label="RATING">
        <View style={styles.row}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Pressable key={n} hitSlop={6} onPress={() => set('rating', draft.rating === n ? 0 : n)}>
              <Text style={[styles.star, n <= draft.rating ? styles.starOn : styles.starOff]}>★</Text>
            </Pressable>
          ))}
        </View>
      </Field>

      <Field label="ENERGY" value={draft.energy != null ? String(draft.energy) : '—'}>
        <View style={styles.cells}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
            const on = draft.energy != null && n <= draft.energy
            return (
              <Pressable
                key={n}
                style={[styles.cell, { backgroundColor: on ? energyFill(n) : 'rgba(42,36,28,0.4)' }]}
                onPress={() => set('energy', draft.energy === n ? null : n)}
              />
            )
          })}
        </View>
      </Field>

      <Field
        label="MOOD"
        value={draft.mood != null ? moodLabel(draft.mood) : '—'}
        onClear={draft.mood != null ? () => set('mood', null) : undefined}
      >
        <MoodBar value={draft.mood} onChange={(m) => set('mood', m)} />
      </Field>

      <Field label="COLOUR">
        <View style={styles.row}>
          <Pressable
            style={[styles.swatch, styles.swatchNone, draft.color === '' && styles.swatchOn]}
            onPress={() => set('color', '')}
          >
            <Text style={styles.noneX}>—</Text>
          </Pressable>
          {TRACK_COLORS.map((c) => (
            <Pressable key={c} hitSlop={4} onPress={() => set('color', c)}>
              <View style={[styles.swatch, { backgroundColor: c }, draft.color === c && styles.swatchOn]} />
            </Pressable>
          ))}
        </View>
      </Field>

      <Field label="TAGS">
        <TagEditor tags={draft.tags} onChange={(t) => set('tags', t)} />
      </Field>

      <Field label="COMMENT">
        <TextInput
          style={styles.comment}
          placeholder="notes…"
          placeholderTextColor={C.muted}
          multiline
          value={draft.comment}
          onChangeText={(t) => set('comment', t)}
        />
      </Field>

      <Pressable
        style={[styles.save, (!dirty || saving) && styles.saveOff]}
        disabled={!dirty || saving}
        onPress={save}
      >
        <Text style={styles.saveTxt}>{saving ? 'SAVING…' : 'SAVE TO DESKTOP'}</Text>
      </Pressable>
      {msg && <Text style={styles.msg}>{msg}</Text>}
    </View>
  )
}

function moodLabel(m: number): string {
  return MOOD_LABELS[Math.round(((m + 1) / 2) * (MOOD_LABELS.length - 1))]
}

function Field({
  label,
  value,
  onClear,
  children
}: {
  label: string
  value?: string
  onClear?: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <View style={styles.field}>
      <View style={styles.fieldHead}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {value !== undefined && <Text style={styles.fieldValue}>{value}</Text>}
        {onClear && (
          <Pressable hitSlop={8} onPress={onClear}>
            <Text style={styles.clear}>clear</Text>
          </Pressable>
        )}
      </View>
      {children}
    </View>
  )
}

function MoodBar({ value, onChange }: { value: number | null; onChange: (m: number) => void }): JSX.Element {
  const [width, setWidth] = useState(0)
  const onLayout = (e: LayoutChangeEvent): void => setWidth(e.nativeEvent.layout.width)
  const pct = value != null ? ((value + 1) / 2) * 100 : 50
  return (
    <View>
      <Pressable
        onLayout={onLayout}
        onPress={(e) => {
          if (width <= 0) return
          const x = Math.max(0, Math.min(width, e.nativeEvent.locationX))
          onChange(+((x / width) * 2 - 1).toFixed(2)) // −1 … +1
        }}
        style={styles.moodTrack}
      >
        <LinearGradient
          colors={MOOD_GRADIENT as unknown as [string, string, ...string[]]}
          locations={[0, 0.2, 0.45, 0.7, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
        {value != null && <View style={[styles.moodThumb, { left: `${pct}%` }]} />}
      </Pressable>
      <View style={styles.moodLabels}>
        {MOOD_LABELS.map((l) => (
          <Text key={l} style={styles.moodLabel}>{l}</Text>
        ))}
      </View>
    </View>
  )
}

function TagEditor({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }): JSX.Element {
  const [entry, setEntry] = useState('')
  const add = (): void => {
    const fresh = entry.split(',').map((s) => s.trim()).filter((s) => s && !tags.includes(s))
    if (fresh.length) onChange([...tags, ...fresh])
    setEntry('')
  }
  return (
    <View>
      {tags.length > 0 && (
        <View style={styles.chips}>
          {tags.map((t) => (
            <Pressable key={t} style={styles.chip} onPress={() => onChange(tags.filter((x) => x !== t))}>
              <Text style={styles.chipTxt}>{t} ×</Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={styles.tagAddRow}>
        <TextInput
          style={styles.tagInput}
          placeholder="add tag, press enter…"
          placeholderTextColor={C.muted}
          autoCapitalize="none"
          autoCorrect={false}
          value={entry}
          onChangeText={setEntry}
          onSubmitEditing={add}
          returnKeyType="done"
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 18, marginTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, paddingTop: 18 },
  field: { gap: 9 },
  fieldHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fieldLabel: { color: C.muted, fontFamily: MONO, fontSize: 9, letterSpacing: 1.6, flex: 1 },
  fieldValue: { color: C.accent, fontFamily: MONO_BOLD, fontSize: 11 },
  clear: { color: C.muted, fontFamily: MONO, fontSize: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  // rating
  star: { fontSize: 22, marginRight: 2 },
  starOn: { color: C.accent },
  starOff: { color: C.border },
  // energy
  cells: { flexDirection: 'row', gap: 2 },
  cell: { flex: 1, height: 20, borderRadius: 2 },
  // mood
  moodTrack: { height: 8, borderRadius: 4, overflow: 'hidden', justifyContent: 'center' },
  moodThumb: { position: 'absolute', width: 3, top: -3, bottom: -3, marginLeft: -1.5, backgroundColor: '#fff', borderRadius: 2 },
  moodLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
  moodLabel: { color: 'rgba(163,152,130,0.5)', fontFamily: MONO, fontSize: 8.5 },
  // colour
  swatch: { width: 22, height: 22, borderRadius: 3, borderWidth: 2, borderColor: 'transparent' },
  swatchNone: { backgroundColor: 'rgba(42,36,28,0.5)', alignItems: 'center', justifyContent: 'center' },
  swatchOn: { borderColor: C.ink },
  noneX: { color: C.muted, fontFamily: MONO, fontSize: 11 },
  // comment
  comment: {
    minHeight: 52, borderWidth: 1, borderColor: 'rgba(42,36,28,0.6)', borderRadius: 4, backgroundColor: C.paper,
    color: C.ink, fontFamily: MONO, fontSize: 13, paddingHorizontal: 10, paddingVertical: 8, textAlignVertical: 'top'
  },
  // tags
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  chip: { backgroundColor: 'rgba(216,106,74,0.15)', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2 },
  chipTxt: { color: C.accent, fontFamily: MONO, fontSize: 12 },
  tagAddRow: { flexDirection: 'row', gap: 8 },
  tagInput: {
    flex: 1, borderWidth: 1, borderColor: 'rgba(42,36,28,0.6)', borderRadius: 4, backgroundColor: C.paper,
    color: C.ink, fontFamily: MONO, fontSize: 13, paddingHorizontal: 10, paddingVertical: 7
  },
  dim: { color: C.muted, fontFamily: MONO, fontSize: 12 },
  // cues
  cueRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(42,36,28,0.5)' },
  cueMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  cueDot: { width: 10, height: 10, borderRadius: 2 },
  cueTag: { color: C.muted, fontFamily: MONO, fontSize: 12, width: 24 },
  cueTime: { color: C.ink, fontFamily: MONO, fontSize: 13, width: 48 },
  cueGo: { color: C.muted, fontFamily: MONO, fontSize: 10 },
  cueDel: { color: C.inkSoft, fontSize: 16, paddingHorizontal: 4 },
  setCue: { borderWidth: 1, borderColor: 'rgba(42,36,28,0.8)', borderRadius: 4, paddingVertical: 9, alignItems: 'center', marginTop: 6 },
  setCueTxt: { color: C.accent, fontFamily: MONO, fontSize: 11, letterSpacing: 0.5 },
  // save
  save: { backgroundColor: C.accent, borderRadius: 4, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  saveOff: { backgroundColor: 'rgba(42,36,28,0.8)' },
  saveTxt: { color: C.bg, fontFamily: MONO_BOLD, fontSize: 13, letterSpacing: 1 },
  msg: { color: C.muted, fontFamily: MONO, fontSize: 11, textAlign: 'center', letterSpacing: 0.5 }
})
