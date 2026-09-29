import { describe, expect, it } from 'vitest'
import { unionSessionMinutes } from './time-tracking'

describe('作業時間の区間集計', () => {
  it('重複する端末の区間はunionで数え、元区間を変えない', () => {
    const sessions = [
      { startedAt: '2026-10-01T10:00:00.000Z', endedAt: '2026-10-01T10:30:00.000Z' },
      { startedAt: '2026-10-01T10:20:00.000Z', endedAt: '2026-10-01T10:50:00.000Z' },
      { startedAt: '2026-10-01T11:00:00.000Z', endedAt: '2026-10-01T11:10:00.000Z' }
    ]
    expect(unionSessionMinutes(sessions)).toBe(60)
    expect(sessions[1].startedAt).toBe('2026-10-01T10:20:00.000Z')
  })
})
