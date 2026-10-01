import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput, updateTask } from './commands'
import { snoozeTask } from './rollover'
import { createReminder, dispatchDueReminders, pendingOSReminder, setReminderPolicy, stopReminder } from './reminders'
import { coachNotificationStateFor, muteCoachNotificationTarget, prepareCoachNotificationDelivery, purgeCoachNotificationSource, queueSnoozeNotification, recordCoachNotificationDelivery, restCoachNotificationsToday, setCoachNotificationPolicy } from './coach-notification-save'
import { validateCoachNotificationState } from './coach-notifications'
import { automationRulesFor, type OperationGroup, type OperationMode } from './automation-policy'
import { changePolicyFor } from './change-set'
const clock = (hour: number, minute = 0) => new Date(2026, 9, 1, hour, minute)
const stamp = (hour: number, minute = 0) => clock(hour, minute).toISOString()
async function task(title = '通知するタスク') { return createTask({ ...newTaskInput(), title, score: { ...newTaskInput().score, mode: 'manual', manualPoints: 20 } }) }
beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings(); await db.settings.update('main', { notifications: true }); await setCoachNotificationPolicy({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) })
describe('共通通知の永続化と既存通知経路', () => {
  it('AT-K05: 今日休むと別タスクの1回・Bug Me・スヌーズの全経路を止める', async () => {
    const first = await task(), second = await task('別の催促'), third = await task('別経路')
    await createReminder('once', first, stamp(11), ['in-app', 'os'], clock(10))
    await createReminder('bug-me', second, '', ['os'], clock(10))
    await snoozeTask(third, 1, stamp(10))
    await restCoachNotificationsToday(stamp(10))
    expect(await dispatchDueReminders(clock(11))).toEqual([])
    expect(await queueSnoozeNotification(third, stamp(11))).toBeNull()
    expect((await db.settings.get('main'))!.reminderState!.rules.every(rule => rule.sentCount === 0)).toBe(true)
    expect(await db.ledger.count()).toBe(0)
  })
  it('停止後に予約済みOS通知を送らず、別宛先のqueuedも取消す', async () => {
    const id = await task(); const rule = await createReminder('once', id, stamp(11), ['in-app', 'os'], clock(10))
    const [event] = await dispatchDueReminders(clock(11)); await stopReminder(rule.id)
    expect(await pendingOSReminder(event, clock(11, 1))).toBeNull()
    const intent = (await db.settings.get('main'))!.notificationState!.intents[0]
    expect(intent.deliveries.find(item => item.destinationId === 'os')?.state).toBe('canceled')
    expect(intent.deliveries.find(item => item.destinationId === 'in-app')?.state).toBe('accepted_by_provider')
  })
  it('完了・対象版の変更・対象の通知停止を送信直前に拒否する', async () => {
    for (const action of ['complete', 'edit', 'mute'] as const) {
      const id = await task(action); await createReminder('once', id, stamp(11), ['in-app', 'os'], clock(10))
      const [event] = await dispatchDueReminders(clock(11))
      if (action === 'complete') await completeTask(id, 1)
      if (action === 'edit') { const item = (await db.tasks.get(id))!; await updateTask(id, item.revision, { ...item, title: '変更された対象' }) }
      if (action === 'mute') await muteCoachNotificationTarget(id, true, stamp(11, 1))
      expect(await pendingOSReminder(event, clock(11, 2))).toBeNull()
    }
  })
  it('共通OFF/quiet/cap変更はpendingを取消し旧設定の予約を送らない', async () => {
    const id = await task(); await createReminder('once', id, stamp(11), ['os'], clock(10))
    const [event] = await dispatchDueReminders(clock(11)); await setCoachNotificationPolicy({ enabled: false }, stamp(11))
    expect(await pendingOSReminder(event, clock(11))).toBeNull()
    expect((await db.settings.get('main'))!.notificationState!.intents[0].deliveries[0].state).toBe('canceled')
    await setCoachNotificationPolicy({ enabled: true, quietStart: '10:00', quietEnd: '12:00' }, stamp(11))
    const another = await task('静かな時間'); await createReminder('once', another, stamp(11, 1), ['os'], clock(10))
    expect(await dispatchDueReminders(clock(11, 1))).toEqual([])
  })
  it('並行したスヌーズ要求は論理ID1件・送信attempt1件にする', async () => {
    const id = await task(); await snoozeTask(id, 1, stamp(10))
    const results = await Promise.all([queueSnoozeNotification(id, stamp(11)), queueSnoozeNotification(id, stamp(11))])
    const intent = results.find(Boolean)!; expect(results.filter(Boolean)).toHaveLength(1)
    const deliveries = await Promise.all([prepareCoachNotificationDelivery(intent.id, 'os', stamp(11)), prepareCoachNotificationDelivery(intent.id, 'os', stamp(11))])
    expect(deliveries.filter(Boolean)).toHaveLength(1)
    const payload = deliveries.find(Boolean)!; await recordCoachNotificationDelivery(intent.id, 'os', 'delivery_unknown', payload.attemptId, stamp(11))
    expect(await queueSnoozeNotification(id, stamp(12))).toBeNull()
    expect(await prepareCoachNotificationDelivery(intent.id, 'os', stamp(12))).toBeNull()
    expect((await db.settings.get('main'))!.notificationState!.intents[0].deliveries[0].state).toBe('delivery_unknown')
  })
  it('OS受付を記録するが別attemptの応答は保存しない', async () => {
    const id = await task(); await createReminder('once', id, stamp(11), ['os'], clock(10))
    const [event] = await dispatchDueReminders(clock(11)), payload = (await pendingOSReminder(event, clock(11)))!
    await recordCoachNotificationDelivery(event.id, 'os', 'accepted_by_provider', 'forged-attempt', stamp(11))
    expect((await db.settings.get('main'))!.notificationState!.intents[0].deliveries[0].state).toBe('sending')
    await recordCoachNotificationDelivery(event.id, 'os', 'accepted_by_provider', payload.attemptId, stamp(11))
    expect((await db.settings.get('main'))!.notificationState!.intents[0].deliveries[0].state).toBe('accepted_by_provider')
  })
  it('スヌーズとリマインダーが同じ日次上限・対象間隔を共有する', async () => {
    await setReminderPolicy({ dailyCap: 1 })
    const first = await task(), second = await task('スヌーズ')
    await createReminder('once', first, stamp(11), ['in-app', 'os'], clock(10))
    await snoozeTask(second, 1, stamp(10))
    expect(await dispatchDueReminders(clock(11))).toHaveLength(1)
    expect(await queueSnoozeNotification(second, stamp(12))).toBeNull()
    const settings = (await db.settings.get('main'))!; expect(settings.notificationState!.policy.dailyCap).toBe(1); expect(settings.reminderState!.dailyCap).toBe(1)
    expect(() => validateCoachNotificationState(settings.notificationState, settings.profileId, settings.datasetId)).not.toThrow()
  })
  it('旧バージョンの通知履歴も共通capに含め、復元・epochの失効を検査する', async () => {
    const first = await task(), second = await task('新しい通知')
    await createReminder('once', first, stamp(11), ['in-app'], clock(10)); await dispatchDueReminders(clock(11))
    await db.settings.update('main', { notificationState: undefined })
    await setReminderPolicy({ dailyCap: 1 })
    await createReminder('once', second, stamp(12), ['os'], clock(11))
    expect(await dispatchDueReminders(clock(12))).toEqual([])
    const settings = (await db.settings.get('main'))!; expect(coachNotificationStateFor(settings).intents).toHaveLength(1)
    expect(() => validateCoachNotificationState(settings.notificationState)).not.toThrow()
  })
  it('予約とevent/rule保存の失敗を全体rollbackし、再実行で1件だけ作る', async () => {
    const id = await task(); await createReminder('once', id, stamp(11), ['in-app', 'os'], clock(10))
    const write = vi.spyOn(db.settings, 'update').mockRejectedValueOnce(new Error('保存失敗'))
    try { await expect(dispatchDueReminders(clock(11))).rejects.toThrow('保存失敗') } finally { write.mockRestore() }
    const after = (await db.settings.get('main'))!
    expect(after.notificationState!.intents).toEqual([]); expect(after.reminderState!.events).toEqual([]); expect(after.reminderState!.rules[0].sentCount).toBe(0)
    expect(await dispatchDueReminders(clock(11))).toHaveLength(1)
  })
  it('完了とpending取消は同txで保存し、取消保存失敗なら完了・台帳もrollbackする', async () => {
    const id = await task(); await createReminder('once', id, stamp(11), ['os'], clock(10)); await dispatchDueReminders(clock(11))
    const write = vi.spyOn(db.settings, 'put').mockRejectedValueOnce(new Error('取消保存失敗'))
    try { await expect(completeTask(id, 1)).rejects.toThrow('取消保存失敗') } finally { write.mockRestore() }
    expect((await db.tasks.get(id))!.status).toBe('open'); expect(await db.completions.count()).toBe(0); expect(await db.ledger.count()).toBe(0)
    expect((await db.settings.get('main'))!.notificationState!.intents[0].deliveries[0].state).toBe('queued')
    await completeTask(id, 1)
    expect((await db.settings.get('main'))!.notificationState!.intents[0].deliveries[0].state).toBe('canceled')
  })
  it('資料の削除/許可取消ではpendingを止め、受付済み通知の派生本文も匿名化する', async () => {
    const id = await task(); await createReminder('once', id, stamp(11), ['in-app', 'os'], clock(10)); await dispatchDueReminders(clock(11))
    const settings = (await db.settings.get('main'))!, state = settings.notificationState!
    state.intents[0].sourceRefs = [{ id: 'private-source', revision: 1, permissionRevision: 0 }]; state.intents[0].text.savedAI = '元資料から生成した私的な文面'
    await db.settings.put({ ...settings, notificationState: state }); await purgeCoachNotificationSource('private-source', stamp(11))
    const intent = (await db.settings.get('main'))!.notificationState!.intents[0]
    expect(intent.text).toEqual({ factual: '削除・権限変更した資料の通知', savedAI: null })
    expect(intent.deliveries.find(item => item.destinationId === 'os')?.state).toBe('canceled')
    expect(intent.deliveries.find(item => item.destinationId === 'in-app')?.state).toBe('accepted_by_provider')
  })
})
async function setOperation(operation: OperationGroup, mode: OperationMode) { const current = (await db.settings.get('main'))!, policy = changePolicyFor(current); await db.settings.put({ ...current, changePolicy: { ...policy, operations: automationRulesFor(policy).map(rule => rule.operation === operation ? { ...rule, mode } : rule) } }) }
describe('N09 notification.send gate', () => {
  it('notification.send=deny mutes reminders and snooze notifications without deleting rules or tasks', async () => {
    const id = await task(), snoozed = await task('スヌーズ')
    await createReminder('once', id, stamp(11), ['in-app', 'os'], clock(10)); await snoozeTask(snoozed, 1, stamp(10))
    await setOperation('notification.send', 'deny')
    expect(await dispatchDueReminders(clock(11))).toEqual([])
    expect(await queueSnoozeNotification(snoozed, stamp(11))).toBeNull()
    expect((await db.settings.get('main'))!.reminderState!.rules).toHaveLength(1); expect(await db.tasks.count()).toBe(2)
    await setOperation('notification.send', 'auto_within_bounds')
    expect(await dispatchDueReminders(clock(11))).toHaveLength(1)
  })
})
