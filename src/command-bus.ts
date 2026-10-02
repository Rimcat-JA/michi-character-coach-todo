import Dexie from 'dexie'
import { db } from './db'
import { canonicalJSON } from './canonical'
import { today, uid, validateDate, type Settings } from './domain'
import { applyChangeSet, approveChangeSetFromUI, cancelChangeSet, changePolicyFor, ChangeSetError, decideChangePolicy, prepareTaskChanges, taskChangeFields, type ChangeContext, type ChangePolicy, type ChangePolicyDecision, type ChangePrincipal, type PreparedChangeSet, type SourceRevision, type TaskChangeField, type TaskChangePatch, type TaskChangeRequest, type TaskFieldOrigin, type UIChangeApproval } from './change-set'
import { operationMode, operationsForFields } from './automation-policy'
import { confirmTaskInstructionFromUI, type VerifiedTaskInstruction } from './task-user-instruction'

/** K12 LocalCommandBus: one envelope, one actor model and one outcome vocabulary for UI, file and MCP entrances. */
export const COMMAND_BASIS_KINDS = ['app_instruction', 'verified_detection', 'approved_rule_instance', 'external_request'] as const
export type CommandBasisKind = typeof COMMAND_BASIS_KINDS[number]
export type CommandBasis = { kind: CommandBasisKind; note?: string }
export type CommandEntrance = 'ui_human' | 'ui_coach' | 'file' | 'mcp' | 'api'
export type CommandEnvelope = { schema_version: '1'; command_id: string; type: string; target_id: string | null; expected_revision: number | null; payload: Record<string, unknown>; basis: CommandBasis }
/** The single snake_case (envelope) to camelCase (ChangeSet) field adapter. */
export const commandFieldMap = { title: 'title', notes: 'notes', scheduled_date: 'scheduledDate', due_date: 'dueDate', due_at: 'dueAt', manual_points: 'manualPoints' } as const satisfies Record<string, TaskChangeField>
export type CommandField = keyof typeof commandFieldMap
export const commandFields = Object.keys(commandFieldMap) as CommandField[]
export const protectedCommandFields: CommandField[] = ['title', 'due_date', 'due_at', 'manual_points']
export type CommandGrant = Readonly<{ fields: CommandField[]; operations: string[]; mutationMode: 'require_approval' | 'auto_within_bounds'; maxScheduleShiftDays: number | null; autoMaxScheduleShiftDays?: number | null }>
/** Built only by trusted entrance adapters below; a cloned or JSON actor is never accepted. */
export type ActorContext = Readonly<{ entrance: CommandEntrance; principal: ChangePrincipal; ownerId: string; datasetId: string; grant: CommandGrant | null; sourceRevisions: SourceRevision[]; fieldOrigins?: Partial<Record<TaskChangeField, TaskFieldOrigin>>; label: string | null; creationContainerId?: string | null }>
export type CommandState = 'applied' | 'awaiting_approval' | 'denied' | 'conflict' | 'expired' | 'rejected' | 'failed'
export type CommandReceipt = Readonly<{ commandId: string; changeSetId: string; digest: string; taskIds: string[]; appliedAt: string }>
export type CommandOutcome = Readonly<{ commandId: string | null; entrance: CommandEntrance | null; state: CommandState; code: string | null; message: string; receipt: CommandReceipt | null }>
export type CommandTrace = { entrance: CommandEntrance; basis: CommandBasisKind; commandId: string; label: string | null }
/** stage 'owner_values': the owner still has to confirm exact values in the app before a reviewable change exists. */
export type PreparedCommand = Readonly<{ id: string; envelope: CommandEnvelope; actor: ActorContext; createdAt: string; expiresAt: string; reason: string; stage: 'owner_values' | 'review'; changeSet: PreparedChangeSet | null; ownerValues: TaskChangeRequest[] | null; body: unknown }>
export type CommandPreparation = { outcome: CommandOutcome; prepared: PreparedCommand | null }
export type CommandSubmitRequest = { event: Event | null; checkedProtectedFields?: TaskChangeField[]; requestKey: string }
/** Registered by N03/N05 modules for task.split / routine.change; task.update is built in. */
export type CommandTypeHandler = {
  type: string
  validate: (envelope: CommandEnvelope) => void
  prepare: (envelope: CommandEnvelope, actor: ActorContext, options: { instruction?: unknown; reason?: string }) => Promise<{ stage?: 'owner_values' | 'review'; changeSet?: PreparedChangeSet | null; body?: unknown; ownerValues?: TaskChangeRequest[] | null; expiresAt: string; reason: string }>
  decide: (prepared: PreparedCommand, settings: Settings) => ChangePolicyDecision
  approve: (prepared: PreparedCommand, event: Event, checked: TaskChangeField[]) => Promise<unknown>
  apply: (prepared: PreparedCommand, approval: unknown, requestKey: string, trace: CommandTrace) => Promise<{ changeSetId: string; digest: string; taskIds: string[]; appliedAt: string }>
  cancel?: (prepared: PreparedCommand) => Promise<void>
  /** Fields listed as protected in the shared approval card. */
  fields?: (prepared: PreparedCommand) => TaskChangeField[]
}

export class CommandError extends ChangeSetError {}
function fail(code: string, message: string): never { throw new CommandError(code, message) }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) }
function exact(value: Record<string, unknown>, keys: readonly string[]) { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 200
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
const date = (value: unknown) => { if (value === null) return true; if (typeof value !== 'string') return false; try { validateDate(value, '日付'); return true } catch { return false } }

/** Entrance-specific codes mapped onto the shared vocabulary (28.10). */
const COMMON_CODES: Record<string, string> = {
  REVISION_CONFLICT: 'CONFLICT', TARGET_OR_REVISION_INVALID: 'CONFLICT', COMMAND_EXPIRED: 'EXPIRED', PROPOSAL_EXPIRED: 'EXPIRED', CONNECTION_EXPIRED: 'EXPIRED',
  FIELD_NOT_GRANTED: 'UNAUTHORIZED', SCOPE_DENIED: 'UNAUTHORIZED', TASK_SCOPE: 'UNAUTHORIZED', OWNER_CHANGED: 'UNAUTHORIZED', READ_NOT_GRANTED: 'UNAUTHORIZED',
  SIGNATURE_INVALID: 'AUTHORITY_UNVERIFIED', SNAPSHOT_INVALID: 'AUTHORITY_UNVERIFIED', REGISTRATION_CHANGED: 'AUTHORITY_UNVERIFIED', REGISTRATION_INVALID: 'AUTHORITY_UNVERIFIED', ACTOR_UNVERIFIED: 'AUTHORITY_UNVERIFIED', COMMAND_BINDING: 'AUTHORITY_UNVERIFIED', CONNECTION_REVOKED: 'AUTHORITY_UNVERIFIED',
  SOURCE_PERMISSION_CHANGED: 'POLICY_CHANGED', OPERATION_NOT_GRANTED: 'UNAUTHORIZED', RULE_SCOPE: 'UNAUTHORIZED', AUTHORITY_CHANGED: 'POLICY_CHANGED', UNVERIFIED_COMMAND: 'UNVERIFIED_CHANGE_SET', PROPOSAL_INVALID: 'COMMAND_SCHEMA', COMMAND_ID_REUSED: 'IDEMPOTENCY_MISMATCH',
}
const STATES: Record<string, CommandState> = {
  CHANGES_STOPPED: 'denied', UNAUTHORIZED: 'denied', SCHEDULE_BOUND: 'denied', DAILY_BOUND: 'denied', AUTHORITY_UNVERIFIED: 'denied', SPLIT_NOT_ALLOWED: 'denied',
  CONFLICT: 'conflict', IDEMPOTENCY_MISMATCH: 'conflict', EXPIRED: 'expired', POLICY_CHANGED: 'expired',
  HUMAN_APPROVAL_REQUIRED: 'awaiting_approval', PROTECTED_FIELD_APPROVAL_REQUIRED: 'awaiting_approval', SPLIT_ALLOCATION_REQUIRED: 'awaiting_approval', USER_INSTRUCTION_REQUIRED: 'awaiting_approval', INVALID_APPROVAL: 'awaiting_approval', NEEDS_CONFIRMATION: 'awaiting_approval', LEASE_INVALID: 'awaiting_approval',
  DIGEST_MISMATCH: 'rejected', UNVERIFIED_CHANGE_SET: 'rejected', INVALID_CHANGE_SET: 'rejected', COMMAND_SCHEMA: 'rejected', UNSUPPORTED_FIELD: 'rejected', UNSUPPORTED_OPERATION: 'rejected', INVALID_PAYLOAD: 'rejected', INVALID_TARGET: 'rejected', INVALID_INPUT: 'rejected', BASIS_UNVERIFIED: 'rejected', NO_CHANGE: 'rejected', APPROVAL_CONSUMED: 'rejected', INVALID_JSON: 'rejected', COMMAND_FILENAME: 'rejected', COMMAND_TOO_LARGE: 'rejected', COMMAND_CHANGED: 'rejected', SPLIT_INVALID: 'rejected', ROUTINE_INVALID: 'rejected',
}
/** Shared labels and outcome text so S06, S21, file and MCP read the same (K12). */
export const ENTRANCE_LABELS = { ui_human: 'アプリ（本人）', ui_coach: 'アプリ内コーチ', file: 'ファイル受信箱', mcp: 'ローカルMCP', api: 'このPC内のAPI', app: 'アプリの確認画面' } as const
/** Shared Japanese labels for the codes S21 shows on rejected/cancelled commands. */
export const COMMAND_CODE_LABELS: Record<string, string> = {
  CHANGES_STOPPED: 'AIによる変更の停止中', UNAUTHORIZED: '許可していない操作・項目', SCHEDULE_BOUND: '予定日の移動範囲を超過', DAILY_BOUND: '1日の上限に到達', AUTHORITY_UNVERIFIED: '権限を確認できません', SPLIT_NOT_ALLOWED: '分割できない状態',
  CONFLICT: 'その後の更新と競合', IDEMPOTENCY_MISMATCH: '同じIDで別の内容', EXPIRED: '確認期限切れ', POLICY_CHANGED: '設定・権限の変更', DIGEST_MISMATCH: '確認後に内容が変化', OWNER_CANCELLED: '本人が取消', NO_CHANGE: '変更なし', BASIS_UNVERIFIED: '根拠を確認できません',
}
export const outcomeNotice = (outcome: Pick<CommandOutcome, 'message' | 'code'>) => `${outcome.message}${outcome.code ? `（${outcome.code}）` : ''}`
export function commonCommandCode(code: string): string { return COMMON_CODES[code] ?? code }
export function commandStateFor(code: string | null): CommandState { return code === null ? 'failed' : STATES[commonCommandCode(code)] ?? 'failed' }
export const terminalCommandState = (state: CommandState) => state !== 'awaiting_approval'
/** Normalizes any thrown error; `commonCode` lets an entrance say which shared reason an ambiguous code had. */
export function commandOutcome(error: unknown, context: { commandId?: string | null; entrance?: CommandEntrance | null } = {}): CommandOutcome {
  const raw = error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string' ? (error as { code: string }).code : null
  const explicit = error && typeof error === 'object' && 'commonCode' in error && typeof (error as { commonCode: unknown }).commonCode === 'string' ? (error as { commonCode: string }).commonCode : null
  const code = explicit ?? (raw ? commonCommandCode(raw) : null)
  return freeze({ commandId: context.commandId ?? null, entrance: context.entrance ?? null, state: commandStateFor(code), code, message: error instanceof Error ? error.message : String(error), receipt: null })
}
/** N09 per command type: the operation groups whose denial stops that type (same sets the type handlers enforce). */
export function commandOperationStopped(policy: ChangePolicy, type: string): boolean {
  if (type === 'task.split') return operationMode(policy, 'task.split') === 'deny' || operationMode(policy, 'task.manual_points') === 'deny'
  if (type === 'routine.change') return operationMode(policy, 'routine.change') === 'deny'
  if (type === 'task.create') return operationMode(policy, 'task.text') === 'deny'
  return operationMode(policy, 'task.text') === 'deny' && operationMode(policy, 'task.schedule') === 'deny'
}
/** N09: AI changes are off, or every operation the connection's grant carries is denied (no grant = task edits). */
export function agentChangesStopped(settings: Settings, grant?: CommandGrant | null): boolean {
  const policy = changePolicyFor(settings)
  if (!settings.aiEnabled || !policy.aiChangesEnabled) return true
  return (grant?.operations ?? ['task.update']).every(type => commandOperationStopped(policy, type))
}
/** An authority change seen while AI changes are stopped reports the stop itself (design 29.4 puts stop first). */
export async function refineCommandOutcome(outcome: CommandOutcome, actor: ActorContext | null): Promise<CommandOutcome> {
  if (!actor || actor.principal.kind === 'human' || outcome.code !== 'POLICY_CHANGED') return outcome
  try {
    const settings = await db.settings.get('main'), policy = settings ? changePolicyFor(settings) : null
    if (settings && policy && agentChangesStopped(settings, actor.grant)) return freeze({ ...outcome, state: 'denied', code: 'CHANGES_STOPPED' })
  } catch { /* An unreadable policy keeps the original outcome. */ }
  return outcome
}
function outcomeOf(prepared: PreparedCommand, state: CommandState, code: string | null, message: string, receipt: CommandReceipt | null = null): CommandOutcome {
  return freeze({ commandId: prepared.envelope.command_id, entrance: prepared.actor.entrance, state, code, message, receipt })
}

const trustedActors = new WeakSet<object>()
function issue(actor: ActorContext): ActorContext { const frozen = freeze(structuredClone(actor)); trustedActors.add(frozen); return frozen }
export function verifyActor(actor: ActorContext) { if (!actor || typeof actor !== 'object' || !trustedActors.has(actor)) fail('ACTOR_UNVERIFIED', 'この操作者の権限をアプリで確認できません') }
export function uiHumanActor(settings: Pick<Settings, 'profileId' | 'datasetId'>): ActorContext {
  return issue({ entrance: 'ui_human', principal: { id: settings.profileId, kind: 'human', model: null }, ownerId: settings.profileId, datasetId: settings.datasetId, grant: null, sourceRevisions: [], label: null })
}
export function uiCoachActor(settings: Pick<Settings, 'profileId' | 'datasetId'>, model: string | null, options: { grant?: CommandGrant | null; fieldOrigins?: Partial<Record<TaskChangeField, TaskFieldOrigin>> } = {}): ActorContext {
  return issue({ entrance: 'ui_coach', principal: { id: 'app-coach', kind: 'coach', model }, ownerId: settings.profileId, datasetId: settings.datasetId, grant: options.grant ?? null, sourceRevisions: [], ...(options.fieldOrigins ? { fieldOrigins: options.fieldOrigins } : {}), label: null })
}
/** Only the file controller calls this, after main verified the signed registration. */
export function externalAgentActor(binding: { ownerId: string; datasetId: string; clientId: string; registrationRevision: number; grantEpoch: number; host: string }, entrance: 'file' | 'mcp' | 'api', grant: CommandGrant, creationContainerId?: string | null): ActorContext {
  return issue({ entrance, principal: { id: binding.clientId, kind: 'external-agent', model: null }, ownerId: binding.ownerId, datasetId: binding.datasetId, grant, sourceRevisions: [{ id: `external-registration:${binding.clientId}`, revision: binding.registrationRevision }, { id: `external-grant:${binding.clientId}`, revision: binding.grantEpoch }], label: binding.host, ...(entrance==='api' ? {creationContainerId:creationContainerId??null} : {}) })
}
export function changeContextFor(actor: ActorContext): ChangeContext {
  const allowedFields = actor.grant ? actor.grant.fields.map(field => commandFieldMap[field]) : [...taskChangeFields]
  return { principal: { ...actor.principal }, ownerId: actor.ownerId, datasetId: actor.datasetId, allowedFields, sourceRevisions: structuredClone(actor.sourceRevisions), ...(actor.fieldOrigins ? { fieldOrigins: { ...actor.fieldOrigins } } : {}) }
}
/** The owner approving another actor's command; it shares the actor's field scope. */
export function humanContextFor(actor: ActorContext): ChangeContext { return { ...changeContextFor(actor), principal: { id: actor.ownerId, kind: 'human' } } }
export function toTaskPatch(payload: Record<string, unknown>): TaskChangePatch {
  return Object.fromEntries(Object.entries(payload).map(([field, value]) => [commandFieldMap[field as CommandField], value])) as TaskChangePatch
}
export function toCommandPayload(patch: TaskChangePatch): Record<string, unknown> {
  const reverse = Object.fromEntries(Object.entries(commandFieldMap).map(([snake, camel]) => [camel, snake])) as Record<TaskChangeField, CommandField>
  return Object.fromEntries(Object.entries(patch).map(([field, value]) => [reverse[field as TaskChangeField], value]))
}

const handlers = new Map<string, CommandTypeHandler>()
export function registerCommandType(handler: CommandTypeHandler) {
  if (!handler || typeof handler.type !== 'string' || !/^[a-z]+\.[a-z_]+$/.test(handler.type) || handlers.has(handler.type) && handlers.get(handler.type) !== handler) throw new Error('コマンド種別の登録が不正です')
  handlers.set(handler.type, handler)
}
export const registeredCommandTypes = () => [...handlers.keys()]
function handlerFor(type: string) { const handler = handlers.get(type); if (!handler) fail('UNSUPPORTED_OPERATION', 'この操作はコマンドとして受け付けていません'); return handler }
export function validateCommandEnvelope(value: unknown): asserts value is CommandEnvelope {
  if (!record(value) || !exact(value, ['schema_version', 'command_id', 'type', 'target_id', 'expected_revision', 'payload', 'basis']) || value.schema_version !== '1' || !id(value.command_id) || typeof value.type !== 'string' || !record(value.payload)) fail('COMMAND_SCHEMA', 'コマンド形式が不正です。承認・操作者・権限の項目は受け付けません')
  if (!record(value.basis) || !(exact(value.basis, ['kind']) || exact(value.basis, ['kind', 'note'])) || !COMMAND_BASIS_KINDS.includes(value.basis.kind as CommandBasisKind) || Object.hasOwn(value.basis, 'note') && (typeof value.basis.note !== 'string' || value.basis.note.length > 1000)) fail('COMMAND_SCHEMA', 'コマンドの根拠の形式が不正です')
  handlerFor(value.type).validate(value as CommandEnvelope)
}
/** Each entrance may only claim the basis it can actually produce; others need app-side verification not offered here. */
function verifyBasis(envelope: CommandEnvelope, actor: ActorContext) {
  const allowed: CommandBasisKind = actor.entrance === 'file' || actor.entrance === 'mcp' || actor.entrance === 'api' ? 'external_request' : 'app_instruction'
  if (envelope.basis.kind !== allowed) fail('BASIS_UNVERIFIED', 'この入口からの根拠は確認できません。本人の確認で扱います')
}
export function validateTaskPayload(payload: Record<string, unknown>, allowed: readonly string[]) {
  const fields = Object.keys(payload)
  if (!fields.length || fields.some(field => !allowed.includes(field))) fail('UNSUPPORTED_FIELD', 'タイトル・メモ・予定日・期限・本人指定ポイント以外は変更できません。完了・配分・系列・権限には別の操作が必要です')
  if (Object.hasOwn(payload, 'title') && (typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > 300) || Object.hasOwn(payload, 'notes') && (typeof payload.notes !== 'string' || payload.notes.length > 50000) || ['scheduled_date', 'due_date'].some(field => Object.hasOwn(payload, field) && !date(payload[field])) || Object.hasOwn(payload, 'manual_points') && !integer(payload.manual_points, 0, 100000) || Object.hasOwn(payload, 'due_at') && payload.due_at !== null && !(record(payload.due_at) && exact(payload.due_at, ['at', 'timezone']) && typeof payload.due_at.at === 'string' && typeof payload.due_at.timezone === 'string')) fail('INVALID_PAYLOAD', '変更値が不正です')
}

/** Effective authority = N09 decision ∩ connection grant: a require_approval grant never becomes automatic. */
export function grantDecision(decision: ChangePolicyDecision, changeSet: PreparedChangeSet, grant: CommandGrant | null): ChangePolicyDecision {
  if (decision.status !== 'auto' || !grant) return decision
  if (grant.mutationMode === 'require_approval') return { ...decision, status: 'awaiting_approval', reason: 'この接続からの変更は毎回本人が確認します' }
  const limit = grant.autoMaxScheduleShiftDays ?? grant.maxScheduleShiftDays
  const beyond = changeSet.changes.some(change => change.fields.includes('scheduledDate') && limit !== null && Math.abs(Date.parse(`${change.after.scheduledDate}T00:00:00Z`) - Date.parse(`${change.before.scheduledDate}T00:00:00Z`)) / 86400000 > limit)
  return beyond ? { ...decision, status: 'awaiting_approval', reason: 'この接続に委任した自動移動の範囲を超えています' } : decision
}
const updateHandler: CommandTypeHandler = {
  type: 'task.update',
  validate(envelope) {
    validateTaskPayload(envelope.payload, commandFields)
    if (!id(envelope.target_id) || !integer(envelope.expected_revision, 1)) fail('INVALID_TARGET', '変更対象と版を指定してください')
  },
  async prepare(envelope, actor, options) {
    const patch = toTaskPatch(envelope.payload), request: TaskChangeRequest = { taskId: envelope.target_id!, expectedRevision: envelope.expected_revision!, patch }
    const grant = actor.grant
    if (grant && Object.keys(envelope.payload).some(field => !grant.fields.includes(field as CommandField))) fail('UNAUTHORIZED', 'この接続で許可していない項目です')
    const instruction = (options.instruction ?? null) as VerifiedTaskInstruction | null
    // External or coach owner-value fields wait for the owner's in-app value confirmation instead of failing.
    if (!instruction && actor.principal.kind !== 'human' && Object.keys(envelope.payload).some(field => protectedCommandFields.includes(field as CommandField))) {
      const settings = await db.settings.get('main'), policy = settings ? changePolicyFor(settings) : null
      if (!settings || settings.profileId !== actor.ownerId || settings.datasetId !== actor.datasetId) fail('UNAUTHORIZED', 'この領域の変更は許可されていません')
      if (!settings.aiEnabled || !policy!.aiChangesEnabled || operationsForFields(Object.keys(patch) as TaskChangeField[]).some(operation => operationMode(policy!, operation) === 'deny') || Object.hasOwn(patch, 'title') && policy!.fieldRules?.title === 'deny') fail('CHANGES_STOPPED', 'AIによる変更は停止しています')
      const task = await db.tasks.get(request.taskId)
      if (!task || task.deletedAt) fail('UNAUTHORIZED', 'この領域の変更は許可されていません')
      if (task.revision !== request.expectedRevision) fail('CONFLICT', 'タスクが更新されています。新しい版で差分を作り直してください')
      return { ownerValues: [request], expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(), reason: options.reason ?? '本人の値確認待ち' }
    }
    const changeSet = await prepareTaskChanges([request], changeContextFor(actor), options.reason ?? '選択したタスクの変更（まだ適用していません）', instruction)
    const change = changeSet.changes[0]
    if (grant?.maxScheduleShiftDays != null && change.fields.includes('scheduledDate') && change.before.scheduledDate && change.after.scheduledDate && Math.abs(Date.parse(change.after.scheduledDate) - Date.parse(change.before.scheduledDate)) / 86400000 > grant.maxScheduleShiftDays) {
      await cancelChangeSet(changeSet, changeContextFor(actor)).catch(() => undefined)
      fail('SCHEDULE_BOUND', 'この接続で許可した予定日の移動範囲を超えています')
    }
    return { changeSet, expiresAt: changeSet.expiresAt, reason: changeSet.reason }
  },
  decide(prepared, settings) {
    if (!prepared.changeSet) return { status: 'awaiting_approval', reason: '本人が指定値を確認してから差分を作ります', protectedFields: [] }
    const decision = decideChangePolicy(prepared.changeSet, changePolicyFor(settings))
    // Effective authority = N09 policy ∩ connection grant: a require_approval grant never becomes automatic.
    return grantDecision(decision, prepared.changeSet, prepared.actor.grant)
  },
  async approve(prepared, event, checked) {
    if (!prepared.changeSet) fail('USER_INSTRUCTION_REQUIRED', '本人が指定値を確認してから差分を作ってください')
    return approveChangeSetFromUI(prepared.changeSet, humanContextFor(prepared.actor), event, checked)
  },
  async apply(prepared, approval, requestKey, trace) {
    if (!prepared.changeSet) fail('USER_INSTRUCTION_REQUIRED', '本人が指定値を確認してから差分を作ってください')
    if (!approval && prepared.actor.grant?.mutationMode === 'require_approval') fail('HUMAN_APPROVAL_REQUIRED', 'この変更を本人が確認してください')
    const receipt = await applyChangeSet(prepared.changeSet, approval as UIChangeApproval | null, changeContextFor(prepared.actor), requestKey, trace)
    return { changeSetId: receipt.changeSetId, digest: receipt.digest, taskIds: receipt.taskIds, appliedAt: receipt.appliedAt }
  },
  async cancel(prepared) { if (prepared.changeSet) await cancelChangeSet(prepared.changeSet, humanContextFor(prepared.actor)) },
  fields: prepared => prepared.changeSet?.changes.flatMap(change => change.fields) ?? [],
}
registerCommandType(updateHandler)

const pending = new Map<string, PreparedCommand>()
const listeners = new Set<() => void>()
let pendingVersion = 0
function changed() { pendingVersion++; for (const listener of listeners) listener() }
export function subscribeCommands(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export const commandsVersion = () => pendingVersion
function sweep(notify = true) { let removed = false; for (const [key, value] of pending) if (Date.parse(value.expiresAt) <= Date.now()) { pending.delete(key); removed = true } if (removed && notify) changed() }
/** Logout, restore and dataset changes only reduce authority. */
export function clearCommandAuthority() { pending.clear(); received.clear(); changed() }
/** Read during render (S21), so it never notifies subscribers. */
export function pendingCommands(): PreparedCommand[] { sweep(false); return [...pending.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }
export function isPendingCommand(prepared: PreparedCommand | null | undefined): prepared is PreparedCommand { return Boolean(prepared && pending.get(prepared.id) === prepared) }
function verifyPrepared(prepared: PreparedCommand) {
  if (!prepared || typeof prepared !== 'object' || !id(prepared.id)) fail('UNVERIFIED_CHANGE_SET', 'この変更案をアプリで作り直してください')
  const saved = pending.get(prepared.id)
  if (!saved) fail('UNVERIFIED_CHANGE_SET', 'この変更案をアプリで作り直してください')
  if (saved !== prepared) fail(canonicalJSON(structuredClone(saved)) === canonicalJSON(structuredClone(prepared)) ? 'UNVERIFIED_CHANGE_SET' : 'DIGEST_MISMATCH', '確認した変更内容が変わりました。差分を作り直してください')
  verifyActor(saved.actor)
  return saved
}

/** Scanned-but-unopened external commands, listed in S21 as received. */
export type ReceivedCommand = Readonly<{ commandId: string; entrance: CommandEntrance; type: string; targetId: string | null; expectedRevision: number | null; principalId: string; host: string | null; fields: string[]; expiresAt: string }>
const received = new Map<string, ReceivedCommand>()
export function noteReceivedCommands(entrance: 'file' | 'mcp' | 'external', values: ReceivedCommand[]) {
  for (const [key, value] of received) if (entrance === 'external' ? value.entrance === 'file' || value.entrance === 'mcp' : value.entrance === entrance) received.delete(key)
  for (const value of values) received.set(value.commandId, freeze(structuredClone(value)))
  changed()
}
export function receivedCommands(): ReceivedCommand[] { return [...received.values()].filter(value => Date.parse(value.expiresAt) > Date.now() && ![...pending.values()].some(item => item.envelope.command_id === value.commandId)) }

export async function prepareCommand(raw: CommandEnvelope, actor: ActorContext, options: { instruction?: unknown; reason?: string } = {}): Promise<CommandPreparation> {
  const commandId = record(raw) && id(raw.command_id) ? raw.command_id as string : null
  let validated: CommandEnvelope | null = null
  try {
    verifyActor(actor)
    const envelope = freeze(structuredClone(raw))
    validateCommandEnvelope(envelope)
    validated = envelope
    verifyBasis(envelope, actor)
    if (actor.grant && !actor.grant.operations.includes(envelope.type)) fail('UNAUTHORIZED', 'この接続で許可していない操作です')
    sweep()
    const body = await handlerFor(envelope.type).prepare(envelope, actor, options)
    // The actor reference is kept as issued; a structured clone would lose its trusted identity.
    const stored: PreparedCommand = freeze({ id: uid(), envelope, actor, createdAt: new Date().toISOString(), expiresAt: body.expiresAt, reason: body.reason, stage: body.stage ?? (body.ownerValues ? 'owner_values' : 'review'), changeSet: body.changeSet ?? null, ownerValues: body.ownerValues ?? null, body: body.body ?? null })
    pending.set(stored.id, stored); changed()
    const settings = (await db.settings.get('main'))!
    const decision = handlerFor(envelope.type).decide(stored, settings)
    if (decision.status === 'denied') { const outcome = outcomeOf(stored, 'denied', 'CHANGES_STOPPED', decision.reason); await recordCommandOutcomeAudit(commandOutcomeFacts(stored), outcome); await discard(stored); return { outcome, prepared: null } }
    return { outcome: pendingOutcome(stored, decision), prepared: stored }
  } catch (error) {
    // Unverified actors and malformed envelopes are refused without an audit; their identity is never trusted.
    const trusted = Boolean(actor && typeof actor === 'object' && trustedActors.has(actor)), outcome = await refineCommandOutcome(commandOutcome(error, { commandId, entrance: trusted ? actor.entrance : null }), trusted ? actor : null)
    if (trusted && validated && terminalCommandState(outcome.state)) await recordCommandOutcomeAudit({ commandId: validated.command_id, entrance: actor.entrance, principal: actor.principal, type: validated.type, targetId: validated.target_id, basis: validated.basis.kind, fields: Object.keys(validated.payload) }, outcome)
    return { outcome, prepared: null }
  }
}
/** Owner confirms the exact values an agent proposed (S06 parity, design 28.9 external_request). */
export async function confirmCommandValuesFromUI(prepared: PreparedCommand, event: Event, message: string, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone): Promise<CommandPreparation> {
  try {
    const saved = verifyPrepared(prepared)
    if (saved.envelope.type !== 'task.update' || !saved.ownerValues) fail('NO_CHANGE', '本人が確認する指定値はありません')
    const instruction = await confirmTaskInstructionFromUI({ message: message.trim() || '外部から届いた指定値を本人が確認して確定する', referenceDate: today(), timezone, changes: structuredClone(saved.ownerValues) }, humanContextFor(saved.actor), event)
    await discard(saved)
    return prepareCommand(saved.envelope, saved.actor, { instruction, reason: `${saved.reason}（本人が値を確認済み）` })
  } catch (error) { return { outcome: commandOutcome(error, { commandId: prepared?.envelope?.command_id ?? null, entrance: prepared?.actor?.entrance ?? null }), prepared: null } }
}
/** What a pending command waits for, in the shared vocabulary (also used by entrances that keep their own wrapper). */
export function pendingOutcome(prepared: PreparedCommand, decision: ChangePolicyDecision): CommandOutcome {
  return outcomeOf(prepared, 'awaiting_approval', prepared.stage === 'owner_values' ? 'USER_INSTRUCTION_REQUIRED' : decision.status === 'auto' ? null : 'HUMAN_APPROVAL_REQUIRED', decision.reason)
}
export function commandDecision(prepared: PreparedCommand, settings: Settings): ChangePolicyDecision { return handlerFor(prepared.envelope.type).decide(prepared, settings) }
export function commandProtectedFields(prepared: PreparedCommand, settings: Settings): TaskChangeField[] { return commandDecision(prepared, settings).protectedFields }
export const commandTrace = (prepared: PreparedCommand): CommandTrace => ({ entrance: prepared.actor.entrance, basis: prepared.envelope.basis.kind, commandId: prepared.envelope.command_id, label: prepared.actor.label })
/** Approval and application used by every entrance; the file controller adds its lease around applyCommand. */
export async function approveCommandFromUI(prepared: PreparedCommand, event: Event, checked: TaskChangeField[] = []): Promise<unknown> {
  const saved = verifyPrepared(prepared)
  return handlerFor(saved.envelope.type).approve(saved, event, checked)
}
/** File/MCP commands apply only with a one-time capability the file controller issues after main's lease, durable claim and daily bound passed. */
const externalApplyCapabilities = new WeakMap<object, PreparedCommand>()
export function issueExternalApplyCapability(prepared: PreparedCommand): object { const token = Object.freeze({}); externalApplyCapabilities.set(token, prepared); return token }
export async function applyCommand(prepared: PreparedCommand, approval: unknown, requestKey: string, capability?: object): Promise<CommandReceipt> {
  const saved = verifyPrepared(prepared)
  if (saved.actor.entrance === 'file' || saved.actor.entrance === 'mcp' || saved.actor.entrance === 'api') {
    if (!capability || externalApplyCapabilities.get(capability) !== saved) fail('LEASE_INVALID', 'ローカルエージェント接続の画面から承認してください')
    externalApplyCapabilities.delete(capability)
  }
  if (Date.parse(saved.expiresAt) <= Date.now()) fail('EXPIRED', '変更案の確認期限が切れました。差分を作り直してください')
  const result = await handlerFor(saved.envelope.type).apply(saved, approval, requestKey, commandTrace(saved))
  return freeze({ commandId: saved.envelope.command_id, ...result })
}
/** Owner value confirmations of registered types (split) re-enter here with their verified instruction. */
export async function reprepareCommand(prepared: PreparedCommand, instruction: unknown, reason: string): Promise<CommandPreparation> {
  try { const saved = verifyPrepared(prepared); await discard(saved); return prepareCommand(saved.envelope, saved.actor, { instruction, reason }) }
  catch (error) { return { outcome: commandOutcome(error, { commandId: prepared?.envelope?.command_id ?? null, entrance: prepared?.actor?.entrance ?? null }), prepared: null } }
}
export function assertPendingCommand(prepared: PreparedCommand): PreparedCommand { return verifyPrepared(prepared) }
export function settleCommand(prepared: PreparedCommand) { if (pending.get(prepared.id) === prepared) { pending.delete(prepared.id); changed() } }
async function discard(prepared: PreparedCommand) { settleCommand(prepared); await handlerFor(prepared.envelope.type).cancel?.(prepared).catch(() => undefined) }
/** `owner`: the owner's own 取消 button, recorded for S21; internal cleanups pass nothing. */
export async function cancelCommand(prepared: PreparedCommand, reason?: 'owner') {
  if (!isPendingCommand(prepared)) return
  if (reason === 'owner') await recordCommandOutcomeAudit(commandOutcomeFacts(prepared), { state: 'cancelled', code: 'OWNER_CANCELLED', message: '本人が変更案を取り消しました' })
  await discard(prepared)
}
export async function submitCommand(prepared: PreparedCommand, request: CommandSubmitRequest): Promise<CommandOutcome> {
  try {
    const saved = verifyPrepared(prepared)
    const approval = request.event ? await approveCommandFromUI(saved, request.event, request.checkedProtectedFields ?? []) : null
    const receipt = await applyCommand(saved, approval, request.requestKey)
    settleCommand(saved)
    return outcomeOf(saved, 'applied', null, '変更を保存しました', receipt)
  } catch (error) {
    const outcome = await refineCommandOutcome(commandOutcome(error, { commandId: prepared?.envelope?.command_id ?? null, entrance: prepared?.actor?.entrance ?? null }), isPendingCommand(prepared) ? prepared.actor : null)
    if (terminalCommandState(outcome.state) && isPendingCommand(prepared)) { await recordCommandOutcomeAudit(commandOutcomeFacts(prepared), outcome); await discard(prepared) }
    return outcome
  }
}

/** K12/S21: a command that ends without being applied leaves one small audit. Names only: no payload, values or ICS/CSV bodies. */
export type CommandOutcomeFacts = { commandId: string; entrance: CommandEntrance; principal: ChangePrincipal; type: string; targetId: string | null; basis: string; fields: string[] }
export const commandOutcomeFacts = (prepared: PreparedCommand): CommandOutcomeFacts => ({ commandId: prepared.envelope.command_id, entrance: prepared.actor.entrance, principal: prepared.actor.principal, type: prepared.envelope.type, targetId: prepared.envelope.target_id, basis: prepared.envelope.basis.kind, fields: (handlers.get(prepared.envelope.type)?.fields?.(prepared) as string[] | undefined) ?? Object.keys(prepared.envelope.payload) })
const RECORDED_OUTCOMES = ['denied', 'conflict', 'expired', 'rejected', 'cancelled']
const recordedOutcomes = new Map<string, string>()
export async function recordCommandOutcomeAudit(facts: CommandOutcomeFacts, outcome: { state: string; code: string | null; message: string }): Promise<void> {
  if (!RECORDED_OUTCOMES.includes(outcome.state)) return
  // One row per command and result: the file entrance reports through the same bus paths, and a cancel after a denial adds nothing.
  const prior = recordedOutcomes.get(facts.commandId)
  if (prior === outcome.state || prior && outcome.state === 'cancelled') return
  recordedOutcomes.set(facts.commandId, outcome.state)
  if (recordedOutcomes.size > 5000) recordedOutcomes.delete(recordedOutcomes.keys().next().value!)
  try {
    await Dexie.ignoreTransaction(async () => {
      const taskId = facts.targetId && facts.type.startsWith('task.') && await db.tasks.get(facts.targetId) ? facts.targetId : null
      await db.audits.add({ id: uid(), taskId, operation: 'command.rejected', at: new Date().toISOString(), detail: JSON.stringify({ schema: 'command.audit/1', entrance: facts.entrance, principal: { kind: facts.principal.kind, id: facts.principal.id, model: facts.principal.model ?? null }, decision: outcome.state, code: outcome.code, commandId: facts.commandId.slice(0, 200), basis: facts.basis, operation: facts.type.slice(0, 40), fields: facts.fields.slice(0, 50).map(field => String(field).slice(0, 40)), summary: outcome.message.slice(0, 200) }) })
    })
  } catch { /* An audit failure never changes the command outcome. */ }
}

/** K12-G3: owner direct edits keep their own authority but share the structured audit shape. Call inside the write transaction. */
export type HumanCommandAudit = { operation: string; taskId: string | null; commandKey: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; revisionBefore: number | null; revisionAfter: number | null; summary: string; at?: string; extra?: Record<string, unknown> }
const MAX_AUDIT_TEXT = 2000
function bounded(value: unknown): unknown {
  if (typeof value === 'string') return value.length > MAX_AUDIT_TEXT ? `${value.slice(0, MAX_AUDIT_TEXT)}…（${value.length}文字）` : value
  if (Array.isArray(value)) return value.slice(0, 50).map(bounded)
  if (record(value)) return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, child]) => [key, bounded(child)]))
  return value === undefined ? null : value
}
export function changedFields(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
  // Raw values are compared; only the stored excerpts are bounded, so a change past the cutoff still counts.
  // JSON round trip drops nested undefined keys, which canonicalJSON would refuse.
  const raw = (value: unknown) => canonicalJSON(JSON.parse(JSON.stringify(value ?? null)))
  return keys.filter(key => raw(before?.[key]) !== raw(after?.[key])).sort()
}
export async function recordHumanCommand(input: HumanCommandAudit): Promise<void> {
  const settings = await db.settings.get('main'), fields = changedFields(input.before, input.after), at = input.at ?? new Date().toISOString()
  const pick = (value: Record<string, unknown> | null) => value === null ? null : Object.fromEntries(fields.map(field => [field, bounded(value[field] ?? null)]))
  await db.audits.add({ id: uid(), taskId: input.taskId, operation: input.operation, at, detail: JSON.stringify({ schema: 'command.audit/1', entrance: 'ui_human', principal: { kind: 'human', id: settings?.profileId ?? null }, decision: 'self', basis: 'app_instruction', operation: input.operation, commandKey: input.commandKey.slice(0, 200), revisionBefore: input.revisionBefore, revisionAfter: input.revisionAfter, fields, before: pick(input.before), after: pick(input.after), summary: input.summary.slice(0, 500), ...(input.extra ? { extra: bounded(input.extra) } : {}) }) })
}
