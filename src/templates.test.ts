import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { addChecklistItem, toggleChecklistItem } from './checklist'
import { createTask, newTaskInput } from './commands'
import { createContainer } from './containers'
import { instantiateTemplate, saveProjectTemplate, saveTaskTemplate } from './templates'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('Saved Items', () => {
  it('同じ準備テンプレートから独立した発生回とチェック状態を作る', async () => {
    const source = await createTask({ ...newTaskInput(), title: '準備' })
    await addChecklistItem(source, '持ち物を確認')
    const templateId = await saveTaskTemplate(source, '準備')
    const first = await instantiateTemplate(templateId, 'first')
    const second = await instantiateTemplate(templateId, 'second')
    expect(first.taskIds[0]).not.toBe(second.taskIds[0])
    expect((await db.tasks.get(first.taskIds[0]))?.generationKey).not.toBe((await db.tasks.get(second.taskIds[0]))?.generationKey)
    const firstItem = (await db.checklistItems.where('taskId').equals(first.taskIds[0]).first())!
    const secondItem = (await db.checklistItems.where('taskId').equals(second.taskIds[0]).first())!
    expect(firstItem.id).not.toBe(secondItem.id)
    await toggleChecklistItem(firstItem.id, true)
    expect((await db.checklistItems.get(secondItem.id))?.done).toBe(false)
    expect(await instantiateTemplate(templateId, 'first')).toEqual(first)
    expect(await db.tasks.count()).toBe(3)
  })
  it('プロジェクト階層とタスクを複製し、実績は複製しない', async () => {
    const root = await createContainer({ kind: 'project', name: '旅行準備', parentId: null })
    const child = await createContainer({ kind: 'project', name: '予約', parentId: root })
    const original = await createTask({ ...newTaskInput(), title: '宿を予約', containerId: child })
    await addChecklistItem(original, '候補を比較')
    const templateId = await saveProjectTemplate(root, '旅行準備')
    const first = await instantiateTemplate(templateId)
    const second = await instantiateTemplate(templateId)
    expect(first.containerId).not.toBe(second.containerId)
    expect((await db.containers.get(first.containerId!))?.name).toBe('旅行準備 (2)')
    expect((await db.containers.get(second.containerId!))?.name).toBe('旅行準備 (3)')
    expect(first.taskIds).toHaveLength(1)
    expect((await db.tasks.get(first.taskIds[0]))?.status).toBe('open')
    expect(await db.completions.count()).toBe(0)
    expect((await db.tasks.get(first.taskIds[0]))?.containerId).not.toBe((await db.tasks.get(second.taskIds[0]))?.containerId)
  })
  it('同名再保存は新しい版にする', async () => {
    const source = await createTask({ ...newTaskInput(), title: '準備' })
    const one = await saveTaskTemplate(source, '定型')
    const two = await saveTaskTemplate(source, '定型')
    const first = (await db.savedTemplates.get(one))!, second = (await db.savedTemplates.get(two))!
    expect([first.version, second.version]).toEqual([1, 2])
    expect(first.familyId).toBe(second.familyId)
  })
})
