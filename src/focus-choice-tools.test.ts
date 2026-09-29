import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTask, newTaskInput, completeTask } from './commands'
import { db, ensureSettings } from './db'
import { addTaskDependency } from './dependencies'
import { choosePair, drawRandomTask, selectRandomEligible, setSpotlight, spotlightTasks, suggestedWithReason } from './focus-tools'
import { createSmartList } from './smart-lists'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('集中候補の選択', () => {
  it('今日10件から3件だけSpotlightへ参照し、元タスクを複製しない', async () => {
    const ids: string[] = []
    for (let index = 0; index < 10; index++) ids.push(await createTask({ ...newTaskInput(), title: `今日${index}`, scheduledDate: '2026-10-01' }))
    for (const id of ids.slice(0, 3)) await setSpotlight(id, 1, true)
    await expect(setSpotlight(ids[3], 1, true)).rejects.toThrow('3件')
    expect(await db.tasks.count()).toBe(10)
    expect(spotlightTasks(await db.tasks.toArray()).map(task => task.id)).toEqual(ids.slice(0, 3))
  })
  it('候補1件の二択で同じタスクを二つ表示しない', async () => {
    const first = await createTask({ ...newTaskInput(), title: '先にやる' })
    const blocked = await createTask({ ...newTaskInput(), title: '後でやる' })
    await addTaskDependency(blocked, first)
    const choice = choosePair(await db.tasks.toArray(), '2026-10-01', await db.taskDependencies.toArray(), '2026-10-01T00:00:00.000Z')
    expect(choice.candidates.map(task => task.id)).toEqual([first])
    expect(choice.message).toContain('再計画')
  })
  it('ランダム選択はblockedを除いた集合から選び、seedと候補IDを監査に残す', async () => {
    const first = await createTask({ ...newTaskInput(), title: '実行可能' })
    const blocked = await createTask({ ...newTaskInput(), title: '依存待ち' })
    await addTaskDependency(blocked, first)
    const tasks = await db.tasks.toArray(), dependencies = await db.taskDependencies.toArray()
    const one = selectRandomEligible(tasks, '2026-10-01', dependencies, 123, '2026-10-01T00:00:00.000Z')
    const two = selectRandomEligible(tasks, '2026-10-01', dependencies, 123, '2026-10-01T00:00:00.000Z')
    expect(one.candidateIds).toEqual([first])
    expect(two.task?.id).toBe(one.task?.id)
    const drawn = await drawRandomTask(123, '2026-10-01')
    expect(drawn.task?.id).toBe(first)
    expect(JSON.parse((await db.audits.toArray()).find(audit => audit.operation === 'random_choice')!.detail)).toEqual({ seed: 123, candidateIds: [first] })
  })
  it('推薦は登録済み候補だけを返し、期限と前提完了の理由を示す', async () => {
    const predecessor = await createTask({ ...newTaskInput(), title: '前提' })
    const next = await createTask({ ...newTaskInput(), title: '期限作業', project: '執筆', dueDate: '2026-10-01', importance: 2 })
    await addTaskDependency(next, predecessor)
    await completeTask(predecessor, 1)
    const tasks = await db.tasks.toArray(), deps = await db.taskDependencies.toArray()
    const listId = await createSmartList('執筆だけ', { type: 'condition', field: 'project', operator: 'eq', value: '執筆' })
    const ownerId = (await db.settings.get('main'))!.profileId
    const list = (await db.smartLists.get(listId))!
    const recommendation = suggestedWithReason(tasks, '2026-10-01', deps, '2026-10-01T00:00:00.000Z', [], [], list, ownerId)
    expect(recommendation?.task.id).toBe(next)
    expect(recommendation?.reasons.join(' ')).toContain('期限 2026-10-01')
    expect(recommendation?.reasons).toContain('前提タスク完了済み')
    expect(recommendation?.reasons).toContain('保存条件 執筆だけ')
  })
})
