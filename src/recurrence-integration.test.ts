import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { captureSnapshot, restoreBackup } from './backup'
import { validateSnapshot } from './backup-validation'
import { completeTask, correctCompletion, undoCompletion } from './commands'
import { emptyScore, type Task } from './domain'
import { calendarFixture, monthlyRule } from './calendar-test-fixtures'
import type { CalendarRule, CalendarRulesState } from './calendar-resolver'
import { applyCalendarProposalFromUI, clearCalendarRulesAuthority, loadCalendarRulesState, prepareCalendarConfiguration, prepareCalendarGeneration, type CalendarRulesConfiguration } from './calendar-rules-save'
import { validateCalendarRulesRecords } from './calendar-rules-validation'
import { emergencyStop, reduceAuthority } from './automation-control'

const click = () => { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
const at = (iso: string) => vi.setSystemTime(new Date(iso))
const step = (points: number) => ({ key: 'main', title: '植物の水やり', kind: 'task' as const, scheduledOffsetDays: 0, dueOffsetDays: null, score: { ...emptyScore(), mode: 'manual' as const, manualPoints: points }, durationMinutes: null })
function config(state: CalendarRulesState): CalendarRulesConfiguration { const { contexts, bindings, calendars, activities, sources, facts, rules } = state; return structuredClone({ contexts, bindings, calendars, activities, sources, facts, rules }) }
async function save(rules: CalendarRule[], base?: CalendarRulesState) {
  const settings = (await db.settings.get('main'))!, state = base ?? calendarFixture()
  if (!base) { state.ownerId = settings.profileId; state.datasetId = settings.datasetId; state.bindings[0].personId = settings.profileId; state.activities = []; state.bindings[0].activityIds = [] }
  state.rules = rules
  await applyCalendarProposalFromUI(await prepareCalendarConfiguration(config(state), (await loadCalendarRulesState()).revision, '2026-10-01', '2026-12-31'), click())
}
async function generate(scope: Parameters<typeof prepareCalendarGeneration>[2] = { kind: 'all_uncompleted' }) { const proposal = await prepareCalendarGeneration('2026-09-17', '2026-12-31', scope); await applyCalendarProposalFromUI(proposal, click()); return proposal.plan }
const live = async () => (await db.tasks.toArray()).filter(task => !task.deletedAt)
const byKey = async (suffix: string) => (await db.tasks.toArray()).find(task => task.generationKey.endsWith(suffix))!
const ledgerSum = async () => (await db.ledger.toArray()).reduce((sum, row) => sum + row.delta, 0)

beforeEach(async () => { clearCalendarRulesAuthority(); await db.delete(); await db.open(); await ensureSettings(); vi.useFakeTimers({ toFake: ['Date'] }); at('2026-10-01T00:00:00.000Z') })
afterEach(() => { vi.useRealTimers(); clearCalendarRulesAuthority() })

describe('完了起点の系列と完了実績', () => {
  it('40pt完了→35pt訂正→取消→再完了でも35ptを保ち、次の回は一つだけ移動する', async () => {
    await save([monthlyRule({ id: 'water', title: '植物の水やり', trigger: { kind: 'completion_relative', firstDate: '2026-10-01', time: '09:00', afterDays: 14, unfinishedPolicy: 'generate_after_completion' }, steps: [step(40)] })])
    expect((await generate()).creates.map(spec => spec.scheduledDate)).toEqual(['2026-10-01'])
    let first = await byKey(':chain:0:main'); expect(first.effectivePoints).toBe(40)
    at('2026-10-01T03:00:00.000Z'); await completeTask(first.id, first.revision); await correctCompletion(first.id, 35, '実際の負荷に合わせて訂正')
    const assessmentsBefore = await db.assessments.toArray()
    expect((await generate()).creates.map(spec => [spec.generationKey, spec.scheduledDate])).toEqual([['calendar:rule:water:chain:1:main', '2026-10-15']])
    const next = await byKey(':chain:1:main')
    first = (await db.tasks.get(first.id))!; await undoCompletion(first.id, first.revision)
    const undone = await prepareCalendarGeneration('2026-09-17', '2026-12-31')
    expect(undone.plan.cancels.map(item => item.before.entityId)).toEqual([next.id]); expect(undone.plan.creates).toEqual([])
    await applyCalendarProposalFromUI(undone, click())
    expect((await db.tasks.get(next.id))?.deletedAt).not.toBeNull()
    at('2026-10-03T01:00:00.000Z'); first = (await db.tasks.get(first.id))!; await completeTask(first.id, first.revision)
    const redo = await generate()
    expect(redo.creates).toEqual([]); expect(redo.updates.map(update => [update.before.entityId, update.after.scheduledDate])).toEqual([[next.id, '2026-10-17']])
    const open = (await live()).filter(task => task.status === 'open')
    expect(open.map(task => [task.id, task.scheduledDate])).toEqual([[next.id, '2026-10-17']])
    const completion = (await db.completions.toArray())[0]
    expect(await db.completions.count()).toBe(1); expect(completion).toMatchObject({ originalPoints: 40, netPoints: 35, originalAt: '2026-10-01T03:00:00.000Z', currentAt: '2026-10-03T01:00:00.000Z' })
    expect((await db.ledger.toArray()).map(row => `${row.kind}:${row.delta}`).sort()).toEqual(['adjust:-5', 'award:40', 'restore:35', 'reverse:-35'])
    expect(await ledgerSum()).toBe(35)
    expect((await db.assessments.toArray()).filter(row => assessmentsBefore.some(old => old.id === row.id))).toEqual(assessmentsBefore)
    expect(await generate()).toMatchObject({ creates: [], updates: [], cancels: [] })
    const saved = await captureSnapshot(); validateSnapshot(saved)
    validateCalendarRulesRecords(saved.calendarRules, saved.tasks, saved.calendarEvents ?? [], saved.settings)
  })
  it('次の回を生成する承認とは別に、完了しただけでは台帳以外を変えない', async () => {
    await save([monthlyRule({ id: 'water', title: '植物の水やり', trigger: { kind: 'completion_relative', firstDate: '2026-10-01', time: '09:00', afterDays: 14, unfinishedPolicy: 'keep_all' }, steps: [step(10)] })])
    await generate(); const first = await byKey(':chain:0:main'), state = await loadCalendarRulesState()
    await completeTask(first.id, first.revision)
    expect(await db.tasks.count()).toBe(1); expect(await loadCalendarRulesState()).toEqual(state); expect(await ledgerSum()).toBe(10)
  })
})

describe('RRULE系列の変更範囲と完了実績', () => {
  const rrule = (rule: string, points = 25): CalendarRule => monthlyRule({ id: 'meeting', title: '町内会の資料確認', trigger: { kind: 'rrule', dtstart: '2026-10-13T10:00', rrule: rule, rdates: [], exdates: [], nonexistentTime: 'skip', ambiguousTime: 'earlier' }, steps: [{ ...step(points), title: '町内会の資料確認' }] })
  it('毎月第2火曜を以後だけ第3火曜へ変えても、完了済みの回と台帳を変えない', async () => {
    await save([rrule('FREQ=MONTHLY;BYDAY=2TU')]); await generate()
    expect((await live()).map(task => task.scheduledDate).sort()).toEqual(['2026-10-13', '2026-11-10', '2026-12-08'])
    const october = await byKey(':anchor:2026-10-13:main'); at('2026-10-13T02:00:00.000Z'); await completeTask(october.id, october.revision)
    const completedBefore = await db.tasks.get(october.id), ledgerBefore = await db.ledger.toArray(), completionsBefore = await db.completions.toArray()
    const state = await loadCalendarRulesState(), rule = state.rules[0]
    rule.revision++; rule.editions = [{ id: 'third', revision: rule.revision, scope: { kind: 'this_and_future', fromDate: '2026-11-01' }, definition: { title: rule.title, enabled: true, trigger: { ...rule.trigger as Extract<CalendarRule['trigger'], { kind: 'rrule' }>, rrule: 'FREQ=MONTHLY;BYDAY=3TU' }, steps: rule.steps } }]
    await save(state.rules, state)
    const future = await generate({ kind: 'this_and_future', fromDate: '2026-11-01' })
    expect(future.creates.map(spec => spec.scheduledDate)).toEqual(['2026-11-17', '2026-12-15']); expect(future.cancels.map(item => item.before.spec.scheduledDate)).toEqual(['2026-11-10', '2026-12-08'])
    expect((await live()).map(task => task.scheduledDate).sort()).toEqual(['2026-10-13', '2026-11-17', '2026-12-15'])
    const again = await loadCalendarRulesState(), changed = again.rules[0], november = await byKey(':anchor:2026-11-17:main')
    changed.revision++; changed.editions = [...changed.editions!, { id: 'once', revision: changed.revision, scope: { kind: 'this_instance', generationKey: november.generationKey }, definition: { ...changed.editions![0].definition, steps: [{ ...changed.steps[0], score: { ...changed.steps[0].score!, manualPoints: 30 } }] } }]
    await save(again.rules, again)
    expect((await generate()).updates.map(update => update.after.generationKey)).toEqual([november.generationKey])
    expect((await db.tasks.get(november.id))?.effectivePoints).toBe(30); expect((await byKey(':anchor:2026-12-15:main')).effectivePoints).toBe(25)
    const all = await loadCalendarRulesState(), last = all.rules[0]
    last.revision++; last.editions = [...last.editions!, { id: 'all', revision: last.revision, scope: { kind: 'all_uncompleted' }, definition: { ...last.editions![0].definition, steps: [{ ...last.steps[0], score: { ...last.steps[0].score!, manualPoints: 40 } }] } }]
    await save(all.rules, all)
    const updated = await generate(); expect(updated.updates).toHaveLength(2); expect([...updated.updates.map(update => update.before.entityId), ...updated.cancels.map(item => item.before.entityId)]).not.toContain(october.id)
    expect(await db.tasks.get(october.id)).toEqual(completedBefore); expect(await db.ledger.toArray()).toEqual(ledgerBefore); expect(await db.completions.toArray()).toEqual(completionsBefore)
  })
})

describe('時刻付き締め切りの生成と復元', () => {
  it('会社の最終営業日17時締め切りをdueAtで保存し、バックアップ復元後も同じ値を保つ', async () => {
    await save([monthlyRule({ trigger: { kind: 'monthly_business', ordinal: 1, from: 'end', time: '09:00' }, steps: [{ key: 'submit', title: '勤怠提出', kind: 'task', scheduledOffsetDays: 0, dueOffsetDays: 0, score: { ...emptyScore(), mode: 'manual', manualPoints: 10 }, durationMinutes: null, dueTime: '17:00' }] })])
    await generate()
    const october = (await live()).find(task => task.scheduledDate === '2026-10-30')!
    expect(october).toMatchObject({ dueDate: '2026-10-30', dueAt: '2026-10-30T08:00:00.000Z', dueTimezone: 'Asia/Tokyo', effectivePoints: 10 })
    const snapshot = await captureSnapshot(); validateSnapshot(snapshot)
    await restoreBackup(snapshot)
    expect(await db.tasks.get(october.id)).toEqual(october)
    expect(await generate()).toMatchObject({ creates: [], updates: [], cancels: [] })
    const legacy = structuredClone(snapshot), task = legacy.tasks.find(row => row.id === october.id)! as Task
    delete task.dueAt; delete task.dueTimezone; legacy.calendarRules = []
    expect(() => validateSnapshot(legacy)).not.toThrow()
    const broken = structuredClone(snapshot); (broken.tasks.find(row => row.id === october.id) as Task).dueDate = '2026-10-31'
    expect(() => validateSnapshot(broken)).toThrow('時刻付き締め切り')
  })
})

describe('次の10回の確認', () => {
  it('毎月第2火曜10:00は次の10回、毎年2月29日は90日より先のうるう年の回を示す', async () => {
    const settings = (await db.settings.get('main'))!, state = calendarFixture()
    state.ownerId = settings.profileId; state.datasetId = settings.datasetId; state.bindings[0].personId = settings.profileId; state.activities = []; state.bindings[0].activityIds = []
    for (const row of [...state.contexts, ...state.bindings, ...state.calendars]) row.validTo = '2036-12-31'
    const rule = (id: string, dtstart: string, value: string) => monthlyRule({ id, title: id, validTo: '2036-12-31', trigger: { kind: 'rrule', dtstart, rrule: value, rdates: [], exdates: [], nonexistentTime: 'skip', ambiguousTime: 'earlier' }, steps: [{ ...step(10), title: id }] })
    state.rules = [rule('tuesday', '2026-10-13T10:00', 'FREQ=MONTHLY;BYDAY=2TU'), rule('leap', '2026-10-01T09:00', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29')]
    const monthly = await prepareCalendarConfiguration(config(state), 1, '2026-10-01', '2026-12-30', 'tuesday')
    expect(monthly.preview.map(spec => spec.scheduledDate)).toEqual(['2026-10-13', '2026-11-10', '2026-12-08', '2027-01-12', '2027-02-09', '2027-03-09', '2027-04-13', '2027-05-11', '2027-06-08', '2027-07-13'])
    const leap = await prepareCalendarConfiguration(config(state), 1, '2026-10-01', '2026-12-30', 'leap')
    expect(leap.preview.map(spec => spec.scheduledDate)).toEqual(['2028-02-29', '2032-02-29', '2036-02-29'])
    expect(await db.tasks.count()).toBe(0); expect(await db.calendarRules.count()).toBe(0)
  })
})

describe('N09の停止スイッチとN05の系列生成', () => {
  it.each(['routines', 'emergency'] as const)('%s 停止中はRRULE系列も完了起点の次の回も生成せず、停止前の確認案も適用しない', async scope => {
    await save([
      monthlyRule({ id: 'meeting', title: '町内会の資料確認', trigger: { kind: 'rrule', dtstart: '2026-10-13T10:00', rrule: 'FREQ=MONTHLY;BYDAY=2TU', rdates: [], exdates: [], nonexistentTime: 'skip', ambiguousTime: 'earlier' }, steps: [{ ...step(25), title: '町内会の資料確認' }] }),
      monthlyRule({ id: 'water', title: '植物の水やり', trigger: { kind: 'completion_relative', firstDate: '2026-10-01', time: '09:00', afterDays: 14, unfinishedPolicy: 'generate_after_completion' }, steps: [step(10)] }),
    ])
    await applyCalendarProposalFromUI(await prepareCalendarGeneration('2026-09-17', '2026-10-31'), click())
    expect((await live()).map(task => task.generationKey).sort()).toEqual(['calendar:rule:meeting:anchor:2026-10-13:main', 'calendar:rule:water:chain:0:main'])
    const first = await byKey(':chain:0:main'); at('2026-10-01T03:00:00.000Z'); await completeTask(first.id, first.revision)
    const pending = await prepareCalendarGeneration('2026-09-17', '2026-12-31')
    expect(pending.plan.creates.map(spec => spec.generationKey).sort()).toEqual(['calendar:rule:meeting:anchor:2026-11-10:main', 'calendar:rule:meeting:anchor:2026-12-08:main', 'calendar:rule:water:chain:1:main'])
    const tasksBefore = await db.tasks.toArray(), stateBefore = await loadCalendarRulesState()
    if (scope === 'routines') await reduceAuthority('routines', 'button'); else await emergencyStop('button')
    await expect(prepareCalendarGeneration('2026-09-17', '2026-12-31')).rejects.toThrow('停止中')
    // The stop also invalidates proposals prepared before it, so nothing generated earlier can be applied afterwards.
    await expect(applyCalendarProposalFromUI(pending, click())).rejects.toThrow()
    expect(await db.tasks.toArray()).toEqual(tasksBefore); expect(await loadCalendarRulesState()).toEqual(stateBefore)
    expect((await live()).map(task => task.generationKey).sort()).toEqual(['calendar:rule:meeting:anchor:2026-10-13:main', 'calendar:rule:water:chain:0:main'])
  })
})
