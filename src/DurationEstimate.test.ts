import { describe, expect, it } from 'vitest'
import { calculateScore, emptyScore } from './domain'
import { estimatedDuration } from './estimates'

describe('作業と移動の見積', () => {
  it('30分作業と20分移動を50分として表示し、式にも一度だけ入れる', () => {
    const score = { ...emptyScore(), mode: 'formula' as const, minutes: 30, travelMinutes: 20, difficulty: 0, uncertainty: 0, coordination: 0, physical: 0, outing: false }
    expect(estimatedDuration(score)).toEqual({ work: 30, travel: 20, total: 50 })
    expect(calculateScore(score).effective).toBe(calculateScore({ ...score, minutes: 50, travelMinutes: 0 }).effective)
    expect(calculateScore(score).effective).toBe(8)
    expect(estimatedDuration({ ...score, travelMinutes: null }).total).toBeNull()
  })
})
