// Auto-cue template manager — lives in Settings › General. Lets the user pick
// the active template, duplicate a built-in into an editable copy, and tweak a
// user template's per-role colours/labels, which roles emit, and sensitivity.
// Built-in presets are read-only (the user clones one to customise).

import { useState } from 'react'
import type { AppSettings, CueRole, CueTemplate } from '@shared/types'
import {
  allCueTemplates,
  resolveCueTemplate,
  cloneCueTemplate,
  CUE_ROLE_ORDER,
  CUE_ROLE_DESC,
  DEFAULT_CUE_TEMPLATE_ID
} from '../lib/cueTemplates'

interface Props {
  settings: AppSettings
  patch: (p: Partial<AppSettings>) => void
}

export function CueTemplateEditor({ settings, patch }: Props): JSX.Element {
  const templates = allCueTemplates(settings)
  const activeId = resolveCueTemplate(settings).id
  // Which template the editor is focused on (defaults to the active one).
  const [editingId, setEditingId] = useState<string>(activeId)
  const editing = templates.find((t) => t.id === editingId) ?? templates[0]

  const userTemplates = settings.cueTemplates ?? []
  const isUser = !editing.builtin

  const saveUser = (next: CueTemplate): void => {
    const exists = userTemplates.some((t) => t.id === next.id)
    const list = exists
      ? userTemplates.map((t) => (t.id === next.id ? next : t))
      : [...userTemplates, next]
    patch({ cueTemplates: list })
  }

  const duplicate = (): void => {
    const copy = cloneCueTemplate(editing, 'tpl')
    patch({ cueTemplates: [...userTemplates, copy], activeCueTemplateId: copy.id })
    setEditingId(copy.id)
  }

  const remove = (): void => {
    const list = userTemplates.filter((t) => t.id !== editing.id)
    const nextActive = activeId === editing.id ? DEFAULT_CUE_TEMPLATE_ID : activeId
    patch({ cueTemplates: list, activeCueTemplateId: nextActive })
    setEditingId(nextActive)
  }

  const setRole = (role: CueRole, change: Partial<CueTemplate['roles'][CueRole]>): void => {
    if (!isUser) return
    saveUser({ ...editing, roles: { ...editing.roles, [role]: { ...editing.roles[role], ...change } } })
  }

  return (
    <div className="space-y-4">
      <p className="font-mono text-[12px] text-muted">
        auto-cue templates decide which structural cues are placed, their colours and labels, and how
        eagerly they’re detected. the active template is used by the Analyse auto-cue tool and the
        per-track “generate cues” action.
      </p>

      {/* Template selector + actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={editingId}
          onChange={(e) => setEditingId(e.target.value)}
          className="font-mono text-[13px] bg-paper border border-border/40 rounded px-2 py-1.5 text-ink focus:border-accent/60 outline-none"
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}{t.builtin ? ' (built-in)' : ''}{t.id === activeId ? ' — active' : ''}
            </option>
          ))}
        </select>

        {editing.id !== activeId && (
          <button
            onClick={() => patch({ activeCueTemplateId: editing.id })}
            className="font-mono text-[12px] uppercase tracking-[0.1em] px-3 py-1.5 rounded border border-accent/50 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
          >set active</button>
        )}
        <button
          onClick={duplicate}
          className="font-mono text-[12px] uppercase tracking-[0.1em] px-3 py-1.5 rounded border border-border/30 text-muted hover:text-ink hover:border-border/60 transition-colors"
        >duplicate</button>
        {isUser && (
          <button
            onClick={remove}
            className="font-mono text-[12px] uppercase tracking-[0.1em] px-3 py-1.5 rounded border border-red-500/40 text-red-500 hover:bg-red-500/10 transition-colors"
          >delete</button>
        )}
      </div>

      {!isUser && (
        <p className="font-mono text-[12px] text-muted/70">
          built-in presets are read-only — <span className="text-ink">duplicate</span> to make an editable copy.
        </p>
      )}

      {/* Editable fields */}
      <div className={`space-y-4 ${isUser ? '' : 'opacity-60 pointer-events-none'}`}>
        <div>
          <label className="font-mono text-[12px] text-muted block mb-1">name</label>
          <input
            value={editing.name}
            onChange={(e) => isUser && saveUser({ ...editing, name: e.target.value })}
            className="font-mono text-[13px] bg-paper border border-border/40 rounded px-2 py-1.5 text-ink w-full max-w-xs focus:border-accent/60 outline-none"
          />
        </div>

        <div>
          <div className="flex items-center justify-between max-w-xs">
            <label className="font-mono text-[12px] text-muted">sensitivity</label>
            <span className="font-mono text-[12px] text-ink">{Math.round(editing.sensitivity * 100)}%</span>
          </div>
          <input
            type="range" min={0} max={1} step={0.05}
            value={editing.sensitivity}
            onChange={(e) => isUser && saveUser({ ...editing, sensitivity: Number(e.target.value) })}
            className="w-full max-w-xs accent-accent"
          />
          <p className="font-mono text-[11px] text-muted/60">lower = fewer, higher-confidence cues · higher = more cues</p>
        </div>

        {/* Per-role rows */}
        <div className="space-y-2">
          <p className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted">cue roles</p>
          {CUE_ROLE_ORDER.map((role) => {
            const rule = editing.roles[role]
            return (
              <div key={role} className="flex items-center gap-3">
                <button
                  onClick={() => setRole(role, { enabled: !rule.enabled })}
                  className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${rule.enabled ? 'bg-accent' : 'bg-border/60'}`}
                  title={rule.enabled ? 'enabled' : 'disabled'}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-paper shadow transition-all ${rule.enabled ? 'left-4' : 'left-0.5'}`} />
                </button>
                <input
                  type="color"
                  value={rule.color}
                  onChange={(e) => setRole(role, { color: e.target.value })}
                  className="w-7 h-7 rounded border border-border/30 bg-transparent shrink-0 cursor-pointer"
                />
                <input
                  value={rule.label}
                  onChange={(e) => setRole(role, { label: e.target.value })}
                  className="font-mono text-[13px] bg-paper border border-border/40 rounded px-2 py-1 text-ink w-28 focus:border-accent/60 outline-none"
                />
                <span className="font-mono text-[11px] text-muted/60">{CUE_ROLE_DESC[role]}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
