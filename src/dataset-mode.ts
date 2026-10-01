import { db } from './db'
import { captureSnapshot, downloadBundle, encryptSnapshot, exportBackup, restoreBackup } from './backup'
import { validateSnapshot, type Snapshot } from './backup-validation'
import { restoreCoachNotificationState } from './coach-notifications'
import { uid, type DatasetLineage, type Settings } from './domain'
import type { DatasetMode } from './dataset-guard'
import { ensureLocalDevice, recordHandoff, stampHandoff } from './handoff-heads'
import { inspectHandoff } from './handoff'

export const datasetModeOf = (settings?: Pick<Settings, 'datasetMode'> | null): DatasetMode => settings?.datasetMode ?? 'active'
export const DATASET_MODE_LABEL: Record<DatasetMode, string> = { active: '編集できます', frozen: '移行のため凍結中', read_only: '移行済み（読み取り専用）' }
type Writer = (content: string, label: string) => void
function trusted(event: Event) {
  const getter = Object.getOwnPropertyDescriptor(Event.prototype, 'type')?.get
  if (!(event instanceof Event) || !event.isTrusted || !getter || !['click', 'submit'].includes(getter.call(event))) throw new Error('本人確認ボタンから操作してください')
}
const b64url = (bytes: Uint8Array) => btoa(Array.from(bytes, value => String.fromCharCode(value)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** 8-character completion code. Only someone who decrypted the move bundle knows move_secret, so the sender can trust it. */
export async function moveCompletionCode(moveId: string, secret: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`michi-move-complete|${moveId}|${secret}`)))
  let bits = 0, value = 0, code = ''
  for (const byte of digest) { value = (value << 8 | byte) & 0xffff; bits += 8; while (bits >= 5 && code.length < 8) { code += CROCKFORD[value >> bits - 5 & 31]; bits -= 5 } if (code.length >= 8) break }
  return `${code.slice(0, 4)}-${code.slice(4)}`
}
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
function withoutMode(settings: Settings): Settings { const next = { ...settings }; delete next.datasetMode; return next }
const emptyLineage = (): DatasetLineage => ({ parentDatasetId: null, ancestorDatasetIds: [], forkedAt: null, moveId: null })

/** Move, step 1 (sender): freeze, then export the move bundle. A failed export resumes editing. */
export async function startMove(password: string, event: Event, write: Writer = downloadBundle): Promise<{ moveId: string; bundleId: string }> {
  trusted(event)
  if (password.length < 10) throw new Error('移行ファイルのパスワードは10文字以上にしてください')
  const device = await ensureLocalDevice(), moveId = uid(), secret = b64url(crypto.getRandomValues(new Uint8Array(32))), startedAt = new Date().toISOString()
  await db.transaction('rw', [db.settings, db.localDevice, db.audits], async () => {
    const settings = await db.settings.get('main')
    if (!settings || datasetModeOf(settings) !== 'active') throw new Error('編集できる状態のデータだけを移行できます')
    await db.settings.put({ ...settings, datasetMode: 'frozen' })
    await db.localDevice.put({ ...device, pendingMove: { moveId, secret, startedAt, bundleId: null } })
    await db.audits.add({ id: uid(), taskId: null, operation: 'dataset_move_started', at: startedAt, detail: `移行を開始し、この端末を凍結: ${moveId}` })
  })
  try {
    const snapshot = await captureSnapshot()
    snapshot.handoff = await stampHandoff(snapshot, 'move', { move_id: moveId, move_secret: secret })
    write(await encryptSnapshot(snapshot, password), 'michi-move')
    await recordHandoff(snapshot, 'export', 'exported')
    await db.localDevice.update('main', { pendingMove: { moveId, secret, startedAt, bundleId: snapshot.handoff.bundle_id } })
    return { moveId, bundleId: snapshot.handoff.bundle_id }
  } catch (error) {
    await resume(moveId, '移行ファイルを書き出せなかったため再開')
    throw error
  }
}
async function resume(moveId: string, detail: string) {
  await db.transaction('rw', [db.settings, db.localDevice, db.audits], async () => {
    const settings = await db.settings.get('main'), device = await db.localDevice.get('main')
    if (!settings || datasetModeOf(settings) !== 'frozen' || device?.pendingMove?.moveId !== moveId) throw new Error('取り消せる移行がありません')
    await db.settings.put(withoutMode(settings))
    await db.localDevice.put({ ...device, pendingMove: null })
    await db.audits.add({ id: uid(), taskId: null, operation: 'dataset_move_cancelled', at: new Date().toISOString(), detail: `${detail}: ${moveId}` })
  })
}
/** Move, cancel before the completion code: the sender becomes editable again. */
export async function cancelMove(event: Event): Promise<void> {
  trusted(event)
  const device = await db.localDevice.get('main')
  if (!device?.pendingMove) throw new Error('取り消せる移行がありません')
  await resume(device.pendingMove.moveId, '本人が移行を取消')
}
/** Move, step 3 (sender): the receiver's code archives this device as read-only. A wrong code changes nothing. */
export async function completeMoveOnSender(code: string, event: Event): Promise<void> {
  trusted(event)
  await db.transaction('rw', [db.settings, db.localDevice, db.audits], async () => {
    const settings = await db.settings.get('main'), device = await db.localDevice.get('main'), pending = device?.pendingMove
    if (!settings || !device || !pending || datasetModeOf(settings) !== 'frozen') throw new Error('完了待ちの移行がありません')
    if (normalizeCode(code) !== normalizeCode(await moveCompletionCode(pending.moveId, pending.secret))) throw new Error('完了コードが一致しません。受入先に表示された8文字を入力してください')
    await db.settings.put({ ...settings, datasetMode: 'read_only', lineage: { ...(settings.lineage ?? emptyLineage()), moveId: pending.moveId } })
    await db.localDevice.put({ ...device, pendingMove: null })
    await db.audits.add({ id: uid(), taskId: null, operation: 'dataset_move_completed', at: new Date().toISOString(), detail: `受入先の完了コードを確認し、この端末を読み取り専用に変更: ${pending.moveId}` })
  })
}
/** Move, step 2 (receiver): validate, replace this device's data and activate it; returns the code to enter on the sender. */
export async function acceptMoveBundle(snapshot: Snapshot, event: Event, options: { confirmDifferentDataset?: boolean; exportFirst?: { password: string; exporter?: (password: string) => Promise<void> } } = {}): Promise<string> {
  trusted(event)
  validateSnapshot(snapshot)
  const manifest = snapshot.handoff
  if (manifest?.kind !== 'move') throw new Error('移行ファイルではありません')
  const preview = await inspectHandoff(snapshot)
  if (!preview.sameDataset && !options.confirmDifferentDataset) throw new Error('この端末の別データセットを置き換えます。件数を確認してから受け入れてください')
  if (preview.sameDataset && preview.comparison.blocking && !options.exportFirst) throw new Error('この端末だけの変更があります。書き出してから受け入れてください')
  if (options.exportFirst) await (options.exportFirst.exporter ?? exportBackup)(options.exportFirst.password)
  await restoreBackup(snapshot)
  await db.transaction('rw', [db.settings, db.audits], async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('設定がありません')
    await db.settings.put({ ...withoutMode(settings), lineage: { ...(settings.lineage ?? emptyLineage()), moveId: manifest.move_id } })
    await db.audits.add({ id: uid(), taskId: null, operation: 'dataset_move_accepted', at: new Date().toISOString(), detail: `移行ファイルを受け入れ、この端末を有効化: ${manifest.move_id}` })
  })
  const code = await moveCompletionCode(manifest.move_id, manifest.move_secret)
  await recordHandoff(snapshot, 'import', 'move_accepted', code)
  return code
}
/** Fork: an independent copy with a new dataset_id and lineage. Publishing, notification reservations and AI/agent authority are not carried over. */
export function forkSnapshot(snapshot: Snapshot, datasetId: string, at: string): Snapshot {
  const source = snapshot.settings[0], parent = source.datasetId
  const { datasetMode: _mode, notificationState, changePolicy, ...rest } = structuredClone(source)
  void _mode
  const settings: Settings = { ...rest, datasetId, aiEnabled: false, lastBackupAt: null, lineage: { parentDatasetId: parent, ancestorDatasetIds: [parent, ...(source.lineage?.ancestorDatasetIds ?? [])].slice(0, 50), forkedAt: at, moveId: null }, ...(changePolicy ? { changePolicy: { ...changePolicy, aiChangesEnabled: false, epoch: changePolicy.epoch + 1 } } : {}), ...(notificationState ? { notificationState: restoreCoachNotificationState(notificationState, source.profileId, datasetId, at) } : {}) }
  const fork: Snapshot = { ...structuredClone(snapshot), exportedAt: at, settings: [settings], calendarRules: (snapshot.calendarRules ?? []).map(state => ({ ...structuredClone(state), datasetId })), taskSourceEvidence: (snapshot.taskSourceEvidence ?? []).map(row => ({ ...structuredClone(row), datasetId })), achievementPolicies: [], achievementEvidence: [], achievementExports: [], commands: snapshot.commands.filter(command => !command.key.startsWith('filebridge:')).map(command => structuredClone(command)) }
  delete fork.handoff
  validateSnapshot(fork)
  return fork
}
export async function exportFork(password: string, event: Event, write: Writer = downloadBundle): Promise<{ datasetId: string; bundleId: string }> {
  trusted(event)
  if (password.length < 10) throw new Error('複製ファイルのパスワードは10文字以上にしてください')
  const snapshot = await captureSnapshot(), datasetId = uid(), fork = forkSnapshot(snapshot, datasetId, new Date().toISOString())
  fork.handoff = await stampHandoff(fork, 'fork', { parent_dataset_id: snapshot.settings[0].datasetId })
  write(await encryptSnapshot(fork, password), 'michi-fork')
  await recordHandoff(fork, 'export', 'exported')
  return { datasetId, bundleId: fork.handoff.bundle_id }
}
