import { describe, expect, it } from 'vitest'
import { emptyScore } from './domain'
import { monthlyRule } from './calendar-test-fixtures'
import { calendarRuleEditorDefinition, calendarRuleEditorScore, calendarRuleEditorSteps, describeCalendarTrigger, emptyRRuleForm, followSeriesClock, localDateTimeList, localDateTimeText, rruleForm, rruleFormNotes, rruleFormStructure, rruleFromForm, type RRuleForm } from './calendar-rule-editor'
import { expandRRule } from './rrule'

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

describe('繰り返し規則エディタの入力', () => {
  const form = (patch: Partial<RRuleForm>): RRuleForm => ({ ...emptyRRuleForm(), ...patch })
  it('月末プリセットと31日、第N曜日、最終平日、終わりの指定をRRULEにする', () => {
    expect(rruleFromForm(form({ freq: 'MONTHLY', monthMode: 'month_end' }))).toBe('FREQ=MONTHLY;BYMONTHDAY=-1')
    expect(rruleFromForm(form({ freq: 'MONTHLY', monthMode: 'monthdays', monthDays: '31' }))).toBe('FREQ=MONTHLY;BYMONTHDAY=31')
    expect(rruleFromForm(form({ freq: 'MONTHLY', monthMode: 'weekdays', weekdays: [2], ordinals: '2' }))).toBe('FREQ=MONTHLY;BYDAY=2TU')
    expect(rruleFromForm(form({ freq: 'MONTHLY', monthMode: 'last_workday' }))).toBe('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1')
    expect(rruleFromForm(form({ freq: 'YEARLY', monthMode: 'monthdays', monthDays: '29', months: [2] }))).toBe('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29')
    expect(rruleFromForm(form({ freq: 'WEEKLY', interval: '2', weekdays: [5, 1], end: 'count', count: '5' }))).toBe('FREQ=WEEKLY;INTERVAL=2;COUNT=5;BYDAY=MO,FR')
    expect(rruleFromForm(form({ freq: 'DAILY', end: 'until', until: '2026-12-31' }))).toBe('FREQ=DAILY;UNTIL=20261231')
    expect(() => rruleFromForm(form({ freq: 'MONTHLY', monthMode: 'monthdays', monthDays: '32' }))).toThrow()
    expect(() => rruleFromForm(form({ freq: 'MONTHLY', monthMode: 'weekdays', weekdays: [2], ordinals: '二' }))).toThrow('数値')
  })
  it('保存済みRRULEをフォームへ戻しても同じ規則になる', () => {
    for (const rule of ['FREQ=MONTHLY;BYDAY=2TU', 'FREQ=MONTHLY;BYMONTHDAY=-1', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', 'FREQ=WEEKLY;INTERVAL=2;COUNT=5;BYDAY=MO,FR', 'FREQ=DAILY;UNTIL=20261231']) expect(rruleFromForm(rruleForm(rule))).toBe(rule)
  })
  it('除外・追加の回を現地日時へ揃え、周期を本人向けに説明する', () => {
    expect(localDateTimeList('2026-12-30, 2026-12-29T15:00、2026-12-30', '10:00')).toEqual(['2026-12-29T15:00', '2026-12-30T10:00'])
    expect(describeCalendarTrigger({ kind: 'rrule', dtstart: '2026-10-13T10:00', rrule: 'FREQ=MONTHLY;BYDAY=2TU', rdates: [], exdates: ['2026-12-08T10:00'], nonexistentTime: 'skip', ambiguousTime: 'earlier' })).toBe('毎月 第2火曜 10:00（開始 2026-10-13 10:00 / 除外1件 / 夏時間：ない時刻の回は作らない・二度ある時刻は前）')
    expect(describeCalendarTrigger({ kind: 'completion_relative', firstDate: '2026-10-01', time: '09:00', afterDays: 14, unfinishedPolicy: 'keep_all' })).toBe('前回の完了から14日後 09:00（最初 2026-10-01 / 未完了の回をすべて残す）')
  })
  it('系列の時刻を変えると、旧時刻のままの除外・追加の回も同じ日の新しい時刻へ移し、別の時刻の指定は残す', () => {
    // A date typed without a clock, a stored value at the old series time, and an explicit other clock.
    expect(followSeriesClock(localDateTimeList('2026-10-20, 2026-10-27T10:00, 2026-11-03T15:00', '11:00'), '10:00', '11:00')).toEqual(['2026-10-20T11:00', '2026-10-27T11:00', '2026-11-03T15:00'])
    expect(followSeriesClock(['2026-10-20T10:00', '2026-10-20T11:00'], '10:00', '11:00')).toEqual(['2026-10-20T11:00'])
    expect(followSeriesClock(['2026-10-20T10:00'], '10:00', '10:00')).toEqual(['2026-10-20T10:00'])
    // Reopening a rule shows values at the series time as bare dates, so saving again with the same time changes nothing.
    expect(localDateTimeText(['2026-10-20T10:00', '2026-11-03T15:00'], '10:00')).toBe('2026-10-20, 2026-11-03T15:00')
    expect(localDateTimeList(localDateTimeText(['2026-10-20T10:00', '2026-11-03T15:00'], '10:00'), '10:00')).toEqual(['2026-10-20T10:00', '2026-11-03T15:00'])
  })
  it('年ごとの最終平日は対象の月を1つだけにし、複数の月は月ごとで毎月作る', () => {
    expect(() => rruleFromForm(form({ freq: 'YEARLY', monthMode: 'last_workday', months: [3, 9] }))).toThrow('対象の月を1つだけ')
    expect(() => rruleFromForm(form({ freq: 'YEARLY', monthMode: 'last_workday' }))).toThrow('対象の月を1つだけ')
    const yearly = rruleFromForm(form({ freq: 'YEARLY', monthMode: 'last_workday', months: [3] }))
    expect(yearly).toBe('FREQ=YEARLY;BYMONTH=3;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1')
    expect(expandRRule({ dtstart: '2026-01-01T09:00', rrule: yearly, from: '2026-01-01', to: '2027-12-31' }).occurrences.map(value => value.slice(0, 10))).toEqual(['2026-03-31', '2027-03-31'])
    const monthly = rruleFromForm(form({ freq: 'MONTHLY', monthMode: 'last_workday', months: [3, 9] }))
    expect(monthly).toBe('FREQ=MONTHLY;BYMONTH=3,9;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1')
    expect(expandRRule({ dtstart: '2026-01-01T09:00', rrule: monthly, from: '2026-01-01', to: '2027-12-31' }).occurrences.map(value => value.slice(0, 10))).toEqual(['2026-03-31', '2026-09-30', '2027-03-31', '2027-09-30'])
  })
  it('年ごとで対象の月が空欄の日付・月末・第N曜日には、毎月や年内の順位になることを示す', () => {
    expect(rruleFormNotes(form({ freq: 'YEARLY', monthMode: 'monthdays', monthDays: '15' }))).toEqual(['対象の月が空欄のため毎月作られます。年1回にするには対象の月を選んでください'])
    expect(rruleFormNotes(form({ freq: 'YEARLY', monthMode: 'month_end' }))[0]).toContain('毎月作られます')
    expect(rruleFormNotes(form({ freq: 'YEARLY', monthMode: 'weekdays', weekdays: [1], ordinals: '2' }))[0]).toContain('年内の順位')
    expect(rruleFormNotes(form({ freq: 'YEARLY', monthMode: 'monthdays', monthDays: '15', months: [10] }))).toEqual([])
    expect(rruleFormNotes(form({ freq: 'MONTHLY', monthMode: 'monthdays', monthDays: '15' }))).toEqual([])
    // The stored rule keeps the RFC meaning; nothing adds a month the owner did not tick.
    expect(rruleFromForm(form({ freq: 'YEARLY', monthMode: 'monthdays', monthDays: '15' }))).toBe('FREQ=YEARLY;BYMONTHDAY=15')
  })
  it('BYSETPOSは保存済みの規則で保ち、頻度・月内の日の決め方を変えたときだけ消す', () => {
    expect(rruleFromForm(rruleForm('FREQ=MONTHLY;BYMONTHDAY=28,29;BYSETPOS=-1'))).toBe('FREQ=MONTHLY;BYMONTHDAY=28,29;BYSETPOS=-1')
    expect(rruleForm('FREQ=MONTHLY;BYMONTHDAY=28,29;BYSETPOS=-1')).toMatchObject({ monthMode: 'monthdays', setPos: '-1' })
    expect(rruleFromForm(form({ freq: 'MONTHLY', monthMode: 'monthdays', monthDays: '1,15', setPos: '' }))).toBe('FREQ=MONTHLY;BYMONTHDAY=1,15')
    const weekdays = form({ freq: 'MONTHLY', monthMode: 'weekdays', weekdays: [1, 2, 3], setPos: '-1' })
    expect(rruleFormStructure(weekdays, { monthMode: 'monthdays' })).toMatchObject({ monthMode: 'monthdays', setPos: '' })
    expect(rruleFormStructure(weekdays, { freq: 'YEARLY' })).toMatchObject({ freq: 'YEARLY', monthMode: 'weekdays', setPos: '' })
    expect(rruleFromForm({ ...rruleFormStructure(weekdays, { monthMode: 'monthdays' }), monthDays: '1,15' })).toBe('FREQ=MONTHLY;BYMONTHDAY=1,15')
  })
})
