import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { groundedRoutinePattern, parseRoutineAssistAnswer, routineAssistStartNote, validateOwnerRoutineAssistCandidate, type RoutineAssistInput, type RoutineAssistSelection } from './routine-assist'
import { calendarFixture, monthlyRule } from './calendar-test-fixtures'
import { emptyScore } from './domain'
import { expandRRule } from './rrule'
import type { CalendarRule, CalendarRulesState } from './calendar-resolver'
import { confirmRoutineInstructionFromUI } from './routine-instruction'
import { applyRoutineAssistConfigurationFromUI, clearRoutineAssistanceAuthority, prepareRoutineAssistConfiguration } from './routine-assist-save'
import { applyCalendarProposalFromUI, clearCalendarRulesAuthority, prepareCalendarGeneration } from './calendar-rules-save'
import { completeTask } from './commands'

function input(message: string, selection: Partial<RoutineAssistSelection> = {}): RoutineAssistInput {
  return { message, referenceDate: '2026-10-01', targetRuleId: null, expectedRuleRevision: null, selection: { contextId: 'company', bindingId: 'self', calendarId: 'business', activityId: null, timezone: 'Asia/Tokyo', validFrom: '2026-10-01', validTo: '2026-12-31', time: '09:00', stepKind: 'task', durationMinutes: null, scheduledOffsetDays: 0, dueOffsetDays: null, ...selection }, scope: { kind: 'all_uncompleted' } }
}
const answer = (title: string, recurrence: string, trigger: Record<string, unknown>, points: number | null = null) => JSON.stringify({ title_quote: title, recurrence_quote: recurrence, trigger, manual_points: points, reason: '本人の原文どおり' })

describe('周期補助のRRULE・完了起点・締め切り時刻の照合', () => {
  it('「前回完了から14日後に植物の水やり、10pt」は14日後・本人指定10ptだけを候補にする', () => {
    const selected = input('前回完了から14日後に植物の水やり、10pt'), state = calendarFixture()
    const candidate = parseRoutineAssistAnswer(answer('植物の水やり', '前回完了から14日後', { kind: 'completion_relative', afterDays: 14 }, 10), selected, state)
    expect(candidate.definition.trigger).toEqual({ kind: 'completion_relative', firstDate: '2026-10-01', time: '09:00', afterDays: 14, unfinishedPolicy: 'keep_all' })
    expect(candidate.definition.steps[0].score).toMatchObject({ mode: 'manual', manualPoints: 10 })
    expect(() => validateOwnerRoutineAssistCandidate(candidate, state)).not.toThrow()
    expect(() => parseRoutineAssistAnswer(answer('植物の水やり', '前回完了から14日後', { kind: 'completion_relative', afterDays: 15 }, 10), selected, state)).toThrow('一致しません')
    expect(() => parseRoutineAssistAnswer(answer('植物の水やり', '前回完了から14日後', { kind: 'rrule', rrule: 'FREQ=DAILY;INTERVAL=14' }, 10), selected, state)).toThrow('種類')
    const latest = input('前回完了から14日後に植物の水やり、10pt', { unfinishedPolicy: 'keep_latest' })
    expect(parseRoutineAssistAnswer(answer('植物の水やり', '前回完了から14日後', { kind: 'completion_relative', afterDays: 14 }, 10), latest, state).definition.trigger).toMatchObject({ unfinishedPolicy: 'keep_latest' })
  })
  it.each(['2週間くらいおきに植物の水やり', '前回完了から2週間くらい後に植物の水やり', 'たまに植物の水やり', '2週間おきに植物の水やり'])('おおよそ・数え方が曖昧な「%s」を確定しない', message => {
    expect(() => parseRoutineAssistAnswer(answer('植物の水やり', message.slice(0, message.indexOf('に')), { kind: 'completion_relative', afterDays: 14 }), input(message), calendarFixture())).toThrow()
  })
  it('「会社の最終営業日に勤怠提出、締め切りは17時、10pt」は最終営業日・締め切り17:00・10ptになる', () => {
    const message = '会社の最終営業日に勤怠提出、締め切りは17時、10pt', state = calendarFixture()
    const trigger = { kind: 'monthly_business', ordinal: 1, from: 'end', time: '09:00' }
    expect(() => parseRoutineAssistAnswer(answer('勤怠提出', '最終営業日', trigger, 10), input(message, { dueOffsetDays: 0 }), state)).toThrow('締め切り')
    expect(() => parseRoutineAssistAnswer(answer('勤怠提出', '最終営業日', trigger, 10), input(message, { dueOffsetDays: 0, dueTime: '18:00' }), state)).toThrow('締め切り')
    const candidate = parseRoutineAssistAnswer(answer('勤怠提出', '最終営業日', trigger, 10), input(message, { dueOffsetDays: 0, dueTime: '17:00' }), state)
    expect(candidate.definition.trigger).toEqual(trigger)
    expect(candidate.definition.steps[0]).toMatchObject({ dueOffsetDays: 0, dueTime: '17:00', score: { mode: 'manual', manualPoints: 10 } })
    expect(() => validateOwnerRoutineAssistCandidate(candidate, state)).not.toThrow()
    const tampered = structuredClone(candidate); tampered.definition.steps[0].dueTime = '18:00'
    expect(() => validateOwnerRoutineAssistCandidate(tampered, state)).toThrow()
    // A clock the owner picked in the form is an owner selection, like the deadline day offset.
    expect(parseRoutineAssistAnswer(answer('勤怠提出', '最終営業日', trigger, 10), input('会社の最終営業日に勤怠提出、10pt', { dueOffsetDays: 0, dueTime: '17:00' }), state).definition.steps[0].dueTime).toBe('17:00')
  })
  it('「毎月第3水曜 19:00に町内会の資料確認」を第3水曜のRRULEとして本人の時刻・開始日で作る', () => {
    const selected = input('毎月第3水曜 19:00に町内会の資料確認', { time: '19:00' }), state = calendarFixture()
    const candidate = parseRoutineAssistAnswer(answer('町内会の資料確認', '毎月第3水曜', { kind: 'rrule', rrule: 'FREQ=MONTHLY;BYDAY=3WE' }), selected, state)
    expect(candidate.definition.trigger).toEqual({ kind: 'rrule', dtstart: '2026-10-01T19:00', rrule: 'FREQ=MONTHLY;BYDAY=3WE', rdates: [], exdates: [], nonexistentTime: 'skip', ambiguousTime: 'earlier' })
    expect(() => validateOwnerRoutineAssistCandidate(candidate, state)).not.toThrow()
    expect(() => parseRoutineAssistAnswer(answer('町内会の資料確認', '毎月第3水曜', { kind: 'rrule', rrule: 'FREQ=MONTHLY;BYDAY=3WE' }), input('毎月第3水曜 19:00に町内会の資料確認'), state)).toThrow('時刻')
  })
  it.each([
    ['毎月第3水曜に回覧', '毎月第3水曜', 'FREQ=MONTHLY;BYDAY=2WE'], ['隔週月曜に定例資料', '隔週月曜', 'FREQ=WEEKLY;BYDAY=MO'], ['毎月末に請求書確認', '毎月末', 'FREQ=MONTHLY;BYMONTHDAY=31'],
    ['毎月31日にバックアップ', '毎月31日', 'FREQ=MONTHLY;BYMONTHDAY=-1'], ['毎年4月1日に保険の更新', '毎年4月1日', 'FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=2'], ['毎日植物に水をやる', '毎日', 'FREQ=DAILY;COUNT=10'],
    ['3日ごとにフィルター確認', '3日ごと', 'FREQ=DAILY;INTERVAL=2'], ['最終金曜に週次まとめ', '最終金曜', 'FREQ=MONTHLY;BYDAY=4FR'], ['毎月15日に経費精算', '毎月15日', 'FREQ=MONTHLY;BYMONTHDAY=15;BYMONTH=1'],
  ])('モデルのRRULEが原文の文法と違えば拒否: %s', (message, recurrence, rrule) => {
    expect(() => parseRoutineAssistAnswer(answer(message.slice(message.indexOf('に') + 1), recurrence, { kind: 'rrule', rrule }), input(message), calendarFixture())).toThrow()
  })
  it.each([['毎日植物に水をやる', 'FREQ=DAILY'], ['隔週月曜に定例資料', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'], ['毎月末に請求書確認', 'FREQ=MONTHLY;BYMONTHDAY=-1'], ['毎年4月1日に保険の更新', 'FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=1'], ['最終金曜に週次まとめ', 'FREQ=MONTHLY;BYDAY=-1FR'], ['毎月15日に経費精算', 'FREQ=MONTHLY;BYMONTHDAY=15']])('原文と一致するRRULE候補は受け付ける: %s', (message, rrule) => {
    const recurrence = message.slice(0, message.indexOf('に'))
    expect(parseRoutineAssistAnswer(answer(message.slice(message.indexOf('に') + 1), recurrence, { kind: 'rrule', rrule }), input(message), calendarFixture()).definition.trigger).toMatchObject({ kind: 'rrule', rrule })
  })
  it.each(['毎週月曜か水曜に提出', '毎月15日以外に精算', '毎日と毎週金曜に確認', '月に1回くらい点検'])('曖昧・除外・複数周期の原文は手動設定へ: %s', message => {
    expect(() => groundedRoutinePattern(message)).toThrow()
  })
  it('モデルがRRULEに開始・回数・夏時間を入れても採用せず、本人選択から作る', () => {
    const selected = input('毎日植物に水をやる')
    expect(() => parseRoutineAssistAnswer(answer('植物に水をやる', '毎日', { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2020-01-01T00:00' }), selected, calendarFixture())).toThrow('項目')
    expect(() => parseRoutineAssistAnswer(answer('植物に水をやる', '毎日', { kind: 'rrule', rrule: 'FREQ=DAILY;UNTIL=20261231' }), selected, calendarFixture())).toThrow()
  })
})

describe('完了起点の周期補助は設定と生成を別に承認する', () => {
  const click = () => { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
  beforeEach(async () => { clearRoutineAssistanceAuthority(); clearCalendarRulesAuthority(); await db.delete(); await db.open(); await ensureSettings(); const settings = (await db.settings.get('main'))!; await db.settings.put({ ...settings, aiEnabled: true, aiModel: 'synthetic/model' }); const state = calendarFixture(); state.ownerId = settings.profileId; state.datasetId = settings.datasetId; state.bindings[0].personId = settings.profileId; state.activities = []; state.bindings[0].activityIds = []; await db.calendarRules.put(state); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z')) })
  afterEach(() => { clearRoutineAssistanceAuthority(); clearCalendarRulesAuthority(); vi.useRealTimers() })
  it('本人確認→設定保存でタスク0、別の生成承認で最初の回、完了後の生成で次の回を一つだけ作る', async () => {
    const selected = input('前回完了から14日後に植物の水やり、10pt'), state = (await db.calendarRules.get('main'))!
    const candidate = parseRoutineAssistAnswer(answer('植物の水やり', '前回完了から14日後', { kind: 'completion_relative', afterDays: 14 }, 10), selected, state)
    await expect(confirmRoutineInstructionFromUI(selected, candidate, 'synthetic/model', new Event('click'))).rejects.toThrow()
    const prepared = await prepareRoutineAssistConfiguration(await confirmRoutineInstructionFromUI(selected, candidate, 'synthetic/model', click()))
    expect(prepared.configuration.preview.map(spec => spec.scheduledDate)).toEqual(['2026-10-01'])
    await applyRoutineAssistConfigurationFromUI(prepared, prepared.digest, click()); expect(await db.tasks.count()).toBe(0)
    const first = await prepareCalendarGeneration('2026-09-17', '2026-12-31'); await applyCalendarProposalFromUI(first, click())
    const task = (await db.tasks.toArray())[0]; expect(task).toMatchObject({ title: '植物の水やり', scheduledDate: '2026-10-01', effectivePoints: 10 })
    await completeTask(task.id, task.revision)
    const next = await prepareCalendarGeneration('2026-09-17', '2026-12-31'); expect(next.plan.creates.map(spec => spec.scheduledDate)).toEqual(['2026-10-15'])
    await applyCalendarProposalFromUI(next, click())
    expect((await prepareCalendarGeneration('2026-09-17', '2026-12-31')).plan.creates).toEqual([])
    expect((await db.tasks.toArray()).filter(row => row.status === 'open')).toHaveLength(1); expect((await db.ledger.toArray()).reduce((sum, row) => sum + row.delta, 0)).toBe(10)
  })
})

describe('既存ルールの周期補助は文法で言えない項目を保持する', () => {
  const step = { key: 'main', title: '町内会の資料確認', kind: 'task' as const, scheduledOffsetDays: 0, dueOffsetDays: null, score: { ...emptyScore(), mode: 'manual' as const, manualPoints: 10 }, durationMinutes: null }
  const rruleTrigger: CalendarRule['trigger'] = { kind: 'rrule', dtstart: '2026-10-13T10:00', rrule: 'FREQ=MONTHLY;COUNT=5;BYDAY=2TU', rdates: ['2026-11-12T15:00'], exdates: ['2026-12-08T10:00'], nonexistentTime: 'next_valid', ambiguousTime: 'later' }
  const chainTrigger: CalendarRule['trigger'] = { kind: 'completion_relative', firstDate: '2026-10-05', time: '10:00', afterDays: 14, unfinishedPolicy: 'keep_latest' }
  function withRule(trigger: CalendarRule['trigger']): CalendarRulesState { const state = calendarFixture(); state.activities = []; state.bindings[0].activityIds = []; state.rules = [monthlyRule({ id: 'rr', title: '町内会の資料確認', trigger, steps: [step] })]; return state }
  const edit = (message: string, scope: RoutineAssistInput['scope'] = { kind: 'all_uncompleted' }): RoutineAssistInput => ({ ...input(message, { validFrom: '2026-01-01', validTo: '2026-12-31', time: '10:00' }), targetRuleId: 'rr', expectedRuleRevision: 1, scope })
  it('点数だけの指示では開始・追加・除外の回・回数・夏時間の扱いを一字も変えない', () => {
    const state = withRule(rruleTrigger), selected = edit('毎月第2火曜の資料確認を20ptにして')
    const candidate = parseRoutineAssistAnswer(JSON.stringify({ title_quote: null, recurrence_quote: '毎月第2火曜', trigger: { kind: 'rrule', rrule: 'FREQ=MONTHLY;BYDAY=2TU' }, manual_points: 20, reason: '点数だけ' }), selected, state)
    expect(JSON.stringify(candidate.definition.trigger)).toBe(JSON.stringify(rruleTrigger))
    expect(candidate.definition.steps[0].score).toMatchObject({ mode: 'manual', manualPoints: 20 })
    expect(() => validateOwnerRoutineAssistCandidate(candidate, state)).not.toThrow()
    for (const tamper of [{ exdates: [] }, { rdates: [] }, { dtstart: '2026-01-01T10:00' }, { rrule: 'FREQ=MONTHLY;BYDAY=2TU' }, { nonexistentTime: 'skip' }]) {
      const tampered = structuredClone(candidate); Object.assign(tampered.definition.trigger, tamper)
      expect(() => validateOwnerRoutineAssistCandidate(tampered, state)).toThrow()
    }
  })
  it('完了起点の最初の回と未完了の扱いを保持する', () => {
    const state = withRule(chainTrigger), selected = edit('前回完了から14日後の資料確認を20ptにして')
    const candidate = parseRoutineAssistAnswer(JSON.stringify({ title_quote: null, recurrence_quote: '前回完了から14日後', trigger: { kind: 'completion_relative', afterDays: 14 }, manual_points: 20, reason: '点数だけ' }), selected, state)
    expect(JSON.stringify(candidate.definition.trigger)).toBe(JSON.stringify(chainTrigger))
    expect(() => validateOwnerRoutineAssistCandidate(candidate, state)).not.toThrow()
    const moved = structuredClone(candidate); Object.assign(moved.definition.trigger, { firstDate: '2026-01-01' })
    expect(() => validateOwnerRoutineAssistCandidate(moved, state)).toThrow()
    const policy = structuredClone(candidate); Object.assign(policy.definition.trigger, { unfinishedPolicy: 'keep_all' })
    expect(() => validateOwnerRoutineAssistCandidate(policy, state)).toThrow()
  })
  it('以後だけ周期を変えるときは変更日より前の回を引いた残りの回数を引き継ぐ', () => {
    const state = withRule(rruleTrigger), selected = edit('毎日資料確認をする', { kind: 'this_and_future', fromDate: '2026-11-01' })
    const candidate = parseRoutineAssistAnswer(JSON.stringify({ title_quote: null, recurrence_quote: '毎日', trigger: { kind: 'rrule', rrule: 'FREQ=DAILY' }, manual_points: null, reason: '周期だけ' }), selected, state)
    // 10/13 is the only earlier occurrence, so 4 remain; DAILY from 10/13 has 19 instances before 11/01.
    expect(candidate.definition.trigger).toEqual({ ...rruleTrigger, rrule: 'FREQ=DAILY;COUNT=23' })
    expect(() => validateOwnerRoutineAssistCandidate(candidate, state)).not.toThrow()
  })
})

describe('決定的に読める英語・毎月曜の表現は補助でも受け付ける', () => {
  it.each([
    ['毎月曜に会議資料', '会議資料', { kind: 'weekly', weekdays: [1], time: '09:00' }],
    ['Water the plants every day', 'Water the plants', { kind: 'rrule', rrule: 'FREQ=DAILY' }],
    ['Send the report every Monday and Wednesday', 'Send the report', { kind: 'weekly', weekdays: [1, 3], time: '09:00' }],
  ] as const)('%s', (message, title, trigger) => {
    const state = calendarFixture(), candidate = parseRoutineAssistAnswer(answer(title, message, trigger), input(message), state)
    expect(candidate.definition.trigger).toMatchObject(trigger)
    expect(() => validateOwnerRoutineAssistCandidate(candidate, state)).not.toThrow()
  })
  it('選択肢・否定・複数周期は引き続き拒否する', () => {
    expect(parseRoutineAssistAnswer(answer('回覧', '毎月第3水曜', { kind: 'rrule', rrule: 'FREQ=MONTHLY;BYDAY=3WE' }), input('毎月第3水曜に回覧'), calendarFixture()).definition.trigger).toMatchObject({ kind: 'rrule', rrule: 'FREQ=MONTHLY;BYDAY=3WE' })
    expect(() => parseRoutineAssistAnswer(answer('回覧', '毎月第3水曜', { kind: 'rrule', rrule: 'FREQ=MONTHLY;BYDAY=3WE' }), input('毎週月曜と毎月第3水曜に回覧'), calendarFixture())).toThrow()
    expect(() => parseRoutineAssistAnswer(answer('Send the report', 'every Monday or Tuesday', { kind: 'weekly', weekdays: [1], time: '09:00' }), input('Send the report every Monday or Tuesday'), calendarFixture())).toThrow()
    expect(() => parseRoutineAssistAnswer(answer('water the plants', 'every day', { kind: 'rrule', rrule: 'FREQ=DAILY' }), input("Don't water the plants every day"), calendarFixture())).toThrow()
    expect(() => parseRoutineAssistAnswer(answer('Water the plants', 'every day', { kind: 'rrule', rrule: 'FREQ=DAILY' }), input('Water the plants every day if it is sunny'), calendarFixture())).toThrow()
  })
  it('有効開始日を起点にし、曜日指定の最初の回と隔週の数え方を説明どおりにする', () => {
    expect(routineAssistStartNote).toContain('起点以降で最初に一致する日が最初の回'); expect(routineAssistStartNote).toContain('起点の週・月から数えます')
    const candidate = parseRoutineAssistAnswer(answer('定例資料', '隔週月曜', { kind: 'rrule', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO' }), input('隔週月曜に定例資料'), calendarFixture()), trigger = candidate.definition.trigger
    if (trigger.kind !== 'rrule') throw new Error('rrule expected')
    expect(trigger.dtstart).toBe('2026-10-01T09:00')
    expect(expandRRule({ dtstart: trigger.dtstart, rrule: trigger.rrule, from: '2026-10-01', to: '2026-11-30' }).occurrences.map(value => value.slice(0, 10))).toEqual(['2026-10-12', '2026-10-26', '2026-11-09', '2026-11-23'])
  })
})
