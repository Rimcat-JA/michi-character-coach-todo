import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput } from './commands'
import { emptyScore } from './domain'
import { addTaskAttachment } from './materials'
import { saveTaskWithScoreProvenance } from './score-assessment-save'
import { exportBackup } from './backup'
import { createHabit, recordHabitLog } from './habits'
import { createGoal } from './goals'
import { readStorageProtection, requestStorageProtection, saveKeepingDraft, STORAGE_ABORT_MESSAGE, STORAGE_FULL_MESSAGE, storageErrorMessage, unbackedChangeCount } from './storage-status'
import { StorageProtectionCard } from './StorageProtectionView'

// fake-indexeddb has no quota; QuotaExceededError is injected at the IDBObjectStore boundary Dexie writes through.
// This is a synthetic unit check, not a real disk-full or browser-quota test.
function injectQuota(storeName: string) {
  const add = IDBObjectStore.prototype.add, put = IDBObjectStore.prototype.put
  const fail = (store: IDBObjectStore) => { if (store.name === storeName) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError') }
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) { fail(this); return add.apply(this, args) })
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) { fail(this); return put.apply(this, args) })
}
async function counts() { return { tasks: await db.tasks.count(), assessments: await db.assessments.count(), audits: await db.audits.count(), commands: await db.commands.count(), attachments: await db.taskAttachments.count(), completions: await db.completions.count(), ledger: await db.ledger.count() } }
beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('AT-N10-08 保存容量不足', () => {
  it('tasks.addの容量不足は既存DBを変えず、日本語の失敗を返し、下書きを保持する', async () => {
    const existing = await createTask({ ...newTaskInput(), title: '既存の25pt', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } })
    await completeTask(existing, 1)
    const before = await counts(), row = await db.tasks.get(existing)
    injectQuota('tasks')
    const draft = { ...newTaskInput(), title: '容量不足で保存できない下書き', notes: '入力した本文', score: { ...emptyScore(), mode: 'manual' as const, manualPoints: 0 } }
    const result = await saveKeepingDraft(draft, value => saveTaskWithScoreProvenance(null, value, null))
    expect(result).toEqual({ ok: false, draft, message: STORAGE_FULL_MESSAGE })
    if (!result.ok) expect(result.draft).toBe(draft)
    expect(draft.title).toBe('容量不足で保存できない下書き')
    vi.restoreAllMocks()
    expect(await counts()).toEqual(before)
    expect(await db.tasks.get(existing)).toEqual(row)
  })
  it('同じtransactionの後半（監査）で容量不足になっても、タスク・評価を半端に残さない', async () => {
    const before = await counts()
    injectQuota('audits')
    await expect(createTask({ ...newTaskInput(), title: '監査で失敗' })).rejects.toSatisfy(error => storageErrorMessage(error) === STORAGE_FULL_MESSAGE)
    vi.restoreAllMocks()
    expect(await counts()).toEqual(before)
  })
  it('taskAttachments.addの容量不足は添付行を作らず、既存のタスクと完了・台帳を保つ', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '添付先', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
    await completeTask(taskId, 1)
    const before = await counts(), task = await db.tasks.get(taskId)
    injectQuota('taskAttachments')
    const file = new File([new Uint8Array(1024 * 1024)], 'large.bin', { type: 'application/octet-stream' })
    let message = ''
    try { await addTaskAttachment(taskId, file) } catch (error) { message = storageErrorMessage(error) ?? '' }
    expect(message).toBe(STORAGE_FULL_MESSAGE)
    vi.restoreAllMocks()
    expect(await counts()).toEqual(before)
    expect(await db.tasks.get(taskId)).toEqual(task)
    expect((await db.ledger.toArray()).reduce((sum, entry) => sum + entry.delta, 0)).toBe(40)
  })
  it('Dexieの包んだ形・AbortErrorも判別し、無関係なエラーは置き換えない', () => {
    expect(storageErrorMessage({ name: 'AbortError', message: 'aborted', inner: { name: 'QuotaExceededError', message: '' } })).toBe(STORAGE_FULL_MESSAGE)
    expect(storageErrorMessage({ name: 'AbortError', message: 'Transaction aborted' })).toBe(STORAGE_ABORT_MESSAGE)
    expect(storageErrorMessage(new Error('別の画面で更新されました'))).toBeNull()
  })
})

describe('AT-N10-15 保存保護と未バックアップ変更', () => {
  it('最後の書き出し以降の監査・コマンド記録と、変更された本人データの行を未バックアップ変更として数える', async () => {
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: () => 'blob:synthetic', revokeObjectURL: () => undefined }))
    vi.stubGlobal('document', { createElement: () => ({ click: () => undefined }) })
    await createTask({ ...newTaskInput(), title: '一件目' })
    expect(await unbackedChangeCount(null)).toBeGreaterThanOrEqual(2)
    await exportBackup('synthetic-password')
    const settings = (await db.settings.get('main'))!
    expect(settings.lastBackupAt).not.toBeNull()
    expect(await unbackedChangeCount(settings.lastBackupAt)).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 5))
    const id = await createTask({ ...newTaskInput(), title: '二件目' })
    await completeTask(id, 1)
    expect(await unbackedChangeCount(settings.lastBackupAt)).toBeGreaterThanOrEqual(4)
    await exportBackup('synthetic-password')
    const second = (await db.settings.get('main'))!.lastBackupAt
    expect(await unbackedChangeCount(second)).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 5))
    // Habits and goals write no audit or command row; their own timestamps still count, so the card never shows 0 here.
    const auditsBefore = await db.audits.count(), commandsBefore = await db.commands.count()
    const habitId = await createHabit({ title: '読書', direction: 'increase', unit: '分', targetAmount: 20, cadence: 'daily', weekdays: [0, 1, 2, 3, 4, 5, 6], timezone: 'Asia/Tokyo', routineId: null })
    await recordHabitLog(habitId, '2026-10-01', 10)
    await createGoal({ title: '本人の目標', description: '', parentId: null, dueDate: null, containerId: null, taskIds: [], habitIds: [], manualPercent: null, checkInCadence: null, checkInQuestion: '' })
    const audits = await db.audits.count() - auditsBefore, commands = await db.commands.count() - commandsBefore
    expect(await unbackedChangeCount(second)).toBeGreaterThanOrEqual(audits + commands + 3)
    await exportBackup('synthetic-password')
    expect(await unbackedChangeCount((await db.settings.get('main'))!.lastBackupAt)).toBe(0)
  })
  it('persist拒否を表示しても入力を止めず、バックアップ導線を残す', async () => {
    const storage = { estimate: async () => ({ usage: 3 * 1024 * 1024, quota: 100 * 1024 * 1024 }), persisted: async () => false, persist: async () => false }
    expect(await readStorageProtection(storage)).toEqual({ persisted: false, usage: 3 * 1024 * 1024, quota: 100 * 1024 * 1024, requested: null })
    const denied = await requestStorageProtection(storage)
    expect(denied.requested).toBe('denied')
    const html = renderToStaticMarkup(<StorageProtectionCard protection={denied} unbacked={3} lastBackupAt={null} datasetId="0b6a4f0e-5d1c-4e2a-9f3b-2c4d5e6f7a8b" electron={false} onPersist={() => undefined} onBackup={() => undefined} />)
    expect(html).toContain('保存保護は許可されませんでした')
    expect(html).toContain('data-storage-persisted="denied"')
    expect(html).toContain('入力はこれまでどおり続けられます')
    expect(html).toContain('<button class="primary-button">バックアップを書き出す</button>')
    expect(html).toContain('3件')
    expect(html).toContain('同じPC内に置いたバックアップは故障対策になりません')
    expect(html).not.toContain('disabled')
    const unknown = await readStorageProtection(undefined)
    expect(unknown).toEqual({ persisted: null, usage: null, quota: null, requested: null })
    const granted = renderToStaticMarkup(<StorageProtectionCard protection={{ persisted: true, usage: 0, quota: 1, requested: 'granted' }} unbacked={0} lastBackupAt={new Date().toISOString()} datasetId="0b6a4f0e" electron onPersist={() => undefined} onBackup={() => undefined} />)
    expect(granted).toContain('保存保護あり')
    expect(granted).not.toContain('入力はこれまでどおり')
  })
})
