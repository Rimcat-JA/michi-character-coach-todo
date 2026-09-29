import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput, updateTask } from './commands'
import { createSmartList, removeSmartList } from './smart-lists'
import { createReminder } from './reminders'
import { customPanelTasks, dashboardSyncLabel, saveCustomScreen, saveDashboardWidgets } from './dashboard'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('ダッシュボードと分割画面', () => {
  it('ウィジェットの順序を保存し、端末単独の同期状態を偽らない', async () => {
    await saveDashboardWidgets(['sync', 'today'])
    expect((await db.settings.get('main'))?.dashboardWidgets).toEqual(['sync', 'today'])
    expect(dashboardSyncLabel()).toEqual({ value: '端末内', detail: '最終同期: なし（単独モード）' })
    await expect(saveDashboardWidgets(['today', 'today'])).rejects.toThrow('ダッシュボード')
  })
  it('両パネルは同じタスクIDを参照し、片側の編集が他方の件数と値へ反映する', async () => {
    const input = { ...newTaskInput(), title: '共有表示する作業', score: { ...newTaskInput().score, mode: 'manual' as const, manualPoints: 25 } }
    const id = await createTask(input)
    const listId = await createSmartList('表示対象', { type: 'condition', field: 'status', operator: 'eq', value: 'open' })
    await saveCustomScreen({ leftListId: listId, rightListId: listId, topListId: listId })
    const owner = (await db.settings.get('main'))!.profileId, lists = await db.smartLists.toArray()
    const before = await db.tasks.toArray(), left = customPanelTasks(listId, before, lists, owner), right = customPanelTasks(listId, before, lists, owner)
    expect(left[0]).toBe(right[0])
    expect(new Set([...left, ...right].map(task => task.id)).size).toBe(1)
    await updateTask(id, 1, { ...input, title: '編集後の作業' })
    const updated = await db.tasks.toArray()
    expect(customPanelTasks(listId, updated, lists, owner)[0].title).toBe('編集後の作業')
    expect(customPanelTasks(listId, updated, lists, owner)[0].effectivePoints).toBe(25)
    expect(await db.tasks.count()).toBe(1)
    expect(await db.ledger.count()).toBe(0)
  })
  it('Smart List削除時は分割画面の参照を外し、待機通知を止める', async () => {
    const listId = await createSmartList('削除対象', { type: 'condition', field: 'status', operator: 'eq', value: 'open' })
    await saveCustomScreen({ leftListId: listId, rightListId: listId })
    await createReminder('smart-daily', listId, '09:00')
    await removeSmartList(listId)
    const settings = await db.settings.get('main')
    expect(settings?.customScreen).toEqual({ leftListId: null, rightListId: null, topListId: null })
    expect(settings?.reminderState?.rules[0].enabled).toBe(false)
  })
})
