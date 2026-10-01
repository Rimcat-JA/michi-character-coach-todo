import { db } from './db'

export type StorageProtection = { persisted: boolean | null; usage: number | null; quota: number | null; requested: 'granted' | 'denied' | null }
type StorageLike = Pick<StorageManager, 'estimate'> & Partial<Pick<StorageManager, 'persist' | 'persisted'>>
export const STORAGE_FULL_MESSAGE = '保存容量が不足しています。既存データは変更していません'
export const STORAGE_ABORT_MESSAGE = '保存を完了できませんでした（書き込みが中断されました）。既存データは変更していません'

const browserStorage = (): StorageLike | undefined => typeof navigator === 'undefined' ? undefined : navigator.storage
export async function readStorageProtection(storage: StorageLike | undefined = browserStorage(), requested: StorageProtection['requested'] = null): Promise<StorageProtection> {
  let persisted: boolean | null = null, usage: number | null = null, quota: number | null = null
  try { persisted = typeof storage?.persisted === 'function' ? await storage.persisted() : null } catch { persisted = null }
  try { const estimate = await storage?.estimate(); usage = estimate?.usage ?? null; quota = estimate?.quota ?? null } catch { /* shown as unknown */ }
  return { persisted, usage, quota, requested }
}
/** persist() is a request the browser may refuse; refusal never blocks input. */
export async function requestStorageProtection(storage: StorageLike | undefined = browserStorage()): Promise<StorageProtection> {
  let granted = false
  try { granted = typeof storage?.persist === 'function' ? await storage.persist() : false } catch { granted = false }
  return readStorageProtection(storage, granted ? 'granted' : 'denied')
}
const STAMPS = ['updatedAt', 'createdAt', 'at', 'currentAt', 'originalAt', 'deletedAt', 'finishedAt', 'endedAt'] as const
/** Latest timestamp a row carries; after an export, rows without one are not counted. */
function changedAt(row: unknown): string {
  let latest = ''
  for (const key of STAMPS) { const value = (row as Record<string, unknown>)[key]; if (typeof value === 'string' && value > latest) latest = value }
  return latest
}
/** Rows changed after the last successful encrypted export (all rows if never exported): audits and commands plus every owner
 * table whose rows carry a timestamp (habits, goals, notes, events and the like write no audit). A row-change count, not a
 * per-edit count; the settings row is not included. Read-only. */
export async function unbackedChangeCount(lastBackupAt: string | null): Promise<number> {
  const audits = lastBackupAt ? await db.audits.where('at').above(lastBackupAt).count() : await db.audits.count()
  const commands = await db.commands.filter(row => !lastBackupAt || row.at > lastBackupAt).count()
  let rows = 0
  for (const table of db.tables) {
    if (['audits', 'commands', 'settings'].includes(table.name)) continue
    rows += lastBackupAt ? await table.filter(row => changedAt(row) > lastBackupAt).count() : await table.count()
  }
  return audits + commands + rows
}
function chain(error: unknown): { name: string; message: string }[] {
  const found: { name: string; message: string }[] = []
  let current: unknown = error
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
    const item = current as { name?: unknown; message?: unknown; inner?: unknown; cause?: unknown }
    found.push({ name: String(item.name ?? ''), message: String(item.message ?? '') })
    current = item.inner ?? item.cause
  }
  return found
}
/** Dexie wraps IndexedDB quota failures as QuotaExceededError, or as AbortError with the quota error inside. */
export function storageErrorMessage(error: unknown): string | null {
  const items = chain(error)
  if (items.some(item => item.name === 'QuotaExceededError' || /quota/i.test(item.message))) return STORAGE_FULL_MESSAGE
  if (items.some(item => item.name === 'AbortError')) return STORAGE_ABORT_MESSAGE
  return null
}
export const formatMegabytes = (bytes: number | null) => bytes === null ? '不明' : `${Math.round(bytes / 1024 / 1024)} MB`
/** The editor keeps its form when saving fails; only a successful save may clear or close it. */
export async function saveKeepingDraft<T, D>(draft: D, save: (draft: D) => Promise<T>): Promise<{ ok: true; result: T } | { ok: false; draft: D; message: string }> {
  try { return { ok: true, result: await save(draft) } }
  catch (error) { return { ok: false, draft, message: storageErrorMessage(error) ?? (error instanceof Error ? error.message : String(error)) } }
}
export function protectionLabel(protection: StorageProtection | null): string {
  if (!protection) return '確認中'
  if (protection.persisted === true) return '保存保護あり（ブラウザが自動では消去しにくい状態）'
  if (protection.requested === 'denied') return '保存保護は許可されませんでした'
  return protection.persisted === false ? '保存保護なし（容量が逼迫するとブラウザが消去する場合があります）' : '保存保護の状態を確認できません'
}
