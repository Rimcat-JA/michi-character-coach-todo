import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput, updateTask } from './commands'
import { emptyScore } from './domain'
import { createReminder, dispatchDueReminders } from './reminders'
import { coachNotificationGuardFor, coachNotificationStateFor, muteCoachNotificationTarget, prepareCoachNotificationDelivery, queueCoachNotification, restCoachNotificationsToday, setCoachNotificationPolicy, setCoachNotificationTriggers } from './coach-notification-save'
import { defaultCoachNotificationPolicy, reserveCoachNotification, type NotificationRequest } from './coach-notifications'
import { deadlineNearRequests, runCoachTriggers, type OSNotificationPayload } from './coach-triggers'
import { defaultSourcePermissions, importLocalSource, setSourcePermissions } from './source-library'
import { calendarFixture, monthlyRule } from './calendar-test-fixtures'
import { applyCalendarProposalFromUI, clearCalendarRulesAuthority, prepareCalendarConfiguration, prepareCalendarGeneration, prepareCalendarScheduleImport } from './calendar-rules-save'

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
const clock = (hour: number, minute = 0, day = 1) => new Date(2026, 9, day, hour, minute)
const stamp = (hour: number, minute = 0, day = 1) => clock(hour, minute, day).toISOString()
const deadline = { enabled: true, leadDays: 1, time: '09:00', os: true }
function humanClick() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
async function task(title = '週次報告書', dueDate: string | null = '2026-10-02') { return createTask({ ...newTaskInput(), title, dueDate, scheduledDate: '2026-10-01', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } }) }
const intents = async () => coachNotificationStateFor((await db.settings.get('main'))!).intents
beforeEach(async () => {
  clearCalendarRulesAuthority(); await db.delete(); await db.open(); await ensureSettings()
  await db.settings.update('main', { notifications: true }); await setCoachNotificationPolicy({ timezone: zone })
})
afterEach(() => { vi.useRealTimers(); clearCalendarRulesAuthority() })

describe('N07 期限が近い事実の通知（deadline_near）', () => {
  it('既定OFF。期限前日に1件だけ予約し、同じ窓では重複せず、OS受付は到着と区別して記録する', async () => {
    const id = await task(), notify = vi.fn(async (_payload: OSNotificationPayload) => true)
    expect(await runCoachTriggers({ notify }, stamp(9, 30))).toEqual([])
    await setCoachNotificationTriggers({ deadlineNear: deadline })
    expect(await runCoachTriggers({ notify }, stamp(8, 30))).toEqual([])
    const [intent] = await runCoachTriggers({ notify }, stamp(9, 30))
    expect(intent).toMatchObject({ purpose: 'deadline_near', category: 'proactive', target: { kind: 'task', id }, ruleWindow: '2026-10-02', text: { factual: '期限が近いタスク: 週次報告書（期限 2026-10-02）', savedAI: null } })
    expect(notify).toHaveBeenCalledTimes(1); expect(notify.mock.calls[0][0]).toMatchObject({ body: intent.text.factual, provenance: 'factual-template' })
    expect(await runCoachTriggers({ notify }, stamp(9, 45))).toEqual([])
    const saved = await intents()
    expect(saved).toHaveLength(1)
    expect(saved[0].deliveries.map(item => [item.destinationId, item.state])).toEqual([['in-app', 'accepted_by_provider'], ['os', 'accepted_by_provider']])
    expect(notify).toHaveBeenCalledTimes(1)
  })
  it('完了で待機中のOS通知を取り消し、送信直前にも拒否する', async () => {
    const id = await task(); await setCoachNotificationTriggers({ deadlineNear: deadline })
    const [intent] = await runCoachTriggers({}, stamp(9, 30))
    expect((await intents())[0].deliveries.find(item => item.destinationId === 'os')?.state).toBe('queued')
    await completeTask(id, 1)
    expect(await prepareCoachNotificationDelivery(intent.id, 'os', stamp(9, 31))).toBeNull()
    expect((await intents())[0].deliveries.find(item => item.destinationId === 'os')?.state).toBe('canceled')
    expect(await runCoachTriggers({}, stamp(11))).toEqual([])
  })
  it('期限を変えると旧い予約は送らず、新しい期限の窓で（同じ対象の間隔後に）予約し直す', async () => {
    const id = await task(); await setCoachNotificationTriggers({ deadlineNear: deadline })
    const [old] = await runCoachTriggers({}, stamp(9, 30)), current = (await db.tasks.get(id))!
    await updateTask(id, current.revision, { ...current, dueDate: '2026-10-01' })
    expect(await prepareCoachNotificationDelivery(old.id, 'os', stamp(9, 35))).toBeNull()
    expect(await runCoachTriggers({}, stamp(9, 40))).toEqual([])
    const [renewed] = await runCoachTriggers({}, stamp(10, 31))
    expect(renewed).toMatchObject({ ruleWindow: '2026-10-01', text: { factual: '期限が近いタスク: 週次報告書（期限 2026-10-01）' } })
  })
  it('静かな時間は拒否し、終了後・有効期限内なら予約する', async () => {
    await task(); await setCoachNotificationTriggers({ deadlineNear: deadline }); await setCoachNotificationPolicy({ quietStart: '09:00', quietEnd: '10:00' })
    expect(await runCoachTriggers({}, stamp(9, 30))).toEqual([])
    expect(await runCoachTriggers({}, stamp(10))).toHaveLength(1)
  })
  it.each(['rest', 'mute', 'stop'] as const)('今日は休む・対象停止・すべて停止(%s)で予約しない', async mode => {
    const id = await task(); await setCoachNotificationTriggers({ deadlineNear: deadline })
    if (mode === 'rest') await restCoachNotificationsToday(stamp(9))
    if (mode === 'mute') await muteCoachNotificationTarget(id, true, stamp(9))
    if (mode === 'stop') await setCoachNotificationPolicy({ enabled: false }, stamp(9))
    const notify = vi.fn(async () => true)
    expect(await runCoachTriggers({ notify }, stamp(9, 30))).toEqual([])
    expect(notify).not.toHaveBeenCalled(); expect(await intents()).toEqual([])
  })
  it('共通の1日上限を別のきっかけ（リマインダー）と共有する', async () => {
    const id = await task(), other = await task('別のリマインダー', null)
    await setCoachNotificationPolicy({ dailyCap: 1 }); await setCoachNotificationTriggers({ deadlineNear: deadline })
    await createReminder('once', other, stamp(9), ['in-app'], clock(8, 30))
    expect(await dispatchDueReminders(clock(9))).toHaveLength(1)
    expect(await runCoachTriggers({}, stamp(9, 30))).toEqual([])
    expect((await intents()).some(intent => intent.target.id === id)).toBe(false)
  })
  it('未接続のメッセンジャーは許可済みでも送れず、OSとメッセンジャーの同報も拒否する', async () => {
    await task(); await setCoachNotificationTriggers({ deadlineNear: deadline })
    const destinations = [...defaultCoachNotificationPolicy(zone).destinations, { id: 'line', channel: 'messenger' as const, label: 'LINE（合成）', approved: true, shared: false, permissionRevision: 0 }]
    await setCoachNotificationPolicy({ destinations })
    const settings = (await db.settings.get('main'))!, [request] = deadlineNearRequests(await db.tasks.toArray(), coachNotificationStateFor(settings).triggers!, settings, stamp(9, 30), zone)
    const viaMessenger: NotificationRequest = { ...request, destinationIds: ['in-app', 'line'] }
    expect(await queueCoachNotification(viaMessenger, coachNotificationGuardFor(settings, { ...request.target, active: true }, { id: request.ruleId, revision: request.ruleRevision, active: true, sentCount: 0 }), stamp(9, 30))).toBeNull()
    const broadcast: NotificationRequest = { ...request, destinationIds: ['os', 'line'] }, guard = { ...coachNotificationGuardFor(settings, { ...request.target, active: true }, { id: request.ruleId, revision: request.ruleRevision, active: true, sentCount: 0 }), availableDestinationIds: ['in-app', 'os', 'line'] }
    expect(reserveCoachNotification(coachNotificationStateFor(settings), broadcast, guard, stamp(9, 30)).decision).toEqual({ allowed: false, reason: '同じ通知を複数の外部サービスへ同報できません' })
  })
  it('資料由来の期限は資料に結び付け、通知許可の取消で待機中を取り消し本文を匿名化する', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clock(9, 20))
    const id = await task('資料で検出した提出'), settings = (await db.settings.get('main'))!
    const sourceId = await importLocalSource({ title: '合成資料', provider: 'slack', externalId: 'synthetic-1', conversation: null, author: null, sourceUrl: null, date: '2026-10-01', fromDate: '2026-09-01', toDate: '2026-10-01', text: '提出は10月2日まで', permissions: { ...defaultSourcePermissions(), notify: true }, allowedModels: [], retentionUntil: null })
    await db.taskSourceEvidence.add({ id: 'evidence', ownerId: settings.profileId, datasetId: settings.datasetId, taskId: id, sourceId, snapshotRevision: 1, permissionRevision: 1, spanId: 's1', quote: '提出は10月2日まで', quoteSha256: 'a'.repeat(64), supports: ['dueDate'], runId: 'run', candidateId: 'candidate', createdAt: stamp(9) })
    await setCoachNotificationTriggers({ deadlineNear: deadline })
    const [intent] = await runCoachTriggers({}, stamp(9, 30))
    expect(intent.sourceRefs.map(ref => ref.id)).toEqual([sourceId])
    await setSourcePermissions(sourceId, 1, defaultSourcePermissions(), [], null)
    const saved = (await intents())[0]
    expect(saved.text).toEqual({ factual: '削除・権限変更した資料の通知', savedAI: null })
    expect(saved.deliveries.find(item => item.destinationId === 'os')?.state).toBe('canceled')
    expect(await prepareCoachNotificationDelivery(intent.id, 'os', stamp(9, 31))).toBeNull()
  })
})

describe('N07 公式カレンダー変更の事実通知（plan_changed）', () => {
  const closed = (date: string) => ({ format: 'coach-schedule-facts', version: 1, source: { id: 'calendar', title: '会社の正式暦', authorityScope: 'calendar', coverageFrom: '2026-01-01', coverageTo: '2026-12-31', revision: 2 }, facts: [{ id: 'closed', revision: 2, kind: 'closed', calendarId: 'business', date, validity: 'active', supersedes: [] }] })
  async function setup() {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clock(10))
    const settings = (await db.settings.get('main'))!, state = calendarFixture()
    state.ownerId = settings.profileId; state.datasetId = settings.datasetId; state.bindings.forEach(binding => { binding.personId = settings.profileId }); state.rules = [monthlyRule()]
    const { contexts, bindings, calendars, activities, sources, facts, rules } = state
    await applyCalendarProposalFromUI(await prepareCalendarConfiguration({ contexts, bindings, calendars, activities, sources, facts, rules }, state.revision, '2026-10-01', '2026-10-31'), humanClick())
    await applyCalendarProposalFromUI(await prepareCalendarGeneration('2026-10-01', '2026-10-31'), humanClick())
    await applyCalendarProposalFromUI(await prepareCalendarScheduleImport('company', closed('2026-10-02'), '2026-10-01', '2026-10-31'), humanClick())
  }
  it('本人が承認した公式変更で動いたタスクごとに1件だけ、事実の定型文で予約する', async () => {
    await setup(); await setCoachNotificationTriggers({ calendarChange: { enabled: true, os: false } })
    const before = (await db.tasks.toArray())[0]
    expect(before.scheduledDate).toBe('2026-10-02')
    const plan = await prepareCalendarGeneration('2026-10-01', '2026-10-31')
    expect(plan.plan.updates.length).toBeGreaterThan(0)
    await applyCalendarProposalFromUI(plan, humanClick())
    const moved = (await db.tasks.get(before.id))!
    expect(moved.scheduledDate).not.toBe('2026-10-02')
    const notices = (await intents()).filter(intent => intent.purpose === 'plan_changed')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ target: { kind: 'task', id: before.id, revision: moved.revision }, text: { factual: `公式カレンダーの変更で予定日を変更: ${moved.title} 2026-10-02→${moved.scheduledDate}` }, destinationIds: ['in-app'] })
    expect(notices[0].deliveries[0].state).toBe('accepted_by_provider')
    await applyCalendarProposalFromUI(plan, humanClick())
    expect((await intents()).filter(intent => intent.purpose === 'plan_changed')).toHaveLength(1)
  })
  it('きっかけがOFFなら公式変更は適用するが通知しない', async () => {
    await setup()
    await applyCalendarProposalFromUI(await prepareCalendarGeneration('2026-10-01', '2026-10-31'), humanClick())
    expect((await db.tasks.toArray())[0].scheduledDate).not.toBe('2026-10-02')
    expect(await intents()).toEqual([])
  })
})
