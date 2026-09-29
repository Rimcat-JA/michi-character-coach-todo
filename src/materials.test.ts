import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput } from './commands'
import { addTaskAttachment, addTaskComment, addTaskNote, getTaskAttachment } from './materials'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('タスクの資料', () => {
  it('ノート・コメント・添付を別資源へ保存し、権限外の添付閲覧を拒否する', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '資料確認' })
    const dangerous = '<img src=x onerror="window.hacked=true"><script>throw 1</script>'
    await addTaskNote(taskId, dangerous, 'source')
    await addTaskComment(taskId, dangerous)
    const attachmentId = await addTaskAttachment(taskId, new File(['private content'], 'private.html', { type: 'text/html' }))
    expect((await db.taskNotes.get((await db.taskNotes.toArray())[0].id))?.kind).toBe('source')
    expect((await db.taskComments.toArray())[0].body).toBe(dangerous)
    await expect(getTaskAttachment(attachmentId, 'another-person')).rejects.toThrow('アクセス権')
    const ownerId = (await ensureSettings()).profileId
    const attachment = await getTaskAttachment(attachmentId, ownerId)
    expect(attachment.blob.type).toBe('application/octet-stream')
    expect(await attachment.blob.text()).toBe('private content')
  })
  it('壊れた添付と5MB超過を拒否する', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '資料' })
    await expect(addTaskAttachment(taskId, new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.bin'))).rejects.toThrow('5MB')
    const id = await addTaskAttachment(taskId, new File(['ok'], '../unsafe.html', { type: 'text/html' }))
    expect((await db.taskAttachments.get(id))?.name).not.toContain('/')
    await db.taskAttachments.update(id, { sha256: '0'.repeat(64) })
    await expect(getTaskAttachment(id, (await ensureSettings()).profileId)).rejects.toThrow('ハッシュ')
  })
})
