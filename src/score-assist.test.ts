import { describe, expect, it } from 'vitest'
import { calculateScore, emptyScore, type ScoreInput } from './domain'
import { acceptScoreCandidate, parseScoreCandidate, scoreAttributeKeys, scoreReferencePreview, type ScoreAttributeValues } from './score-assist'

const source = '図書館へ本を返す。作業15分、移動30分。'
const fullValues: ScoreAttributeValues = { minutes: 15, travelMinutes: 30, difficulty: 0, uncertainty: 0, coordination: 0, physical: 1, outing: true }
function answer(values: ScoreAttributeValues = fullValues) { return JSON.stringify({ attributes: Object.fromEntries(scoreAttributeKeys.map(field => [field, { value: values[field], evidence: values[field] === null ? null : source }])) }) }

describe('AI score attribute candidates', () => {
  it('keeps missing values unknown instead of filling zero or false', () => {
    const values = { ...fullValues, minutes: null, outing: null }
    const candidate = parseScoreCandidate(source, answer(values))
    const accepted = acceptScoreCandidate({ ...emptyScore(), mode: 'formula' }, candidate, candidate.values, [...scoreAttributeKeys], 'model/a', source)
    expect(accepted.score.minutes).toBeNull()
    expect(accepted.score.outing).toBeNull()
    expect(calculateScore(accepted.score).effective).toBeNull()
    expect(calculateScore(accepted.score).upper).toBeNull()
    const zero = parseScoreCandidate(source, answer({ ...fullValues, minutes: 0, outing: false }))
    expect(zero.values.minutes).toBe(0)
    expect(zero.values.outing).toBe(false)
  })

  it('derives the same point with the same attributes across model names', () => {
    const candidate = parseScoreCandidate(source, answer())
    const a = acceptScoreCandidate({ ...emptyScore(), mode: 'formula' }, candidate, candidate.values, [...scoreAttributeKeys], 'model/a', source)
    const b = acceptScoreCandidate({ ...emptyScore(), mode: 'formula' }, candidate, candidate.values, [...scoreAttributeKeys], 'model/b', source)
    expect(calculateScore(a.score)).toEqual(calculateScore(b.score))
    expect(calculateScore(a.score).effective).toBe(20)
    expect(a.provenance.ruleVersion).toBe('v1')
    expect(a.provenance.model).not.toBe(b.provenance.model)
  })

  it('retains a manually assigned 25pt and only offers a formula reference', () => {
    const original: ScoreInput = { ...emptyScore(), mode: 'manual', manualPoints: 25 }
    const candidate = parseScoreCandidate(source, answer())
    const accepted = acceptScoreCandidate(original, candidate, candidate.values, [...scoreAttributeKeys], 'model/a', source)
    expect(accepted.score.mode).toBe('manual')
    expect(accepted.score.manualPoints).toBe(25)
    expect(calculateScore(accepted.score).effective).toBe(25)
    expect(scoreReferencePreview(accepted.score).effective).toBe(20)
    expect(original).toEqual({ ...emptyScore(), mode: 'manual', manualPoints: 25 })
  })

  it('only adopts selected fields, preserves existing values and records edited origin', () => {
    const original: ScoreInput = { ...emptyScore(), mode: 'allocated', manualPoints: 5, minutes: 75, difficulty: 3 }
    const candidate = parseScoreCandidate(source, answer())
    const accepted = acceptScoreCandidate(original, candidate, { ...candidate.values, travelMinutes: 25 }, ['travelMinutes', 'outing'], 'model/a', source)
    expect(accepted.score).toEqual({ ...original, travelMinutes: 25, outing: true })
    expect(accepted.provenance.fields).toEqual([
      { field: 'travelMinutes', value: 25, origin: 'human', evidence: null },
      { field: 'outing', value: true, origin: 'ai_estimate', evidence: source },
    ])
    expect(accepted.provenance.estimated).toBe(true)
    expect(accepted.provenance.sourceText).toBe(source)
  })

  it('rejects model points, extra fields, missing fields and malformed data', () => {
    const parsed = JSON.parse(answer())
    expect(() => parseScoreCandidate(source, '{')).toThrow()
    expect(() => parseScoreCandidate(source, JSON.stringify({ ...parsed, manualPoints: 800 }))).toThrow()
    expect(() => parseScoreCandidate(source, JSON.stringify({ attributes: { ...parsed.attributes, confidence: 0.9 } }))).toThrow()
    expect(() => parseScoreCandidate(source, JSON.stringify({ attributes: { minutes: parsed.attributes.minutes } }))).toThrow()
    expect(() => parseScoreCandidate(source, JSON.stringify({ attributes: { ...parsed.attributes, minutes: { value: 15, evidence: source, points: 25 } } }))).toThrow()
    expect(() => parseScoreCandidate(source, 'null')).toThrow()
  })

  it('rejects fabricated evidence, noninteger values, out of range values and invalid booleans', () => {
    const parsed = JSON.parse(answer())
    const withField = (field: string, value: unknown, evidence: unknown = source) => JSON.stringify({ attributes: { ...parsed.attributes, [field]: { value, evidence } } })
    expect(() => parseScoreCandidate(source, withField('minutes', 20, '高難度の作業を2時間'))).toThrow()
    expect(() => parseScoreCandidate(source, withField('minutes', 20, ''))).toThrow()
    expect(() => parseScoreCandidate(source, withField('minutes', 20, '。'))).toThrow()
    expect(() => parseScoreCandidate(source, withField('difficulty', 1.5))).toThrow()
    expect(() => parseScoreCandidate(source, withField('coordination', 4))).toThrow()
    expect(() => parseScoreCandidate(source, withField('travelMinutes', 10081))).toThrow()
    expect(() => parseScoreCandidate(source, withField('physical', -1))).toThrow()
    expect(() => parseScoreCandidate(source, withField('outing', 'true'))).toThrow()
    expect(() => parseScoreCandidate(source, withField('minutes', null))).toThrow()
  })

  it('validates edited adoption and does not mutate the current score on failure', () => {
    const original = emptyScore()
    const candidate = parseScoreCandidate(source, answer())
    expect(() => acceptScoreCandidate(original, candidate, { ...candidate.values, minutes: -5 }, ['minutes'], 'model/a', source)).toThrow()
    expect(() => acceptScoreCandidate(original, candidate, candidate.values, [], 'model/a', source)).toThrow()
    expect(() => acceptScoreCandidate(original, candidate, candidate.values, ['minutes', 'minutes'], 'model/a', source)).toThrow()
    expect(original).toEqual(emptyScore())
  })

})
