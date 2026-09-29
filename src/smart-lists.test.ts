import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTask, newTaskInput, updateTask } from './commands'
import { db, ensureSettings } from './db'
import { emptyScore, type SmartListAst } from './domain'
import { createSmartList, querySmartList, validateSmartListAst } from './smart-lists'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('Smart List', () => {
  it('15分以下かつ生活ラベルの保存済み条件が入力更新に追従する', async () => {
    const short = await createTask({ ...newTaskInput(), title: '短い生活作業', labels: ['生活'], score: { ...emptyScore(), mode: 'manual', manualPoints: 10, minutes: 12 } })
    const long = await createTask({ ...newTaskInput(), title: '長い生活作業', labels: ['生活'], score: { ...emptyScore(), mode: 'manual', manualPoints: 20, minutes: 30 } })
    const ast: SmartListAst = { type: 'all', children: [{ type: 'condition', field: 'minutes', operator: 'lte', value: 15 }, { type: 'condition', field: 'labels', operator: 'contains', value: '生活' }] }
    const id = await createSmartList('短い生活作業', ast)
    const list = (await db.smartLists.get(id))!, ownerId = (await db.settings.get('main'))!.profileId
    expect(querySmartList(list, await db.tasks.toArray(), ownerId).map(task => task.id)).toEqual([short])
    const longTask = (await db.tasks.get(long))!
    await updateTask(long, 1, { ...newTaskInput(), title: longTask.title, labels: ['生活'], score: { ...longTask.score, minutes: 15 } })
    expect(new Set(querySmartList(list, await db.tasks.toArray(), ownerId).map(task => task.id))).toEqual(new Set([short, long]))
    expect(() => querySmartList(list, [], '別の所有者')).toThrow('アクセス')
  })
  it('未知値を0扱いせず、is_unknownでだけ明示検索する', async () => {
    const id = await createTask({ ...newTaskInput(), title: '見積なし' })
    const ownerId = (await db.settings.get('main'))!.profileId
    const low = (await db.smartLists.get(await createSmartList('短い', { type: 'condition', field: 'minutes', operator: 'lte', value: 15 })))!
    const unknown = (await db.smartLists.get(await createSmartList('未設定', { type: 'condition', field: 'minutes', operator: 'is_unknown' })))!
    expect(querySmartList(low, await db.tasks.toArray(), ownerId)).toEqual([])
    expect(querySmartList(unknown, await db.tasks.toArray(), ownerId).map(task => task.id)).toEqual([id])
  })
  it('深さ5段・条件50個を上限とし、未許可の項目を拒否する', () => {
    const leaf: SmartListAst = { type: 'condition', field: 'importance', operator: 'gte', value: 2 }
    expect(() => validateSmartListAst({ type: 'all', children: Array.from({ length: 50 }, () => leaf) })).not.toThrow()
    expect(() => validateSmartListAst({ type: 'all', children: Array.from({ length: 51 }, () => leaf) })).toThrow()
    const deep = (depth: number): SmartListAst => depth === 1 ? leaf : { type: 'not', child: deep(depth - 1) }
    expect(() => validateSmartListAst(deep(5))).not.toThrow()
    expect(() => validateSmartListAst(deep(6))).toThrow()
    expect(() => validateSmartListAst({ type: 'condition', field: 'constructor', operator: 'eq', value: 'x' })).toThrow()
  })
})
