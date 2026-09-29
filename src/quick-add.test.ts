import { describe, expect, it } from 'vitest'
import { parseBraindump, parseQuickAddLine, setQuickAddPoints } from './quick-add'

describe('AIを使わないQuick Add', () => {
  it('設計書の確定構文をフォームと同じ入力へ変換する', () => {
    const result = parseQuickAddLine('図書館へ返却 #生活 @2026-10-01 !due:2026-10-03 ~45m pt:25')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.title).toBe('図書館へ返却')
    expect(result.input.project).toBe('生活')
    expect(result.input.scheduledDate).toBe('2026-10-01')
    expect(result.input.dueDate).toBe('2026-10-03')
    expect(result.input.score).toMatchObject({ mode: 'manual', manualPoints: 25, minutes: 45 })
  })

  it('0ptを保存対象とし、不正値を黙って捨てない', () => {
    const zero = parseQuickAddLine('連絡 pt:0')
    expect(zero.ok && zero.input.score.manualPoints).toBe(0)
    for (const line of ['連絡 pt:-1', '連絡 pt:1.5', '連絡 ~foo', '連絡 @2026-02-30', '連絡 !unknown:today', '連絡 pt:5 pt:6']) {
      expect(parseQuickAddLine(line).ok).toBe(false)
    }
  })

  it('100行を超える入力を切り捨てずに拒否し、行番号を保持する', () => {
    expect(parseBraindump('良い行\n連絡 pt:bad')).toMatchObject([{ line: 1, result: { ok: true } }, { line: 2, result: { ok: false } }])
    expect(() => parseBraindump(Array.from({ length: 101 }, (_, i) => `作業${i}`).join('\n'))).toThrow('100行')
  })

  it('候補の手動ポイントを行ごとに修正できる', () => {
    const parsed = parseQuickAddLine('調査 ~45m')
    if (!parsed.ok) throw new Error(parsed.error)
    const edited = setQuickAddPoints(parsed.input, '25')
    expect(edited.ok && edited.input.score).toMatchObject({ mode: 'manual', manualPoints: 25, minutes: 45 })
    expect(setQuickAddPoints(parsed.input, 'abc').ok).toBe(false)
  })
})
