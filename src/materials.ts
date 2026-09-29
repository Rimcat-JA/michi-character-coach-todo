import { db, ensureSettings } from './db'
import { uid } from './domain'

const now = () => new Date().toISOString()
async function ownedTask(taskId: string) {
  const settings = await ensureSettings(), task = await db.tasks.get(taskId)
  if (!task || task.deletedAt) throw new Error('タスクにアクセスできません')
  return settings.profileId
}
function body(text: string, max: number) {
  const clean = text.trim()
  if (!clean || clean.length > max) throw new Error(`本文は1〜${max}文字で入力してください`)
  return clean
}
export async function addTaskNote(taskId: string, text: string, kind: 'self' | 'source') {
  const ownerId = await ownedTask(taskId)
  if (kind !== 'self' && kind !== 'source') throw new Error('ノートの種類が不正です')
  const note = { id: uid(), taskId, ownerId, kind, body: body(text, 50000), createdAt: now() }
  await db.taskNotes.add(note)
  return note.id
}
export async function addTaskComment(taskId: string, text: string) {
  const ownerId = await ownedTask(taskId)
  const comment = { id: uid(), taskId, ownerId, body: body(text, 10000), createdAt: now() }
  await db.taskComments.add(comment)
  return comment.id
}
function safeName(value: string) {
  const name = [...value.replace(/[\\/:*?"<>|]/g, '_')].map(char => char.charCodeAt(0) < 32 ? '_' : char).join('').trim()
  if (!name || name.length > 200) throw new Error('添付ファイル名が不正です')
  return name
}
export async function addTaskAttachment(taskId: string, file: File) {
  const ownerId = await ownedTask(taskId)
  if (!file || !Number.isInteger(file.size) || file.size < 1 || file.size > 5 * 1024 * 1024) throw new Error('添付は1バイト〜5MBにしてください')
  const name = safeName(file.name), bytes = await file.arrayBuffer()
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('')
  const attachment = { id: uid(), taskId, ownerId, name, mediaType: file.type.slice(0, 120), size: file.size, sha256: hash, blob: new Blob([bytes], { type: 'application/octet-stream' }), createdAt: now() }
  await db.taskAttachments.add(attachment)
  return attachment.id
}
export async function getTaskAttachment(id: string, actorId: string) {
  const item = await db.taskAttachments.get(id), settings = await ensureSettings()
  if (!item || item.ownerId !== actorId || actorId !== settings.profileId) throw new Error('添付へのアクセス権がありません')
  await ownedTask(item.taskId)
  if (item.blob.size !== item.size) throw new Error('添付ファイルが破損しています')
  const bytes = await item.blob.arrayBuffer()
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('')
  if (hash !== item.sha256) throw new Error('添付ファイルのハッシュが一致しません')
  return { name: item.name, blob: item.blob }
}
export async function downloadTaskAttachment(id: string) {
  const settings = await ensureSettings(), { name, blob } = await getTaskAttachment(id, settings.profileId)
  const url = URL.createObjectURL(blob), anchor = document.createElement('a')
  anchor.href = url; anchor.download = name; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
