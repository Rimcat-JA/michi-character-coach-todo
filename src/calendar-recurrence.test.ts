import { describe, expect, it } from 'vitest'
import { addDays, emptyScore } from './domain'
import { followSeriesClock, rebaseFutureCount } from './calendar-rule-editor'
import { buildCalendarChangePlan, resolveCalendarOccurrences, type CalendarRule, type CalendarRulesState, type CurrentCalendarEntity, type RecurrenceUnfinishedPolicy, type ResolvedCalendarSpec } from './calendar-resolver'
import { validateCalendarRulesState } from './calendar-rules-validation'
import { calendarFixture, monthlyRule } from './calendar-test-fixtures'

const task = (points = 10) => ({ key: 'main', title: '資料確認', kind: 'task' as const, scheduledOffsetDays: 0, dueOffsetDays: null, score: { ...emptyScore(), mode: 'manual' as const, manualPoints: points }, durationMinutes: null })
const event = { key: 'meet', title: '町内会', kind: 'event' as const, scheduledOffsetDays: 0, dueOffsetDays: null, score: null, durationMinutes: 60 }
function rruleRule(rrule: string, dtstart = '2026-10-13T10:00', patch: Partial<CalendarRule> = {}): CalendarRule {
  return monthlyRule({ id: 'rr', title: '町内会の資料確認', trigger: { kind: 'rrule', dtstart, rrule, rdates: [], exdates: [], nonexistentTime: 'skip', ambiguousTime: 'earlier' }, steps: [task()], ...patch })
}
function chainRule(unfinishedPolicy: RecurrenceUnfinishedPolicy = 'generate_after_completion', patch: Partial<Extract<CalendarRule['trigger'], { kind: 'completion_relative' }>> = {}): CalendarRule {
  return monthlyRule({ id: 'water', title: '植物の水やり', trigger: { kind: 'completion_relative', firstDate: '2026-10-01', time: '09:00', afterDays: 14, unfinishedPolicy, ...patch }, steps: [task()] })
}
function state(...rules: CalendarRule[]): CalendarRulesState {
  const value = calendarFixture(); value.activities = []; value.bindings[0].activityIds = []; value.rules = rules
  validateCalendarRulesState(value, 'owner', 'dataset'); return value
}
const entity = (spec: ResolvedCalendarSpec, patch: Partial<CurrentCalendarEntity> = {}): CurrentCalendarEntity => ({ generationKey: spec.generationKey, entityId: `entity:${spec.generationKey}`, revision: 1, status: 'active', completed: false, edited: false, started: false, spec, completedAt: null, ...patch })
const resolved = (value: CalendarRulesState, from = '2026-10-01', to = '2026-12-31', today?: string) => resolveCalendarOccurrences(value, from, to, [], today ? { today } : {})
const dates = (specs: ResolvedCalendarSpec[]) => specs.map(spec => spec.scheduledDate ?? spec.startAt)
type RRuleTrigger = Extract<CalendarRule['trigger'], { kind: 'rrule' }>
/** A time-only "all uncompleted" edition, as the editor saves it. */
function laterTime(value: CalendarRulesState, trigger: Partial<RRuleTrigger>) {
  const rule = value.rules[0]; rule.revision = 2
  rule.editions = [{ id: 'later', revision: 2, scope: { kind: 'all_uncompleted' }, definition: { title: rule.title, enabled: true, trigger: { ...rule.trigger as RRuleTrigger, dtstart: `${(rule.trigger as RRuleTrigger).dtstart.slice(0, 10)}T11:00`, ...trigger }, steps: rule.steps } }]
  validateCalendarRulesState(value, 'owner', 'dataset')
}

describe('共通resolverのRRULE系列', () => {
  it('毎月第2火曜10:00を本来の発生日でキー付けし、既存の毎週・第N営業日のキーを変えない', () => {
    const value = state(rruleRule('FREQ=MONTHLY;BYDAY=2TU'), monthlyRule(), monthlyRule({ id: 'weekly', trigger: { kind: 'weekly', weekdays: [1], time: '09:00' } }))
    const result = resolved(value)
    expect(result.occurrences.filter(spec => spec.ruleId === 'rr').map(spec => [spec.scheduledDate, spec.generationKey])).toEqual([['2026-10-13', 'calendar:rule:rr:anchor:2026-10-13:main'], ['2026-11-10', 'calendar:rule:rr:anchor:2026-11-10:main'], ['2026-12-08', 'calendar:rule:rr:anchor:2026-12-08:main']])
    expect(result.occurrences.filter(spec => spec.ruleId === 'payroll').map(spec => spec.generationKey)).toEqual(['calendar:rule:payroll:month:2026-10:submit', 'calendar:rule:payroll:month:2026-11:submit', 'calendar:rule:payroll:month:2026-12:submit'])
    expect(result.occurrences.find(spec => spec.ruleId === 'weekly')?.generationKey).toBe('calendar:rule:weekly:anchor:2026-10-05:submit')
    expect(result.truncatedSeries).toEqual([]); expect(result.conflicts).toEqual([])
  })
  it('毎年2月29日はうるう年だけ、月末プリセットと31日を区別する', () => {
    const leap = state(rruleRule('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', '2024-02-29T09:00', { validFrom: '2026-01-01', validTo: '2026-12-31' }))
    expect(resolved(leap, '2026-01-01', '2026-12-31').occurrences).toEqual([])
    const monthEnd = state(rruleRule('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-01-31T09:00'), rruleRule('FREQ=MONTHLY;BYMONTHDAY=31', '2026-01-31T09:00', { id: 'day31' }))
    const result = resolved(monthEnd, '2026-09-01', '2026-11-30')
    expect(dates(result.occurrences.filter(spec => spec.ruleId === 'rr'))).toEqual(['2026-09-30', '2026-10-31', '2026-11-30'])
    expect(dates(result.occurrences.filter(spec => spec.ruleId === 'day31'))).toEqual(['2026-10-31'])
  })
  it('EXDATEは本来の回を除き、RDATEは別の識別で追加する', () => {
    const rule = rruleRule('FREQ=MONTHLY;BYDAY=2TU'); if (rule.trigger.kind === 'rrule') { rule.trigger.exdates = ['2026-11-10T10:00']; rule.trigger.rdates = ['2026-11-12T15:00'] }
    expect(resolved(state(rule)).occurrences.map(spec => spec.generationKey)).toEqual(['calendar:rule:rr:anchor:2026-10-13:main', 'calendar:rule:rr:anchor:2026-12-08:main', 'calendar:rule:rr:rdate:2026-11-12T15:00:main'])
  })
  it('今回だけ・以後・未完了全部の変更で完了済みの回を保持する', () => {
    const value = state(rruleRule('FREQ=MONTHLY;BYDAY=2TU')), base = resolved(value).occurrences
    const current = base.map((spec, index) => entity(spec, index === 0 ? { completed: true, completedAt: '2026-10-13T03:00:00.000Z' } : {}))
    const rule = value.rules[0], trigger = rule.trigger
    rule.revision = 2; rule.editions = [{ id: 'once', revision: 2, scope: { kind: 'this_instance', generationKey: base[1].generationKey }, definition: { title: rule.title, enabled: true, trigger, steps: [task(20)] } }]
    expect(buildCalendarChangePlan(value, current, '2026-10-01', '2026-12-31')).toMatchObject({ skippedCompleted: 1, unchanged: 1, creates: [], cancels: [], updates: [{ after: { generationKey: base[1].generationKey, score: { manualPoints: 20 } } }] })
    rule.editions = [{ id: 'future', revision: 2, scope: { kind: 'this_and_future', fromDate: '2026-11-01' }, definition: { title: rule.title, enabled: true, trigger: { ...trigger as Extract<CalendarRule['trigger'], { kind: 'rrule' }>, rrule: 'FREQ=MONTHLY;BYDAY=3TU' }, steps: [task()] } }]
    validateCalendarRulesState(value, 'owner', 'dataset')
    const future = buildCalendarChangePlan(value, current, '2026-10-01', '2026-12-31', { kind: 'this_and_future', fromDate: '2026-11-01' })
    expect(future.skippedCompleted).toBe(0); expect(future.creates.map(spec => spec.scheduledDate)).toEqual(['2026-11-17', '2026-12-15']); expect(future.cancels.map(item => item.before.spec.scheduledDate)).toEqual(['2026-11-10', '2026-12-08'])
    expect(buildCalendarChangePlan(value, current, '2026-10-01', '2026-12-31')).toMatchObject({ skippedCompleted: 1 })
    rule.editions = [{ id: 'all', revision: 2, scope: { kind: 'all_uncompleted' }, definition: { title: rule.title, enabled: true, trigger, steps: [task(30)] } }]
    const all = buildCalendarChangePlan(value, current, '2026-10-01', '2026-12-31')
    expect(all.skippedCompleted).toBe(1); expect(all.updates.map(update => [update.after.scheduledDate, update.after.score?.manualPoints])).toEqual([['2026-11-10', 30], ['2026-12-08', 30]])
    expect(all.updates.some(update => update.before.completed)).toBe(false)
  })
  it('時刻だけの変更は同じ発生回を更新し、取消と再作成にしない', () => {
    const value = state(rruleRule('FREQ=MONTHLY;BYDAY=2TU', '2026-10-13T10:00', { steps: [task(), event] })), base = resolved(value).occurrences, current = base.map(spec => entity(spec))
    const rule = value.rules[0]; rule.revision = 2; rule.editions = [{ id: 'later', revision: 2, scope: { kind: 'all_uncompleted' }, definition: { title: rule.title, enabled: true, trigger: { ...rule.trigger as Extract<CalendarRule['trigger'], { kind: 'rrule' }>, dtstart: '2026-10-13T11:00' }, steps: rule.steps } }]
    const plan = buildCalendarChangePlan(value, current, '2026-10-01', '2026-12-31')
    expect(plan.creates).toEqual([]); expect(plan.cancels).toEqual([]); expect(plan.unchanged).toBe(3)
    expect(plan.updates.map(update => [update.after.generationKey, update.after.startAt])).toEqual([['calendar:rule:rr:anchor:2026-10-13:meet', '2026-10-13T02:00:00.000Z'], ['calendar:rule:rr:anchor:2026-11-10:meet', '2026-11-10T02:00:00.000Z'], ['calendar:rule:rr:anchor:2026-12-08:meet', '2026-12-08T02:00:00.000Z']])
  })
  it('除外して取消済みの回は、時刻だけの変更後も作り直さず復活させない', () => {
    const value = state(rruleRule('FREQ=WEEKLY;BYDAY=TU', '2026-10-13T10:00', { steps: [task(), event] })), before = resolved(value, '2026-10-01', '2026-11-10').occurrences
    ;(value.rules[0].trigger as RRuleTrigger).exdates = ['2026-10-20T10:00']; validateCalendarRulesState(value, 'owner', 'dataset')
    const current = before.map(spec => entity(spec, spec.scheduledDate === '2026-10-20' || spec.startAt?.startsWith('2026-10-20') ? { status: 'cancelled' } : {}))
    expect(buildCalendarChangePlan(value, current, '2026-10-01', '2026-11-10')).toMatchObject({ creates: [], updates: [], cancels: [] })
    // The stored EXDATE keeps 10:00 (as the editor and legacy conversion store it) while the series moves to 11:00.
    laterTime(value, {})
    const plan = buildCalendarChangePlan(value, current, '2026-10-01', '2026-11-10')
    expect([...plan.creates, ...plan.updates.map(update => update.after)].filter(spec => spec.triggerKey === 'anchor:2026-10-20')).toEqual([])
    expect(plan.creates).toEqual([]); expect(plan.cancels).toEqual([])
    expect(plan.updates.map(update => [update.before.entityId, update.after.startAt])).toEqual(['10-13', '10-27', '11-03', '11-10'].map(day => [`entity:calendar:rule:rr:anchor:2026-${day}:meet`, `2026-${day}T02:00:00.000Z`]))
    // The editor moves values at the old series time along, and leaves an explicit other clock alone.
    expect(followSeriesClock(['2026-10-20T10:00', '2026-11-04T15:00'], '10:00', '11:00')).toEqual(['2026-10-20T11:00', '2026-11-04T15:00'])
  })
  it('EXDATEは発生日で除き、時刻だけの変更版でも同じ日を除外し続ける', () => {
    const rule = rruleRule('FREQ=MONTHLY;BYDAY=2TU', '2026-10-13T10:00', { steps: [task(), event] }); (rule.trigger as RRuleTrigger).exdates = ['2026-11-10T10:00']
    const value = state(rule), current = resolved(value).occurrences.map(spec => entity(spec))
    expect(current.some(item => item.spec.triggerKey === 'anchor:2026-11-10')).toBe(false)
    laterTime(value, {})
    const plan = buildCalendarChangePlan(value, current, '2026-10-01', '2026-12-31')
    expect(plan.creates).toEqual([]); expect(plan.cancels).toEqual([]); expect(plan.updates).toHaveLength(2)
    expect(resolved(value).occurrences.some(spec => spec.triggerKey === 'anchor:2026-11-10')).toBe(false)
  })
  it('RDATEだけに一致するEXDATEはそのRDATEだけを除き、同じ日の本来の回は残す', () => {
    const rule = rruleRule('FREQ=MONTHLY;BYDAY=2TU'); Object.assign(rule.trigger, { rdates: ['2026-11-10T15:00', '2026-11-12T15:00'], exdates: ['2026-11-10T15:00'] })
    expect(resolved(state(rule)).occurrences.map(spec => spec.generationKey)).toEqual(['calendar:rule:rr:anchor:2026-10-13:main', 'calendar:rule:rr:anchor:2026-11-10:main', 'calendar:rule:rr:anchor:2026-12-08:main', 'calendar:rule:rr:rdate:2026-11-12T15:00:main'])
  })
  it('回数（COUNT）付きの系列を以後だけ変えるとき、変更日より前の回を引いた残りの回数を引き継ぐ', () => {
    const value = state(rruleRule('FREQ=WEEKLY;COUNT=6;BYDAY=TU', '2026-10-06T10:00')), rule = value.rules[0], base = rule.trigger as RRuleTrigger
    expect(dates(resolved(value).occurrences)).toEqual(['2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10'])
    const daily = { ...base, rrule: 'FREQ=DAILY;COUNT=6' }, rebased = rebaseFutureCount(rule, daily, '2026-10-20')!
    // DTSTART stays, so the implicit day and interval phase do not move; 14 daily instances fall before 10/20 and 4 remain.
    expect(rebased).toEqual({ trigger: { ...daily, rrule: 'FREQ=DAILY;COUNT=18' }, remaining: 4 })
    expect(rebaseFutureCount(rule, base, '2026-10-20')?.trigger).toEqual(base)
    rule.revision = 2; rule.editions = [{ id: 'future', revision: 2, scope: { kind: 'this_and_future', fromDate: '2026-10-20' }, definition: { title: rule.title, enabled: true, trigger: rebased.trigger, steps: rule.steps } }]
    validateCalendarRulesState(value, 'owner', 'dataset')
    const result = resolved(value)
    expect(dates(result.occurrences)).toEqual(['2026-10-06', '2026-10-13', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']); expect(result.notices).toEqual([])
    // An older edition saved without the adjustment says why nothing follows instead of ending silently.
    rule.editions[0].definition.trigger = daily
    const stale = resolved(value)
    expect(dates(stale.occurrences)).toEqual(['2026-10-06', '2026-10-13']); expect(stale.notices.map(item => item.reason)).toEqual(['以後の変更の回数（COUNT）が変更日より前に尽きたため、2026-10-20以後の回はありません'])
    rule.editions = []
    expect(() => rebaseFutureCount(rule, daily, '2026-11-11')).toThrow('使い切って')
    expect(rebaseFutureCount(rule, { ...base, rrule: 'FREQ=DAILY' }, '2026-10-20')).toBeNull()
  })
  it('America/New_Yorkの存在しない02:30は本人選択で除外か切替前の時差、二度ある01:30は前後を選ぶ', () => {
    const value = state(rruleRule('FREQ=DAILY', '2026-03-07T02:30', { steps: [event] })); value.contexts[0].timezone = 'America/New_York'
    const skipped = resolved(value, '2026-03-07', '2026-03-09')
    expect(dates(skipped.occurrences)).toEqual(['2026-03-07T07:30:00.000Z', '2026-03-09T06:30:00.000Z'])
    expect(skipped.notices.map(item => item.reason)).toEqual(['2026-03-08 02:30は夏時間の切替で存在しないため、本人の設定どおりこの回を作りません']); expect(skipped.conflicts).toEqual([])
    const trigger = value.rules[0].trigger as Extract<CalendarRule['trigger'], { kind: 'rrule' }>; trigger.nonexistentTime = 'next_valid'
    const shifted = resolved(value, '2026-03-08', '2026-03-08')
    expect(dates(shifted.occurrences)).toEqual(['2026-03-08T07:30:00.000Z']); expect(shifted.notices[0].reason).toContain('03:30に作ります')
    trigger.dtstart = '2026-10-31T01:30'
    const earlier = resolved(value, '2026-11-01', '2026-11-01')
    expect(dates(earlier.occurrences)).toEqual(['2026-11-01T05:30:00.000Z'])
    expect(earlier.notices).toHaveLength(1); expect(earlier.notices[0].reason).toContain('前の回'); expect(earlier.notices[0].reason).toContain('01:30')
    trigger.ambiguousTime = 'later'
    const later = resolved(value, '2026-11-01', '2026-11-01')
    expect(dates(later.occurrences)).toEqual(['2026-11-01T06:30:00.000Z'])
    expect(later.notices).toHaveLength(1); expect(later.notices[0].reason).toContain('後の回')
    value.contexts[0].timezone = 'Asia/Tokyo'; trigger.dtstart = '2026-03-07T02:30'
    const tokyo = resolved(value, '2026-03-07', '2026-03-09'); expect(tokyo.occurrences).toHaveLength(3); expect(tokyo.notices).toEqual([])
  })
  it('UTCのUNTILは本人が選んだ夏時間の扱いで置く時刻と比べ、UNTILより後の回を作らない', () => {
    const value = state(rruleRule('FREQ=DAILY;UNTIL=20261101T060000Z', '2026-10-30T01:30', { steps: [event] })); value.contexts[0].timezone = 'America/New_York'
    // 01:30 on 11/01 is 05:30Z (EDT, earlier) or 06:30Z (EST, later); UNTIL is 06:00Z.
    expect(dates(resolved(value, '2026-10-31', '2026-11-01').occurrences)).toEqual(['2026-10-31T05:30:00.000Z', '2026-11-01T05:30:00.000Z'])
    ;(value.rules[0].trigger as RRuleTrigger).ambiguousTime = 'later'
    expect(dates(resolved(value, '2026-10-31', '2026-11-01').occurrences)).toEqual(['2026-10-31T05:30:00.000Z'])
  })
  it('1系列1,000回を超える分は理由付きで切り詰め、切り詰めた先の既存回を取消にしない', () => {
    const steps = [task(), { ...task(), key: 'second' }, { ...task(), key: 'third' }]
    const value = state(rruleRule('FREQ=DAILY', '2026-01-01T09:00', { steps }))
    const result = resolved(value, '2026-01-01', '2026-12-31')
    expect(result.occurrences).toHaveLength(1000)
    expect(result.truncatedSeries).toEqual([{ series: 'rule:rr', limit: 1000, omitted: 95, firstOmittedDate: '2026-11-30', reason: '1系列1000回の上限を超えたため、2026-11-30以降は表示期間を移して確認してください' }])
    const later = resolved(value, '2026-11-30', '2026-12-31'); expect(later.truncatedSeries).toEqual([]); expect(later.occurrences).toHaveLength(96)
    const current = later.occurrences.filter(spec => spec.scheduledDate! >= '2026-12-01').map(spec => entity(spec))
    const plan = buildCalendarChangePlan(value, current, '2026-01-01', '2026-12-31')
    expect(plan.cancels).toEqual([]); expect(plan.truncatedSeries).toHaveLength(1)
  })
  it('壊れたRRULE・夏時間選択・開始日時・重複したEXDATEを保存しない', () => {
    const mutations: ((trigger: Extract<CalendarRule['trigger'], { kind: 'rrule' }>) => void)[] = [
      trigger => { trigger.rrule = 'FREQ=DAILY;COUNT=3;UNTIL=20261231' }, trigger => { trigger.rrule = 'freq=monthly;byday=2tu' }, trigger => { trigger.rrule = 'FREQ=WEEKLY;BYDAY=1MO' }, trigger => { trigger.rrule = 'FREQ=HOURLY' },
      trigger => { trigger.dtstart = '2026-02-30T10:00' }, trigger => { trigger.dtstart = '2026-10-13' }, trigger => { trigger.exdates = ['2026-11-10T10:00', '2026-11-10T10:00'] }, trigger => { trigger.rdates = ['2026-12-01T10:00', '2026-11-01T10:00'] },
      trigger => { (trigger as { nonexistentTime: string }).nonexistentTime = 'guess' }, trigger => { (trigger as { ambiguousTime: string }).ambiguousTime = 'utc' }, trigger => { (trigger as Record<string, unknown>).approved = true },
    ]
    for (const mutate of mutations) { const value = state(rruleRule('FREQ=MONTHLY;BYDAY=2TU')); mutate(value.rules[0].trigger as Extract<CalendarRule['trigger'], { kind: 'rrule' }>); expect(() => validateCalendarRulesState(value, 'owner', 'dataset')).toThrow() }
    for (const patch of [{ afterDays: 0 }, { afterDays: 3651 }, { firstDate: '2025-12-31' }, { unfinishedPolicy: 'drop' as RecurrenceUnfinishedPolicy }]) { const value = state(chainRule()); Object.assign(value.rules[0].trigger, patch); expect(() => validateCalendarRulesState(value, 'owner', 'dataset')).toThrow() }
    const eventOnly = state(chainRule()); eventOnly.rules[0].steps = [event]; expect(() => validateCalendarRulesState(eventOnly, 'owner', 'dataset')).toThrow('タスク')
    for (const step of [{ ...task(), dueTime: '17:00' }, { ...task(), dueOffsetDays: 0, dueTime: '25:00' }, { ...event, dueTime: '17:00' }]) { const value = state(monthlyRule()); value.rules[0].steps = [step]; expect(() => validateCalendarRulesState(value, 'owner', 'dataset')).toThrow() }
  })
  it('JSONの保存・復元で同じ系列と発生回を再現する', () => {
    const rule = rruleRule('FREQ=MONTHLY;BYDAY=2TU'); if (rule.trigger.kind === 'rrule') rule.trigger.exdates = ['2026-11-10T10:00']
    const value = state(rule, chainRule('keep_latest'), monthlyRule({ id: 'deadline', steps: [{ ...task(), dueOffsetDays: 0, dueTime: '17:00' }] }))
    const restored = JSON.parse(JSON.stringify(value)); validateCalendarRulesState(restored, 'owner', 'dataset')
    expect(resolveCalendarOccurrences(restored, '2026-10-01', '2026-12-31', [], { today: '2026-10-01' })).toEqual(resolveCalendarOccurrences(value, '2026-10-01', '2026-12-31', [], { today: '2026-10-01' }))
  })
})

describe('前回の完了からN日後の系列', () => {
  const plan = (value: CalendarRulesState, current: CurrentCalendarEntity[], today = '2026-10-01') => buildCalendarChangePlan(value, current, '2026-09-17', '2026-12-31', { kind: 'all_uncompleted' }, { today })
  it('10/1完了で次は10/15、取消で次の未着手回を取消、10/3の再完了で同じ次の回を10/17へ移す', () => {
    const value = state(chainRule())
    const first = plan(value, []); expect(first.creates.map(spec => [spec.generationKey, spec.scheduledDate])).toEqual([['calendar:rule:water:chain:0:main', '2026-10-01']])
    const done = entity(first.creates[0], { completed: true, completedAt: '2026-10-01T03:00:00.000Z' })
    const next = plan(value, [done]); expect(next.creates.map(spec => [spec.generationKey, spec.scheduledDate])).toEqual([['calendar:rule:water:chain:1:main', '2026-10-15']]); expect(next.skippedCompleted).toBe(1)
    const undone = plan(value, [{ ...done, completed: false, completedAt: null }, entity(next.creates[0])])
    expect(undone.creates).toEqual([]); expect(undone.cancels.map(item => item.before.generationKey)).toEqual(['calendar:rule:water:chain:1:main']); expect(undone.cancels[0].reason).toContain('完了が取り消された')
    const recompleted = plan(value, [{ ...done, completedAt: '2026-10-03T01:00:00.000Z' }, entity(next.creates[0], { status: 'cancelled' })], '2026-10-03')
    expect(recompleted.creates).toEqual([]); expect(recompleted.updates.map(update => [update.after.generationKey, update.after.scheduledDate])).toEqual([['calendar:rule:water:chain:1:main', '2026-10-17']])
    const stillOpen = plan(value, [{ ...done, completedAt: '2026-10-03T01:00:00.000Z' }, entity(next.creates[0])], '2026-10-03')
    expect(stillOpen.creates).toEqual([]); expect(stillOpen.updates).toHaveLength(1)
  })
  it('本人が編集・着手した次の回は取消・移動せず確認に回す', () => {
    const value = state(chainRule()), first = plan(value, [])
    const done = entity(first.creates[0], { completed: true, completedAt: '2026-10-01T03:00:00.000Z' }), next = plan(value, [done]).creates[0]
    expect(plan(value, [{ ...done, completed: false, completedAt: null }, entity(next, { edited: true })])).toMatchObject({ cancels: [], conflicts: [{ key: next.generationKey }] })
    expect(plan(value, [{ ...done, completedAt: '2026-10-03T01:00:00.000Z' }, entity(next, { started: true })], '2026-10-03')).toMatchObject({ updates: [], conflicts: [{ key: next.generationKey }] })
  })
  it('未完了の扱い: keep_allは期限が来た回を作り、keep_latestは未着手の古い回を取消、完了後生成は待つ', () => {
    const today = '2026-10-20'
    const keepAll = state(chainRule('keep_all', { afterDays: 7 }))
    const all = plan(keepAll, [], today); expect(all.creates.map(spec => spec.scheduledDate)).toEqual(['2026-10-01', '2026-10-08', '2026-10-15'])
    const latest = state(chainRule('keep_latest', { afterDays: 7 })), existing = all.creates.slice(0, 2).map(spec => entity({ ...spec }))
    const trimmed = plan(latest, existing, today)
    expect(trimmed.cancels.map(item => item.before.spec.scheduledDate)).toEqual(['2026-10-01', '2026-10-08']); expect(trimmed.creates.map(spec => spec.scheduledDate)).toEqual(['2026-10-15'])
    expect(plan(latest, [entity(existing[0].spec, { started: true }), existing[1]], today).conflicts.map(item => item.key)).toEqual([existing[0].generationKey])
    expect(plan(state(chainRule('generate_after_completion', { afterDays: 7 })), [], today).creates.map(spec => spec.scheduledDate)).toEqual(['2026-10-01'])
  })
  it('長く止まっていても表示期間より前の過去回をまとめて作らない', () => {
    const value = state(chainRule('keep_all', { afterDays: 7, firstDate: '2026-06-01' }))
    const result = buildCalendarChangePlan(value, [], '2026-10-06', '2027-01-18', { kind: 'all_uncompleted' }, { today: '2026-10-20' })
    expect(result.creates.map(spec => spec.scheduledDate)).toEqual(['2026-10-12', '2026-10-19'])
  })
  it('1,000回を超えて続く系列でも、表示期間の次の回を同じ位置の識別で作る', () => {
    const long = (unfinished: RecurrenceUnfinishedPolicy) => { const value = calendarFixture(); value.activities = []; value.bindings[0].activityIds = []; value.rules = [chainRule(unfinished, { firstDate: '2024-01-01', afterDays: 1 })]; for (const row of [value.contexts[0], value.bindings[0], value.calendars[0], value.rules[0]]) row.validFrom = '2024-01-01'; validateCalendarRulesState(value, 'owner', 'dataset'); return value }
    const value = long('generate_after_completion')
    const done = Array.from({ length: 1000 }, (_, index): CurrentCalendarEntity => { const date = addDays('2024-01-01', index); return entity({ generationKey: `calendar:rule:water:chain:${index}:main`, triggerKey: `chain:${index}`, stepKey: 'main', contextId: 'company', bindingId: 'self', activityId: null, ruleId: 'water', kind: 'task', title: '資料確認', scheduledDate: date, dueDate: null, score: task().score, startAt: null, endAt: null, eventKind: null, timezone: 'Asia/Tokyo', sourceRefs: [], originBasis: 'user_instruction' }, { completed: true, completedAt: `${date}T03:00:00.000Z` }) })
    expect(done.at(-1)!.spec.scheduledDate).toBe('2026-09-26')
    const next = plan(value, done)
    expect(next.creates.map(spec => [spec.generationKey, spec.scheduledDate])).toEqual([['calendar:rule:water:chain:1000:main', '2026-09-27']])
    expect(next.truncatedSeries).toEqual([]); expect(next.skippedCompleted).toBe(10); expect(next.cancels).toEqual([])
    // Rollovers since 2024 also pass 1,000 items; the window still gets its own items.
    const rollover = plan(long('keep_all'), [])
    expect(rollover.creates.map(spec => spec.scheduledDate).sort()).toEqual(Array.from({ length: 15 }, (_, index) => addDays('2026-09-17', index)))
    expect(rollover.creates.find(spec => spec.scheduledDate === '2026-10-01')!.generationKey).toBe('calendar:rule:water:chain:1004:main'); expect(rollover.truncatedSeries).toEqual([])
  })
  it('以後の変更は、前の回の完了が変更日より前でも、変更日以後に予定された次の回へ及ぶ', () => {
    const value = state(chainRule()), zero = plan(value, []).creates[0], doneZero = entity(zero, { completed: true, completedAt: '2026-10-01T03:00:00.000Z' })
    const one = entity(plan(value, [doneZero]).creates[0]); expect(one.spec.scheduledDate).toBe('2026-10-15')
    const edit = (fromDate: string) => { const rule = value.rules[0]; rule.revision = 2; rule.editions = [{ id: 'future', revision: 2, scope: { kind: 'this_and_future', fromDate }, definition: { title: rule.title, enabled: true, trigger: rule.trigger, steps: [task(20)] } }]; validateCalendarRulesState(value, 'owner', 'dataset') }
    const future = (fromDate: string) => buildCalendarChangePlan(value, [doneZero, one], '2026-09-17', '2026-12-31', { kind: 'this_and_future', fromDate }, { today: '2026-10-11' })
    edit('2026-10-10')
    const applied = future('2026-10-10')
    expect(applied.updates.map(update => [update.after.generationKey, update.after.score?.manualPoints])).toEqual([['calendar:rule:water:chain:1:main', 20]]); expect(applied.skippedCompleted).toBe(0); expect(applied.creates).toEqual([])
    const all = buildCalendarChangePlan(value, [doneZero, one], '2026-09-17', '2026-12-31', { kind: 'all_uncompleted' }, { today: '2026-10-11' })
    expect(all.skippedCompleted).toBe(1); expect(all.updates.some(update => update.before.completed)).toBe(false); expect(all.cancels).toEqual([])
    edit('2026-10-16')
    expect(future('2026-10-16')).toMatchObject({ updates: [], creates: [], cancels: [] })
    expect(resolveCalendarOccurrences(value, '2026-10-15', '2026-10-15', [], { progress: { [doneZero.generationKey]: { completedDate: '2026-10-01', scheduledDate: '2026-10-01' } }, today: '2026-10-11' }).occurrences[0].score?.manualPoints).toBe(10)
  })
  it('前の回を取消しても完了済みの後の回はその位置のまま残す', () => {
    const value = state(chainRule()), zero = plan(value, []).creates[0], doneZero = entity(zero, { completed: true, completedAt: '2026-10-01T03:00:00.000Z' })
    const one = plan(value, [doneZero]).creates[0], doneOne = entity(one, { completed: true, completedAt: '2026-10-15T03:00:00.000Z' })
    const two = plan(value, [doneZero, doneOne], '2026-10-15').creates[0]; expect(two.scheduledDate).toBe('2026-10-29')
    const reopened = plan(value, [{ ...doneZero, completed: false, completedAt: null }, doneOne, entity(two)], '2026-10-16')
    expect(reopened).toMatchObject({ creates: [], updates: [], cancels: [], skippedCompleted: 1, unchanged: 2 })
  })
})

describe('時刻付き締め切りの定型ステップ', () => {
  it('会社の最終営業日に17時締め切りのdueAtを作り、締め切り日は現地日付のまま', () => {
    const value = state(monthlyRule({ trigger: { kind: 'monthly_business', ordinal: 1, from: 'end', time: '09:00' }, steps: [{ ...task(), dueOffsetDays: 0, dueTime: '17:00' }] }))
    expect(resolved(value, '2026-10-01', '2026-10-31').occurrences.map(spec => [spec.scheduledDate, spec.dueDate, spec.dueAt])).toEqual([['2026-10-30', '2026-10-30', '2026-10-30T08:00:00.000Z']])
    const dateOnly = state(monthlyRule()); expect(resolved(dateOnly, '2026-10-01', '2026-10-31').occurrences[0]).not.toHaveProperty('dueAt')
  })
  it('夏時間で存在しない締め切り時刻は推測せず確認に回す', () => {
    const value = state(monthlyRule({ trigger: { kind: 'weekly', weekdays: [0], time: '09:00' }, steps: [{ ...task(), dueOffsetDays: 0, dueTime: '02:30' }] })); value.contexts[0].timezone = 'America/New_York'
    const result = resolved(value, '2026-03-08', '2026-03-08')
    expect(result.occurrences).toEqual([]); expect(result.conflicts[0].reason).toContain('締め切り時刻')
  })
})
