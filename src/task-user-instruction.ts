import {labelSelectionAuthority} from './labels'
import Dexie from 'dexie'
import { db } from './db'
import { canonicalJSON, contentDigest } from './canonical'
import { isTimeZone } from './zoned-time'
import { uid, validateDate, type ScoreInput, type Settings } from './domain'
import type { ChangeContext, TaskChangeRequest } from './change-set'

export type TaskInstructionInput = { message: string; referenceDate: string; timezone: string; changes: TaskChangeRequest[] }
export type VerifiedTaskInstruction = Readonly<{
  version: 1; id: string; nonce: string; ownerId: string; datasetId: string; channel: 'app'
  policyEpoch: number; sourcePermissionRevision: number; issuedAt: string; expiresAt: string
  messageDigest: string; referenceDate: string; timezone: string
  changes: { taskId: string; expectedRevision: number; patch: TaskChangeRequest['patch']; scoreBefore: ScoreInput; labelAuthority?: string }[]
  digest: string
}>
const issued = new Map<string, VerifiedTaskInstruction>()
function error(message = '本人が指定した対象と値をアプリの確認ボタンで確定してください'): never { throw new Error(message) }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } return value }
export function clearTaskInstructionAuthority() { issued.clear() }
export function revokeTaskInstruction(value: VerifiedTaskInstruction) { if (issued.get(value.id) === value) issued.delete(value.id) }

function nativeOwner(context: ChangeContext, event: Event) {
  if (context.principal.kind !== 'human' || context.principal.id !== context.ownerId || !(event instanceof Event) || !event.isTrusted || !['click', 'submit'].includes(event.type)) error()
  const getter = Object.getOwnPropertyDescriptor(Event.prototype, 'type')?.get
  try { if (!getter || !['click', 'submit'].includes(getter.call(event))) error() } catch { error() }
}
function validateInput(input: TaskInstructionInput) {
  if (!record(input) || Object.keys(input).length !== 4 || !['message', 'referenceDate', 'timezone', 'changes'].every(key => Object.hasOwn(input, key)) || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 4000) error('本人の指示は1〜4000文字で入力してください')
  if(typeof input.referenceDate!=='string')error('指示の基準日が不正です')
  validateDate(input.referenceDate, '指示の基準日')
  try { if (typeof input.timezone !== 'string' || input.timezone.length > 100) error(); new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format() } catch { error('指示のタイムゾーンが不正です') }
  if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > 100 || new Set(input.changes.map(change => change?.taskId)).size !== input.changes.length) error()
  for (const change of input.changes) {
    if (!record(change) || Object.keys(change).length !== 3 || !['taskId', 'expectedRevision', 'patch'].every(key => Object.hasOwn(change, key)) || typeof change.taskId !== 'string' || !change.taskId || change.taskId.length > 200 || !Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 1 || !record(change.patch) || !Object.keys(change.patch).length || Object.keys(change.patch).some(field => !['title', 'notes', 'scheduledDate', 'dueDate', 'dueAt', 'manualPoints', 'labels'].includes(field))) error()
    const patch = change.patch
    if (Object.hasOwn(patch, 'labels') && (!Array.isArray(patch.labels) || patch.labels.length > 30 || patch.labels.some(name => typeof name !== 'string' || !name.trim() || name.length > 100) || new Set(patch.labels).size !== patch.labels.length)) error('ラベルが不正です')
    if (Object.hasOwn(patch, 'title') && (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.length > 300)) error('タイトルが不正です')
    if (Object.hasOwn(patch, 'notes') && (typeof patch.notes !== 'string' || patch.notes.length > 50000)) error('メモが不正です')
    for (const field of ['scheduledDate', 'dueDate'] as const) if (Object.hasOwn(patch, field)) { if (patch[field] !== null && typeof patch[field] !== 'string') error('指示の日付が不正です'); validateDate(patch[field]!, '指示の日付') }
    if (Object.hasOwn(patch, 'manualPoints') && (!Number.isInteger(patch.manualPoints) || patch.manualPoints! < 0 || patch.manualPoints! > 100000)) error('指定ポイントは0〜100000の整数にしてください')
    if (Object.hasOwn(patch, 'dueAt') && patch.dueAt !== null && (!record(patch.dueAt) || Object.keys(patch.dueAt).length !== 2 || typeof patch.dueAt.at !== 'string' || !Number.isFinite(Date.parse(patch.dueAt.at)) || new Date(patch.dueAt.at).toISOString() !== patch.dueAt.at || !isTimeZone(patch.dueAt.timezone))) error('指示の締め切り時刻が不正です')
  }
}
/** A native owner operation confirms exact values; model output is never authority. */
export async function confirmTaskInstructionFromUI(input: TaskInstructionInput, context: ChangeContext, event: Event): Promise<VerifiedTaskInstruction> {
  nativeOwner(context, event)
  for (const [id, previous] of issued) if (Date.parse(previous.expiresAt) <= Date.now()) issued.delete(id)
  input = structuredClone(input); context = structuredClone(context)
  validateInput(input)
  const payload = await db.transaction('r', [db.tasks, db.settings, ...(input.changes.some(change=>Object.hasOwn(change.patch,'labels'))?[db.labelGroups,db.labelDefinitions]:[])], async () => {
    const settings = await db.settings.get('main')
    if (!settings || settings.profileId !== context.ownerId || settings.datasetId !== context.datasetId) error('この保存先の本人指示として確認できません')
    const changes: VerifiedTaskInstruction['changes'] = []
    for (const change of input.changes) {
      const task = await db.tasks.get(change.taskId)
      if (!task || task.deletedAt || task.revision !== change.expectedRevision || Object.keys(change.patch).some(field => !context.allowedFields.includes(field as typeof context.allowedFields[number]))) error('対象のタスク・版・許可を確認し直してください')
      const labelAuthority=Object.hasOwn(change.patch,'labels')?await labelSelectionAuthority(change.patch.labels!,context.ownerId,false):undefined
      changes.push({ ...change, scoreBefore: structuredClone(task.score), ...(labelAuthority?{labelAuthority}:{}) })
    }
    const at = new Date().toISOString()
    return { version: 1 as const, id: uid(), nonce: uid(), ownerId: context.ownerId, datasetId: context.datasetId, channel: 'app' as const, policyEpoch: settings.changePolicy?.epoch ?? 0, sourcePermissionRevision: settings.changePolicy?.sourcePermissionRevision ?? 0, issuedAt: at, expiresAt: new Date(Date.now() + 86400000).toISOString(), messageDigest: await Dexie.waitFor(contentDigest(input.message)), referenceDate: input.referenceDate, timezone: input.timezone, changes }
  })
  const value = freeze({ ...payload, digest: await Dexie.waitFor(contentDigest(payload)) })
  issued.set(value.id, value)
  return value
}
/** Called at preparation, approval and commit; saved metadata cannot reissue an instruction. */
export function assertTaskInstruction(value: VerifiedTaskInstruction | null | undefined, requests: TaskChangeRequest[], context: ChangeContext, settings: Settings): asserts value is VerifiedTaskInstruction {
  if (!value || issued.get(value.id) !== value || value.ownerId !== context.ownerId || value.datasetId !== context.datasetId || value.policyEpoch !== (settings.changePolicy?.epoch ?? 0) || value.sourcePermissionRevision !== (settings.changePolicy?.sourcePermissionRevision ?? 0) || Date.parse(value.expiresAt) <= Date.now()) error()
  const requested = requests.map(change => ({ taskId: change.taskId, expectedRevision: change.expectedRevision, patch: change.patch }))
  const confirmed = value.changes.map(({ taskId, expectedRevision, patch }) => ({ taskId, expectedRevision, patch }))
  if (canonicalJSON(requested) !== canonicalJSON(confirmed)) error('候補の対象・版・変更値が本人の指定と一致しません')
}
