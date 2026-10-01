import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput, updateTask } from './commands'
import { emptyScore } from './domain'
import { createSmartList } from './smart-lists'
import { createReminder, dispatchDueReminders, setReminderPolicy } from './reminders'
import { effectiveNetworkPolicy, setNetworkPolicy } from './runtime-profile'
import { catchUpRoutines } from './routine-catchup'

// AT-N10-24 as a synthetic clock jump (vi.setSystemTime) on fake-indexeddb. It is not a device left offline for 400 days.
const T0 = new Date(2026, 9, 1, 8, 0)
const later = (days: number, hour = 8) => { const value = new Date(T0); value.setDate(value.getDate() + days); value.setHours(hour, 0, 0, 0); return value }
beforeEach(async () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0); await db.delete(); await db.open(); await ensureSettings(); await setNetworkPolicy('offline_only') })
afterEach(() => { vi.useRealTimers() })

describe('AT-N10-24 単独モードで長期間ネット不使用', () => {
  it.each([30, 400])('+%i日後も閲覧専用化・オンライン認証を求めず、作成・編集・完了できる', async days => {
    const kept = await createTask({ ...newTaskInput(), title: '前から残る作業', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } })
    const before = (await db.settings.get('main'))!
    vi.setSystemTime(later(days))
    const settings = await ensureSettings()
    expect(settings).toEqual(before)
    expect(effectiveNetworkPolicy(settings)).toEqual({ policy: 'offline_only', source: 'profile' })
    expect(Object.keys(settings).filter(key => /lock|readonly|read_only|auth|login|expire|license/i.test(key))).toEqual([])
    const id = await createTask({ ...newTaskInput(), title: `${days}日後の作業`, score: { ...emptyScore(), mode: 'manual', manualPoints: 0 } })
    await updateTask(id, 1, { ...newTaskInput(), title: `${days}日後に編集`, score: { ...emptyScore(), mode: 'manual', manualPoints: 0 } })
    await completeTask(id, 2)
    await completeTask(kept, 1)
    expect((await db.completions.toArray()).map(row => row.netPoints).sort()).toEqual([0, 25])
    expect((await db.ledger.toArray()).reduce((sum, row) => sum + row.delta, 0)).toBe(25)
    expect((await catchUpRoutines(later(days))).created).toBe(0)
  })
  it('+400日後のsmart-dailyは溜まった回数ではなく一度だけ通知する', async () => {
    await createTask({ ...newTaskInput(), title: '合致する作業' })
    const listId = await createSmartList('毎朝の候補', { type: 'condition', field: 'title', operator: 'contains', value: '合致' })
    await createReminder('smart-daily', listId, '09:00', ['in-app'], T0)
    expect(await dispatchDueReminders(later(0, 9))).toHaveLength(1)
    vi.setSystemTime(later(400, 9))
    expect(await dispatchDueReminders(later(400, 9))).toHaveLength(1)
    expect(await dispatchDueReminders(later(400, 10))).toEqual([])
    expect((await db.settings.get('main'))!.reminderState!.events).toHaveLength(2)
  })
  it('+400日後に期限切れの予約がまとめて来ても日次上限を超えない', async () => {
    await setReminderPolicy({ dailyCap: 3 })
    for (let index = 0; index < 8; index++) {
      const id = await createTask({ ...newTaskInput(), title: `予約${index}` })
      await createReminder('once', id, later(1, 9).toISOString(), ['in-app'], T0)
    }
    vi.setSystemTime(later(400, 9))
    const first = await dispatchDueReminders(later(400, 9))
    expect(first.length).toBeLessThanOrEqual(3)
    expect(first.length).toBeGreaterThan(0)
    const sameDay = await dispatchDueReminders(later(400, 12))
    expect(first.length + sameDay.length).toBeLessThanOrEqual(3)
  })
})
