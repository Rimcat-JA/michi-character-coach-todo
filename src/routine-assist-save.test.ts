import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { calendarFixture, monthlyRule } from './calendar-test-fixtures'
import { contentDigest } from './canonical'
import { parseRoutineAssistAnswer, type RoutineAssistInput } from './routine-assist'
import { confirmRoutineInstructionFromUI } from './routine-instruction'
import { applyRoutineAssistConfigurationFromUI, cancelRoutineAssistance, clearRoutineAssistanceAuthority, prepareRoutineAssistConfiguration, prepareSourceRoutineConfiguration } from './routine-assist-save'
import { applyCalendarProposalFromUI, clearCalendarRulesAuthority, prepareCalendarGeneration } from './calendar-rules-save'
import { completeTask } from './commands'
import { changePolicyFor } from './change-set'

beforeEach(async () => { clearRoutineAssistanceAuthority(); clearCalendarRulesAuthority(); await db.delete(); await db.open(); await ensureSettings(); const settings = (await db.settings.get('main'))!; await db.settings.put({ ...settings, aiEnabled: true, aiModel: 'synthetic/model' }); const state = calendarFixture(); state.ownerId = settings.profileId; state.datasetId = settings.datasetId; state.bindings[0].personId = settings.profileId; state.activities = []; state.bindings[0].activityIds = []; await db.calendarRules.put(state) })
afterEach(() => { clearRoutineAssistanceAuthority(); clearCalendarRulesAuthority(); vi.restoreAllMocks(); vi.useRealTimers() })
const click = () => { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
function input(): RoutineAssistInput { return { message: '毎月第2営業日に勤怠提出を作って。10pt', referenceDate: '2026-10-01', targetRuleId: null, expectedRuleRevision: null, selection: { contextId: 'company', bindingId: 'self', calendarId: 'business', activityId: null, timezone: 'Asia/Tokyo', validFrom: '2026-01-01', validTo: '2026-12-31', time: '09:00', stepKind: 'task', durationMinutes: null, scheduledOffsetDays: 0, dueOffsetDays: null }, scope: { kind: 'all_uncompleted' } } }
async function candidate(selected = input(), manualPoints: number | null = 10) { return parseRoutineAssistAnswer(JSON.stringify({ title_quote: selected.targetRuleId ? null : '勤怠提出', recurrence_quote: '毎月第2営業日', trigger: { kind: 'monthly_business', ordinal: 2, from: 'start', time: '09:00' }, manual_points: manualPoints, reason: '本人の周期' }), selected, (await db.calendarRules.get('main'))!) }
async function prepare(selected = input(), manualPoints: number | null = 10) { const value = await candidate(selected, manualPoints); return prepareRoutineAssistConfiguration(await confirmRoutineInstructionFromUI(selected, value, 'synthetic/model', click())) }
async function snapshot() { return { rules: await db.calendarRules.toArray(), tasks: await db.tasks.toArray(), events: await db.calendarEvents.toArray(), assessments: await db.assessments.toArray(), completions: await db.completions.toArray(), ledger: await db.ledger.toArray(), commands: await db.commands.toArray(), audits: await db.audits.toArray() } }
async function generate(from = '2026-10-01', to = '2026-12-31') { const value = await prepareCalendarGeneration(from, to); await applyCalendarProposalFromUI(value, click()); return value }

describe('周期補助は共通の設定・生成承認を通す', () => {
  it('設定・次の10回を確認してもタスク0、設定の確認後も生成確認までは0、再送で重複なし', async () => {
    const initial = await snapshot(), prepared = await prepare(); expect(prepared.configuration.preview).toHaveLength(10); expect(await snapshot()).toEqual(initial)
    await expect(applyRoutineAssistConfigurationFromUI(prepared, prepared.digest, new Event('click'))).rejects.toThrow('本人')
    const ruleId = await applyRoutineAssistConfigurationFromUI(prepared, prepared.digest, click()); expect((await db.calendarRules.get('main'))?.rules[0].id).toBe(ruleId); expect(await db.tasks.count()).toBe(0)
    const saved = await snapshot(); expect(await applyRoutineAssistConfigurationFromUI(prepared, prepared.digest, click())).toBe(ruleId); expect(await snapshot()).toEqual(saved)
    const plan = await generate(); expect(plan.plan.creates).toHaveLength(3); expect(await db.tasks.count()).toBe(3); expect(await db.ledger.count()).toBe(0)
    expect((await db.assessments.toArray()).every(value => value.origin === 'routine')).toBe(true)
    expect((await db.audits.toArray()).filter(value => value.operation === 'create').every(value => /ルーティン/.test(value.detail))).toBe(true)
    expect((await prepareCalendarGeneration('2026-10-01', '2026-12-31')).plan.creates).toHaveLength(0)
  })
  it('AIoffの本人手動経路はnative設定保存まで完了でき、モデルなしの由来を残す', async () => {
    await db.settings.update('main', { aiEnabled: false }); const value = await candidate(), instruction = await confirmRoutineInstructionFromUI(value.input, value, null, click()), prepared = await prepareRoutineAssistConfiguration(instruction)
    const ruleId = await applyRoutineAssistConfigurationFromUI(prepared, prepared.digest, click()); expect((await db.calendarRules.get('main'))?.rules[0].id).toBe(ruleId); expect(await db.tasks.count()).toBe(0)
    const audit = (await db.audits.toArray()).find(value => value.operation === 'routine.assistance.approved')!
    expect(JSON.parse(audit.detail)).toMatchObject({ origin: 'manual', model: null, approvedBy: instruction.ownerId })
  })
  it('会社の休日・土曜営業を同じresolverで照合し、国民祝日へ置換しない', async () => {
    const state = (await db.calendarRules.get('main'))!
    state.facts = [{ id: 'holiday', kind: 'closed', calendarId: 'business', date: '2026-10-02', sourceId: 'calendar', contextId: 'company', revision: 1, validity: 'active', supersedes: [] }, { id: 'saturday-open', kind: 'open', calendarId: 'business', date: '2026-10-03', sourceId: 'calendar', contextId: 'company', revision: 1, validity: 'active', supersedes: [] }]
    await db.calendarRules.put(state); const prepared = await prepare(); expect(prepared.configuration.preview.find(value => value.scheduledDate?.startsWith('2026-10'))?.scheduledDate).toBe('2026-10-03')
    await applyRoutineAssistConfigurationFromUI(prepared, prepared.digest, click()); await generate('2026-10-01', '2026-10-31'); expect((await db.tasks.toArray())[0].scheduledDate).toBe('2026-10-03')
  })
  it('他の系列で全体first10が埋まっていても、今回の系列の次の10回をプレビューする', async () => {
    const state = (await db.calendarRules.get('main'))!
    state.rules = [monthlyRule({ id: 'existing-weekly', trigger: { kind: 'weekly', weekdays: [1, 3, 5], time: '08:00' } })]
    await db.calendarRules.put(state); const prepared = await prepare(), ruleId = prepared.configuration.next.rules.find(value => value.id !== 'existing-weekly')!.id
    expect(prepared.configuration.preview).toHaveLength(10); expect(prepared.configuration.preview.every(value => value.ruleId === ruleId)).toBe(true)
    expect(prepared.configuration.preview.map(value => value.scheduledDate).slice(0, 2)).toEqual(['2026-01-02', '2026-02-03'])
  })
  it.each(['this_instance', 'this_and_future', 'all_uncompleted'] as const)('%s変更でも完了時ポイント・台帳を保護し、再展開の二重作成なし', async kind => {
    const prepared = await prepare(); await applyRoutineAssistConfigurationFromUI(prepared, prepared.digest, click()); await generate()
    const tasks = (await db.tasks.toArray()).sort((a, b) => a.scheduledDate!.localeCompare(b.scheduledDate!)); await completeTask(tasks[0].id, tasks[0].revision)
    const completed = await db.tasks.get(tasks[0].id), ledger = await db.ledger.toArray(), completions = await db.completions.toArray(), state = (await db.calendarRules.get('main'))!, rule = state.rules[0]
    const selected = input(); selected.message = '毎月第2営業日の必要ポイントを30ptに変更して'; selected.targetRuleId = rule.id; selected.expectedRuleRevision = rule.revision
    selected.scope = kind === 'this_instance' ? { kind, generationKey: state.instances.find(value => value.entityId === tasks[1].id)!.generationKey } : kind === 'this_and_future' ? { kind, fromDate: tasks[1].scheduledDate! } : { kind }
    const changed = await prepare(selected, 30); await applyRoutineAssistConfigurationFromUI(changed, changed.digest, click()); const plan = await generate()
    expect(await db.tasks.get(tasks[0].id)).toEqual(completed); expect(await db.ledger.toArray()).toEqual(ledger); expect(await db.completions.toArray()).toEqual(completions)
    expect((await db.tasks.get(tasks[1].id))?.effectivePoints).toBe(30); expect((await db.tasks.get(tasks[2].id))?.effectivePoints).toBe(kind === 'this_instance' ? 10 : 30)
    expect(plan.plan.skippedCompleted).toBe(1); expect(await db.tasks.count()).toBe(3)
    expect((await prepareCalendarGeneration('2026-10-01', '2026-12-31')).plan).toMatchObject({ creates: [], updates: [], cancels: [] })
  })
  it('設定確認後の競合・AI停止・失効でouter/innerどちらも不変更', async () => {
    const prepared = await prepare(), initial = await snapshot(); await db.settings.update('main', { aiEnabled: false })
    await expect(applyRoutineAssistConfigurationFromUI(prepared, prepared.digest, click())).rejects.toThrow('AI設定'); await expect(applyCalendarProposalFromUI(prepared.configuration, click())).rejects.toThrow('AI設定'); expect(await snapshot()).toEqual(initial)
    await db.settings.update('main', { aiEnabled: true }); const state = (await db.calendarRules.get('main'))!; await db.calendarRules.put({ ...state, revision: state.revision + 1 }); const stale = await snapshot()
    await expect(applyCalendarProposalFromUI(prepared.configuration, click())).rejects.toThrow('版'); expect(await snapshot()).toEqual(stale)
  })
  it.each(['binding', 'calendar', 'context', 'fact', 'source'] as const)('globalrevision同値でも%sの実値変更をnative低層apply前に拒否する', async kind => {
    const prepared = await prepare(), state = (await db.calendarRules.get('main'))!
    if (kind === 'binding') state.bindings[0].confirmed = false
    if (kind === 'calendar') state.calendars[0].weekdays = [1, 2, 3, 4, 5, 6]
    if (kind === 'context') state.contexts[0].timezone = 'UTC'
    if (kind === 'fact') state.facts.push({ id: 'late-holiday', kind: 'closed', calendarId: 'business', date: '2026-10-02', sourceId: 'calendar', contextId: 'company', revision: 1, validity: 'active', supersedes: [] })
    if (kind === 'source') state.sources[0].bodyHash = 'b'.repeat(64)
    await db.calendarRules.put(state); const changed = await snapshot()
    await expect(applyCalendarProposalFromUI(prepared.configuration, click())).rejects.toThrow('根拠が変わりました'); expect(await snapshot()).toEqual(changed)
  })
  it('AI変更案の受付停止を反映直前に検査し、手動設定は継続できる', async () => {
    const prepared = await prepare(), current = (await db.settings.get('main'))!, before = await snapshot()
    await db.settings.put({ ...current, changePolicy: { ...changePolicyFor(current), aiChangesEnabled: false } })
    await expect(applyCalendarProposalFromUI(prepared.configuration, click())).rejects.toThrow('AI設定'); expect(await snapshot()).toEqual(before)
    const value = await candidate(), manual = await prepareRoutineAssistConfiguration(await confirmRoutineInstructionFromUI(value.input, value, null, click()))
    expect(await applyRoutineAssistConfigurationFromUI(manual, manual.digest, click())).toBeTruthy(); expect(await db.tasks.count()).toBe(0)
  })
  it('無関係な系列の実値が同globalrevisionで変更されても古い全体設定で上書きしない', async () => {
    const state = (await db.calendarRules.get('main'))!; state.rules = [monthlyRule({ id: 'unrelated-rule' })]; await db.calendarRules.put(state)
    const prepared = await prepare(), latest = (await db.calendarRules.get('main'))!; latest.rules[0].steps[0].title = '後から本人が訂正した作業'; await db.calendarRules.put(latest); const changed = await snapshot()
    await expect(applyCalendarProposalFromUI(prepared.configuration, click())).rejects.toThrow('設定全体'); expect(await snapshot()).toEqual(changed)
  })
  it('copiedJSON・digest差し替え・取消・authority消去から適用権限を復活させない', async () => {
    const prepared = await prepare(), initial = await snapshot()
    await expect(applyRoutineAssistConfigurationFromUI(structuredClone(prepared), prepared.digest, click())).rejects.toThrow('登録済み')
    await expect(applyRoutineAssistConfigurationFromUI(prepared, 'a'.repeat(64), click())).rejects.toThrow('登録済み')
    cancelRoutineAssistance(prepared); await expect(applyCalendarProposalFromUI(prepared.configuration, click())).rejects.toThrow('登録済み'); expect(await snapshot()).toEqual(initial)
    const another = await prepare(); clearRoutineAssistanceAuthority(); await expect(applyCalendarProposalFromUI(another.configuration, click())).rejects.toThrow('本人確認'); expect(await snapshot()).toEqual(initial)
  })
  it('source guardはlowlevel applyでも同じtx内で再検査する', async () => {
    const value = await candidate(), sourceCheck = vi.fn(async () => {}), prepared = await prepareSourceRoutineConfiguration(value.input, value, 'synthetic/model', { assertCurrent: sourceCheck, businessKey: 'source-business', candidateKey: 'source-candidate', detail: { sourceSha256: 'a'.repeat(64) } }, click()), initial = await snapshot()
    sourceCheck.mockRejectedValueOnce(new Error('資料許可が取り消されました'))
    await expect(applyCalendarProposalFromUI(structuredClone(prepared.configuration), click())).rejects.toThrow('資料許可'); expect(await snapshot()).toEqual(initial)
    const ruleId = await applyCalendarProposalFromUI(prepared.configuration, click()); expect((await db.commands.get('source-business'))?.resultId).toBe(ruleId); expect((await db.commands.get('source-candidate'))?.resultId).toBe(ruleId)
    expect((await db.calendarRules.get('main'))?.rules[0].originBasis).toBe('user_approved_rule'); expect(await db.tasks.count()).toBe(0)
    expect(JSON.stringify(await db.audits.toArray())).not.toContain(value.input.message)
  })
  it('同じ根拠の別検出runも既存系列へ戻し、同じ候補の変更再採用を拒否する', async () => {
    const value = await candidate(), guard = { assertCurrent: async () => {}, businessKey: 'same-business', candidateKey: 'first-candidate', detail: { hash: 'a'.repeat(64) } }
    const first = await prepareSourceRoutineConfiguration(value.input, value, 'synthetic/model', guard, click()), ruleId = await applyRoutineAssistConfigurationFromUI(first, first.digest, click())
    const again = await prepareSourceRoutineConfiguration(value.input, value, 'synthetic/model', { ...guard, candidateKey: 'new-run-candidate' }, click()); expect(await applyCalendarProposalFromUI(again.configuration, click())).toBe(ruleId); expect((await db.calendarRules.get('main'))?.rules).toHaveLength(1)
    const changed = structuredClone(value); changed.input.selection.time = '10:00'; if (changed.definition.trigger.kind !== 'activity_relative') changed.definition.trigger.time = '10:00'
    const altered = await prepareSourceRoutineConfiguration(changed.input, changed, 'synthetic/model', { ...guard, businessKey: 'different-business' }, click()), before = await snapshot()
    await expect(applyCalendarProposalFromUI(altered.configuration, click())).rejects.toThrow('同じ検出候補'); expect(await snapshot()).toEqual(before)
  })
  it('最後の根拠receipt失敗でも設定・監査・receiptをすべてrollbackする', async () => {
    const value = await candidate(), prepared = await prepareSourceRoutineConfiguration(value.input, value, 'synthetic/model', { assertCurrent: async () => {}, businessKey: 'late-business', detail: {} }, click()), initial = await snapshot(), original = db.commands.add.bind(db.commands)
    vi.spyOn(db.commands, 'add').mockImplementation((row, key) => row.key === 'late-business' ? Promise.reject(new Error('late failure')) as never : original(row, key))
    await expect(applyRoutineAssistConfigurationFromUI(prepared, prepared.digest, click())).rejects.toThrow('late failure'); expect(await snapshot()).toEqual(initial)
    const { digest, ...payload } = prepared; expect(digest).toBe(await contentDigest(payload))
  })
})
