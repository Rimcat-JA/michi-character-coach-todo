import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput } from './commands'
import { containerPointTotals, createContainer, moveContainer, renameContainer } from './containers'
import { emptyScore } from './domain'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('カテゴリとプロジェクトの階層', () => {
  it('親を自分の子へ移す操作を拒否し元階層を保持する', async () => {
    const parent = await createContainer({ kind: 'category', name: '親', parentId: null })
    const child = await createContainer({ kind: 'category', name: '子', parentId: parent })
    await expect(moveContainer(parent, 1, child)).rejects.toThrow('自分または子')
    expect((await db.containers.get(parent))?.parentId).toBeNull()
    expect((await db.containers.get(child))?.parentId).toBe(parent)
  })

  it('子の10ptと20ptを親へ表示し、全体の実績は30ptのままにする', async () => {
    const parent = await createContainer({ kind: 'project', name: '親案件', parentId: null })
    const child = await createContainer({ kind: 'project', name: '子案件', parentId: parent })
    for (const value of [10, 20]) {
      const id = await createTask({ ...newTaskInput(), title: `${value}ptの作業`, containerId: child, score: { ...emptyScore(), mode: 'manual', manualPoints: value } })
      await completeTask(id, 1)
    }
    const totals = containerPointTotals(await db.containers.toArray(), await db.tasks.toArray(), await db.completions.toArray())
    expect(totals.get(child)).toBe(30)
    expect(totals.get(parent)).toBe(30)
    expect((await db.completions.toArray()).reduce((sum, value) => sum + (value.netPoints ?? 0), 0)).toBe(30)
  })

  it('移動・改名でタスクの表示経路を更新し、アクセス境界と深さ12を守る', async () => {
    const category = await createContainer({ kind: 'category', name: '生活', parentId: null })
    const project = await createContainer({ kind: 'project', name: '準備', parentId: category })
    const id = await createTask({ ...newTaskInput(), title: '買い物', containerId: project })
    await renameContainer(category, 1, '家庭')
    expect((await db.tasks.get(id))?.project).toBe('家庭 / 準備')
    await moveContainer(project, 1, null)
    expect((await db.tasks.get(id))?.project).toBe('準備')
    const other = { ...(await db.containers.get(project))!, id: crypto.randomUUID(), name: '他人', ownerId: 'other', parentId: null }
    await db.containers.add(other)
    await expect(moveContainer(project, 2, other.id)).rejects.toThrow('アクセス境界')
    let parentId: string | null = null
    for (let depth = 0; depth < 12; depth++) parentId = await createContainer({ kind: 'category', name: `階層${depth}`, parentId })
    await expect(createContainer({ kind: 'category', name: '13段目', parentId })).rejects.toThrow('12段')
  })
  it('旧DBの平坦なプロジェクト名を階層へ移行する', async () => {
    const settings = (await db.settings.get('main'))!
    await db.delete()
    const legacy = new Dexie('character-coach-v1')
    legacy.version(1).stores({ tasks: 'id, &generationKey, status, scheduledDate, dueDate, project, routineId, deletedAt, updatedAt', assessments: 'id, taskId, createdAt', completions: 'id, &taskId, currentAt', ledger: 'id, completionId, taskId, at', routines: 'id, active', sessions: 'id, taskId, startedAt', commands: 'key', audits: 'id, taskId, at', settings: 'id' })
    await legacy.open()
    await legacy.table('settings').add(settings)
    await legacy.table('tasks').add({ ...newTaskInput(), id: 'old-task', generationKey: 'old-task', routineId: null, title: '旧タスク', project: '旧案件', effectivePoints: null, assessmentId: 'old-assessment', status: 'open', revision: 1, createdAt: settings.createdAt, updatedAt: settings.createdAt, deletedAt: null })
    legacy.close()
    await db.open()
    const task = await db.tasks.get('old-task')
    const container = await db.containers.get(task!.containerId!)
    expect(container?.name).toBe('旧案件')
    expect(container?.ownerId).toBe(settings.profileId)
  })
})
