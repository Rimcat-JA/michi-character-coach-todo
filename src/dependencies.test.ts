import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput } from './commands'
import { createContainer } from './containers'
import { addTaskDependency, executableTasks, projectNextStepStatus } from './dependencies'
import { suggestedTasks } from './planning'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('依存関係と次の一歩', () => {
  it('A→B→CにC→Aを加える循環を拒否し、A完了でBだけ解放する', async () => {
    const a = await createTask({ ...newTaskInput(), title: 'A' })
    const b = await createTask({ ...newTaskInput(), title: 'B' })
    const c = await createTask({ ...newTaskInput(), title: 'C' })
    await addTaskDependency(b, a)
    await addTaskDependency(c, b)
    await expect(addTaskDependency(a, c)).rejects.toThrow('循環')
    expect(await db.taskDependencies.count()).toBe(2)
    expect(executableTasks(await db.tasks.toArray(), await db.taskDependencies.toArray()).map(task => task.title)).toEqual(['A'])
    await completeTask(a, 1)
    expect(suggestedTasks(await db.tasks.toArray(), '2026-10-01', 3, await db.taskDependencies.toArray()).map(task => task.title)).toEqual(['B'])
  })
  it('タスクなし案件だけを案内し、全件完了案件と区別する', async () => {
    const empty = await createContainer({ kind: 'project', name: '空の案件', parentId: null })
    const done = await createContainer({ kind: 'project', name: '済んだ案件', parentId: null })
    const taskId = await createTask({ ...newTaskInput(), title: '完了済み', containerId: done })
    await completeTask(taskId, 1)
    const status = projectNextStepStatus(await db.containers.toArray(), await db.tasks.toArray(), [])
    expect(status.get(empty)).toBe('empty')
    expect(status.get(done)).toBe('all_done')
  })
})
