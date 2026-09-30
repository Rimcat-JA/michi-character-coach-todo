import { calculateScore, validateScore, type ScoreInput, type ScoreResult } from './domain'

export const scoreAttributeKeys = ['minutes', 'travelMinutes', 'difficulty', 'uncertainty', 'coordination', 'physical', 'outing'] as const
export type ScoreAttributeKey = typeof scoreAttributeKeys[number]
export type ScoreAttributeValues = Pick<ScoreInput, ScoreAttributeKey>
export type ScoreCandidate = { values: ScoreAttributeValues; evidence: Record<ScoreAttributeKey, string | null> }
export type ScoreAcceptanceProvenance = {
  ruleVersion: 'v1'; model: string; sourceText: string; estimated: boolean
  fields: { field: ScoreAttributeKey; value: number | boolean | null; origin: 'ai_estimate' | 'human'; evidence: string | null }[]
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }

/** Validate untrusted model output. The model never controls mode or final points. */
export function parseScoreCandidate(sourceText: string, answer: string): ScoreCandidate {
  if (!sourceText.trim() || sourceText.length > 6000) throw new Error('見積もりに使う本文は1〜6000文字で指定してください')
  let parsed: unknown
  try { parsed = JSON.parse(answer) } catch { throw new Error('AIの属性候補を読めませんでした。元の値は残っています。') }
  if (!record(parsed) || !exactKeys(parsed, ['attributes']) || !record(parsed.attributes) || !exactKeys(parsed.attributes, scoreAttributeKeys)) throw new Error('AIの属性候補の形式が不正です')
  const values: ScoreAttributeValues = { minutes: null, travelMinutes: null, difficulty: null, uncertainty: null, coordination: null, physical: null, outing: null }
  const evidence = {} as Record<ScoreAttributeKey, string | null>
  for (const field of scoreAttributeKeys) {
    const candidate = parsed.attributes[field]
    if (!record(candidate) || !exactKeys(candidate, ['value', 'evidence'])) throw new Error(`${field}の候補形式が不正です`)
    const value = candidate.value
    if (value === null) {
      if (candidate.evidence !== null) throw new Error(`${field}が不明な場合は根拠も空にしてください`)
    } else {
      if (typeof candidate.evidence !== 'string' || !/[\p{L}\p{N}]/u.test(candidate.evidence) || candidate.evidence.length > 6000 || !sourceText.includes(candidate.evidence)) throw new Error(`${field}の根拠が選択した本文と一致しません`)
      if (field === 'outing' ? typeof value !== 'boolean' : typeof value !== 'number') throw new Error(`${field}の値が不正です`)
    }
    if (field === 'outing') values.outing = value as boolean | null
    else values[field] = value as number | null
    evidence[field] = candidate.evidence as string | null
  }
  validateScore({ ...values, mode: 'formula', manualPoints: null })
  return { values, evidence }
}

export function scoreReferencePreview(score: ScoreInput): ScoreResult {
  return calculateScore({ ...score, mode: 'formula', manualPoints: null })
}

/** Only explicitly selected fields are applied. Manual and allocated scores remain locked. */
export function acceptScoreCandidate(score: ScoreInput, candidate: ScoreCandidate, edited: ScoreAttributeValues, selected: ScoreAttributeKey[], model: string, sourceText: string): { score: ScoreInput; provenance: ScoreAcceptanceProvenance } {
  parseScoreCandidate(sourceText, JSON.stringify({ attributes: Object.fromEntries(scoreAttributeKeys.map(field => [field, { value: candidate.values[field], evidence: candidate.evidence[field] }])) }))
  if (new Set(selected).size !== selected.length || selected.some(field => !scoreAttributeKeys.includes(field))) throw new Error('採用する属性が不正です')
  if (!selected.length) throw new Error('採用する属性を選んでください')
  const next: ScoreInput = { ...score }
  const fields: ScoreAcceptanceProvenance['fields'] = []
  for (const field of selected) {
    const value = edited[field]
    if (field === 'outing') next.outing = value as boolean | null
    else next[field] = value as number | null
    const origin = value === candidate.values[field] && value !== null ? 'ai_estimate' : 'human'
    fields.push({ field, value, origin, evidence: origin === 'ai_estimate' ? candidate.evidence[field] : null })
  }
  validateScore(next)
  return { score: next, provenance: { ruleVersion: 'v1', model, sourceText, estimated: fields.some(field => field.origin === 'ai_estimate'), fields } }
}
