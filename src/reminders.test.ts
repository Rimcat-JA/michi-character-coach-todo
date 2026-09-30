import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput, updateTask } from './commands'
import { createSmartList } from './smart-lists'
import { createReminder, dispatchDueReminders, pendingOSReminder, setReminderPolicy, stopReminder } from './reminders'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })
const clock = (hour: number, minute = 0) => new Date(2026, 8, 29, hour, minute)
async function moveReview(taskId: string, reviewDate: string | null) {
  const task = (await db.tasks.get(taskId))!
  await updateTask(taskId, task.revision, { ...task, reviewDate })
}

describe('ローカルリマインダー', () => {
  it('見直し通知は本人の予約後にだけ出し、予定・期限・完了・実績を変えない', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '返答待ち', reviewDate: '2026-09-29', scheduledDate: '2026-10-01', dueDate: '2026-10-05', score: { ...newTaskInput().score, mode: 'manual', manualPoints: 25 } })
    const original = await db.tasks.get(taskId)
    await db.settings.update('main', { notifications: true })
    expect(await dispatchDueReminders(clock(11))).toEqual([])
    await createReminder('review', taskId, '12:00', ['in-app', 'os'], clock(11))
    const [event] = await dispatchDueReminders(clock(12))
    expect(event).toMatchObject({ kind: 'review', reviewDate: '2026-09-29', reviewRevision: 1, channels: ['in-app', 'os'] })
    expect(await pendingOSReminder(event, clock(12))).toMatchObject({ title: 'michi 通知', body: '見直し: 返答待ち', attemptId: expect.any(String), notificationId: event.id, destinationId: 'os', provenance: 'factual-template' })
    expect(await dispatchDueReminders(clock(13))).toEqual([])
    expect(await db.tasks.get(taskId)).toEqual(original)
    expect(await db.completions.count()).toBe(0)
    expect(await db.ledger.count()).toBe(0)
  })

  it('見直し日なし・不正な時刻・重複した見直し通知を拒否する', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '日付を確認' })
    await expect(createReminder('review', taskId, '09:00', ['in-app'], clock(8))).rejects.toThrow('見直し日')
    await moveReview(taskId, '2026-09-29')
    await expect(createReminder('review', taskId, '25:00', ['in-app'], clock(8))).rejects.toThrow('時刻')
    await createReminder('review', taskId, '09:00', ['in-app'], clock(8))
    await expect(createReminder('review', taskId, '10:00', ['in-app'], clock(8))).rejects.toThrow('予約済み')
  })

  it('未来の見直し日を前後に移しても変更後の日付だけに追従する', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '日付に追従', reviewDate: '2026-09-29' })
    await createReminder('review', taskId, '09:00', ['in-app'], clock(8))
    await moveReview(taskId, '2026-10-05')
    expect(await dispatchDueReminders(clock(9))).toEqual([])
    const saved = (await db.settings.get('main'))!.reminderState!.rules[0]
    expect(saved.reviewDate).toBe('2026-10-05')
    expect(saved.nextAt).toBe(new Date(2026, 9, 5, 9).toISOString())
    await moveReview(taskId, '2026-09-30')
    expect(await dispatchDueReminders(new Date(2026, 8, 30, 9))).toHaveLength(1)
    expect(await dispatchDueReminders(new Date(2026, 9, 5, 9))).toEqual([])
  })

  it('見直し日の削除は待機にし、再設定後はその日付に一度通知する', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '日付の再設定', reviewDate: '2026-09-29' })
    await createReminder('review', taskId, '09:00', ['in-app'], clock(8))
    await moveReview(taskId, null)
    expect(await dispatchDueReminders(clock(9))).toEqual([])
    expect((await db.settings.get('main'))!.reminderState!.rules[0]).toMatchObject({ enabled: true, reviewDate: null, sentCount: 0 })
    await moveReview(taskId, '2026-09-30')
    expect(await dispatchDueReminders(new Date(2026, 8, 30, 9))).toHaveLength(1)
    await moveReview(taskId, '2026-10-01')
    expect(await dispatchDueReminders(new Date(2026, 9, 1, 9))).toHaveLength(1)
    expect(await dispatchDueReminders(new Date(2026, 9, 1, 10))).toEqual([])
  })

  it('確保済みの見直し通知は日付変更・削除・停止後にOSへ送らない', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '古い見直し通知', reviewDate: '2026-09-29' })
    await db.settings.update('main', { notifications: true })
    const rule = await createReminder('review', taskId, '09:00', ['in-app', 'os'], clock(8))
    const [event] = await dispatchDueReminders(clock(9))
    await moveReview(taskId, '2026-09-30')
    expect(await dispatchDueReminders(clock(9))).toEqual([])
    expect((await db.settings.get('main'))!.reminderState!.rules[0].reviewDate).toBe('2026-09-30')
    expect(await pendingOSReminder(event, clock(9, 1))).toBeNull()
    await moveReview(taskId, '2026-09-29')
    expect(await pendingOSReminder(event, clock(9, 2))).toBeNull()
    await moveReview(taskId, null)
    expect(await pendingOSReminder(event, clock(9, 3))).toBeNull()
    await stopReminder(rule.id)
    await moveReview(taskId, '2026-09-30')
    expect(await dispatchDueReminders(new Date(2026, 8, 30, 9))).toEqual([])
  })

  it('見直し通知も静かな時間・日次上限・完了後抑止を守る', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '夜の見直し', reviewDate: '2026-09-29', score: { ...newTaskInput().score, mode: 'manual', manualPoints: 0 } })
    await db.settings.update('main', { notifications: true })
    await createReminder('review', taskId, '23:00', ['in-app', 'os'], clock(21))
    expect(await dispatchDueReminders(clock(23))).toEqual([])
    await setReminderPolicy({ dailyCap: 0 })
    expect(await dispatchDueReminders(new Date(2026, 8, 30, 8))).toEqual([])
    await setReminderPolicy({ dailyCap: 1 })
    const [event] = await dispatchDueReminders(new Date(2026, 8, 30, 8))
    expect(await pendingOSReminder(event, new Date(2026, 8, 30, 8))).not.toBeNull()
    await completeTask(taskId, 1)
    expect(await pendingOSReminder(event, new Date(2026, 8, 30, 8, 1))).toBeNull()
    expect(await dispatchDueReminders(new Date(2026, 8, 30, 9))).toEqual([])
    expect((await db.settings.get('main'))!.reminderState!.rules[0].enabled).toBe(false)
  })

  it('見直し日より前の完了でも予約を停止して通知しない', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '先に完了', reviewDate: '2026-10-05', score: { ...newTaskInput().score, mode: 'manual', manualPoints: 0 } })
    await createReminder('review', taskId, '09:00', ['in-app'], clock(8))
    await completeTask(taskId, 1)
    expect(await dispatchDueReminders(clock(9))).toEqual([])
    expect((await db.settings.get('main'))!.reminderState!.rules[0].enabled).toBe(false)
  })

  it('タスク完了後は待機中の全宛先を抑制する', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '完了する作業', score: { ...newTaskInput().score, mode: 'manual', manualPoints: 0 } })
    await db.settings.update('main', { notifications: true })
    await createReminder('once', taskId, clock(12).toISOString(), ['in-app', 'os'], clock(11))
    await completeTask(taskId, 1)
    expect(await dispatchDueReminders(clock(12))).toEqual([])
    const saved = (await db.settings.get('main'))!.reminderState!
    expect(saved.events).toEqual([])
    expect(saved.rules[0].enabled).toBe(false)
  })

  it('Bug Meの停止で待機分を全宛先に送らず、30分・3回・当日を初期値にする', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '進める作業' })
    await db.settings.update('main', { notifications: true })
    const rule = await createReminder('bug-me', taskId, '', ['in-app', 'os'], clock(10))
    expect(rule).toMatchObject({ intervalMinutes: 30, maxCount: 3, endDate: '2026-09-29' })
    const [event] = await dispatchDueReminders(clock(10, 30))
    expect(await pendingOSReminder(event, clock(10, 30))).toMatchObject({ body: '進める作業' })
    await stopReminder(rule.id)
    expect(await pendingOSReminder(event, clock(10, 31))).toBeNull()
    expect(await dispatchDueReminders(clock(11))).toEqual([])
    expect(await dispatchDueReminders(new Date(2026, 8, 30, 10))).toEqual([])
    const events = (await db.settings.get('main'))!.reminderState!.events
    expect(events).toHaveLength(1)
    expect(events[0].channels).toEqual(['in-app', 'os'])
  })

  it('通知履歴を確保した後でもタスク完了ならOSへの送出を止める', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '送出前に完了', score: { ...newTaskInput().score, mode: 'manual', manualPoints: 0 } })
    await db.settings.update('main', { notifications: true })
    await createReminder('once', taskId, clock(11).toISOString(), ['in-app', 'os'], clock(10))
    const [event] = await dispatchDueReminders(clock(11))
    expect(await pendingOSReminder(event, clock(11))).toMatchObject({ body: '送出前に完了' })
    await completeTask(taskId, 1)
    expect(await pendingOSReminder(event, clock(11, 1))).toBeNull()
  })

  it('静かな時間、日次上限、同じ対象への間隔を守る', async () => {
    const first = await createTask({ ...newTaskInput(), title: '一件目' })
    const second = await createTask({ ...newTaskInput(), title: '二件目' })
    await createReminder('once', first, clock(22).toISOString(), ['in-app'], clock(21))
    expect(await dispatchDueReminders(clock(22))).toEqual([])
    await setReminderPolicy({ dailyCap: 1 })
    expect(await dispatchDueReminders(new Date(2026, 8, 30, 8))).toHaveLength(1)
    await createReminder('once', second, new Date(2026, 8, 30, 8, 30).toISOString(), ['in-app'], new Date(2026, 8, 30, 8))
    expect(await dispatchDueReminders(new Date(2026, 8, 30, 8, 30))).toEqual([])
    expect(await dispatchDueReminders(new Date(2026, 9, 1, 8))).toHaveLength(1)
    await setReminderPolicy({ dailyCap: 6 })
    await createReminder('once', first, new Date(2026, 9, 1, 8, 10).toISOString(), ['in-app'], new Date(2026, 9, 1, 8))
    expect(await dispatchDueReminders(new Date(2026, 9, 1, 8, 10))).toHaveLength(1)
    await createReminder('once', first, new Date(2026, 9, 1, 8, 30).toISOString(), ['in-app'], new Date(2026, 9, 1, 8, 11))
    expect(await dispatchDueReminders(new Date(2026, 9, 1, 8, 30))).toEqual([])
  })

  it('Smart Listの条件が空なら送らず、次の日に該当すれば一度送る', async () => {
    await createTask({ ...newTaskInput(), title: '別の作業' })
    const listId = await createSmartList('作業候補', { type: 'condition', field: 'title', operator: 'contains', value: '合致' })
    await createReminder('smart-daily', listId, '09:00', ['in-app'], clock(8))
    expect(await dispatchDueReminders(clock(9))).toEqual([])
    await createTask({ ...newTaskInput(), title: '合致する作業' })
    expect(await dispatchDueReminders(new Date(2026, 8, 30, 9))).toHaveLength(1)
    expect(await dispatchDueReminders(new Date(2026, 8, 30, 9, 1))).toEqual([])
  })
})
