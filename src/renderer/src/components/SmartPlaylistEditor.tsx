import { useState } from 'react'
import type { SmartRule, SmartRuleField, SmartRuleOp, Playlist } from '@shared/types'

const FIELDS: { value: SmartRuleField; label: string; type: 'text' | 'numeric' | 'date' }[] = [
  { value: 'title', label: 'Title', type: 'text' },
  { value: 'artist', label: 'Artist', type: 'text' },
  { value: 'album', label: 'Album', type: 'text' },
  { value: 'genre', label: 'Genre', type: 'text' },
  { value: 'key', label: 'Key', type: 'text' },
  { value: 'comment', label: 'Comment', type: 'text' },
  { value: 'bpm', label: 'BPM', type: 'numeric' },
  { value: 'rating', label: 'Rating', type: 'numeric' },
  { value: 'durationSeconds', label: 'Duration (sec)', type: 'numeric' },
  { value: 'dateAdded', label: 'Date Added', type: 'date' }
]

const OPS_FOR_TYPE: Record<string, { value: SmartRuleOp; label: string }[]> = {
  text: [
    { value: 'contains', label: 'contains' },
    { value: 'not_contains', label: 'does not contain' },
    { value: 'is', label: 'is' },
    { value: 'is_not', label: 'is not' }
  ],
  numeric: [
    { value: 'greater_than', label: 'greater than' },
    { value: 'less_than', label: 'less than' },
    { value: 'between', label: 'between' },
    { value: 'is', label: 'is' }
  ],
  date: [
    { value: 'in_last_days', label: 'in last N days' },
    { value: 'greater_than', label: 'after' },
    { value: 'less_than', label: 'before' }
  ]
}

function fieldType(field: SmartRuleField): string {
  return FIELDS.find((f) => f.value === field)?.type ?? 'text'
}

function defaultValue(field: SmartRuleField, op: SmartRuleOp): SmartRule['value'] {
  if (op === 'between') return [0, 200]
  if (op === 'in_last_days') return 30
  if (fieldType(field) === 'numeric') return 0
  return ''
}

function makeRule(): SmartRule {
  return { field: 'artist', op: 'contains', value: '' }
}

interface Props {
  playlist?: Playlist
  onSave: (name: string, rules: SmartRule[]) => void
  onClose: () => void
}

export function SmartPlaylistEditor({ playlist, onSave, onClose }: Props): JSX.Element {
  const [name, setName] = useState(playlist?.name ?? '')
  const [rules, setRules] = useState<SmartRule[]>(
    playlist?.rules?.length ? playlist.rules : [makeRule()]
  )

  const addRule = (): void => setRules((r) => [...r, makeRule()])

  const removeRule = (i: number): void =>
    setRules((r) => r.filter((_, idx) => idx !== i))

  const changeField = (i: number, field: SmartRuleField): void => {
    setRules((r) =>
      r.map((rule, idx) => {
        if (idx !== i) return rule
        const type = fieldType(field)
        const ops = OPS_FOR_TYPE[type]
        const op = ops.find((o) => o.value === rule.op) ? rule.op : ops[0].value
        return { field, op, value: defaultValue(field, op) }
      })
    )
  }

  const changeOp = (i: number, op: SmartRuleOp): void => {
    setRules((r) =>
      r.map((rule, idx) => {
        if (idx !== i) return rule
        let value: SmartRule['value'] = rule.value
        if (op === 'between') {
          value = Array.isArray(rule.value)
            ? rule.value
            : typeof rule.value === 'number'
            ? [rule.value, rule.value + 20]
            : [0, 200]
        } else if (op === 'in_last_days') {
          value = typeof rule.value === 'number' ? rule.value : 30
        } else if (fieldType(rule.field) === 'numeric') {
          value = Array.isArray(rule.value) ? rule.value[0] : (typeof rule.value === 'number' ? rule.value : 0)
        } else {
          value = Array.isArray(rule.value) ? '' : String(rule.value)
        }
        return { ...rule, op, value }
      })
    )
  }

  const changeValue = (i: number, value: SmartRule['value']): void => {
    setRules((r) => r.map((rule, idx) => (idx === i ? { ...rule, value } : rule)))
  }

  const handleSave = (): void => {
    if (!name.trim()) return
    onSave(name.trim(), rules)
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-900 rounded-xl border border-white/10 w-[580px] max-h-[80vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
          <h2 className="text-white font-semibold text-base">
            {playlist ? 'Edit Smart Playlist' : 'New Smart Playlist'}
          </h2>
          <button onClick={onClose} className="text-white/40 hover:text-white transition-colors text-lg">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <div>
            <label className="block text-xs text-white/40 mb-1 uppercase tracking-wider">Name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              placeholder="Smart playlist name…"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/60"
            />
          </div>

          <div>
            <label className="block text-xs text-white/40 mb-2 uppercase tracking-wider">
              Rules — all must match
            </label>
            <div className="space-y-2">
              {rules.map((rule, i) => (
                <RuleRow
                  key={i}
                  rule={rule}
                  onFieldChange={(f) => changeField(i, f)}
                  onOpChange={(op) => changeOp(i, op)}
                  onValueChange={(v) => changeValue(i, v)}
                  onRemove={() => removeRule(i)}
                  canRemove={rules.length > 1}
                />
              ))}
            </div>
            <button
              onClick={addRule}
              className="mt-2 text-xs text-accent hover:text-white transition-colors"
            >
              + Add rule
            </button>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-white/10 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-white/60 hover:text-white rounded-lg hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim()}
            className="px-4 py-2 text-sm bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

interface RuleRowProps {
  rule: SmartRule
  onFieldChange: (f: SmartRuleField) => void
  onOpChange: (op: SmartRuleOp) => void
  onValueChange: (v: SmartRule['value']) => void
  onRemove: () => void
  canRemove: boolean
}

function RuleRow({ rule, onFieldChange, onOpChange, onValueChange, onRemove, canRemove }: RuleRowProps): JSX.Element {
  const type = fieldType(rule.field)
  const ops = OPS_FOR_TYPE[type]

  const selectCls = 'bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white outline-none focus:border-accent/60 cursor-pointer'
  const inputCls = 'bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white outline-none focus:border-accent/60 w-24'

  return (
    <div className="flex items-center gap-2">
      <select
        value={rule.field}
        onChange={(e) => onFieldChange(e.target.value as SmartRuleField)}
        className={selectCls}
      >
        {FIELDS.map((f) => (
          <option key={f.value} value={f.value}>{f.label}</option>
        ))}
      </select>

      <select
        value={rule.op}
        onChange={(e) => onOpChange(e.target.value as SmartRuleOp)}
        className={selectCls}
      >
        {ops.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {rule.op === 'between' && Array.isArray(rule.value) ? (
        <>
          <input
            type="number"
            value={rule.value[0]}
            onChange={(e) => onValueChange([Number(e.target.value), (rule.value as [number, number])[1]])}
            className={inputCls}
          />
          <span className="text-xs text-white/40">—</span>
          <input
            type="number"
            value={rule.value[1]}
            onChange={(e) => onValueChange([(rule.value as [number, number])[0], Number(e.target.value)])}
            className={inputCls}
          />
        </>
      ) : rule.op === 'in_last_days' ? (
        <>
          <input
            type="number"
            min={1}
            value={typeof rule.value === 'number' ? rule.value : 30}
            onChange={(e) => onValueChange(Number(e.target.value))}
            className={inputCls}
          />
          <span className="text-xs text-white/40">days</span>
        </>
      ) : type === 'numeric' ? (
        <input
          type="number"
          value={typeof rule.value === 'number' ? rule.value : 0}
          onChange={(e) => onValueChange(Number(e.target.value))}
          className={inputCls}
        />
      ) : (
        <input
          type="text"
          value={String(rule.value)}
          onChange={(e) => onValueChange(e.target.value)}
          className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white outline-none focus:border-accent/60 flex-1 min-w-0"
          placeholder="value…"
        />
      )}

      <button
        onClick={onRemove}
        disabled={!canRemove}
        className="shrink-0 text-white/30 hover:text-red-400 transition-colors text-sm disabled:opacity-0"
        title="Remove rule"
      >
        ×
      </button>
    </div>
  )
}
