// Batch-edit action bar shown when tracks are multi-selected in the library.
// Pick a field (rating / energy / mood / colour / tag) and the chosen value is
// applied to the whole selection in one push — no per-track drilling.

import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { TRACK_COLORS, MOOD_STEPS, type BatchFields } from './edits'
import { MOOD_LABELS, C, MONO, MONO_BOLD } from './theme'

type Picker = 'rating' | 'energy' | 'mood' | 'color' | 'tag' | null

export function BatchEditBar({
  count,
  onApply,
  onClear
}: {
  count: number
  onApply: (fields: BatchFields) => void
  onClear: () => void
}): JSX.Element {
  const [picker, setPicker] = useState<Picker>(null)
  const [tag, setTag] = useState('')
  const [done, setDone] = useState<string | null>(null)

  const apply = (fields: BatchFields, label: string): void => {
    onApply(fields)
    setPicker(null)
    setDone(label)
  }

  return (
    <View style={styles.wrap}>
      {done && <Text style={styles.done}>{done} → {count} track{count === 1 ? '' : 's'} ✓</Text>}

      {picker === 'rating' && (
        <Row>
          {[0, 1, 2, 3, 4, 5].map((r) => (
            <Chip key={r} onPress={() => apply({ rating: r }, `Rating ${r}`)}>{r === 0 ? '✕' : '★'.repeat(r)}</Chip>
          ))}
        </Row>
      )}
      {picker === 'energy' && (
        <Row>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((e) => (
            <Chip key={e} onPress={() => apply({ energy: e }, `Energy ${e}`)}>{`${e}`}</Chip>
          ))}
        </Row>
      )}
      {picker === 'mood' && (
        <Row>
          {MOOD_STEPS.map((m, i) => (
            <Chip key={m} onPress={() => apply({ mood: m }, MOOD_LABELS[i])}>{MOOD_LABELS[i]}</Chip>
          ))}
        </Row>
      )}
      {picker === 'color' && (
        <Row>
          <Pressable style={[styles.swatch, styles.swatchClear]} onPress={() => apply({ color: '' }, 'Colour cleared')}>
            <Text style={styles.swatchX}>✕</Text>
          </Pressable>
          {TRACK_COLORS.map((c) => (
            <Pressable key={c} style={[styles.swatch, { backgroundColor: c }]} onPress={() => apply({ color: c }, 'Colour set')} />
          ))}
        </Row>
      )}
      {picker === 'tag' && (
        <View style={styles.tagRow}>
          <TextInput
            style={styles.tagInput}
            placeholder="Tag to add"
            placeholderTextColor={C.muted}
            autoCapitalize="none"
            value={tag}
            onChangeText={setTag}
            onSubmitEditing={() => tag.trim() && apply({ addTag: tag.trim() }, `+${tag.trim()}`)}
            returnKeyType="done"
          />
          <Pressable style={[styles.tagAdd, !tag.trim() && styles.faded]} disabled={!tag.trim()} onPress={() => apply({ addTag: tag.trim() }, `+${tag.trim()}`)}>
            <Text style={styles.tagAddTxt}>Add</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.bar}>
        <Text style={styles.count}>{count} selected</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.actions}>
          <Act on={picker === 'rating'} onPress={() => { setDone(null); setPicker((p) => (p === 'rating' ? null : 'rating')) }}>★ Rating</Act>
          <Act on={picker === 'energy'} onPress={() => { setDone(null); setPicker((p) => (p === 'energy' ? null : 'energy')) }}>⚡ Energy</Act>
          <Act on={picker === 'mood'} onPress={() => { setDone(null); setPicker((p) => (p === 'mood' ? null : 'mood')) }}>◑ Mood</Act>
          <Act on={picker === 'color'} onPress={() => { setDone(null); setPicker((p) => (p === 'color' ? null : 'color')) }}>● Colour</Act>
          <Act on={picker === 'tag'} onPress={() => { setDone(null); setPicker((p) => (p === 'tag' ? null : 'tag')) }}>＋ Tag</Act>
        </ScrollView>
        <Pressable onPress={onClear} hitSlop={8}><Text style={styles.cancel}>Done</Text></Pressable>
      </View>
    </View>
  )
}

function Row({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pickerRow}>
      {children}
    </ScrollView>
  )
}
function Chip({ children, onPress }: { children: React.ReactNode; onPress: () => void }): JSX.Element {
  return (
    <Pressable style={styles.chip} onPress={onPress}>
      <Text style={styles.chipTxt}>{children}</Text>
    </Pressable>
  )
}
function Act({ children, on, onPress }: { children: React.ReactNode; on: boolean; onPress: () => void }): JSX.Element {
  return (
    <Pressable style={[styles.act, on && styles.actOn]} onPress={onPress}>
      <Text style={[styles.actTxt, on && styles.actTxtOn]}>{children}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: C.panel, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
  done: { color: '#6E8059', fontFamily: MONO, fontSize: 11, textAlign: 'center', paddingTop: 6 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  count: { color: C.ink, fontFamily: MONO_BOLD, fontSize: 12 },
  actions: { gap: 8, alignItems: 'center', paddingRight: 8 },
  act: { paddingHorizontal: 11, paddingVertical: 7, borderRadius: 6, borderWidth: 1, borderColor: C.border },
  actOn: { backgroundColor: '#D86A4A22', borderColor: C.accent },
  actTxt: { color: C.inkSoft, fontFamily: MONO, fontSize: 12 },
  actTxtOn: { color: C.accent },
  cancel: { color: C.accent, fontFamily: MONO, fontSize: 12 },
  pickerRow: { gap: 7, paddingHorizontal: 14, paddingTop: 10, alignItems: 'center' },
  chip: { minWidth: 34, paddingHorizontal: 10, height: 32, borderRadius: 6, borderWidth: 1, borderColor: C.border, backgroundColor: C.paper, alignItems: 'center', justifyContent: 'center' },
  chipTxt: { color: C.ink, fontFamily: MONO, fontSize: 12 },
  swatch: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, borderColor: C.border },
  swatchClear: { backgroundColor: C.paper, alignItems: 'center', justifyContent: 'center' },
  swatchX: { color: C.muted, fontFamily: MONO, fontSize: 13 },
  tagRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingTop: 10 },
  tagInput: { flex: 1, backgroundColor: C.paper, borderWidth: 1, borderColor: C.border, borderRadius: 6, color: C.ink, fontFamily: MONO, paddingHorizontal: 10, paddingVertical: 7, fontSize: 13 },
  tagAdd: { backgroundColor: C.accent, borderRadius: 6, paddingHorizontal: 14, justifyContent: 'center' },
  tagAddTxt: { color: C.bg, fontFamily: MONO_BOLD, fontSize: 12 },
  faded: { opacity: 0.4 }
})
