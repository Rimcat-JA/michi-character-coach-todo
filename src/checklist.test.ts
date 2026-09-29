import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput } from './commands'
import { addChecklistItem, checklistProgress, convertChecklistItem, toggleChecklistItem } from './checklist'
import { emptyScore } from './domain'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('チェックリストと配分', () => {
  it('40pt親の項目を10pt子へ変換し、両方完了でも合計40ptを維持する', async () => {
    const parentId = await createTask({ ...newTaskInput(), title: '準備', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
    const itemId = await addChecklistItem(parentId, '資料を集める')
    await toggleChecklistItem(itemId, true)
    expect(checklistProgress(await db.checklistItems.toArray())).toEqual({ done: 1, total: 1 })
    expect(await db.ledger.count()).toBe(0)
    const childId = await convertChecklistItem(itemId, 1, 10)
    expect(await convertChecklistItem(itemId, 1, 10)).toBe(childId)
    expect((await db.tasks.get(parentId))?.effectivePoints).toBe(30)
    expect((await db.tasks.get(childId))?.effectivePoints).toBe(10)
    expect(checklistProgress(await db.checklistItems.toArray())).toEqual({ done: 0, total: 0 })
    await completeTask(parentId, 2)
    await completeTask(childId, 1)
    expect((await db.ledger.toArray()).reduce((sum, entry) => sum + entry.delta, 0)).toBe(40)
  })

  it('古いrevisionと予算超過の変換では親子を変更しない', async () => {
    const parentId = await createTask({ ...newTaskInput(), title: '予算', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
    const itemId = await addChecklistItem(parentId, '一項目')
    await expect(convertChecklistItem(itemId, 1, 50)).rejects.toThrow('配分')
    await expect(convertChecklistItem(itemId, 0, 10)).rejects.toThrow('別の画面')
    expect(await db.tasks.count()).toBe(1)
    expect((await db.tasks.get(parentId))?.effectivePoints).toBe(40)
  })
})
