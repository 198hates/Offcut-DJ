// Auto-cue templates — a reusable layer on top of the structural cue detector.
//
// The detector (analyzerWorker.detectStructuralCues) emits up to five roles with
// fixed labels/colours. A template decides which of those roles to keep, recolours
// and relabels them, and sets an overall sensitivity. Sensitivity scales the
// detector's confidence thresholds (passed into the worker); the role filter and
// colour/label remap are applied here as a pure post-process over the result.

import type { CueRole, CueRoleRule, CueTemplate, AppSettings } from '@shared/types'
import type { SuggestedCue } from './analyzerWorker'

// The detector's built-in label for each role — the join key between the raw
// SuggestedCue.label and a template role. Keep in sync with detectStructuralCues.
const LABEL_TO_ROLE: Record<string, CueRole> = {
  'Mix In': 'mixIn',
  Build: 'build',
  Drop: 'drop',
  Break: 'break',
  Outro: 'outro'
}

export const CUE_ROLE_ORDER: CueRole[] = ['mixIn', 'build', 'drop', 'break', 'outro']

export const CUE_ROLE_LABELS: Record<CueRole, string> = {
  mixIn: 'Mix In',
  build: 'Build',
  drop: 'Drop',
  break: 'Break',
  outro: 'Outro'
}

/** Short human description of what each role marks — for UI legends. */
export const CUE_ROLE_DESC: Record<CueRole, string> = {
  mixIn: 'first energy rise above intro',
  build: 'riser into the drop',
  drop: 'global energy peak',
  break: 'post-drop energy dip',
  outro: 'energy falls and stays low'
}

const DEFAULT_COLORS: Record<CueRole, string> = {
  mixIn: '#3CA86A',
  build: '#E0B43C',
  drop: '#D86A4A',
  break: '#3CA8C0',
  outro: '#A855C8'
}

function roleRule(role: CueRole, enabled: boolean, overrides: Partial<CueRoleRule> = {}): CueRoleRule {
  return {
    enabled,
    color: overrides.color ?? DEFAULT_COLORS[role],
    label: overrides.label ?? CUE_ROLE_LABELS[role]
  }
}

function roles(enabled: Record<CueRole, boolean>): Record<CueRole, CueRoleRule> {
  return {
    mixIn: roleRule('mixIn', enabled.mixIn),
    build: roleRule('build', enabled.build),
    drop: roleRule('drop', enabled.drop),
    break: roleRule('break', enabled.break),
    outro: roleRule('outro', enabled.outro)
  }
}

const ALL = { mixIn: true, build: true, drop: true, break: true, outro: true }

// Shipped presets. `builtin: true` makes them read-only in the editor (the user
// clones one to customise).
export const BUILTIN_CUE_TEMPLATES: CueTemplate[] = [
  {
    id: 'builtin:standard',
    name: 'Standard (5-cue)',
    builtin: true,
    sensitivity: 0.5,
    roles: roles(ALL)
  },
  {
    id: 'builtin:minimal',
    name: 'Minimal (intro · drop · outro)',
    builtin: true,
    sensitivity: 0.5,
    roles: roles({ mixIn: true, build: false, drop: true, break: false, outro: true })
  },
  {
    id: 'builtin:peaktime',
    name: 'Peak-time (drop · build · break)',
    builtin: true,
    sensitivity: 0.65, // a touch more eager — peak-time tracks have busy structure
    roles: roles({ mixIn: false, build: true, drop: true, break: true, outro: false })
  }
]

export const DEFAULT_CUE_TEMPLATE_ID = BUILTIN_CUE_TEMPLATES[0].id

/** Every template available to the user: built-ins first, then user-created. */
export function allCueTemplates(settings?: Partial<AppSettings> | null): CueTemplate[] {
  return [...BUILTIN_CUE_TEMPLATES, ...(settings?.cueTemplates ?? [])]
}

/** Resolve the active template from settings, falling back to Standard. */
export function resolveCueTemplate(settings?: Partial<AppSettings> | null): CueTemplate {
  const all = allCueTemplates(settings)
  const id = settings?.activeCueTemplateId
  return all.find((t) => t.id === id) ?? all[0]
}

/**
 * Detector confidence-threshold multiplier for a template. Sensitivity 0.5 is
 * neutral (×1); higher loosens the thresholds (more cues), lower tightens them.
 * Clamped so a template can never go negative or wildly past the detector's range.
 */
export function templateThresholdScale(t: CueTemplate): number {
  const s = Math.max(0, Math.min(1, t.sensitivity))
  return Math.max(0, Math.min(2, 2 * (1 - s)))
}

/**
 * Apply a template's role filter + colour/label remap to detector output. Cues
 * whose role is disabled are dropped; survivors are recoloured/relabelled and
 * returned in their original time order. Pure — no detection, no I/O.
 */
export function applyCueTemplate(cues: SuggestedCue[], template: CueTemplate): SuggestedCue[] {
  const out: SuggestedCue[] = []
  for (const c of cues) {
    const role = LABEL_TO_ROLE[c.label]
    // An unrecognised label (shouldn't happen) passes through untouched.
    if (!role) {
      out.push(c)
      continue
    }
    const rule = template.roles[role]
    if (!rule.enabled) continue
    out.push({ ...c, color: rule.color, label: rule.label })
  }
  return out
}

let _userTemplateSeq = 0
/** Create a user-editable copy of a template (used by the "duplicate" action). */
export function cloneCueTemplate(src: CueTemplate, idSuffix: string): CueTemplate {
  // idSuffix keeps ids stable/unique without Date.now()/random (forbidden here).
  _userTemplateSeq += 1
  return {
    id: `user:${idSuffix}:${_userTemplateSeq}`,
    name: `${src.name.replace(/\s*\(copy\)$/, '')} (copy)`,
    builtin: false,
    sensitivity: src.sensitivity,
    roles: {
      mixIn: { ...src.roles.mixIn },
      build: { ...src.roles.build },
      drop: { ...src.roles.drop },
      break: { ...src.roles.break },
      outro: { ...src.roles.outro }
    }
  }
}
