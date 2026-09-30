import { describe, expect, it } from 'vitest'
import { emptyScore } from './domain'
import { monthlyRule } from './calendar-test-fixtures'
import { calendarRuleEditorDefinition, calendarRuleEditorScore, calendarRuleEditorSteps } from './calendar-rule-editor'

describe('ルーティン本人編集のポイント保護', () => {
  it('formulaの空欄表示を変更と見なさず、全属性を保持する', () => {
    const score = { ...emptyScore(), mode: 'formula' as const, minutes: 45, travelMinutes: 20, difficulty: 2, uncertainty: 1, coordination: 2, physical: 1, outing: true }
    const edited = calendarRuleEditorScore(score, '')
    expect(edited).toEqual(score); expect(edited).not.toBe(score)
    expect(calendarRuleEditorScore(score, '25')).toEqual({ ...score, mode: 'manual', manualPoints: 25 })
  })
  it('手動25ptを変えない編集でも移動・負荷属性を保持し、明示的な点数変更だけを反映する', () => {
    const score = { ...emptyScore(), mode: 'manual' as const, manualPoints: 25, minutes: 60, travelMinutes: 30, difficulty: 4, uncertainty: 2, coordination: 1, physical: 2, outing: true }
    expect(calendarRuleEditorScore(score, '25')).toEqual(score)
    expect(calendarRuleEditorScore(score, '40')).toEqual({ ...score, manualPoints: 40 })
    expect(calendarRuleEditorScore(score, '')).toEqual({ ...score, mode: 'unset', manualPoints: null })
    expect(() => calendarRuleEditorScore(score, '2.5')).toThrow('整数')
  })
  it('最新変更版のステップ・キー・属性・残りのステップを保持し、保存済み版を変更しない', () => {
    const rule = monthlyRule(), first = { ...rule.steps[0], key: 'latest-first', score: { ...emptyScore(), mode: 'manual' as const, manualPoints: 30, minutes: 90, travelMinutes: 10 } }, second = { ...rule.steps[0], key: 'latest-second', title: '最新変更版の次のステップ' }
    rule.revision = 2; rule.editions = [{ id: 'newest', revision: 2, scope: { kind: 'all_uncompleted' }, definition: { title: '最新版', enabled: true, trigger: rule.trigger, steps: [first, second] } }]
    const before = structuredClone(rule), latest = calendarRuleEditorDefinition(rule)
    expect(latest.steps).toEqual([first, second])
    const steps = calendarRuleEditorSteps(rule, { title: 'タイトルだけ変更', kind: 'task', scheduledOffsetDays: 0, dueOffsetDays: 0, durationMinutes: null }, '30')
    expect(steps).toEqual([{ ...first, title: 'タイトルだけ変更' }, second])
    expect(rule).toEqual(before); expect(steps[1]).not.toBe(second); expect(steps[0].score).not.toBe(first.score)
  })
})
