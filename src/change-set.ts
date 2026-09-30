import Dexie from 'dexie'
import { db } from './db'
import { contentDigest, canonicalJSON } from './canonical'
import { uid, validateDate, type Settings, type Task } from './domain'

export const taskChangeFields = ['notes', 'scheduledDate'] as const
export type TaskChangeField = typeof taskChangeFields[number]
export type TaskChangePatch = Partial<Pick<Task, TaskChangeField>>
export type ChangePrincipal = { id: string; kind: 'human' | 'coach' | 'external-agent'; model?: string | null }
export type SourceRevision = { id: string; revision: number }
/** Constructed by the authenticated app/transport layer, never by a model payload. */
export type ChangeContext = { principal: ChangePrincipal; ownerId: string; datasetId: string; allowedFields: TaskChangeField[]; sourceRevisions: SourceRevision[] }
export type ChangePolicy = {
  epoch: number; sourcePermissionRevision: number; aiChangesEnabled: boolean
  taskUpdate: 'deny' | 'require_approval' | 'auto_within_bounds'
  bounds: { maxTasks: number; maxScheduledDayShift: number; maxNotesCharacters: number }
  locks: Partial<Record<TaskChangeField, 'unlocked' | 'protect_from_autonomous' | 'locked_until_human_approval'>>
}
export type TaskChangeRequest = { taskId: string; expectedRevision: number; patch: TaskChangePatch }
export type TaskChange = { taskId: string; baseRevision: number; title: string; before: Pick<Task, TaskChangeField>; after: Pick<Task, TaskChangeField>; fields: TaskChangeField[] }
export type PreparedChangeSet = {
  version: 1; id: string; principal: ChangePrincipal; ownerId: string; datasetId: string
  policyEpoch: number; sourcePermissionRevision: number; aiEnabledAtPrepare: boolean; sourceRevisions: SourceRevision[]
  createdAt: string; expiresAt: string; changes: TaskChange[]; reason: string; digest: string
}
export type UIChangeApproval = Readonly<{ id: string; changeSetId: string; digest: string; approvedBy: string; expiresAt: string }>
export type ChangeReceipt = { changeSetId: string; digest: string; taskIds: string[]; revisions: { taskId: string; revision: number }[]; appliedAt: string }
export type ChangePolicyDecision = { status: 'denied' | 'awaiting_approval' | 'auto'; reason: string; protectedFields: TaskChangeField[] }

export class ChangeSetError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}
function fail(code: string, message: string): never { throw new ChangeSetError(code, message) }
const proposals = new Map<string, PreparedChangeSet>()
const approvals = new WeakMap<UIChangeApproval, { proposalId: string; digest: string; policyEpoch: number; sourcePermissionRevision: number; userId: string; checkedFields: TaskChangeField[]; consumed: boolean }>()
const now = () => new Date().toISOString()
const principal = (value: ChangePrincipal): ChangePrincipal => ({ id: value.id, kind: value.kind, model: value.model ?? null })
const sourceOrder = (a:SourceRevision,b:SourceRevision) => a.id<b.id?-1:a.id>b.id?1:0
/** Dataset restore/logout only reduces authority; no serialized grant is trusted. */
export function clearChangeSetAuthority() { proposals.clear() }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function integer(value: unknown, min: number, max: number) { return Number.isInteger(value) && Number(value) >= min && Number(value) <= max }
function id(value: unknown) { return typeof value === 'string' && value.length > 0 && value.length <= 200 }

export const defaultChangePolicy = (): ChangePolicy => ({ epoch: 0, sourcePermissionRevision: 0, aiChangesEnabled: true, taskUpdate: 'require_approval', bounds: { maxTasks: 20, maxScheduledDayShift: 3, maxNotesCharacters: 1000 }, locks: {} })
export function validateChangePolicy(value: unknown): asserts value is ChangePolicy {
  if (!record(value) || !exactKeys(value, ['epoch','sourcePermissionRevision','aiChangesEnabled','taskUpdate','bounds','locks']) || !integer(value.epoch,0,Number.MAX_SAFE_INTEGER) || !integer(value.sourcePermissionRevision,0,Number.MAX_SAFE_INTEGER) || typeof value.aiChangesEnabled !== 'boolean' || !['deny','require_approval','auto_within_bounds'].includes(value.taskUpdate as string)) fail('POLICY_INVALID','変更の権限設定が不正です')
  if (!record(value.bounds) || !exactKeys(value.bounds,['maxTasks','maxScheduledDayShift','maxNotesCharacters']) || !integer(value.bounds.maxTasks,1,100) || !integer(value.bounds.maxScheduledDayShift,0,3650) || !integer(value.bounds.maxNotesCharacters,0,50000)) fail('POLICY_INVALID','変更の上限設定が不正です')
  if (!record(value.locks) || Object.entries(value.locks).some(([field, lock]) => !taskChangeFields.includes(field as TaskChangeField) || !['unlocked','protect_from_autonomous','locked_until_human_approval'].includes(lock as string))) fail('POLICY_INVALID','保護する項目の設定が不正です')
}
export function changePolicyFor(settings: Settings): ChangePolicy {
  const value = (settings as Settings & { changePolicy?: ChangePolicy }).changePolicy ?? defaultChangePolicy()
  validateChangePolicy(value)
  return structuredClone(value)
}
/** Policy updates invalidate queued work; only the owner's trusted setting UI may call this. */
export async function setChangePolicyFromUI(context: ChangeContext, event: Event, next: Omit<ChangePolicy, 'epoch'>): Promise<ChangePolicy> {
  context=freeze(structuredClone(context)); next=freeze(structuredClone(next))
  trustedHumanEvent(context,event)
  return db.transaction('rw', db.settings, async () => {
    const settings = await currentSettings(context)
    const previous = changePolicyFor(settings)
    const policy = { ...structuredClone(next), epoch: previous.epoch + 1 }
    validateChangePolicy(policy)
    await db.settings.put({ ...settings, changePolicy: policy } as Settings & { changePolicy: ChangePolicy })
    return policy
  })
}
function validateContext(context: ChangeContext) {
  if (!context || !id(context.ownerId) || !id(context.datasetId) || !context.principal || !id(context.principal.id) || !['human','coach','external-agent'].includes(context.principal.kind) || context.principal.model != null && (typeof context.principal.model!=='string'||context.principal.model.length>200) || context.principal.kind === 'human' && context.principal.id !== context.ownerId || !Array.isArray(context.allowedFields) || context.allowedFields.some(field => !taskChangeFields.includes(field)) || !Array.isArray(context.sourceRevisions) || context.sourceRevisions.some(source => !record(source) || !exactKeys(source,['id','revision']) || !id(source.id) || !integer(source.revision,0,Number.MAX_SAFE_INTEGER)) || new Set(context.sourceRevisions.map(source=>source.id)).size !== context.sourceRevisions.length) fail('UNAUTHORIZED','この領域の変更は許可されていません')
}
async function currentSettings(context: ChangeContext): Promise<Settings> {
  validateContext(context)
  const settings = await db.settings.get('main')
  if (!settings || settings.profileId !== context.ownerId || settings.datasetId !== context.datasetId) fail('UNAUTHORIZED','この領域の変更は許可されていません')
  return settings
}
function trustedHumanEvent(context: ChangeContext, event: Event) {
  validateContext(context)
  if (context.principal.kind !== 'human' || context.principal.id !== context.ownerId || !(event instanceof Event) || !event.isTrusted || !['click','submit'].includes(event.type)) fail('HUMAN_APPROVAL_REQUIRED','アプリの本人確認ボタンから承認してください')
  // The native Event getter verifies the object has Event's internal slots;
  // plain JSON and objects inheriting Event.prototype cannot become approvals.
  const getType = Object.getOwnPropertyDescriptor(Event.prototype,'type')?.get
  try { if (!getType || !['click','submit'].includes(getType.call(event))) throw new Error() }
  catch { fail('HUMAN_APPROVAL_REQUIRED','アプリの本人確認ボタンから承認してください') }
}
function validatePatch(value: unknown): asserts value is TaskChangePatch {
  if (!record(value) || !Object.keys(value).length || Object.keys(value).some(field => !taskChangeFields.includes(field as TaskChangeField))) fail('UNSUPPORTED_FIELD','この変更ではメモと予定日だけを編集できます。点数・期限・完了・権限の変更には対応していません。')
  if (Object.hasOwn(value,'notes') && (typeof value.notes !== 'string' || value.notes.length > 50000)) fail('INVALID_INPUT','メモは50,000文字以内で入力してください')
  if (Object.hasOwn(value,'scheduledDate')) {
    if (value.scheduledDate !== null && typeof value.scheduledDate !== 'string') fail('INVALID_INPUT','予定日が不正です')
    try { validateDate(value.scheduledDate as string|null,'予定日') } catch { fail('INVALID_INPUT','予定日が不正です') }
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
async function verifyProposal(value: PreparedChangeSet): Promise<PreparedChangeSet> {
  if (!record(value) || !exactKeys(value,['version','id','principal','ownerId','datasetId','policyEpoch','sourcePermissionRevision','aiEnabledAtPrepare','sourceRevisions','createdAt','expiresAt','changes','reason','digest'])) fail('INVALID_CHANGE_SET','変更案の形式が不正です')
  const saved = proposals.get(value.id)
  if (!saved) fail('UNVERIFIED_CHANGE_SET','この変更案をアプリで作り直してください')
  const copy = structuredClone(value)
  const { digest, ...payload } = copy
  if (digest !== saved.digest || digest !== await Dexie.waitFor(contentDigest(payload))) fail('DIGEST_MISMATCH','確認した変更内容が変わりました。差分を作り直してください')
  if (proposals.get(saved.id)!==saved) fail('UNVERIFIED_CHANGE_SET','この変更案は取り消されました')
  return saved
}
function authorizeProposal(prepared: PreparedChangeSet, context: ChangeContext, settings: Settings, asApprover = false) {
  const policy = changePolicyFor(settings)
  if (prepared.ownerId !== context.ownerId || prepared.datasetId !== context.datasetId || !asApprover && canonicalJSON(principal(context.principal)) !== canonicalJSON(prepared.principal)) fail('UNAUTHORIZED','この変更案を実行する権限がありません')
  if (prepared.changes.some(change => change.fields.some(field => !context.allowedFields.includes(field)))) fail('UNAUTHORIZED','この項目の変更は許可されていません')
  if (policy.epoch !== prepared.policyEpoch || settings.aiEnabled !== prepared.aiEnabledAtPrepare) fail('POLICY_CHANGED','変更案の作成後にAIまたは権限設定が変わりました。差分を作り直してください')
  if (policy.sourcePermissionRevision !== prepared.sourcePermissionRevision || canonicalJSON(context.sourceRevisions.slice().sort(sourceOrder)) !== canonicalJSON(prepared.sourceRevisions)) fail('SOURCE_PERMISSION_CHANGED','出典の版または利用許可が変わりました。差分を作り直してください')
  if (prepared.principal.kind !== 'human' && (!settings.aiEnabled || !policy.aiChangesEnabled || policy.taskUpdate === 'deny')) fail('CHANGES_STOPPED','AIによる変更は停止しています')
  if (Date.parse(prepared.expiresAt) <= Date.now()) fail('EXPIRED','変更案の確認期限が切れました。差分を作り直してください')
  return policy
}
function changedCharacters(before: string, after: string) {
  let prefix = 0, suffix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  while (suffix < before.length-prefix && suffix < after.length-prefix && before[before.length-1-suffix] === after[after.length-1-suffix]) suffix++
  return Math.max(before.length-prefix-suffix,after.length-prefix-suffix)
}
export function decideChangePolicy(prepared: PreparedChangeSet, policy: ChangePolicy): ChangePolicyDecision {
  validateChangePolicy(policy)
  const agent = prepared.principal.kind !== 'human'
  const protectedFields = [...new Set(prepared.changes.flatMap(change => change.fields.filter(field => policy.locks[field] === 'locked_until_human_approval' || agent && policy.locks[field] === 'protect_from_autonomous')))]
  if (agent && (!policy.aiChangesEnabled || policy.taskUpdate === 'deny')) return {status:'denied',reason:'AIによる変更は停止しています',protectedFields}
  if (!agent || policy.taskUpdate !== 'auto_within_bounds' || protectedFields.length) return {status:'awaiting_approval',reason:protectedFields.length?'保護された項目の本人確認が必要です':'この変更の本人確認が必要です',protectedFields}
  if (prepared.changes.length > policy.bounds.maxTasks) return {status:'awaiting_approval',reason:'自動変更の件数上限を超えています',protectedFields}
  for (const change of prepared.changes) {
    if (change.fields.includes('notes') && changedCharacters(change.before.notes,change.after.notes) > policy.bounds.maxNotesCharacters) return {status:'awaiting_approval',reason:'メモの自動変更量を超えています',protectedFields}
    if (change.fields.includes('scheduledDate')) {
      const a=change.before.scheduledDate,b=change.after.scheduledDate
      if (!a || !b || Math.abs(Date.parse(`${a}T00:00:00Z`)-Date.parse(`${b}T00:00:00Z`))/86400000 > policy.bounds.maxScheduledDayShift) return {status:'awaiting_approval',reason:'予定日の自動移動範囲を超えています',protectedFields}
    }
  }
  return {status:'auto',reason:'本人が設定した自動変更の範囲内です',protectedFields}
}

export async function prepareTaskChanges(requests: TaskChangeRequest[], context: ChangeContext, reason = 'メモと予定日の変更'): Promise<PreparedChangeSet> {
  for (const [key,proposal] of proposals) if (Date.parse(proposal.expiresAt)<=Date.now()) proposals.delete(key)
  requests=freeze(structuredClone(requests)); context=freeze(structuredClone(context))
  validateContext(context)
  if (!Array.isArray(requests) || !requests.length || requests.length > 100 || new Set(requests.map(item=>item?.taskId)).size !== requests.length) fail('INVALID_INPUT','重複のない1〜100件のタスクを指定してください')
  if (typeof reason !== 'string' || reason.length > 1000) fail('INVALID_INPUT','変更理由は1,000文字以内にしてください')
  for (const request of requests) {
    if (!record(request) || !exactKeys(request,['taskId','expectedRevision','patch']) || !id(request.taskId) || !integer(request.expectedRevision,1,Number.MAX_SAFE_INTEGER)) fail('INVALID_INPUT','変更対象の指定が不正です')
    validatePatch(request.patch)
    if (Object.keys(request.patch).some(field=>!context.allowedFields.includes(field as TaskChangeField))) fail('UNAUTHORIZED','この項目の変更は許可されていません')
  }
  const payload = await db.transaction('r',db.tasks,db.settings,async()=>{
    const settings = await currentSettings(context), policy=changePolicyFor(settings)
    if (context.principal.kind !== 'human' && (!settings.aiEnabled || !policy.aiChangesEnabled || policy.taskUpdate==='deny')) fail('CHANGES_STOPPED','AIによる変更は停止しています')
    const changes: TaskChange[] = []
    for (const request of requests) {
      const task=await db.tasks.get(request.taskId)
      if (!task || task.deletedAt) fail('UNAUTHORIZED','この領域の変更は許可されていません')
      if (task.revision!==request.expectedRevision) fail('CONFLICT','タスクが更新されています。新しい版で差分を作り直してください')
      const before={notes:task.notes,scheduledDate:task.scheduledDate},after={...before,...request.patch}
      const fields=taskChangeFields.filter(field=>before[field]!==after[field])
      if (!fields.length) fail('NO_CHANGE','変更する内容がありません')
      changes.push({taskId:task.id,baseRevision:task.revision,title:task.title,before,after,fields})
    }
    const createdAt=now()
    return {version:1 as const,id:uid(),principal:principal(context.principal),ownerId:context.ownerId,datasetId:context.datasetId,policyEpoch:policy.epoch,sourcePermissionRevision:policy.sourcePermissionRevision,aiEnabledAtPrepare:settings.aiEnabled,sourceRevisions:structuredClone(context.sourceRevisions.slice().sort(sourceOrder)),createdAt,expiresAt:new Date(Date.now()+24*60*60*1000).toISOString(),changes,reason}
  })
  const prepared=freeze({...payload,digest:await Dexie.waitFor(contentDigest(payload))})
  proposals.set(prepared.id,prepared)
  return prepared
}

export async function cancelChangeSet(value: PreparedChangeSet, context: ChangeContext): Promise<void> {
  context=freeze(structuredClone(context))
  const prepared=await verifyProposal(value)
  await currentSettings(context)
  if (prepared.ownerId!==context.ownerId || prepared.datasetId!==context.datasetId || context.principal.kind!=='human' && canonicalJSON(principal(context.principal))!==canonicalJSON(prepared.principal)) fail('UNAUTHORIZED','この変更案を取り消す権限がありません')
  proposals.delete(prepared.id)
}

export async function approveChangeSetFromUI(value: PreparedChangeSet, context: ChangeContext, event: Event, checkedProtectedFields: TaskChangeField[] = []): Promise<UIChangeApproval> {
  context=freeze(structuredClone(context)); checkedProtectedFields=[...checkedProtectedFields]
  trustedHumanEvent(context,event)
  const prepared=await verifyProposal(value)
  const settings=await currentSettings(context),policy=authorizeProposal(prepared,context,settings,true)
  const decision=decideChangePolicy(prepared,policy)
  if (decision.status==='denied') fail('CHANGES_STOPPED',decision.reason)
  if (checkedProtectedFields.some(field=>!taskChangeFields.includes(field)) || decision.protectedFields.some(field=>!checkedProtectedFields.includes(field))) fail('PROTECTED_FIELD_APPROVAL_REQUIRED','保護された項目を個別に確認してください')
  const grant=Object.freeze({id:uid(),changeSetId:prepared.id,digest:prepared.digest,approvedBy:context.ownerId,expiresAt:prepared.expiresAt})
  approvals.set(grant,{proposalId:prepared.id,digest:prepared.digest,policyEpoch:prepared.policyEpoch,sourcePermissionRevision:prepared.sourcePermissionRevision,userId:context.ownerId,checkedFields:[...checkedProtectedFields],consumed:false})
  return grant
}

export async function applyChangeSet(value: PreparedChangeSet, approval: UIChangeApproval | null, context: ChangeContext, requestKey: string): Promise<ChangeReceipt> {
  context=freeze(structuredClone(context))
  validateContext(context)
  if (!id(requestKey)) fail('INVALID_REQUEST_KEY','実行キーを指定してください')
  const prepared=await verifyProposal(value)
  const requestStorageKey=`changeset:request:${await Dexie.waitFor(contentDigest({principalId:context.principal.id,requestKey}))}`
  const appliedStorageKey=`changeset:applied:${prepared.id}`
  const receipt=await db.transaction('rw',db.tasks,db.settings,db.commands,db.audits,async()=>{
    if (proposals.get(prepared.id)!==prepared) fail('UNVERIFIED_CHANGE_SET','この変更案は取り消されました')
    const settings=await currentSettings(context),policy=authorizeProposal(prepared,context,settings)
    const decision=decideChangePolicy(prepared,policy)
    if (decision.status==='denied') fail('CHANGES_STOPPED',decision.reason)
    const grant=approval ? approvals.get(approval) : undefined
    if (approval && (!grant || grant.proposalId!==prepared.id || grant.digest!==prepared.digest || grant.userId!==context.ownerId || grant.policyEpoch!==policy.epoch || grant.sourcePermissionRevision!==policy.sourcePermissionRevision)) fail('INVALID_APPROVAL','この変更に対する本人承認が確認できません')
    if (decision.status!=='auto' && !grant) fail('HUMAN_APPROVAL_REQUIRED','この変更を本人が確認してください')
    if (decision.protectedFields.some(field=>!grant?.checkedFields.includes(field))) fail('PROTECTED_FIELD_APPROVAL_REQUIRED','保護された項目を個別に確認してください')
    const priorRequest=await db.commands.get(requestStorageKey)
    if (priorRequest) {
      if (priorRequest.hash!==prepared.digest) fail('IDEMPOTENCY_MISMATCH','同じ実行キーが別の変更内容に使われています')
      return JSON.parse(priorRequest.resultId) as ChangeReceipt
    }
    const priorApplied=await db.commands.get(appliedStorageKey)
    if (priorApplied) {
      if (priorApplied.hash!==prepared.digest) fail('IDEMPOTENCY_MISMATCH','適用済み変更の内容が一致しません')
      await db.commands.add({key:requestStorageKey,hash:prepared.digest,resultId:priorApplied.resultId,at:now()})
      return JSON.parse(priorApplied.resultId) as ChangeReceipt
    }
    if (grant?.consumed) fail('APPROVAL_CONSUMED','この本人承認は既に使用されています')
    const tasks=await Promise.all(prepared.changes.map(change=>db.tasks.get(change.taskId)))
    if (tasks.some((task,index)=>!task || task.deletedAt || task.revision!==prepared.changes[index].baseRevision || task.title!==prepared.changes[index].title || task.notes!==prepared.changes[index].before.notes || task.scheduledDate!==prepared.changes[index].before.scheduledDate)) fail('CONFLICT','タスクが更新されています。新しい版で差分を確認してください')
    const at=now(),revisions:ChangeReceipt['revisions']=[]
    for (const [index,change] of prepared.changes.entries()) {
      const task=tasks[index]!
      await db.tasks.put({...task,...change.after,firstScheduledDate:task.firstScheduledDate??task.scheduledDate??change.after.scheduledDate,revision:task.revision+1,updatedAt:at})
      revisions.push({taskId:task.id,revision:task.revision+1})
      await db.audits.add({id:uid(),taskId:task.id,operation:'changeset.update',at,detail:JSON.stringify({changeSetId:prepared.id,digest:prepared.digest,principal:prepared.principal,approvedBy:grant?.userId??null,policyEpoch:policy.epoch,sourcePermissionRevision:policy.sourcePermissionRevision,sourceRevisions:prepared.sourceRevisions,before:change.before,after:change.after,reason:prepared.reason,undo:{expectedRevision:task.revision+1,patch:Object.fromEntries(change.fields.map(field=>[field,change.before[field]]))}})})
    }
    const result:ChangeReceipt={changeSetId:prepared.id,digest:prepared.digest,taskIds:prepared.changes.map(change=>change.taskId),revisions,appliedAt:at}
    const resultId=JSON.stringify(result)
    await db.commands.add({key:appliedStorageKey,hash:prepared.digest,resultId,at})
    await db.commands.add({key:requestStorageKey,hash:prepared.digest,resultId,at})
    return result
  })
  if (approval) { const grant=approvals.get(approval); if(grant) grant.consumed=true }
  return receipt
}
