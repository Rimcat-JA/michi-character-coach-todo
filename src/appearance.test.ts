import { expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, validateAppearance } from './appearance'
import { emptyScore, scoreText } from './domain'

it('配色に依存せず手動・自動・未設定を文字で区別し、不正設定を拒否する', () => {
  expect(scoreText({ score: { ...emptyScore(), mode: 'manual', manualPoints: 25 }, effectivePoints: 25 })).toContain('手動')
  expect(scoreText({ score: { ...emptyScore(), mode: 'formula' }, effectivePoints: 25 })).toContain('自動')
  expect(scoreText({ score: emptyScore(), effectivePoints: null })).toBe('未設定')
  expect(() => validateAppearance(DEFAULT_APPEARANCE)).not.toThrow()
  expect(() => validateAppearance({ ...DEFAULT_APPEARANCE, accent: 'invisible' })).toThrow('見た目')
})
