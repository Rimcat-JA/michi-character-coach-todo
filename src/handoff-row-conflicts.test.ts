import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import { captureSnapshot, restoreBackup } from './backup'
import { computeRowHashes } from './handoff-heads'
import { handoffReplacementGuard, inspectHandoff, replaceAfterExport, replaceWithHandoff } from './handoff'
import { exportFile, manualTask, PASSWORD, resetDevices, switchDevice } from './device-test-fixtures'

beforeEach(() => resetDevices())

async function basePair() {
  await switchDevice('A')
  const taskId = await manualTask('固定表示も守る', 25)
  const ownerId = (await db.settings.get('main'))!.profileId
  await db.taskNotes.add({ id: 'note-1', taskId, ownerId, kind: 'self', body: '基準のノート', createdAt: new Date().toISOString() })
  const first = await exportFile()
  await switchDevice('B')
  await replaceWithHandoff(first.snapshot, { confirmDifferentDataset: true })
  return { taskId, first }
}

describe('I05 全業務行の内容を比較してローカル変更を保護する', () => {
  it.each(['taskNotes', 'tasks'] as const)('同じIDの%sのローカル編集を検出する', async table => {
    const { taskId } = await basePair()
    const incoming = await exportFile()
    await switchDevice('A')
    if (table === 'tasks') await db.tasks.update(taskId, { pinned: true })
    else await db.taskNotes.update('note-1', { body: 'この端末で変更' })
    const preview = await inspectHandoff(incoming.snapshot)
    expect(preview.comparison.tasks[0].state).toBe('identical')
    expect(preview.comparison.localOnlyRows).toEqual({})
    expect(preview.comparison.rowConflicts).toContainEqual({ table, id: table === 'tasks' ? taskId : 'note-1', state: 'local_only' })
    await expect(replaceWithHandoff(incoming.snapshot)).rejects.toThrow('この端末だけの変更')
    expect(await db.taskNotes.get('note-1')).toBeDefined()
    expect(await db.ledger.count()).toBe(0)
  })

  it('両側のノート編集とこの端末での削除は要確認、取込側だけの編集は置き換え可能', async () => {
    await basePair()
    await db.taskNotes.update('note-1', { body: 'Bの変更' })
    const incoming = await exportFile()
    await switchDevice('A')
    expect((await inspectHandoff(incoming.snapshot)).comparison.blocking).toBe(false)
    await db.taskNotes.update('note-1', { body: 'Aの変更' })
    expect((await inspectHandoff(incoming.snapshot)).comparison.rowConflicts).toContainEqual({ table: 'taskNotes', id: 'note-1', state: 'both_changed' })
    await db.taskNotes.delete('note-1')
    expect((await inspectHandoff(incoming.snapshot)).comparison.rowConflicts).toContainEqual({ table: 'taskNotes', id: 'note-1', state: 'deleted_local' })
    await expect(replaceWithHandoff(incoming.snapshot)).rejects.toThrow('この端末だけの変更')
    expect(await db.taskNotes.get('note-1')).toBeUndefined()
  })

  it('旧baseのID一覧だけでは同じIDの変更元を推測しない', async () => {
    const { first } = await basePair()
    await db.taskNotes.update('note-1', { body: 'Bの変更' })
    const incoming = await exportFile()
    await switchDevice('A')
    await db.handoffHeads.update(`export:${first.snapshot.handoff!.bundle_id}`, { rowHashes: undefined })
    const comparison = (await inspectHandoff(incoming.snapshot)).comparison
    expect(comparison.rowConflicts).toContainEqual({ table: 'taskNotes', id: 'note-1', state: 'needs_review' })
    expect(comparison.blocking).toBe(true)
  })

  it('新しく比較に加えたラベル定義の同ID編集も保護する', async () => {
    await switchDevice('A')
    await manualTask('ラベル', 0)
    await db.labelDefinitions.add({ id: 'label-1', ownerId: (await db.settings.get('main'))!.profileId, groupId: null, name: '基準', createdAt: new Date().toISOString() })
    const first = await exportFile()
    await switchDevice('B'); await replaceWithHandoff(first.snapshot, { confirmDifferentDataset: true })
    const incoming = await exportFile()
    await switchDevice('A'); await db.labelDefinitions.update('label-1', { name: 'ローカル' })
    expect((await inspectHandoff(incoming.snapshot)).comparison.rowConflicts).toContainEqual({ table: 'labelDefinitions', id: 'label-1', state: 'local_only' })
    await expect(replaceWithHandoff(incoming.snapshot)).rejects.toThrow()
    expect((await db.labelDefinitions.get('label-1'))!.name).toBe('ローカル')
  })

  it('添付のBlob表現とbackupのBase64表現は同じ内容として比較する', async () => {
    await switchDevice('A')
    const taskId = await manualTask('添付', 10), ownerId = (await db.settings.get('main'))!.profileId
    const bytes = new TextEncoder().encode('同じ原本')
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    await db.taskAttachments.add({ id: 'attachment-1', taskId, ownerId, name: 'a.txt', mediaType: 'text/plain', size: bytes.length, sha256, blob: new Blob([bytes]), createdAt: new Date().toISOString() })
    const snapshot = await captureSnapshot()
    const raw = await computeRowHashes({ tasks: snapshot.tasks, completions: snapshot.completions, taskAttachments: await db.taskAttachments.toArray() })
    expect(raw.taskAttachments).toEqual((await computeRowHashes(snapshot)).taskAttachments)
    expect((await inspectHandoff(snapshot)).comparison.blocking).toBe(false)
  })
})

describe('I05 プレビュー・書き出し後の競合を置き換えtransaction内で拒否する', () => {
  it('事前確認の後に編集が入っても消去を始めない', async () => {
    const { taskId } = await basePair()
    const incoming = await exportFile()
    await switchDevice('A')
    const beforeReplace = await handoffReplacementGuard(incoming.snapshot)
    await db.tasks.update(taskId, { pinned: true })
    await expect(restoreBackup(incoming.snapshot, { beforeReplace })).rejects.toThrow('この端末だけの変更')
    expect((await db.tasks.get(taskId))!.pinned).toBe(true)
    expect((await db.taskNotes.get('note-1'))!.body).toBe('基準のノート')
  })

  it('書き出し中の変更があれば未保存の新しい値を失わない', async () => {
    await basePair()
    const incoming = await exportFile()
    await switchDevice('A')
    await expect(replaceAfterExport(incoming.snapshot, PASSWORD, async () => {
      await db.taskNotes.update('note-1', { body: '書き出し後の未保存値' })
    })).rejects.toThrow('内容が変わりました')
    expect((await db.taskNotes.get('note-1'))!.body).toBe('書き出し後の未保存値')
    expect(await db.completions.count()).toBe(0)
    expect(await db.ledger.count()).toBe(0)
  })
})
