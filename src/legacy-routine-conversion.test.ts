import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createRoutine, expandRoutines, trashTask, undoCompletion, updateTask, newTaskInput } from './commands'
import { emptyScore, type Routine } from './domain'
import { calendarFixture } from './calendar-test-fixtures'
import { applyCalendarProposalFromUI, clearCalendarRulesAuthority, prepareCalendarGeneration } from './calendar-rules-save'
import { validateCalendarRulesRecords } from './calendar-rules-validation'
import { captureSnapshot } from './backup'
import { validateSnapshot } from './backup-validation'
import { applyLegacyRoutineConversionFromUI, clearLegacyRoutineConversionAuthority, legacyRoutineTrigger, prepareLegacyRoutineConversion } from './legacy-routine-conversion'
import { expandRRule } from './rrule'
import { buildCalendarChangePlan, resolveCalendarOccurrences, type CalendarRule, type CurrentCalendarEntity } from './calendar-resolver'
import { validateCalendarRulesState } from './calendar-rules-validation'
import { addDays } from './domain'
import { monthlyRule } from './calendar-test-fixtures'

const click = () => { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
const selection = { contextId: 'company', bindingId: 'self', calendarId: 'business', time: '09:00' }
const routine = (patch: Partial<Routine>): Omit<Routine, 'id' | 'revision' | 'createdAt'> => ({ title: '旧ルーティン', cadence: 'daily', interval: 1, weekdays: [], monthDay: 1, startDate: '2026-10-01', endDate: null, excludedDates: [], afterTaskId: null, score: { ...emptyScore(), mode: 'manual', manualPoints: 25 }, project: '', active: true, ...patch })
async function stored() { return { completions: await db.completions.toArray(), ledger: await db.ledger.toArray(), assessments: await db.assessments.toArray() } }
async function generate(from = '2026-09-17', to = '2026-12-31') { const proposal = await prepareCalendarGeneration(from, to); await applyCalendarProposalFromUI(proposal, click()); return proposal.plan }

beforeEach(async () => {
  clearLegacyRoutineConversionAuthority(); clearCalendarRulesAuthority(); await db.delete(); await db.open(); await ensureSettings()
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
  const settings = (await db.settings.get('main'))!, state = calendarFixture()
  state.ownerId = settings.profileId; state.datasetId = settings.datasetId; state.bindings[0].personId = settings.profileId; state.activities = []; state.bindings[0].activityIds = []; state.calendars[0].weekdays = [0, 1, 2, 3, 4, 5, 6]
  await db.calendarRules.put(state)
})
afterEach(() => { vi.useRealTimers(); clearLegacyRoutineConversionAuthority(); clearCalendarRulesAuthority() })

describe('旧ルーティンの日付計算をRRULEで再現する', () => {
  const legacyDates = async (input: Omit<Routine, 'id' | 'revision' | 'createdAt'>, from: string, days: number) => { const id = await createRoutine(input); await expandRoutines(from, days); return (await db.tasks.where('routineId').equals(id).toArray()).map(task => task.scheduledDate!).sort() }
  it.each([
    ['2日ごと', routine({ cadence: 'daily', interval: 2, excludedDates: ['2026-10-05'] })],
    ['隔週の水・金（水曜開始）', routine({ cadence: 'weekly', interval: 2, weekdays: [3, 5], startDate: '2026-10-07' })],
    ['毎週月曜で終了日あり', routine({ cadence: 'weekly', interval: 1, weekdays: [1], endDate: '2026-11-30' })],
    ['毎月31日（月末へ寄せる）', routine({ cadence: 'monthly', monthDay: 31, startDate: '2026-01-31' })],
    ['2か月ごとの30日', routine({ cadence: 'monthly', interval: 2, monthDay: 30, startDate: '2026-01-30' })],
    ['毎月29日', routine({ cadence: 'monthly', monthDay: 29, startDate: '2027-01-29' })],
  ])('%s', async (_, input) => {
    const expected = await legacyDates(input, input.startDate, 400), trigger = legacyRoutineTrigger({ ...input, id: 'r', revision: 1, createdAt: '' }, '09:00')
    if (trigger.kind !== 'rrule') throw new Error('rrule expected')
    expect(expandRRule({ dtstart: trigger.dtstart, rrule: trigger.rrule, exdates: trigger.exdates, from: input.startDate, to: expected.at(-1)! }).occurrences.map(value => value.slice(0, 10))).toEqual(expected)
  })
})

describe('旧ルーティンの本人確認つき移行', () => {
  it('移行確認の「次の回」は移行するルーティンの回だけを示し、他の規則の未生成の回を混ぜない', async () => {
    const state = (await db.calendarRules.get('main'))!; state.rules = [monthlyRule()]; await db.calendarRules.put(state)
    const id = await createRoutine(routine({ title: '旧月次30日', cadence: 'monthly', monthDay: 30, startDate: '2026-10-30' })); await expandRoutines('2026-09-01', 120)
    expect((await db.tasks.where('routineId').equals(id).toArray()).map(task => task.scheduledDate).sort()).toEqual(['2026-10-30', '2026-11-30'])
    const proposal = await prepareLegacyRoutineConversion(id, selection)
    expect(proposal.preview.map(spec => [spec.ruleId, spec.title, spec.scheduledDate])).toEqual([[proposal.rule.id, '旧月次30日', '2026-12-30']])
  })
  it('毎日のルーティンを移行しても既存タスク・完了・台帳を保ち、生成で重複しない', async () => {
    const id = await createRoutine(routine({ project: '家事' })); await expandRoutines('2026-10-01', 5)
    const tasks = (await db.tasks.where('routineId').equals(id).toArray()).sort((a, b) => a.scheduledDate!.localeCompare(b.scheduledDate!))
    await completeTask(tasks[0].id, tasks[0].revision); await trashTask(tasks[1].id, tasks[1].revision)
    await updateTask(tasks[2].id, tasks[2].revision, { ...newTaskInput(), title: '今回だけ名前を変更', scheduledDate: tasks[2].scheduledDate, score: tasks[2].score })
    const before = await stored(), count = await db.tasks.count()
    const proposal = await prepareLegacyRoutineConversion(id, selection)
    expect(await db.tasks.count()).toBe(count); expect((await db.calendarRules.get('main'))!.rules).toHaveLength(0)
    expect(proposal.rule.trigger).toMatchObject({ kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-10-01T09:00' })
    expect(proposal.totals).toEqual({ tasks: 5, completed: 1, netPoints: 25 }); expect(proposal.notices.join()).toContain('家事')
    await expect(applyLegacyRoutineConversionFromUI(proposal, proposal.digest, new Event('click'))).rejects.toThrow('本人')
    await expect(applyLegacyRoutineConversionFromUI(proposal, 'other', click())).rejects.toThrow('移行確認案')
    const ruleId = await applyLegacyRoutineConversionFromUI(proposal, proposal.digest, click())
    expect(await applyLegacyRoutineConversionFromUI(proposal, proposal.digest, click())).toBe(ruleId)
    expect((await db.routines.get(id))?.active).toBe(false); expect(await db.tasks.count()).toBe(count)
    const converted = (await db.tasks.where('routineId').equals(id).toArray()).sort((a, b) => a.scheduledDate!.localeCompare(b.scheduledDate!))
    expect(converted.map(task => task.generationKey)).toEqual(tasks.map(task => `calendar:rule:${ruleId}:anchor:${task.scheduledDate}:main`))
    expect(converted.map(task => task.id)).toEqual(tasks.map(task => task.id)); expect(await stored()).toEqual(before)
    const audit = (await db.audits.toArray()).find(row => row.operation === 'routine.legacy_conversion')!
    expect(JSON.parse(audit.detail).legacy_id_map).toEqual(tasks.map(task => ({ taskId: task.id, from: `${id}:${task.scheduledDate}`, to: `calendar:rule:${ruleId}:anchor:${task.scheduledDate}:main` })))
    const plan = await generate('2026-10-01', '2026-10-10')
    expect(plan.creates.map(spec => spec.scheduledDate)).toEqual(['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']); expect(plan.cancels).toEqual([]); expect(plan.updates).toEqual([])
    expect((await db.tasks.get(tasks[1].id))?.deletedAt).not.toBeNull(); expect((await db.tasks.get(tasks[2].id))?.title).toBe('今回だけ名前を変更')
    await expandRoutines('2026-10-01', 10)
    const after = await stored(); expect(await db.tasks.count()).toBe(count + 5); expect(after.completions).toEqual(before.completions); expect(after.ledger).toEqual(before.ledger)
    expect(after.assessments.filter(row => before.assessments.some(old => old.id === row.id))).toEqual(before.assessments)
    const snapshot = await captureSnapshot(); validateSnapshot(snapshot); validateCalendarRulesRecords(snapshot.calendarRules, snapshot.tasks, snapshot.calendarEvents ?? [], snapshot.settings)
  })
  it('完了後ルーティンを完了起点の系列へ移し、次の回を一つだけ保つ', async () => {
    const id = await createRoutine(routine({ cadence: 'after_completion', interval: 3 })); await expandRoutines('2026-10-01', 1)
    const first = (await db.tasks.where('routineId').equals(id).first())!; await completeTask(first.id, first.revision); await expandRoutines('2026-10-01', 1)
    expect((await db.tasks.where('routineId').equals(id).toArray()).map(task => task.scheduledDate).sort()).toEqual(['2026-10-01', '2026-10-04'])
    const proposal = await prepareLegacyRoutineConversion(id, selection)
    expect(proposal.rule.trigger).toEqual({ kind: 'completion_relative', firstDate: '2026-10-01', time: '09:00', afterDays: 3, unfinishedPolicy: 'generate_after_completion' })
    expect(proposal.mappings.map(row => row.to.split(':').slice(-3, -1).join(':'))).toEqual(['chain:0', 'chain:1'])
    await applyLegacyRoutineConversionFromUI(proposal, proposal.digest, click())
    expect(await generate()).toMatchObject({ creates: [], updates: [], cancels: [] })
    const next = (await db.tasks.toArray()).find(task => task.status === 'open')!
    vi.setSystemTime(new Date('2026-10-05T00:00:00.000Z')); await completeTask(next.id, next.revision)
    expect((await generate()).creates.map(spec => spec.scheduledDate)).toEqual(['2026-10-08'])
    expect((await db.tasks.toArray()).filter(task => task.status === 'open')).toHaveLength(1); expect((await db.ledger.toArray()).reduce((sum, row) => sum + row.delta, 0)).toBe(50)
  })
  it('自動では移行せず、同じ回として作れない状態・停止済み・選択不足は移行しない', async () => {
    const id = await createRoutine(routine({ cadence: 'after_completion', interval: 3 })); await expandRoutines('2026-10-01', 1)
    const first = (await db.tasks.where('routineId').equals(id).first())!; await completeTask(first.id, first.revision); await expandRoutines('2026-10-01', 1)
    await expandRoutines('2026-10-01', 30); expect((await db.calendarRules.get('main'))!.rules).toHaveLength(0)
    const done = (await db.tasks.get(first.id))!; await undoCompletion(done.id, done.revision)
    await expect(prepareLegacyRoutineConversion(id, selection)).rejects.toThrow('同じ回として作られません')
    await expect(prepareLegacyRoutineConversion(id, { ...selection, bindingId: 'missing' })).rejects.toThrow('本人適用')
    await expect(prepareLegacyRoutineConversion(id, { ...selection, time: '25:00' })).rejects.toThrow('HH:mm')
    const daily = await createRoutine(routine({ startDate: '2025-12-30' })); await expandRoutines('2025-12-30', 3)
    await expect(prepareLegacyRoutineConversion(daily, selection)).rejects.toThrow('同じ回として作られません')
    await db.routines.update(daily, { active: false }); await expect(prepareLegacyRoutineConversion(daily, selection)).rejects.toThrow('有効な旧ルーティン')
    const weekly = await createRoutine(routine({ cadence: 'weekly', weekdays: [] }))
    await expect(prepareLegacyRoutineConversion(weekly, selection)).rejects.toThrow('曜日')
  })
  it('確認後にタスクや旧ルーティンが変わったら移行しない', async () => {
    const id = await createRoutine(routine({})); await expandRoutines('2026-10-01', 2)
    const proposal = await prepareLegacyRoutineConversion(id, selection), task = (await db.tasks.where('routineId').equals(id).first())!
    await completeTask(task.id, task.revision)
    await expect(applyLegacyRoutineConversionFromUI(proposal, proposal.digest, click())).rejects.toThrow('変わりました')
    expect((await db.routines.get(id))?.active).toBe(true); expect((await db.calendarRules.get('main'))!.rules).toHaveLength(0)
    expect((await db.tasks.where('routineId').equals(id).toArray()).every(row => row.generationKey.startsWith(`${id}:`))).toBe(true)
  })
})

describe('移行後の系列を時刻変更・長い完了履歴でも同じ回として保つ', () => {
  const step = { key: 'main', title: '旧ルーティン', kind: 'task' as const, scheduledOffsetDays: 0, dueOffsetDays: null, score: { ...emptyScore(), mode: 'manual' as const, manualPoints: 25 }, durationMinutes: null }
  const meet = { key: 'meet', title: '旧ルーティンの時間', kind: 'event' as const, scheduledOffsetDays: 0, dueOffsetDays: null, score: null, durationMinutes: 30 }
  function converted(trigger: CalendarRule['trigger'], patch: Partial<CalendarRule> = {}) {
    const state = calendarFixture(); state.activities = []; state.bindings[0].activityIds = []; state.calendars[0].weekdays = [0, 1, 2, 3, 4, 5, 6]; state.rules = [monthlyRule({ id: 'legacy', title: '旧ルーティン', trigger, steps: [step, meet], ...patch })]
    validateCalendarRulesState(state, 'owner', 'dataset'); return state
  }
  const entity = (spec: CurrentCalendarEntity['spec'], patch: Partial<CurrentCalendarEntity> = {}): CurrentCalendarEntity => ({ generationKey: spec.generationKey, entityId: spec.generationKey, revision: 1, status: 'active', completed: false, edited: false, started: false, spec, completedAt: null, ...patch })
  it('除外日つきの旧ルーティンは、移行後に時刻だけ変えても除外日を作り直さない', () => {
    const trigger = legacyRoutineTrigger({ ...routine({ cadence: 'weekly', weekdays: [2], startDate: '2026-10-06', excludedDates: ['2026-10-20'] }), id: 'r', revision: 1, createdAt: '' }, '10:00')
    if (trigger.kind !== 'rrule') throw new Error('rrule expected')
    expect(trigger.exdates).toEqual(['2026-10-20T10:00'])
    const state = converted(trigger), current = resolveCalendarOccurrences(state, '2026-10-01', '2026-11-10').occurrences.map(spec => entity(spec))
    expect(current.some(item => item.spec.triggerKey === 'anchor:2026-10-20')).toBe(false)
    const rule = state.rules[0]; rule.revision = 2; rule.editions = [{ id: 'later', revision: 2, scope: { kind: 'all_uncompleted' }, definition: { title: rule.title, enabled: true, trigger: { ...trigger, dtstart: '2026-10-06T11:00' }, steps: rule.steps } }]
    validateCalendarRulesState(state, 'owner', 'dataset')
    const plan = buildCalendarChangePlan(state, current, '2026-10-01', '2026-11-10')
    expect(plan.creates).toEqual([]); expect(plan.cancels).toEqual([]); expect(plan.updates.every(update => update.after.triggerKey !== 'anchor:2026-10-20')).toBe(true)
    expect(plan.updates.map(update => update.after.startAt)).toEqual(['10-06', '10-13', '10-27', '11-03', '11-10'].map(day => `2026-${day}T02:00:00.000Z`))
  })
  it('完了後ルーティンの完了が1,000回を超えても、未完了の最後の回は同じ識別のまま', () => {
    const trigger = legacyRoutineTrigger({ ...routine({ cadence: 'after_completion', interval: 1, startDate: '2024-01-01' }), id: 'r', revision: 1, createdAt: '' }, '09:00')
    const state = calendarFixture(); state.activities = []; state.bindings[0].activityIds = []; state.rules = [monthlyRule({ id: 'legacy', title: '旧ルーティン', trigger, steps: [step] })]
    for (const row of [state.contexts[0], state.bindings[0], state.calendars[0], state.rules[0]]) row.validFrom = '2024-01-01'
    validateCalendarRulesState(state, 'owner', 'dataset')
    const spec = (index: number, date: string) => ({ generationKey: `calendar:rule:legacy:chain:${index}:main`, triggerKey: `chain:${index}`, stepKey: 'main', contextId: 'company', bindingId: 'self', activityId: null, ruleId: 'legacy', kind: 'task' as const, title: '旧ルーティン', scheduledDate: date, dueDate: null, score: { ...step.score }, startAt: null, endAt: null, eventKind: null, timezone: 'Asia/Tokyo', sourceRefs: [], originBasis: 'user_instruction' as const })
    const done = Array.from({ length: 1001 }, (_, index) => { const date = addDays('2024-01-01', index); return entity(spec(index, date), { completed: true, completedAt: `${date}T03:00:00.000Z` }) })
    const tail = entity(spec(1001, '2026-09-28'))
    const plan = buildCalendarChangePlan(state, [...done, tail], '2026-09-17', '2026-12-31', { kind: 'all_uncompleted' }, { today: '2026-10-01' })
    expect(plan).toMatchObject({ creates: [], updates: [], cancels: [], truncatedSeries: [], unchanged: 1 })
  })
})
