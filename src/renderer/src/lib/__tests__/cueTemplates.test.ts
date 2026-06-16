import { describe, it, expect } from 'vitest'
import type { SuggestedCue } from '../analyzerWorker'
import {
  BUILTIN_CUE_TEMPLATES,
  resolveCueTemplate,
  allCueTemplates,
  templateThresholdScale,
  applyCueTemplate,
  cloneCueTemplate,
  DEFAULT_CUE_TEMPLATE_ID
} from '../cueTemplates'

const cues: SuggestedCue[] = [
  { positionMs: 1000, label: 'Mix In', color: '#000', confidence: 0.5 },
  { positionMs: 2000, label: 'Build', color: '#000', confidence: 0.5 },
  { positionMs: 3000, label: 'Drop', color: '#000', confidence: 0.9 },
  { positionMs: 4000, label: 'Break', color: '#000', confidence: 0.4 },
  { positionMs: 5000, label: 'Outro', color: '#000', confidence: 0.6 }
]

const standard = BUILTIN_CUE_TEMPLATES[0]
const minimal = BUILTIN_CUE_TEMPLATES.find((t) => t.id === 'builtin:minimal')!

describe('resolveCueTemplate', () => {
  it('falls back to the Standard preset when nothing is set', () => {
    expect(resolveCueTemplate(null).id).toBe(DEFAULT_CUE_TEMPLATE_ID)
    expect(resolveCueTemplate({}).id).toBe(DEFAULT_CUE_TEMPLATE_ID)
  })
  it('resolves a built-in by id', () => {
    expect(resolveCueTemplate({ activeCueTemplateId: 'builtin:minimal' }).id).toBe('builtin:minimal')
  })
  it('resolves a user template and lists it after the built-ins', () => {
    const user = cloneCueTemplate(standard, 'x')
    const settings = { cueTemplates: [user], activeCueTemplateId: user.id }
    expect(resolveCueTemplate(settings).id).toBe(user.id)
    expect(allCueTemplates(settings).at(-1)?.id).toBe(user.id)
  })
  it('falls back when the active id no longer exists', () => {
    expect(resolveCueTemplate({ activeCueTemplateId: 'user:gone' }).id).toBe(DEFAULT_CUE_TEMPLATE_ID)
  })
})

describe('templateThresholdScale', () => {
  it('is neutral (×1) at the default 0.5 sensitivity', () => {
    expect(templateThresholdScale(standard)).toBeCloseTo(1)
  })
  it('loosens (<1) as sensitivity rises and tightens (>1) as it falls', () => {
    expect(templateThresholdScale({ ...standard, sensitivity: 1 })).toBeCloseTo(0)
    expect(templateThresholdScale({ ...standard, sensitivity: 0 })).toBeCloseTo(2)
  })
})

describe('applyCueTemplate', () => {
  it('keeps all five roles for the Standard template', () => {
    const out = applyCueTemplate(cues, standard)
    expect(out.map((c) => c.label)).toEqual(['Mix In', 'Build', 'Drop', 'Break', 'Outro'])
  })

  it('drops disabled roles for the Minimal template', () => {
    const out = applyCueTemplate(cues, minimal)
    // Minimal enables only mixIn, drop, outro
    expect(out.map((c) => c.label)).toEqual(['Mix In', 'Drop', 'Outro'])
  })

  it('remaps colour and label from the role rule', () => {
    const user = cloneCueTemplate(standard, 'x')
    user.roles.drop = { enabled: true, color: '#ff0000', label: 'THE DROP' }
    const out = applyCueTemplate(cues, user)
    const drop = out.find((c) => c.label === 'THE DROP')
    expect(drop?.color).toBe('#ff0000')
    expect(drop?.positionMs).toBe(3000) // position untouched
  })

  it('preserves time order and passes through unknown labels', () => {
    const extra = [...cues, { positionMs: 500, label: 'Custom', color: '#abc' }]
    const out = applyCueTemplate(extra, standard)
    expect(out.find((c) => c.label === 'Custom')).toBeTruthy()
  })
})

describe('cloneCueTemplate', () => {
  it('produces an editable, uniquely-id-ed, deep copy', () => {
    const copy = cloneCueTemplate(standard, 'x')
    expect(copy.builtin).toBe(false)
    expect(copy.id).not.toBe(standard.id)
    expect(copy.name).toContain('(copy)')
    copy.roles.drop.enabled = false
    expect(standard.roles.drop.enabled).toBe(true) // original untouched
  })
  it('gives two clones distinct ids', () => {
    expect(cloneCueTemplate(standard, 'x').id).not.toBe(cloneCueTemplate(standard, 'x').id)
  })
})
