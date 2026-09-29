import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput } from './commands'
import { createSmartList } from './smart-lists'
import { createReminder, dispatchDueReminders, pendingOSReminder, setReminderPolicy, stopReminder } from './reminders'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })
const clock = (hour: number, minute = 0) => new Date(2026, 8, 29, hour, minute)

describe('ローカルリマインダー', () => {
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
