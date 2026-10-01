import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, newTaskInput, updateTask } from './commands'
import { changePolicyFor } from './change-set'
import { contentDigest } from './canonical'
import { calendarFixture, monthlyRule } from './calendar-test-fixtures'
import { type CalendarRule, type CalendarRulesState } from './calendar-resolver'
import { applyCalendarProposalFromUI, clearCalendarRulesAuthority, loadCalendarRulesState, prepareCalendarConfiguration, prepareCalendarGeneration, prepareCalendarScheduleImport, type CalendarRulesConfiguration } from './calendar-rules-save'
import { validateCalendarRulesRecords } from './calendar-rules-validation'

beforeEach(async () => { clearCalendarRulesAuthority(); await db.delete(); await db.open(); await ensureSettings() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); clearCalendarRulesAuthority() })
function humanClick() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
function config(state: CalendarRulesState): CalendarRulesConfiguration { const { contexts, bindings, calendars, activities, sources, facts, rules } = state; return { contexts, bindings, calendars, activities, sources, facts, rules } }
async function fixture(): Promise<CalendarRulesState> {
  const settings = (await db.settings.get('main'))!, state = calendarFixture()
  state.ownerId = settings.profileId; state.datasetId = settings.datasetId; state.bindings.forEach(binding => { binding.personId = state.ownerId })
  state.activities[0].weekdays = [1]; state.bindings[0].weekdays = [1]
  state.rules = [monthlyRule({ trigger: { kind: 'weekly', weekdays: [1], time: '09:00' } })]
  return state
}
async function save(state: CalendarRulesState) { await applyCalendarProposalFromUI(await prepareCalendarConfiguration(config(state), state.revision, '2026-10-01', '2026-10-15'), humanClick()) }
async function generate(from = '2026-10-01', to = '2026-10-15') { const proposal = await prepareCalendarGeneration(from, to); await applyCalendarProposalFromUI(proposal, humanClick()); return proposal }
async function storage() { return { state: await db.calendarRules.toArray(), tasks: await db.tasks.toArray(), events: await db.calendarEvents.toArray(), assessments: await db.assessments.toArray(), completions: await db.completions.toArray(), ledger: await db.ledger.toArray(), audits: await db.audits.toArray(), commands: await db.commands.toArray() } }
function officialClosed(revision: number, validity = 'active') { return { format: 'coach-schedule-facts', version: 1, source: { id: 'calendar', title: '会社の正式暦', authorityScope: 'calendar', coverageFrom: '2026-01-01', coverageTo: '2026-12-31', revision }, facts: [{ id: 'closed-mon', revision, kind: 'closed', calendarId: 'business', date: '2026-10-05', validity, supersedes: [] }] } }

describe('本人確認からの共通カレンダー保存', () => {
  it('previewでは書き込まず、本人適用の設定と発生回を別確認し、再送・再展開で重複しない', async () => {
    const state = await fixture(), configProposal = await prepareCalendarConfiguration(config(state), 1, '2026-10-01', '2026-10-15')
    expect(await db.calendarRules.count()).toBe(0); expect(await db.tasks.count()).toBe(0); expect(configProposal.preview).toHaveLength(4)
    await applyCalendarProposalFromUI(configProposal, humanClick()); expect(await db.tasks.count()).toBe(0)
    const proposal = await prepareCalendarGeneration('2026-10-01', '2026-10-15'); expect(proposal.plan.creates).toHaveLength(4); expect(await db.tasks.count()).toBe(0)
    const result = await applyCalendarProposalFromUI(proposal, humanClick()), saved = await storage()
    expect(saved.tasks).toHaveLength(2); expect(saved.events).toHaveLength(2); expect(saved.tasks.every(task => task.effectivePoints === 10)).toBe(true)
    expect(await applyCalendarProposalFromUI(proposal, humanClick())).toBe(result); expect(await storage()).toEqual(saved)
    expect((await prepareCalendarGeneration('2026-10-01', '2026-10-15')).plan).toMatchObject({ creates: [], updates: [], cancels: [], unchanged: 4 })
    validateCalendarRulesRecords(saved.state, saved.tasks, saved.events, await db.settings.toArray())
  })
  it('完了済みタスクとそのpoints台帳を不変にし、未完了の回だけ明示ポイントを変更する', async () => {
    await save(await fixture()); await generate()
    const tasks = (await db.tasks.toArray()).sort((a, b) => a.scheduledDate!.localeCompare(b.scheduledDate!)), first = tasks[0]
    await completeTask(first.id, first.revision)
    const completedBefore = await db.tasks.get(first.id), ledgerBefore = await db.ledger.toArray(), completionsBefore = await db.completions.toArray()
    const state = await loadCalendarRulesState(), rule = state.rules[0]
    rule.revision++; rule.editions = [{ id: 'all', revision: rule.revision, scope: { kind: 'all_uncompleted' }, definition: { title: rule.title, enabled: true, trigger: rule.trigger, steps: [{ ...rule.steps[0], score: { ...rule.steps[0].score!, manualPoints: 25 } }] } }]
    await save(state)
    const plan = await prepareCalendarGeneration('2026-10-01', '2026-10-15'); expect(plan.plan).toMatchObject({ skippedCompleted: 1, conflicts: [] }); expect(plan.plan.updates).toHaveLength(1)
    await applyCalendarProposalFromUI(plan, humanClick())
    expect(await db.tasks.get(first.id)).toEqual(completedBefore); expect(await db.ledger.toArray()).toEqual(ledgerBefore); expect(await db.completions.toArray()).toEqual(completionsBefore)
    expect((await db.tasks.get(tasks[1].id))?.effectivePoints).toBe(25)
  })
  it('公式休日の取消と撤回を確認して適用し、復活は同じtask/event IDを使う', async () => {
    const state = await fixture(); state.rules[0].trigger = { kind: 'activity_relative', activityId: 'work', edge: 'start', offsetDays: 0, offsetMinutes: 0 }
    await save(state); await generate('2026-10-05', '2026-10-05')
    const first = await storage(), taskId = first.tasks[0].id, eventId = first.events[0].id
    const importProposal = await prepareCalendarScheduleImport('company', officialClosed(2), '2026-10-05', '2026-10-05')
    expect((await storage()).tasks[0].deletedAt).toBeNull(); await applyCalendarProposalFromUI(importProposal, humanClick())
    const plan = await prepareCalendarGeneration('2026-10-05', '2026-10-05'); expect(plan.plan.cancels).toHaveLength(2); await applyCalendarProposalFromUI(plan, humanClick())
    expect((await db.tasks.get(taskId))?.deletedAt).not.toBeNull(); expect(await db.calendarEvents.count()).toBe(0)
    const noOp = await prepareCalendarScheduleImport('company', officialClosed(2), '2026-10-05', '2026-10-05'), unchangedState = await loadCalendarRulesState()
    expect(noOp.importPreview?.noOp).toBe(true); await applyCalendarProposalFromUI(noOp, humanClick()); expect(await loadCalendarRulesState()).toEqual(unchangedState)
    await applyCalendarProposalFromUI(await prepareCalendarScheduleImport('company', officialClosed(3, 'withdrawn'), '2026-10-05', '2026-10-05'), humanClick())
    const restored = await prepareCalendarGeneration('2026-10-05', '2026-10-05'); expect(restored.plan.creates).toHaveLength(0); expect(restored.plan.updates).toHaveLength(2)
    await applyCalendarProposalFromUI(restored, humanClick()); expect(await db.tasks.count()).toBe(1); expect((await db.tasks.get(taskId))?.deletedAt).toBeNull(); expect((await db.calendarEvents.toArray())[0].id).toBe(eventId)
  })
  it('今回だけの版は保存後の再展開にも残り、他の回のポイントを変えない', async () => {
    await save(await fixture()); await generate()
    const state = await loadCalendarRulesState(), rule = state.rules[0], first = state.instances.find(instance => instance.spec.ruleId === rule.id)!
    const definition: Pick<CalendarRule, 'title' | 'enabled' | 'trigger' | 'steps'> = { title: rule.title, enabled: true, trigger: rule.trigger, steps: [{ ...rule.steps[0], score: { ...rule.steps[0].score!, manualPoints: 20 } }] }
    rule.revision++; rule.editions = [{ id: 'only-one', revision: rule.revision, scope: { kind: 'this_instance', generationKey: first.generationKey }, definition }]
    await save(state); const plan = await prepareCalendarGeneration('2026-10-01', '2026-10-15'); expect(plan.plan.updates).toHaveLength(1)
    await applyCalendarProposalFromUI(plan, humanClick()); expect((await db.tasks.toArray()).map(task => task.effectivePoints).sort()).toEqual([10, 20])
    expect((await prepareCalendarGeneration('2026-10-01', '2026-10-15')).plan).toMatchObject({ creates: [], updates: [], cancels: [] })
  })
  it('preview後の本人編集をtx内で検出し、古い差分の部分反映をしない', async () => {
    await save(await fixture()); await generate()
    const state = await loadCalendarRulesState(); state.rules[0].steps[0].title = '更新案'; state.rules[0].revision++; await save(state)
    const proposal = await prepareCalendarGeneration('2026-10-01', '2026-10-15'), task = (await db.tasks.toArray())[0]
    await updateTask(task.id, task.revision, { ...newTaskInput(), ...task, title: '本人の編集' })
    const before = await storage(); await expect(applyCalendarProposalFromUI(proposal, humanClick())).rejects.toThrow('別の画面'); expect(await storage()).toEqual(before)
    expect((await prepareCalendarGeneration('2026-10-01', '2026-10-15')).plan.conflicts).toHaveLength(1)
  })
  it('epoch、利用者・dataset、期限変更を反映直前に拒否する', async () => {
    await save(await fixture()); const proposal = await prepareCalendarGeneration('2026-10-01', '2026-10-15'), current = (await db.settings.get('main'))!
    await db.settings.put({ ...current, changePolicy: { ...changePolicyFor(current), epoch: changePolicyFor(current).epoch + 1 } })
    await expect(applyCalendarProposalFromUI(proposal, humanClick())).rejects.toThrow('設定'); expect(await db.tasks.count()).toBe(0)
    await db.settings.put(current); await db.settings.update('main', { datasetId: 'other-dataset' }); await expect(applyCalendarProposalFromUI(proposal, humanClick())).rejects.toThrow('データセット'); expect(await db.tasks.count()).toBe(0)
    await db.settings.put(current); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(Date.now() + 86400001))
    await expect(applyCalendarProposalFromUI(proposal, humanClick())).rejects.toThrow('期限'); vi.useRealTimers()
  })
  it('モデルの自己承認・変造digest・偽nativeEvent・instances混入を拒否する', async () => {
    await save(await fixture()); const proposal = await prepareCalendarGeneration('2026-10-01', '2026-10-15')
    await expect(applyCalendarProposalFromUI(proposal, new Event('click'))).rejects.toThrow('本人確認')
    await expect(applyCalendarProposalFromUI(proposal, { isTrusted: true, type: 'click' } as Event)).rejects.toThrow('本人確認')
    const forged = Object.create(Event.prototype); Object.defineProperties(forged, { isTrusted: { value: true }, type: { value: 'click' } }); await expect(applyCalendarProposalFromUI(proposal, forged)).rejects.toThrow('本人確認')
    const altered = structuredClone(proposal); altered.plan.creates[0].title = '勝手な変更'; const { digest: _, ...unsigned } = altered; altered.digest = await contentDigest(unsigned)
    await expect(applyCalendarProposalFromUI(altered, humanClick())).rejects.toThrow('登録済み')
    const state = await loadCalendarRulesState(); await expect(prepareCalendarConfiguration({ ...config(state), instances: [] } as CalendarRulesConfiguration, state.revision, '2026-10-01', '2026-10-15')).rejects.toThrow('本人設定')
    clearCalendarRulesAuthority(); await expect(applyCalendarProposalFromUI(proposal, humanClick())).rejects.toThrow('登録済み')
  })
  it('保存終盤の失敗でもtask、event、assessment、instance、receiptをすべてrollbackする', async () => {
    await save(await fixture()); const proposal = await prepareCalendarGeneration('2026-10-01', '2026-10-15'), before = await storage()
    vi.spyOn(db.calendarRules, 'put').mockRejectedValueOnce(new Error('late failure'))
    await expect(applyCalendarProposalFromUI(proposal, humanClick())).rejects.toThrow('late failure'); expect(await storage()).toEqual(before)
  })
  it('バックアップで発生回の本人/タスク/取消不整合を拒否し、完了後のタイトル保護を許可する', async () => {
    await save(await fixture()); await generate(); const saved = await storage(), settings = await db.settings.toArray()
    const editedTasks = structuredClone(saved.tasks); editedTasks[0].title = '本人変更'; editedTasks[0].revision++; validateCalendarRulesRecords(saved.state, editedTasks, saved.events, settings)
    expect(() => validateCalendarRulesRecords(saved.state, [], saved.events, settings)).toThrow('タスク')
    const foreign = structuredClone(saved.state); foreign[0].ownerId = 'other'; expect(() => validateCalendarRulesRecords(foreign, saved.tasks, saved.events, settings)).toThrow('本人')
    const cancelled = structuredClone(saved.state), cancelledInstance = cancelled[0].instances.find(instance => instance.spec.kind === 'task')!; cancelledInstance.status = 'cancelled'; expect(() => validateCalendarRulesRecords(cancelled, saved.tasks, saved.events, settings)).toThrow('取消')
  })
})

describe('N09 routine stop and emergency stop for calendar generation', () => {
  it('a pending generation proposal is rejected after the routine stop or emergency stop; nothing is created until a native resume', async () => {
    const { reduceAuthority, emergencyStop, previewResume, resumeAuthorityFromUI } = await import('./automation-control')
    const state = await fixture(); await save(state)
    const pending = await prepareCalendarGeneration('2026-10-01', '2026-10-15'); expect(pending.plan.creates).toHaveLength(4)
    await reduceAuthority('routines', 'button')
    // The stop both clears in-memory proposals and refuses generation while stopped.
    await expect(applyCalendarProposalFromUI(pending, humanClick())).rejects.toThrow(/停止中|登録済みの確認案ではありません/)
    await expect(prepareCalendarGeneration('2026-10-01', '2026-10-15')).rejects.toThrow('停止中')
    expect(await db.tasks.count()).toBe(0)
    const settings = (await db.settings.get('main'))!, owner = { principal: { id: settings.profileId, kind: 'human' as const }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: [], sourceRevisions: [] }
    await resumeAuthorityFromUI(owner, humanClick(), 'routines', (await previewResume('routines')).token)
    const again = await prepareCalendarGeneration('2026-10-01', '2026-10-15')
    await emergencyStop('button')
    await expect(applyCalendarProposalFromUI(again, humanClick())).rejects.toThrow()
    expect(await db.tasks.count()).toBe(0)
    expect(changePolicyFor((await db.settings.get('main'))!).stops).toEqual({ notifications: true, routines: true })
  })
})
