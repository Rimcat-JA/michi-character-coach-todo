import { describe, expect, it } from 'vitest'
import { emptyScore } from './domain'
import { calendarDateAt, prepareCalendarChangePlan, resolveCalendarOccurrences, resolveLocalCalendarTime, type CalendarRulesState, type CurrentCalendarEntity, type ScheduleFact } from './calendar-resolver'
import { mergeScheduleImport, prepareScheduleImport, validateCalendarRulesState } from './calendar-rules-validation'
import { calendarFixture, monthlyRule } from './calendar-test-fixtures'
type FactPayload = { [K in ScheduleFact['kind']]: Omit<Extract<ScheduleFact, { kind: K }>, 'id' | 'sourceId' | 'contextId' | 'revision' | 'validity' | 'supersedes'> }[ScheduleFact['kind']]
function fact(payload: FactPayload & { id?: string; sourceId?: string; supersedes?: string[] }): ScheduleFact {
  return { id: payload.id ?? 'exception', sourceId: payload.sourceId ?? (payload.kind === 'roster_assignment' ? 'roster' : payload.kind === 'cancel' || payload.kind === 'reschedule' ? 'activity' : 'calendar'), contextId: 'company', revision: 1, validity: 'active', supersedes: [], ...payload } as ScheduleFact
}
function current(state: CalendarRulesState, from = '2026-10-01', to = '2026-10-31'): CurrentCalendarEntity[] {
  return resolveCalendarOccurrences(state, from, to).occurrences.map((spec, index) => ({ generationKey: spec.generationKey, entityId: `entity-${index}`, revision: 1, status: 'active', completed: false, edited: false, started: false, spec }))
}

describe('共通本人カレンダー resolver', () => {
  it('活動は占有予定だけで、頻度から準備タスクを創作しない。明示周期だけがタスクを作る', () => {
    const state = calendarFixture()
    expect(resolveCalendarOccurrences(state, '2026-10-01', '2026-10-31').occurrences.filter(item => item.kind === 'task')).toHaveLength(0)
    state.rules = [monthlyRule({ trigger: { kind: 'weekly', weekdays: [1], time: '09:00' } })]
    const tasks = resolveCalendarOccurrences(state, '2026-10-01', '2026-10-31').occurrences.filter(item => item.kind === 'task')
    expect(tasks.map(item => item.scheduledDate)).toEqual(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'])
    expect(tasks.every(item => item.score?.manualPoints === 10)).toBe(true)
  })
  it('毎月第2営業日を本人選択の会社暦で計算し、会社の土曜営業を祝日で消さない', () => {
    const state = calendarFixture(); state.rules = [monthlyRule()]
    state.facts = [fact({ kind: 'closed', calendarId: 'business', date: '2026-10-02' }), fact({ id: 'saturday', kind: 'open', calendarId: 'business', date: '2026-10-03' })]
    const tasks = resolveCalendarOccurrences(state, '2026-10-01', '2026-10-31').occurrences.filter(item => item.kind === 'task')
    expect(tasks).toHaveLength(1); expect(tasks[0]).toMatchObject({ scheduledDate: '2026-10-03', dueDate: '2026-10-03', generationKey: 'calendar:rule:payroll:month:2026-10:submit' })
  })
  it('木曜を月曜パターンへ置換しても、月曜に本人が参加する活動だけを作る', () => {
    const state = calendarFixture(); state.activities[0].weekdays = [1]; state.bindings[0].weekdays = [1]
    state.facts = [fact({ kind: 'substitute_pattern', calendarId: 'business', date: '2026-10-08', patternWeekday: 1, mode: 'replace' })]
    expect(resolveCalendarOccurrences(state, '2026-10-08', '2026-10-08').occurrences.map(item => [item.title, item.triggerKey])).toEqual([['出勤', 'substitute:exception']])
    state.bindings[0].activityIds = []
    expect(resolveCalendarOccurrences(state, '2026-10-08', '2026-10-08').occurrences).toHaveLength(0)
  })
  it('本人の公開シフトだけを読み、金曜22時から土曜6時を1回と扱う', () => {
    const state = calendarFixture(); state.activities[0].weekdays = []
    state.facts = [fact({ kind: 'roster_assignment', activityId: 'work', externalId: 'shift-001', personRef: 'staff-001', published: true, status: 'scheduled', startAt: '2026-10-02T13:00:00.000Z', endAt: '2026-10-02T21:00:00.000Z' })]
    const resolved = resolveCalendarOccurrences(state, '2026-10-02', '2026-10-03')
    expect(resolved.occurrences).toHaveLength(1); expect(calendarDateAt(resolved.occurrences[0].endAt!, 'Asia/Tokyo')).toBe('2026-10-03')
    const roster = state.facts[0] as Extract<ScheduleFact, { kind: 'roster_assignment' }>
    roster.published = false; expect(resolveCalendarOccurrences(state, '2026-10-02', '2026-10-03').occurrences).toHaveLength(0)
    roster.published = true; roster.personRef = 'staff-002'; expect(resolveCalendarOccurrences(state, '2026-10-02', '2026-10-03').occurrences).toHaveLength(0)
  })
  it('公開土曜勤務は標準平日パターンを上書きするが、明示休業との矛盾は候補確認へ', () => {
    const state = calendarFixture(); state.activities[0].weekdays = []
    state.facts = [fact({ kind: 'roster_assignment', activityId: 'work', externalId: 'shift-002', personRef: 'staff-001', published: true, status: 'scheduled', startAt: '2026-10-03T00:00:00.000Z', endAt: '2026-10-03T08:00:00.000Z' })]
    expect(resolveCalendarOccurrences(state, '2026-10-03', '2026-10-03').occurrences).toHaveLength(1)
    state.facts.push(fact({ id: 'closed', kind: 'closed', calendarId: 'business', date: '2026-10-03' }))
    expect(resolveCalendarOccurrences(state, '2026-10-03', '2026-10-03')).toMatchObject({ occurrences: [], blockedSeries: ['activity:work'] })
    state.facts[0].supersedes = ['closed']; expect(resolveCalendarOccurrences(state, '2026-10-03', '2026-10-03').occurrences).toHaveLength(1)
  })
  it('新しい資料だからと矛盾を上書きしない。明示supersedesだけを使う', () => {
    const state = calendarFixture(); state.facts = [fact({ id: 'closed', kind: 'closed', calendarId: 'business', date: '2026-10-05' }), fact({ id: 'open', kind: 'open', calendarId: 'business', date: '2026-10-05' })]
    expect(resolveCalendarOccurrences(state, '2026-10-05', '2026-10-05').conflicts).not.toHaveLength(0)
    state.facts[1].supersedes = ['closed']; expect(resolveCalendarOccurrences(state, '2026-10-05', '2026-10-05').occurrences).toHaveLength(1)
  })
  it('同一シフトの取消/勤務矛盾と複数の振替IDは確認に回し、二重勤務を作らない', () => {
    const state = calendarFixture(); state.activities[0].weekdays = []
    const shift = { kind: 'roster_assignment' as const, activityId: 'work', externalId: 'shift-001', personRef: 'staff-001', published: true, status: 'scheduled' as const, startAt: '2026-10-03T00:00:00.000Z', endAt: '2026-10-03T08:00:00.000Z' }
    state.facts = [fact({ id: 'planned', ...shift }), fact({ id: 'cancelled', ...shift, status: 'cancelled' })]
    expect(resolveCalendarOccurrences(state, '2026-10-03', '2026-10-03')).toMatchObject({ occurrences: [], blockedSeries: ['activity:work'] })
    state.facts[1].supersedes = ['planned']; const cancelled = resolveCalendarOccurrences(state, '2026-10-03', '2026-10-03'); expect(cancelled.conflicts).toHaveLength(0); expect(cancelled.cancellations).toHaveLength(1)
    state.activities[0].weekdays = [1]
    state.facts = [fact({ id: 'sub-a', kind: 'substitute_pattern', calendarId: 'business', date: '2026-10-08', patternWeekday: 1, mode: 'replace' }), fact({ id: 'sub-b', kind: 'substitute_pattern', calendarId: 'business', date: '2026-10-08', patternWeekday: 1, mode: 'replace' })]
    expect(resolveCalendarOccurrences(state, '2026-10-08', '2026-10-08').occurrences).toHaveLength(0)
    state.facts[1].supersedes = ['sub-a']; expect(resolveCalendarOccurrences(state, '2026-10-08', '2026-10-08').occurrences).toHaveLength(1)
  })
  it('予定移動もルール版変更も発生キーを変えず、未完了だけを移動する', async () => {
    const state = calendarFixture(), entities = current(state, '2026-10-05', '2026-10-05'); state.facts = [fact({ kind: 'reschedule', activityId: 'work', originalDate: '2026-10-05', newDate: '2026-10-24' })]
    const plan = await prepareCalendarChangePlan(state, entities, '2026-10-05', '2026-10-05')
    expect(plan.creates).toHaveLength(0); expect(plan.cancels).toHaveLength(0); expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0].after.generationKey).toBe(entities[0].generationKey)
    expect(calendarDateAt(plan.updates[0].after.startAt!, 'Asia/Tokyo')).toBe('2026-10-24')
    entities[0].completed = true; expect(await prepareCalendarChangePlan(state, entities, '2026-10-05', '2026-10-05')).toMatchObject({ creates: [], updates: [], cancels: [], skippedCompleted: 1 })
  })
  it('今回だけ・以後・未完了全部の変更scopeを保ち、本人編集/着手済みを確認へ回す', async () => {
    const state = calendarFixture(); state.activities = []; state.bindings[0].activityIds = []; state.rules = [monthlyRule({ trigger: { kind: 'weekly', weekdays: [1], time: '09:00' } })]
    const entities = current(state); entities[0].completed = true; state.rules[0].steps[0].title = '変更された提出'; state.rules[0].revision++
    expect((await prepareCalendarChangePlan(state, entities, '2026-10-01', '2026-10-31', { kind: 'this_instance', generationKey: entities[2].generationKey })).updates).toHaveLength(1)
    expect((await prepareCalendarChangePlan(state, entities, '2026-10-01', '2026-10-31', { kind: 'this_and_future', fromDate: '2026-10-19' })).updates).toHaveLength(2)
    expect((await prepareCalendarChangePlan(state, entities, '2026-10-01', '2026-10-31')).updates).toHaveLength(3)
    entities[1].edited = true; entities[2].started = true
    expect((await prepareCalendarChangePlan(state, entities, '2026-10-01', '2026-10-31')).conflicts).toHaveLength(2)
    state.rules[0].enabled = false
    const cancelled = await prepareCalendarChangePlan(state, entities, '2026-10-01', '2026-10-31'); expect(cancelled.cancels).toHaveLength(1); expect(cancelled.conflicts).toHaveLength(2)
  })
  it('取消後の復活は同じ発生回を更新し、再生成を増やさない。取得失敗は取消にしない', async () => {
    const state = calendarFixture(), entities = current(state, '2026-10-05', '2026-10-05'); entities[0].status = 'cancelled'
    expect((await prepareCalendarChangePlan(state, entities, '2026-10-05', '2026-10-05')).updates).toHaveLength(1)
    state.sources[0].status = 'stale'; entities[0].status = 'active'
    expect(await prepareCalendarChangePlan(state, entities, '2026-10-05', '2026-10-05')).toMatchObject({ creates: [], updates: [], cancels: [] })
  })
  it('今回だけ/以後のルール変更を版として保存し、次の再展開でも別の回へ広げない', async () => {
    const state = calendarFixture(); state.activities = []; state.bindings[0].activityIds = []; state.rules = [monthlyRule({ trigger: { kind: 'weekly', weekdays: [1], time: '09:00' } })]
    const rule = state.rules[0], entities = current(state)
    rule.revision = 3; rule.editions = [
      { id: 'one', revision: 2, scope: { kind: 'this_instance', generationKey: entities[1].generationKey }, definition: { title: rule.title, enabled: true, trigger: rule.trigger, steps: [{ ...rule.steps[0], title: '今回だけ20pt', score: { ...emptyScore(), mode: 'manual', manualPoints: 20 } }] } },
      { id: 'future', revision: 3, scope: { kind: 'this_and_future', fromDate: '2026-10-19' }, definition: { title: rule.title, enabled: true, trigger: rule.trigger, steps: [{ ...rule.steps[0], title: '以後30pt', score: { ...emptyScore(), mode: 'manual', manualPoints: 30 } }] } },
    ]
    validateCalendarRulesState(state)
    const expected = [10, 20, 30, 30]
    expect(resolveCalendarOccurrences(state, '2026-10-01', '2026-10-31').occurrences.map(item => item.score?.manualPoints)).toEqual(expected)
    const applied = await prepareCalendarChangePlan(state, entities, '2026-10-01', '2026-10-31'); expect(applied.updates).toHaveLength(3)
    for (const update of applied.updates) entities.find(row => row.generationKey === update.after.generationKey)!.spec = update.after
    expect((await prepareCalendarChangePlan(state, entities, '2026-10-01', '2026-10-31')).updates).toHaveLength(0)
    expect(resolveCalendarOccurrences(structuredClone(state), '2026-10-01', '2026-10-31').occurrences.map(item => item.score?.manualPoints)).toEqual(expected)
  })
  it('イベント相対の期間外アンカーからも展開し、日単位offsetは夏時間を跨いでも現地時刻を保つ', () => {
    const state = calendarFixture(); state.contexts[0].timezone = 'America/New_York'; state.activities[0].weekdays = [1]; state.bindings[0].weekdays = [1]
    state.rules = [monthlyRule({ trigger: { kind: 'activity_relative', activityId: 'work', edge: 'start', offsetDays: -1, offsetMinutes: 0 }, steps: [{ key: 'prep', title: '明示準備', kind: 'event', scheduledOffsetDays: -1, dueOffsetDays: null, score: null, durationMinutes: 30 }] })]
    const resolved = resolveCalendarOccurrences(state, '2026-03-07', '2026-03-07')
    expect(resolved.occurrences).toHaveLength(1); expect(resolved.occurrences[0].startAt).toBe('2026-03-07T14:00:00.000Z')
    expect(resolveLocalCalendarTime('2026-03-08', '02:30', 'America/New_York').at).toBeNull()
    expect(resolveLocalCalendarTime('2026-11-01', '01:30', 'America/New_York').at).toBeNull()
  })
})

describe('本人選択の公式資料JSON取込', () => {
  function input(revision = 1) { return { format: 'coach-schedule-facts', version: 1, source: { id: 'official-calendar', title: '会社の正式暦', authorityScope: 'calendar', coverageFrom: '2026-01-01', coverageTo: '2026-12-31', revision }, facts: [{ id: 'holiday', revision, validity: 'active', supersedes: [], kind: 'closed', calendarId: 'business', date: '2026-10-05' }] } }
  it('版・適用範囲・取消を確認し、同じ版は冪等、資料から消えた事実は勝手に取消さない', async () => {
    const state = calendarFixture(), preview = await prepareScheduleImport(state, 'company', input()), merged = mergeScheduleImport(state, preview)
    expect(merged.facts).toHaveLength(1); expect(merged.revision).toBe(2)
    const again = await prepareScheduleImport(merged, 'company', input()); expect(again.noOp).toBe(true); expect(mergeScheduleImport(merged, again)).toEqual(merged)
    const next = input(2); next.facts = []
    expect(mergeScheduleImport(merged, await prepareScheduleImport(merged, 'company', next)).facts).toHaveLength(1)
    const changedSameVersion = input(); changedSameVersion.facts[0].date = '2026-10-06'; await expect(prepareScheduleImport(merged, 'company', changedSameVersion)).rejects.toThrow('版')
    const withdrawn = input(2); withdrawn.facts[0].validity = 'withdrawn'; expect(mergeScheduleImport(merged, await prepareScheduleImport(merged, 'company', withdrawn)).facts[0].validity).toBe('withdrawn')
  })
  it('資料に本人承認・ルール・命令を紛れ込ませても受け付けず、他対象と取得範囲外は拒否', async () => {
    const state = calendarFixture(); validateCalendarRulesState(state, 'owner', 'dataset')
    await expect(prepareScheduleImport(state, 'company', { ...input(), confirmed: true })).rejects.toThrow('項目')
    await expect(prepareScheduleImport(state, 'company', { ...input(), rules: [monthlyRule()] })).rejects.toThrow('項目')
    const outside = input(); outside.source.coverageTo = '2026-10-01'; await expect(prepareScheduleImport(state, 'company', outside)).rejects.toThrow('期間')
    const altered = structuredClone(state); altered.bindings[0].contextId = 'foreign'; expect(() => validateCalendarRulesState(altered)).toThrow('コンテキスト')
    expect(() => validateCalendarRulesState(state, 'someone-else')).toThrow('本人')
  })
})
