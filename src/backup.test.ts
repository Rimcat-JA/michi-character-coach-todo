import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput, completeTask, correctCompletion, undoCompletion } from './commands'
import { emptyScore } from './domain'
import { createContainer } from './containers'
import { addChecklistItem, convertChecklistItem } from './checklist'
import { createLabelDefinition, createLabelGroup } from './labels'
import { instantiateTemplate, saveTaskTemplate } from './templates'
import { addTaskAttachment, addTaskComment, addTaskNote, getTaskAttachment } from './materials'
import { addTaskDependency } from './dependencies'
import { inspectBackup, restoreBackup } from './backup'
import { validateSnapshot, type Snapshot } from './backup-validation'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

async function snapshot(): Promise<Snapshot> {
  const attachments = await Promise.all((await db.taskAttachments.toArray()).map(async ({ blob, ...item }) => ({ ...item, contentBase64: btoa(Array.from(new Uint8Array(await blob.arrayBuffer()), value => String.fromCharCode(value)).join('')) })))
  return {
    format: 'coachbundle', version: 1, exportedAt: new Date().toISOString(),
    tasks: await db.tasks.toArray(), assessments: await db.assessments.toArray(),
    completions: await db.completions.toArray(), ledger: await db.ledger.toArray(),
    routines: await db.routines.toArray(), sessions: await db.sessions.toArray(),
    commands: await db.commands.toArray(), audits: await db.audits.toArray(),
    settings: await db.settings.toArray(), containers: await db.containers.toArray(), checklistItems: await db.checklistItems.toArray(), labelGroups: await db.labelGroups.toArray(), labelDefinitions: await db.labelDefinitions.toArray(), savedTemplates: await db.savedTemplates.toArray(), taskNotes: await db.taskNotes.toArray(), taskComments: await db.taskComments.toArray(), taskAttachments: attachments, taskDependencies: await db.taskDependencies.toArray()
  }
}

describe('バックアップの復元前検証', () => {
  it('有効な実績と取消履歴を復元できる', async () => {
    const input = { ...newTaskInput(), title: '復元するタスク', score: { ...emptyScore(), mode: 'manual' as const, manualPoints: 20 } }
    const id = await createTask(input)
    await completeTask(id, 1)
    await correctCompletion(id, 25, '実績を訂正')
    await undoCompletion(id, 2)
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    await db.tasks.clear()
    await restoreBackup(saved)
    expect((await db.tasks.get(id))?.title).toBe('復元するタスク')
    expect((await db.ledger.toArray()).reduce((sum, entry) => sum + entry.delta, 0)).toBe(0)
  })

  it('台帳の不一致を拒否し現在のデータを保持する', async () => {
    const id = await createTask({ ...newTaskInput(), title: '保護対象', score: { ...emptyScore(), mode: 'manual', manualPoints: 20 } })
    await completeTask(id, 1)
    const corrupt = await snapshot()
    corrupt.ledger[0].delta = 99
    await expect(restoreBackup(corrupt)).rejects.toThrow('台帳の合計')
    expect((await db.tasks.get(id))?.title).toBe('保護対象')
    expect((await db.ledger.toArray())[0].delta).toBe(20)
  })

  it('重複キー、欠落した評価、不正な日時を拒否する', async () => {
    await createTask({ ...newTaskInput(), title: '一件目' })
    await createTask({ ...newTaskInput(), title: '二件目' })
    const valid = await snapshot()
    const duplicate = structuredClone(valid)
    duplicate.tasks[1].generationKey = duplicate.tasks[0].generationKey
    expect(() => validateSnapshot(duplicate)).toThrow('重複')
    const missing = structuredClone(valid)
    missing.assessments = []
    expect(() => validateSnapshot(missing)).toThrow('評価参照')
    const badDate = structuredClone(valid)
    badDate.tasks[0].createdAt = 'yesterday'
    expect(() => validateSnapshot(badDate)).toThrow('履歴')
  })
  it('認証情報のような未対応設定を取り込まない', async () => {
    const data = await snapshot()
    const injected = { ...data, settings: [{ ...data.settings[0], apiKey: 'synthetic-test-only' }] }
    expect(() => validateSnapshot(injected)).toThrow('未対応の項目')
  })
  it('version付きJSONを検証して復元候補を返す', async () => {
    await createTask({ ...newTaskInput(), title: 'JSONの対象' })
    const data = await snapshot()
    const file = new File([JSON.stringify(data)], 'portable.json', { type: 'application/json' })
    const inspected = await inspectBackup(file, '')
    expect(inspected.tasks[0].title).toBe('JSONの対象')
    expect(inspected.format).toBe('coachbundle')
  })
  it('階層付きタスクを復元し参照を保つ', async () => {
    const parent = await createContainer({ kind: 'category', name: '生活', parentId: null })
    const child = await createContainer({ kind: 'project', name: '買い物', parentId: parent })
    const id = await createTask({ ...newTaskInput(), title: '食品を買う', containerId: child })
    const saved = await snapshot()
    await db.containers.clear(); await db.tasks.clear()
    await restoreBackup(saved)
    expect((await db.tasks.get(id))?.containerId).toBe(child)
    expect((await db.containers.get(child))?.parentId).toBe(parent)
  })
  it('配分済みチェック項目と子タスクを一緒に復元する', async () => {
    const parent = await createTask({ ...newTaskInput(), title: '親', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
    const item = await addChecklistItem(parent, '子にする項目')
    const child = await convertChecklistItem(item, 1, 10)
    const saved = await snapshot()
    await db.checklistItems.clear(); await db.tasks.clear()
    await restoreBackup(saved)
    expect((await db.checklistItems.get(item))?.convertedTaskId).toBe(child)
    expect((await db.tasks.get(parent))?.effectivePoints).toBe(30)
    expect((await db.tasks.get(child))?.effectivePoints).toBe(10)
  })
  it('singleグループを保持して復元し、二値指定の破損を拒否する', async () => {
    const group = await createLabelGroup('場所', 'single')
    await createLabelDefinition('家', group); await createLabelDefinition('外', group)
    const id = await createTask({ ...newTaskInput(), title: '準備', labels: ['家'] })
    const saved = await snapshot()
    const corrupt = structuredClone(saved)
    corrupt.tasks[0].labels = ['家', '外']
    await expect(restoreBackup(corrupt)).rejects.toThrow('1つだけ')
    await db.labelGroups.clear(); await db.labelDefinitions.clear(); await db.tasks.clear()
    await restoreBackup(saved)
    expect((await db.labelGroups.get(group))?.selectionMode).toBe('single')
    expect((await db.tasks.get(id))?.labels).toEqual(['家'])
  })
  it('保存済みテンプレートを復元して新しい発生回を作る', async () => {
    const source = await createTask({ ...newTaskInput(), title: '準備' })
    await addChecklistItem(source, '持ち物')
    const template = await saveTaskTemplate(source, '準備')
    const saved = await snapshot()
    await db.savedTemplates.clear()
    await restoreBackup(saved)
    expect((await db.savedTemplates.get(template))?.version).toBe(1)
    const created = await instantiateTemplate(template)
    expect((await db.checklistItems.where('taskId').equals(created.taskIds[0]).first())?.done).toBe(false)
  })
  it('ノート・コメント・添付の内容とハッシュを検証して復元する', async () => {
    const task = await createTask({ ...newTaskInput(), title: '資料' })
    await addTaskNote(task, '**確認**', 'self'); await addTaskComment(task, '確認しました')
    const id = await addTaskAttachment(task, new File(['contents'], 'memo.txt', { type: 'text/plain' }))
    const saved = await snapshot()
    const corrupt = structuredClone(saved)
    corrupt.taskAttachments![0].contentBase64 = btoa('tampered')
    await expect(restoreBackup(corrupt)).rejects.toThrow('ハッシュ')
    expect(await db.taskAttachments.count()).toBe(1)
    await db.taskAttachments.clear(); await db.taskNotes.clear(); await db.taskComments.clear()
    await restoreBackup(saved)
    expect((await db.taskNotes.toArray())[0].body).toBe('**確認**')
    expect((await db.taskComments.toArray())[0].body).toBe('確認しました')
    expect((await getTaskAttachment(id, (await ensureSettings()).profileId)).name).toBe('memo.txt')
  })
  it('依存関係を復元し、循環するバックアップは拒否する', async () => {
    const a = await createTask({ ...newTaskInput(), title: 'A' }), b = await createTask({ ...newTaskInput(), title: 'B' })
    await addTaskDependency(b, a)
    const saved = await snapshot()
    const corrupt = structuredClone(saved)
    corrupt.taskDependencies!.push({ id: crypto.randomUUID(), taskId: a, dependsOnId: b, createdAt: new Date().toISOString() })
    await expect(restoreBackup(corrupt)).rejects.toThrow('循環')
    await db.taskDependencies.clear()
    await restoreBackup(saved)
    expect((await db.taskDependencies.toArray())[0]).toMatchObject({ taskId: b, dependsOnId: a })
  })
})
