import { describe, expect, it } from 'vitest'
import { calculateScore, emptyScore } from './domain'

describe('必要ポイント', () => {
  it('未設定と手動0ptを分ける', () => {
    expect(calculateScore(emptyScore()).effective).toBeNull()
    expect(calculateScore({ ...emptyScore(), mode: 'manual', manualPoints: 0 }).effective).toBe(0)
  })
  it('設計書の計算例と外出最低点を守る', () => {
    const score = { ...emptyScore(), mode: 'formula' as const, minutes: 60, travelMinutes: 0, difficulty: 1, uncertainty: 2, coordination: 2, physical: 1, outing: true }
    expect(calculateScore(score).effective).toBe(36)
    expect(calculateScore({ ...score, minutes: 0, difficulty: 0, uncertainty: 0, coordination: 0, physical: 0 }).effective).toBe(20)
  })
  it('所要時間不明を0分として確定しない', () => {
    const score = { ...emptyScore(), mode: 'formula' as const, difficulty: 1, uncertainty: 0, coordination: 0, physical: 0, outing: false }
    expect(calculateScore(score).effective).toBeNull()
    expect(calculateScore(score).upper).toBeNull()
  })
})
