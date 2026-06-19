// Smart-playlist rule builder. Build/edit an AND-combined SmartRule[] on the
// phone; the same rules the desktop SmartRule evaluator uses (and mobile already
// evaluates read-only via smartRules.ts). Shown as a full-screen modal.

import { useMemo, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { C, MONO, MONO_BOLD } from './theme'
import type { SmartRule, SmartRuleField, SmartRuleOp } from './sync-types'

type FieldType = 'number' | 'string' | 'tags'
const FIELDS: { field: SmartRuleField; label: string; type: FieldType }[] = [
  { field: 'genre', label: 'Genre', type: 'string' },
  { field: 'artist', label: 'Artist', type: 'string' },
  { field: 'album', label: 'Album', type: 'string' },
  { field: 'title', label: 'Title', type: 'string' },
  { field: 'label', label: 'Label', type: 'string' },
  { field: 'comment', label: 'Comment', type: 'string' },
  { field: 'key', label: 'Key', type: 'string' },
  { field: 'bpm', label: 'BPM', type: 'number' },
  { field: 'year', label: 'Year', type: 'number' },
  { field: 'rating', label: 'Rating', type: 'number' },
  { field: 'energy', label: 'Energy', type: 'number' },
  { field: 'tags', label: 'Tags', type: 'tags' }
]
const OPS: Record<FieldType, { op: SmartRuleOp; label: string }[]> = {
  string: [{ op: 'contains', label: 'contains' }, { op: 'not_contains', label: "doesn't contain" }, { op: 'is', label: 'is' }, { op: 'is_not', label: 'is not' }],
  number: [{ op: 'is', label: '=' }, { op: 'greater_than', label: '>' }, { op: 'less_than', label: '<' }, { op: 'between', label: 'between' }, { op: 'is_not', label: '≠' }],
  tags: [{ op: 'contains', label: 'has' }, { op: 'not_contains', label: "doesn't have" }]
}
const typeOf = (f: SmartRuleField): FieldType => FIELDS.find((x) => x.field === f)?.type ?? 'string'
const labelOf = (f: SmartRuleField): string => FIELDS.find((x) => x.field === f)?.label ?? f
const opLabel = (f: SmartRuleField, op: SmartRuleOp): string => OPS[typeOf(f)].find((o) => o.op === op)?.label ?? op

interface Row { field: SmartRuleField; op: SmartRuleOp; value: string; value2: string }

function toRow(r: SmartRule): Row {
  const between = Array.isArray(r.value)
  return {
    field: r.field,
    op: r.op,
    value: between ? String((r.value as [number, number])[0]) : String(r.value ?? ''),
    value2: between ? String((r.value as [number, number])[1]) : ''
  }
}
function toRule(row: Row): SmartRule {
  return { field: row.field, op: row.op, value: row.op === 'between' ? [Number(row.value) || 0, Number(row.value2) || 0] : row.value }
}

export function SmartPlaylistEditor({
  visible,
  mode,
  initialName,
  initialRules,
  countFor,
  onSave,
  onClose
}: {
  visible: boolean
  mode: 'create' | 'edit'
  initialName: string
  initialRules: SmartRule[]
  countFor: (rules: SmartRule[]) => number
  onSave: (name: string, rules: SmartRule[]) => void
  onClose: () => void
}): JSX.Element {
  const insets = useSafeAreaInsets()
  const [name, setName] = useState(initialName)
  const [rows, setRows] = useState<Row[]>(initialRules.length ? initialRules.map(toRow) : [{ field: 'genre', op: 'contains', value: '', value2: '' }])
  const [open, setOpen] = useState<{ i: number; kind: 'field' | 'op' } | null>(null)

  const rules = useMemo(() => rows.map(toRule), [rows])
  const count = useMemo(() => countFor(rules), [rules, countFor])

  const setRow = (i: number, patch: Partial<Row>): void =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const pickField = (i: number, field: SmartRuleField): void => {
    const ops = OPS[typeOf(field)]
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, field, op: ops.some((o) => o.op === r.op) ? r.op : ops[0].op } : r)))
    setOpen(null)
  }
  const addRow = (): void => setRows((rs) => [...rs, { field: 'genre', op: 'contains', value: '', value2: '' }])
  const removeRow = (i: number): void => setRows((rs) => rs.filter((_, j) => j !== i))

  const save = (): void => { onSave(name.trim() || 'Smart playlist', rules); onClose() }

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <View style={[styles.fill, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={8}><Text style={styles.cancel}>Cancel</Text></Pressable>
          <Text style={styles.htitle}>{mode === 'create' ? 'New smart playlist' : 'Edit rules'}</Text>
          <Pressable onPress={save} hitSlop={8}><Text style={styles.save}>Save</Text></Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <TextInput style={styles.name} placeholder="Playlist name" placeholderTextColor={C.muted} value={name} onChangeText={setName} />
          <Text style={styles.matchLine}>✨ matches {count.toLocaleString()} track{count === 1 ? '' : 's'} · all rules (AND)</Text>

          {rows.map((row, i) => {
            const t = typeOf(row.field)
            return (
              <View key={i} style={styles.rule}>
                <View style={styles.ruleTop}>
                  <Pressable style={styles.seg} onPress={() => setOpen((o) => (o?.i === i && o.kind === 'field' ? null : { i, kind: 'field' }))}>
                    <Text style={styles.segTxt}>{labelOf(row.field)}</Text>
                  </Pressable>
                  <Pressable style={styles.seg} onPress={() => setOpen((o) => (o?.i === i && o.kind === 'op' ? null : { i, kind: 'op' }))}>
                    <Text style={styles.segTxt}>{opLabel(row.field, row.op)}</Text>
                  </Pressable>
                  {rows.length > 1 && (
                    <Pressable hitSlop={8} onPress={() => removeRow(i)}><Text style={styles.rm}>✕</Text></Pressable>
                  )}
                </View>

                {open?.i === i && open.kind === 'field' && (
                  <View style={styles.chips}>
                    {FIELDS.map((f) => (
                      <Pressable key={f.field} style={[styles.chip, row.field === f.field && styles.chipOn]} onPress={() => pickField(i, f.field)}>
                        <Text style={[styles.chipTxt, row.field === f.field && styles.chipTxtOn]}>{f.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
                {open?.i === i && open.kind === 'op' && (
                  <View style={styles.chips}>
                    {OPS[t].map((o) => (
                      <Pressable key={o.op} style={[styles.chip, row.op === o.op && styles.chipOn]} onPress={() => { setRow(i, { op: o.op }); setOpen(null) }}>
                        <Text style={[styles.chipTxt, row.op === o.op && styles.chipTxtOn]}>{o.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}

                <View style={styles.valRow}>
                  <TextInput
                    style={styles.val}
                    placeholder={row.op === 'between' ? 'min' : 'value'}
                    placeholderTextColor={C.muted}
                    keyboardType={t === 'number' ? 'numeric' : 'default'}
                    autoCapitalize="none"
                    value={row.value}
                    onChangeText={(v) => setRow(i, { value: v })}
                  />
                  {row.op === 'between' && (
                    <TextInput
                      style={styles.val}
                      placeholder="max"
                      placeholderTextColor={C.muted}
                      keyboardType="numeric"
                      value={row.value2}
                      onChangeText={(v) => setRow(i, { value2: v })}
                    />
                  )}
                </View>
              </View>
            )
          })}

          <Pressable style={styles.addRule} onPress={addRow}><Text style={styles.addRuleTxt}>＋ Add rule</Text></Pressable>
        </ScrollView>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 16 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 14 },
  htitle: { color: C.ink, fontFamily: MONO_BOLD, fontSize: 15 },
  cancel: { color: C.muted, fontFamily: MONO, fontSize: 13 },
  save: { color: C.accent, fontFamily: MONO_BOLD, fontSize: 13 },
  body: { paddingBottom: 60, gap: 12 },
  name: { backgroundColor: C.paper, borderWidth: 1, borderColor: C.border, borderRadius: 8, color: C.ink, fontFamily: MONO_BOLD, fontSize: 16, paddingHorizontal: 12, paddingVertical: 10 },
  matchLine: { color: C.accent, fontFamily: MONO, fontSize: 12 },
  rule: { backgroundColor: C.panel, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: C.border, padding: 12, gap: 10 },
  ruleTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  seg: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: C.border, backgroundColor: C.paper },
  segTxt: { color: C.ink, fontFamily: MONO, fontSize: 13 },
  rm: { color: C.muted, fontFamily: MONO, fontSize: 14, marginLeft: 'auto' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: C.border, backgroundColor: C.paper },
  chipOn: { backgroundColor: '#D86A4A22', borderColor: C.accent },
  chipTxt: { color: C.inkSoft, fontFamily: MONO, fontSize: 12 },
  chipTxtOn: { color: C.accent },
  valRow: { flexDirection: 'row', gap: 8 },
  val: { flex: 1, backgroundColor: C.paper, borderWidth: 1, borderColor: C.border, borderRadius: 6, color: C.ink, fontFamily: MONO, fontSize: 14, paddingHorizontal: 10, paddingVertical: 8 },
  addRule: { borderWidth: 1, borderColor: C.border, borderStyle: 'dashed', borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  addRuleTxt: { color: C.accent, fontFamily: MONO, fontSize: 13 }
})
