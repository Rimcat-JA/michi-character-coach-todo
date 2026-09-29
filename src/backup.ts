import { db } from './db'
import { validateSnapshot, type Snapshot } from './backup-validation'
import { tasksToCsv, tasksToIcs } from './data-export'
import type { TaskAttachment } from './domain'

type Envelope = { format: 'coachbundle-encrypted'; version: 1; kdf: 'PBKDF2-SHA256'; iterations: 250000; cipher: 'AES-256-GCM'; salt: string; iv: string; data: string }
const bytes = (s: string) => new TextEncoder().encode(s)
const b64 = (a: Uint8Array) => btoa(Array.from(a, x => String.fromCharCode(x)).join(''))
const fromB64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))
function download(content: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
const dateStamp = () => new Date().toISOString().slice(0, 10)
async function key(password: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey('raw', bytes(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 250000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
async function captureSnapshot(): Promise<Snapshot> {
  let attachmentRows: TaskAttachment[] = []
  const snapshot: Snapshot = await db.transaction('r', [db.tasks, db.assessments, db.completions, db.ledger, db.routines, db.sessions, db.commands, db.audits, db.settings, db.containers, db.checklistItems, db.labelGroups, db.labelDefinitions, db.savedTemplates, db.taskNotes, db.taskComments, db.taskAttachments, db.taskDependencies, db.planningBuckets, db.timeBlocks, db.calendarEvents, db.rollovers, db.themeRules, db.smartLists, db.focusSelections, db.habits, db.habitLogs], async () => {
    attachmentRows = await db.taskAttachments.toArray()
    return {
      format: 'coachbundle', version: 1, exportedAt: new Date().toISOString(), tasks: await db.tasks.toArray(), assessments: await db.assessments.toArray(), completions: await db.completions.toArray(), ledger: await db.ledger.toArray(), routines: await db.routines.toArray(), sessions: await db.sessions.toArray(), commands: await db.commands.toArray(), audits: await db.audits.toArray(), settings: await db.settings.toArray(), containers: await db.containers.toArray(), checklistItems: await db.checklistItems.toArray(), labelGroups: await db.labelGroups.toArray(), labelDefinitions: await db.labelDefinitions.toArray(), savedTemplates: await db.savedTemplates.toArray(), taskNotes: await db.taskNotes.toArray(), taskComments: await db.taskComments.toArray(), taskAttachments: [], taskDependencies: await db.taskDependencies.toArray(), planningBuckets: await db.planningBuckets.toArray(), timeBlocks: await db.timeBlocks.toArray(), calendarEvents: await db.calendarEvents.toArray(), rollovers: await db.rollovers.toArray(), themeRules: await db.themeRules.toArray(), smartLists: await db.smartLists.toArray(), focusSelections: await db.focusSelections.toArray(), habits: await db.habits.toArray(), habitLogs: await db.habitLogs.toArray()
    }
  })
  snapshot.taskAttachments = await Promise.all(attachmentRows.map(async ({ blob, ...metadata }) => ({ ...metadata, contentBase64: b64(new Uint8Array(await blob.arrayBuffer())) })))
  validateSnapshot(snapshot)
  return snapshot
}
export async function exportBackup(password: string) {
  if (password.length < 10) throw new Error('バックアップのパスワードは10文字以上にしてください')
  const snapshot = await captureSnapshot()
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(password, salt), bytes(JSON.stringify(snapshot))))
  const envelope: Envelope = { format: 'coachbundle-encrypted', version: 1, kdf: 'PBKDF2-SHA256', iterations: 250000, cipher: 'AES-256-GCM', salt: b64(salt), iv: b64(iv), data: b64(data) }
  download(JSON.stringify(envelope), `character-coach-${dateStamp()}.coachbundle`, 'application/json')
  await db.settings.update('main', { lastBackupAt: new Date().toISOString() })
}
export async function exportPortableJson() {
  download(JSON.stringify(await captureSnapshot(), null, 2), `character-coach-${dateStamp()}.json`, 'application/json')
}
export async function exportTasksCsv() {
  download(`\uFEFF${tasksToCsv(await db.tasks.toArray())}`, `michi-tasks-${dateStamp()}.csv`, 'text/csv;charset=utf-8')
}
export async function exportTasksIcs() {
  download(tasksToIcs(await db.tasks.toArray()), `michi-tasks-${dateStamp()}.ics`, 'text/calendar;charset=utf-8')
}
export async function inspectBackup(file: File, password: string): Promise<Snapshot> {
  if (file.size > 50 * 1024 * 1024) throw new Error('50MBを超えるファイルは読み込めません')
  const e: unknown = JSON.parse(await file.text())
  if (!e || typeof e !== 'object') throw new Error('対応していない暗号化形式です')
  if ((e as Snapshot).format === 'coachbundle') { validateSnapshot(e); return e }
  const envelope = e as Envelope
  if (envelope.format !== 'coachbundle-encrypted' || envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== 250000 || envelope.cipher !== 'AES-256-GCM' || typeof envelope.salt !== 'string' || typeof envelope.iv !== 'string' || typeof envelope.data !== 'string') throw new Error('対応していない暗号化形式です')
  if (!password) throw new Error('暗号化バックアップのパスワードを入力してください')
  let plain: ArrayBuffer
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(envelope.iv) as BufferSource }, await key(password, fromB64(envelope.salt)), fromB64(envelope.data) as BufferSource) }
  catch { throw new Error('パスワードが違うか、ファイルが破損しています') }
  const snapshot: unknown = JSON.parse(new TextDecoder().decode(plain))
  validateSnapshot(snapshot)
  return snapshot
}
export async function restoreBackup(snapshot: Snapshot) {
  validateSnapshot(snapshot)
  const names = snapshot.containers === undefined ? [...new Set(snapshot.tasks.map(task => task.project.trim()).filter(Boolean))] : []
  const at = new Date().toISOString(), ownerId = snapshot.settings[0].profileId
  const legacyContainers = names.map(name => ({ id: crypto.randomUUID(), parentId: null, kind: 'project' as const, name, ownerId, revision: 1, createdAt: at, updatedAt: at, deletedAt: null }))
  const byName = new Map(legacyContainers.map(container => [container.name, container.id]))
  const prepared: Snapshot = snapshot.containers === undefined ? { ...snapshot, containers: legacyContainers, tasks: snapshot.tasks.map(task => ({ ...task, containerId: task.project.trim() ? byName.get(task.project.trim()) : null })) } : snapshot
  validateSnapshot(prepared)
  const attachments: TaskAttachment[] = await Promise.all((prepared.taskAttachments ?? []).map(async ({ contentBase64, ...metadata }) => {
    const bytes = fromB64(contentBase64)
    if (bytes.length !== metadata.size) throw new Error('添付のサイズが一致しません')
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('')
    if (hash !== metadata.sha256) throw new Error('添付のハッシュが一致しません')
    return { ...metadata, blob: new Blob([bytes], { type: 'application/octet-stream' }) }
  }))
  await db.transaction('rw', [db.tasks, db.assessments, db.completions, db.ledger, db.routines, db.sessions, db.commands, db.audits, db.settings, db.containers, db.checklistItems, db.labelGroups, db.labelDefinitions, db.savedTemplates, db.taskNotes, db.taskComments, db.taskAttachments, db.taskDependencies, db.planningBuckets, db.timeBlocks, db.calendarEvents, db.rollovers, db.themeRules, db.smartLists, db.focusSelections, db.habits, db.habitLogs], async () => {
    await Promise.all([db.tasks.clear(), db.assessments.clear(), db.completions.clear(), db.ledger.clear(), db.routines.clear(), db.sessions.clear(), db.commands.clear(), db.audits.clear(), db.settings.clear(), db.containers.clear(), db.checklistItems.clear(), db.labelGroups.clear(), db.labelDefinitions.clear(), db.savedTemplates.clear(), db.taskNotes.clear(), db.taskComments.clear(), db.taskAttachments.clear(), db.taskDependencies.clear(), db.planningBuckets.clear(), db.timeBlocks.clear(), db.calendarEvents.clear(), db.rollovers.clear(), db.themeRules.clear(), db.smartLists.clear(), db.focusSelections.clear(), db.habits.clear(), db.habitLogs.clear()])
    await db.tasks.bulkAdd(prepared.tasks); await db.assessments.bulkAdd(prepared.assessments); await db.completions.bulkAdd(prepared.completions); await db.ledger.bulkAdd(prepared.ledger)
    await db.routines.bulkAdd(prepared.routines); await db.sessions.bulkAdd(prepared.sessions); await db.commands.bulkAdd(prepared.commands); await db.audits.bulkAdd(prepared.audits); await db.settings.bulkAdd(prepared.settings); await db.containers.bulkAdd(prepared.containers ?? []); await db.checklistItems.bulkAdd(prepared.checklistItems ?? []); await db.labelGroups.bulkAdd(prepared.labelGroups ?? []); await db.labelDefinitions.bulkAdd(prepared.labelDefinitions ?? []); await db.savedTemplates.bulkAdd(prepared.savedTemplates ?? []); await db.taskNotes.bulkAdd(prepared.taskNotes ?? []); await db.taskComments.bulkAdd(prepared.taskComments ?? []); await db.taskAttachments.bulkAdd(attachments); await db.taskDependencies.bulkAdd(prepared.taskDependencies ?? []); await db.planningBuckets.bulkAdd(prepared.planningBuckets ?? []); await db.timeBlocks.bulkAdd(prepared.timeBlocks ?? []); await db.calendarEvents.bulkAdd(prepared.calendarEvents ?? []); await db.rollovers.bulkAdd(prepared.rollovers ?? []); await db.themeRules.bulkAdd(prepared.themeRules ?? []); await db.smartLists.bulkAdd(prepared.smartLists ?? []); await db.focusSelections.bulkAdd(prepared.focusSelections ?? []); await db.habits.bulkAdd(prepared.habits ?? []); await db.habitLogs.bulkAdd(prepared.habitLogs ?? [])
  })
}
