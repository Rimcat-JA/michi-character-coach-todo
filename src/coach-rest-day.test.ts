import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput } from './commands'
import { emptyScore } from './domain'
import { snoozeTask } from './rollover'
import { createReminder, dispatchDueReminders, pendingOSReminder } from './reminders'
import { coachNotificationGuardFor, coachNotificationStateFor, muteCoachNotificationTarget, prepareCoachNotificationDelivery, queueCoachNotification, queueSnoozeNotification, restCoachNotificationsToday, setCoachNotificationPolicy, setCoachNotificationTriggers } from './coach-notification-save'
import type { NotificationRequest } from './coach-notifications'
import { queueCalendarChangeNotifications, runCoachTriggers } from './coach-triggers'
import { reduceAuthority } from './automation-control'

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
const clock = (hour: number, minute = 0) => new Date(2026, 9, 1, hour, minute)
const stamp = (hour: number, minute = 0) => clock(hour, minute).toISOString()
async function task(title: string, patch: Partial<ReturnType<typeof newTaskInput>> = {}) { return createTask({ ...newTaskInput(), title, score: { ...emptyScore(), mode: 'manual', manualPoints: 20 }, ...patch }) }
const state = async () => coachNotificationStateFor((await db.settings.get('main'))!)
function direct(purpose: 'direct_reply' | 'focus_ended', targetId: string, revision: number): NotificationRequest {
  return { id: `${purpose}:${targetId}`, purpose, category: purpose === 'direct_reply' ? 'reply' : 'timer', target: { kind: 'task', id: targetId, revision }, ruleId: `${purpose}:rule`, ruleRevision: '1', ruleWindow: stamp(11), notBefore: stamp(11), expiresAt: stamp(23), destinationIds: ['in-app'], sourceRefs: [], text: { factual: purpose === 'direct_reply' ? '本人の質問への返信' : '本人が始めたタイマーの終了', savedAI: null }, intervalMinutes: null, maxCount: null, endDate: null }
}
beforeEach(async () => {
  await db.delete(); await db.open(); await ensureSettings()
  await db.settings.update('main', { notifications: true }); await setCoachNotificationPolicy({ timezone: zone })
})

describe('AT-K05 本人が休止した日は別triggerを使っても催促しない', () => {
  it('休む前の予約はepoch更新で取消・送信直前に拒否し、休んだ後は全producerが予約時点で拒否される', async () => {
    const once = await task('1回通知'), review = await task('見直し', { reviewDate: '2026-10-01' }), bugMe = await task('Bug Me'), snoozed = await task('スヌーズ'), moved = await task('公式変更で移動', { scheduledDate: '2026-10-05' })
    await task('期限', { dueDate: '2026-10-02' }); await task('過ぎた予定', { scheduledDate: '2026-09-30' })
    await db.smartLists.add({ id: 'list', ownerId: (await db.settings.get('main'))!.profileId, name: '未完了', ast: { type: 'condition', field: 'status', operator: 'eq', value: 'open' }, revision: 1, createdAt: stamp(9), updatedAt: stamp(9) })
    await setCoachNotificationTriggers({ deadlineNear: { enabled: true, leadDays: 1, time: '09:00', os: true }, replanPrompt: { enabled: true, time: '09:00', os: true }, calendarChange: { enabled: true, os: true } })
    // Reserved before the rest: OS deliveries still queued.
    await createReminder('once', once, stamp(10), ['in-app', 'os'], clock(9, 50))
    const [early] = await dispatchDueReminders(clock(10))
    const triggered = await runCoachTriggers({}, stamp(10))
    expect(triggered.map(intent => intent.purpose).sort()).toEqual(['deadline_near', 'plan_changed'])
    const pending = [early.id, ...triggered.map(intent => intent.id)]
    // Producers scheduled for later today.
    await createReminder('once', once, stamp(11), ['in-app', 'os'], clock(10))
    await createReminder('review', review, '11:00', ['in-app', 'os'], clock(10))
    await createReminder('bug-me', bugMe, '', ['in-app', 'os'], clock(10))
    await createReminder('smart-daily', 'list', '11:00', ['in-app', 'os'], clock(10))
    await snoozeTask(snoozed, 1, stamp(10, 30))
    const epoch = (await state()).policy.epoch
    await restCoachNotificationsToday(stamp(10, 5))
    const rested = await state()
    expect(rested.policy.epoch).toBe(epoch + 1)
    for (const id of pending) {
      expect(rested.intents.find(intent => intent.id === id)!.deliveries.find(item => item.destinationId === 'os')?.state).toBe('canceled')
      expect(await prepareCoachNotificationDelivery(id, 'os', stamp(10, 6))).toBeNull()
    }
    expect(await pendingOSReminder(early, clock(10, 6))).toBeNull()
    const notify = vi.fn(async () => true), notificationText = vi.fn(async () => 'AI文')
    const producers: [string, () => Promise<unknown>][] = [
      ['reminder/review/bug-me/smart-daily', () => dispatchDueReminders(clock(11))],
      ['snooze plan_changed', () => queueSnoozeNotification(snoozed, stamp(11))],
      ['deadline_near / replan prompt', () => runCoachTriggers({ notify, notificationText }, stamp(11))],
      ['official calendar plan_changed', () => queueCalendarChangeNotifications('proposal', [{ taskId: moved, title: '公式変更で移動', revision: 1, from: '2026-10-05', to: '2026-10-06' }], stamp(11))],
    ]
    const before = (await state()).intents.length
    for (const [, run] of producers) expect(await run()).toSatisfy((value: unknown) => value === null || Array.isArray(value) && value.length === 0)
    expect((await state()).intents.length).toBe(before)
    expect(notify).not.toHaveBeenCalled(); expect(notificationText).not.toHaveBeenCalled()
    // Replies to the person and timers they started are separate kinds, but a muted target is still honored.
    const settings = (await db.settings.get('main'))!, target = (await db.tasks.get(once))!
    for (const purpose of ['direct_reply', 'focus_ended'] as const) {
      const request = direct(purpose, once, target.revision)
      expect(await queueCoachNotification(request, coachNotificationGuardFor(settings, { ...request.target, active: true }, { id: request.ruleId, revision: '1', active: true, sentCount: 0 }), stamp(11))).not.toBeNull()
    }
    await muteCoachNotificationTarget(once, true, stamp(11, 1))
    const muted = (await db.settings.get('main'))!, request = { ...direct('direct_reply', once, target.revision), id: 'direct_reply:again', ruleWindow: stamp(12) }
    expect(await queueCoachNotification(request, coachNotificationGuardFor(muted, { ...request.target, active: true }, { id: request.ruleId, revision: '1', active: true, sentCount: 0 }), stamp(12))).toBeNull()
  })
  it('休みを解除しない限り同じ日の後の時刻・別の送信先でも予約しない（翌日は通常判定）', async () => {
    await task('期限', { dueDate: '2026-10-02' })
    await setCoachNotificationTriggers({ deadlineNear: { enabled: true, leadDays: 1, time: '09:00', os: false } })
    await restCoachNotificationsToday(stamp(8, 30))
    for (const at of [stamp(9), stamp(15), stamp(21, 59)]) expect(await runCoachTriggers({}, at)).toEqual([])
    expect(await runCoachTriggers({}, new Date(2026, 9, 2, 9).toISOString())).toHaveLength(1)
  })
})

describe('N09 の通知停止スイッチを事実triggerにも使う（別の停止機構を作らない）', () => {
  it('停止スイッチで待機中の期限・再計画通知を取り消し、停止中は期限・公式変更・再計画を予約もAI文面生成もしない', async () => {
    await task('期限', { dueDate: '2026-10-02' }); await task('過ぎた予定', { scheduledDate: '2026-09-30' })
    const moved = await task('公式変更で移動', { scheduledDate: '2026-10-05' })
    await setCoachNotificationTriggers({ deadlineNear: { enabled: true, leadDays: 1, time: '09:00', os: true }, replanPrompt: { enabled: true, time: '09:00', os: true }, calendarChange: { enabled: true, os: true }, aiText: true })
    const pending = await runCoachTriggers({}, stamp(10))
    expect(pending).toHaveLength(2)
    await reduceAuthority('notifications', 'tray')
    for (const intent of pending) expect(await prepareCoachNotificationDelivery(intent.id, 'os', stamp(10, 1))).toBeNull()
    const notify = vi.fn(async () => true), notificationText = vi.fn(async () => 'AI文')
    expect(await runCoachTriggers({ notify, notificationText }, new Date(2026, 9, 2, 10).toISOString())).toEqual([])
    expect(await queueCalendarChangeNotifications('proposal', [{ taskId: moved, title: '公式変更で移動', revision: 1, from: '2026-10-05', to: '2026-10-06' }], stamp(11))).toEqual([])
    expect(notify).not.toHaveBeenCalled(); expect(notificationText).not.toHaveBeenCalled()
    const audit = (await db.audits.toArray()).find(item => item.operation === 'automation.stop')
    expect(JSON.parse(audit!.detail)).toMatchObject({ scope: 'notifications', origin: 'tray' })
  })
  it('notification.send を deny にした自動化設定でも事実triggerは予約しない', async () => {
    await task('期限', { dueDate: '2026-10-02' })
    await setCoachNotificationTriggers({ deadlineNear: { enabled: true, leadDays: 1, time: '09:00', os: false } })
    const settings = (await db.settings.get('main'))!
    const { changePolicyFor } = await import('./change-set'), { automationRulesFor } = await import('./automation-policy')
    const policy = changePolicyFor(settings), rules = automationRulesFor(policy).map(rule => rule.operation === 'notification.send' ? { ...rule, mode: 'deny' as const } : rule)
    await db.settings.put({ ...settings, changePolicy: { ...policy, operations: rules } })
    expect(await runCoachTriggers({}, stamp(10))).toEqual([])
  })
})
