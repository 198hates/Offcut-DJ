import { useState } from 'react'
import type { SmartRule, SmartRuleField, SmartRuleOp, Playlist } from '@shared/types'

const FIELDS: { value: SmartRuleField; label: string; type: 'text' | 'numeric' | 'date' }[] = [
  { value: 'title',           label: 'title',          type: 'text'    },
  { value: 'artist',          label: 'artist',         type: 'text'    },
  { value: 'album',           label: 'album',          type: 'text'    },
  { value: 'genre',           label: 'genre',          type: 'text'    },
  { value: 'key',             label: 'key',            type: 'text'    },
  { value: 'comment',         label: 'comment',        type: 'text'    },
  { value: 'bpm',             label: 'bpm',            type: 'numeric' },
  { value: 'rating',          label: 'rating',         type: 'numeric' },
  { value: 'durationSeconds', label: 'duration (sec)', type: 'numeric' },
  { value: 'dateAdded',       label: 'date added',     type: 'date'    },
  { value: 'playCount',       label: 'play count',     type: 'numeric' },
  { value: 'lastPlayedAt',    label: 'last played',    type: 'date'    }
]

const OPS_FOR_TYPE: Record<string, { value: SmartRuleOp; label: string }[]> = {
  text:    [
    { value: 'contains',     label: 'contains' },
    { value: 'not_contains', label: 'does not contain' },
    { value: 'is',           label: 'is' },
    { value: 'is_not',       label: 'is not' }
  ],
  numeric: [
    { value: 'greater_than', label: 'greater than' },
    { value: 'less_than',    label: 'less than' },
    { value: 'between',      label: 'between' },
    { value: 'is',           label: 'is' }
  ],
  date: [
    { value: 'in_last_days', label: 'in last N days' },
    { value: 'greater_than', label: 'after' },
    { value: 'less_than',    label: 'before' }
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

const SEL = 'bg-paper border border-border/40 rounded px-2 py-1.5 font-mono text-[10px] text-ink outline-none focus:border-accent cursor-pointer'
const INP = 'bg-paper border border-border/40 rounded px-2 py-1.5 font-mono text-[10px] text-ink outline-none focus:border-accent placeholder-muted w-24'

export function SmartPlaylistEditor({ playlist, onSave, onClose }: Props): JSX.Element {
  const [name, setName] = useState(playlist?.name ?? '')
  const [rules, setRules] = useState<SmartRule[]>(
    playlist?.rules?.length ? playlist.rules : [makeRule()]
  )

  const addRule    = (): void => setRules((r) => [...r, makeRule()])
  const removeRule = (i: number): void => setRules((r) => r.filter((_, idx) => idx !== i))

  const changeField = (i: number, field: SmartRuleField): void => {
    setRules((r) => r.map((rule, idx) => {
      if (idx !== i) return rule
      const ops = OPS_FOR_TYPE[fieldType(field)]
      const op  = ops.find((o) => o.value === rule.op) ? rule.op : ops[0].value
      return { field, op, value: defaultValue(field, op) }
    }))
  }

  const changeOp = (i: number, op: SmartRuleOp): void => {
    setRules((r) => r.map((rule, idx) => {
      if (idx !== i) return rule
      let value: SmartRule['value'] = rule.value
      if (op === 'between')      value = Array.isArray(rule.value) ? rule.value : typeof rule.value === 'number' ? [rule.value, rule.value + 20] : [0, 200]
      else if (op === 'in_last_days') value = typeof rule.value === 'number' ? rule.value : 30
      else if (fieldType(rule.field) === 'numeric') value = Array.isArray(rule.value) ? rule.value[0] : (typeof rule.value === 'number' ? rule.value : 0)
      else value = Array.isArray(rule.value) ? '' : String(rule.value)
      return { ...rule, op, value }
    }))
  }

  const changeValue = (i: number, value: SmartRule['value']): void =>
    setRules((r) => r.map((rule, idx) => (idx === i ? { ...rule, value } : rule)))

  const handleSave = (): void => {
    if (!name.trim()) return
    onSave(name.trim(), rules)
  }

  return (
    <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-chassis border border-border/50 rounded-lg w-[580px] max-h-[80vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ boxShadow: '0 20px 60px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.12)' }}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-border/30 flex items-center justify-between bg-chassis-soft rounded-t-lg">
          <h2 className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-ink">
            <span className="text-accent mr-1.5">⚡</span>
            {playlist ? 'edit smart playlist' : 'new smart playlist'}
          </h2>
          <button onClick={onClose} className="text-muted hover:text-ink transition-colors text-base leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Name */}
          <div className="space-y-1">
            <label className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted block">name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              placeholder="playlist name…"
              className="w-full bg-paper border border-border/40 rounded px-3 py-2 font-mono text-[11px] text-ink outline-none focus:border-accent placeholder-muted"
            />
          </div>

          {/* Rules */}
          <div className="space-y-2">
            <label className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted block">
              rules — all must match
            </label>
            <div className="space-y-1.5">
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
              className="font-mono text-[10px] uppercase tracking-[0.1em] text-accent hover:text-accent/80 transition-colors"
            >
              + add rule
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border/30 flex justify-end gap-2 bg-chassis-soft rounded-b-lg">
          <button
            onClick={onClose}
            className="px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted hover:text-ink rounded hover:bg-ink/5 transition-colors"
          >
            cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim()}
            className="px-4 py-1.5 font-mono text-[10px] uppercase tracking-[0.1em] bg-accent hover:bg-accent/90 text-paper rounded transition-colors disabled:opacity-40"
          >
            save
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
  const ops  = OPS_FOR_TYPE[type]

  return (
    <div className="flex items-center gap-1.5 bg-ink/[0.03] border border-border/25 rounded px-2 py-1.5">
      <select value={rule.field} onChange={(e) => onFieldChange(e.target.value as SmartRuleField)} className={SEL}>
        {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
      </select>

      <select value={rule.op} onChange={(e) => onOpChange(e.target.value as SmartRuleOp)} className={SEL}>
        {ops.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>

      {rule.op === 'between' && Array.isArray(rule.value) ? (
        <>
          <input type="number" value={rule.value[0]} onChange={(e) => onValueChange([Number(e.target.value), (rule.value as [number,number])[1]])} className={INP} />
          <span className="font-mono text-[10px] text-muted">—</span>
          <input type="number" value={rule.value[1]} onChange={(e) => onValueChange([(rule.value as [number,number])[0], Number(e.target.value)])} className={INP} />
        </>
      ) : rule.op === 'in_last_days' ? (
        <>
          <input type="number" min={1} value={typeof rule.value === 'number' ? rule.value : 30} onChange={(e) => onValueChange(Number(e.target.value))} className={INP} />
          <span className="font-mono text-[10px] text-muted">days</span>
        </>
      ) : type === 'numeric' ? (
        <input type="number" value={typeof rule.value === 'number' ? rule.value : 0} onChange={(e) => onValueChange(Number(e.target.value))} className={INP} />
      ) : (
        <input
          type="text"
          value={String(rule.value)}
          onChange={(e) => onValueChange(e.target.value)}
          className="bg-paper border border-border/40 rounded px-2 py-1.5 font-mono text-[10px] text-ink outline-none focus:border-accent flex-1 min-w-0 placeholder-muted"
          placeholder="value…"
        />
      )}

      <button
        onClick={onRemove}
        disabled={!canRemove}
        className="shrink-0 text-muted hover:text-red-500 transition-colors font-mono text-sm disabled:opacity-0 ml-auto pl-1"
      >×</button>
    </div>
  )
}
