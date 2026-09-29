import { db } from './db'
import type { Assessment, Audit, CommandReceipt, Completion, LedgerEntry, Routine, Settings, Task, WorkSession } from './domain'

type Snapshot = { format: 'coachbundle'; version: 1; exportedAt: string; tasks: Task[]; assessments: Assessment[]; completions: Completion[]; ledger: LedgerEntry[]; routines: Routine[]; sessions: WorkSession[]; commands: CommandReceipt[]; audits: Audit[]; settings: Settings[] }
type Envelope = { format: 'coachbundle-encrypted'; version: 1; kdf: 'PBKDF2-SHA256'; iterations: 250000; cipher: 'AES-256-GCM'; salt: string; iv: string; data: string }
const bytes = (s: string) => new TextEncoder().encode(s)
const b64 = (a: Uint8Array) => btoa(Array.from(a, x => String.fromCharCode(x)).join(''))
const fromB64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))
async function key(password: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey('raw', bytes(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 250000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
export async function exportBackup(password: string) {
  if (password.length < 10) throw new Error('バックアップのパスワードは10文字以上にしてください')
  const snapshot: Snapshot = await db.transaction('r', [db.tasks, db.assessments, db.completions, db.ledger, db.routines, db.sessions, db.commands, db.audits, db.settings], async () => ({
    format: 'coachbundle', version: 1, exportedAt: new Date().toISOString(), tasks: await db.tasks.toArray(), assessments: await db.assessments.toArray(), completions: await db.completions.toArray(), ledger: await db.ledger.toArray(), routines: await db.routines.toArray(), sessions: await db.sessions.toArray(), commands: await db.commands.toArray(), audits: await db.audits.toArray(), settings: await db.settings.toArray()
  }))
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(password, salt), bytes(JSON.stringify(snapshot))))
  const envelope: Envelope = { format: 'coachbundle-encrypted', version: 1, kdf: 'PBKDF2-SHA256', iterations: 250000, cipher: 'AES-256-GCM', salt: b64(salt), iv: b64(iv), data: b64(data) }
  const blob = new Blob([JSON.stringify(envelope)], { type: 'application/json' })
  const url = URL.createObjectURL(blob), anchor = document.createElement('a')
  anchor.href = url; anchor.download = `character-coach-${new Date().toISOString().slice(0, 10)}.coachbundle`; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
  await db.settings.update('main', { lastBackupAt: new Date().toISOString() })
}
function validateSnapshot(s: unknown): asserts s is Snapshot {
  if (!s || typeof s !== 'object') throw new Error('バックアップ形式が不正です')
  const value = s as Record<string, unknown>
  if (value.format !== 'coachbundle' || value.version !== 1) throw new Error('対応していないバックアップ形式です')
  for (const name of ['tasks', 'assessments', 'completions', 'ledger', 'routines', 'sessions', 'commands', 'audits', 'settings']) if (!Array.isArray(value[name])) throw new Error(`${name}がありません`)
  const tasks = value.tasks as Task[], completions = value.completions as Completion[], ledger = value.ledger as LedgerEntry[]
  const taskIds = new Set(tasks.map(x => x.id)), completionIds = new Set(completions.map(x => x.id))
  if (taskIds.size !== tasks.length || completionIds.size !== completions.length) throw new Error('IDが重複しています')
  if ((value.settings as Settings[]).length !== 1 || (value.settings as Settings[])[0]?.id !== 'main') throw new Error('設定が不正です')
  for (const c of completions) {
    if (!taskIds.has(c.taskId)) throw new Error('完了記録の参照先がありません')
    const sum = ledger.filter(e => e.completionId === c.id).reduce((n, e) => n + e.delta, 0)
    if (c.currentAt && c.scoreState === 'confirmed' && sum !== c.netPoints) throw new Error('台帳の合計が一致しません')
    if (!c.currentAt && sum !== 0) throw new Error('取消済み台帳が一致しません')
  }
}
export async function inspectBackup(file: File, password: string): Promise<Snapshot> {
  if (file.size > 50 * 1024 * 1024) throw new Error('50MBを超えるファイルは読み込めません')
  const e = JSON.parse(await file.text()) as Envelope
  if (e.format !== 'coachbundle-encrypted' || e.version !== 1 || e.iterations !== 250000 || e.cipher !== 'AES-256-GCM') throw new Error('対応していない暗号化形式です')
  let plain: ArrayBuffer
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(e.iv) as BufferSource }, await key(password, fromB64(e.salt)), fromB64(e.data) as BufferSource) }
  catch { throw new Error('パスワードが違うか、ファイルが破損しています') }
  const snapshot: unknown = JSON.parse(new TextDecoder().decode(plain))
  validateSnapshot(snapshot)
  return snapshot
}
export async function restoreBackup(snapshot: Snapshot) {
  validateSnapshot(snapshot)
  await db.transaction('rw', [db.tasks, db.assessments, db.completions, db.ledger, db.routines, db.sessions, db.commands, db.audits, db.settings], async () => {
    await Promise.all([db.tasks.clear(), db.assessments.clear(), db.completions.clear(), db.ledger.clear(), db.routines.clear(), db.sessions.clear(), db.commands.clear(), db.audits.clear(), db.settings.clear()])
    await db.tasks.bulkAdd(snapshot.tasks); await db.assessments.bulkAdd(snapshot.assessments); await db.completions.bulkAdd(snapshot.completions); await db.ledger.bulkAdd(snapshot.ledger)
    await db.routines.bulkAdd(snapshot.routines); await db.sessions.bulkAdd(snapshot.sessions); await db.commands.bulkAdd(snapshot.commands); await db.audits.bulkAdd(snapshot.audits); await db.settings.bulkAdd(snapshot.settings)
  })
}
