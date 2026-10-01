import Dexie from 'dexie'
import { db } from './db'
import { contentDigest, canonicalJSON } from './canonical'
import { calculateScore, uid, validateDate, validateTaskDue, validateTaskInput, type ScoreInput, type Settings, type Task } from './domain'
import { assertTripTaskScoreChangeAllowed } from './trip-bundles'
import { localDateAt, localTimeAt } from './zoned-time'
import { cancelCoachNotificationTarget } from './coach-notification-save'
import { assertTaskInstruction, clearTaskInstructionAuthority, type VerifiedTaskInstruction } from './task-user-instruction'
import { autoChangeCounts, automationRulesFor, changeAuditFact, coachMediatedChange, OPERATION_INFO, operationsForFields, ownerTimezone, validateAllowedHours, validateAutomationRules, validateStopFlags, withinAllowedHours, type AllowedHours, type AutomationRule, type AutomationStopFlags, type ChangeAuditFact, type OperationGroup } from './automation-policy'

export const taskChangeFields = ['title', 'notes', 'scheduledDate', 'dueDate', 'dueAt', 'manualPoints'] as const
export type TaskChangeField = typeof taskChangeFields[number]
/** A clock deadline: UTC instant plus the IANA zone it was set in; the task's dueDate must be its local date. */
export type TaskDueClock = { at: string; timezone: string }
export type TaskChangePatch = Partial<Pick<Task, 'title'|'notes'|'scheduledDate'|'dueDate'>> & { dueAt?: TaskDueClock|null; manualPoints?: number }
/** Display text for a change value; a clock deadline shows its local date-time in its own zone. */
export function taskChangeValueText(value: TaskChangeValues[keyof TaskChangeValues] | undefined): string {
  if (value === null || value === undefined) return '未設定'
  if (typeof value === 'object') return `${localDateAt(value.at, value.timezone)} ${localTimeAt(value.at, value.timezone)}（${value.timezone}）`
  return String(value)
}
export type ChangePrincipal = { id: string; kind: 'human' | 'coach' | 'external-agent'; model?: string | null }
export type SourceRevision = { id: string; revision: number }
/** Constructed by the authenticated app/transport layer, never by a model payload. */
export type TaskFieldOrigin = 'human'|'agent_proposal'|'human_override'|'user_instruction_via_agent'
export type ChangeContext = { principal: ChangePrincipal; ownerId: string; datasetId: string; allowedFields: TaskChangeField[]; sourceRevisions: SourceRevision[]; fieldOrigins?:Partial<Record<TaskChangeField,TaskFieldOrigin>> }
export type ChangePolicy = {
  epoch: number; sourcePermissionRevision: number; aiChangesEnabled: boolean
  taskUpdate: 'deny' | 'require_approval' | 'auto_within_bounds'
  bounds: { maxTasks: number; maxScheduledDayShift: number; maxNotesCharacters: number }
  locks: Partial<Record<TaskChangeField, 'unlocked' | 'protect_from_autonomous' | 'locked_until_human_approval'>>
  /** New fields never inherit the old notes/schedule automatic permission. */
  fieldRules?: Partial<Record<'title'|'dueDate'|'manualPoints', 'deny'|'require_approval'>>
  /** N09 operation table; older data has none and is derived from taskUpdate/fieldRules with identical decisions. */
  operations?: AutomationRule[]
  allowedHours?: Partial<Record<OperationGroup, AllowedHours>>
  stops?: AutomationStopFlags
}
export type TaskChangeRequest = { taskId: string; expectedRevision: number; patch: TaskChangePatch }
export type TaskChangeValues = Pick<Task,'title'|'notes'|'scheduledDate'|'dueDate'> & { dueAt: TaskDueClock|null; manualPoints: number|null }
export type TaskChange = { taskId: string; baseRevision: number; title: string; before: TaskChangeValues; after: TaskChangeValues; fields: TaskChangeField[]; patch: TaskChangePatch; scoreBefore: ScoreInput; scoreAfter: ScoreInput; assessmentBefore: string; effectivePointsBefore: number|null; fieldOrigins:Partial<Record<TaskChangeField,TaskFieldOrigin>> }
export type PreparedChangeSet = {
  version: 1; id: string; principal: ChangePrincipal; ownerId: string; datasetId: string
  policyEpoch: number; sourcePermissionRevision: number; aiEnabledAtPrepare: boolean; sourceRevisions: SourceRevision[]
  createdAt: string; expiresAt: string; changes: TaskChange[]; reason: string; instruction: VerifiedTaskInstruction|null; digest: string
}
export type UIChangeApproval = Readonly<{ id: string; changeSetId: string; digest: string; approvedBy: string; expiresAt: string }>
export type ChangeReceipt = { changeSetId: string; digest: string; taskIds: string[]; revisions: { taskId: string; revision: number }[]; appliedAt: string }
export type ChangePolicyDecision = { status: 'denied' | 'awaiting_approval' | 'auto'; reason: string; protectedFields: TaskChangeField[] }
/** Facts outside the ChangeSet that bound automatic changes; omitted values mean no count/time restriction. */
export type ChangeDecisionContext = { at?: string; timezone?: string; autoCountToday?: Partial<Record<OperationGroup, number>> }

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
// prepared ChangeSet id -> audit id (single) or task id -> audit id (whole ChangeSet undo)
const undoLinks = new Map<string, string | Record<string, string>>()
/** Dataset restore/logout only reduces authority; no serialized grant is trusted. */
export function clearChangeSetAuthority() { proposals.clear(); undoLinks.clear(); clearTaskInstructionAuthority() }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function integer(value: unknown, min: number, max: number) { return Number.isInteger(value) && Number(value) >= min && Number(value) <= max }
function id(value: unknown) { return typeof value === 'string' && value.length > 0 && value.length <= 200 }

export const defaultChangePolicy = (): ChangePolicy => ({ epoch: 0, sourcePermissionRevision: 0, aiChangesEnabled: true, taskUpdate: 'require_approval', bounds: { maxTasks: 20, maxScheduledDayShift: 3, maxNotesCharacters: 1000 }, locks: {}, fieldRules: { title:'require_approval', dueDate:'require_approval', manualPoints:'require_approval' } })
export function validateChangePolicy(value: unknown): asserts value is ChangePolicy {
  if (!record(value) || !['epoch','sourcePermissionRevision','aiChangesEnabled','taskUpdate','bounds','locks'].every(key=>Object.hasOwn(value,key)) || Object.keys(value).some(key=>!['epoch','sourcePermissionRevision','aiChangesEnabled','taskUpdate','bounds','locks','fieldRules','operations','allowedHours','stops'].includes(key)) || !integer(value.epoch,0,Number.MAX_SAFE_INTEGER) || !integer(value.sourcePermissionRevision,0,Number.MAX_SAFE_INTEGER) || typeof value.aiChangesEnabled !== 'boolean' || !['deny','require_approval','auto_within_bounds'].includes(value.taskUpdate as string)) fail('POLICY_INVALID','変更の権限設定が不正です')
  if (!record(value.bounds) || !exactKeys(value.bounds,['maxTasks','maxScheduledDayShift','maxNotesCharacters']) || !integer(value.bounds.maxTasks,1,100) || !integer(value.bounds.maxScheduledDayShift,0,3650) || !integer(value.bounds.maxNotesCharacters,0,50000)) fail('POLICY_INVALID','変更の上限設定が不正です')
  if (!record(value.locks) || Object.entries(value.locks).some(([field, lock]) => !taskChangeFields.includes(field as TaskChangeField) || !['unlocked','protect_from_autonomous','locked_until_human_approval'].includes(lock as string))) fail('POLICY_INVALID','保護する項目の設定が不正です')
  if (value.fieldRules !== undefined && (!record(value.fieldRules) || Object.entries(value.fieldRules).some(([field, rule])=>!['title','dueDate','manualPoints'].includes(field)||!['deny','require_approval'].includes(rule as string)))) fail('POLICY_INVALID','追加項目の変更設定が不正です')
  try {
    if (value.operations !== undefined) validateAutomationRules(value.operations)
    if (value.allowedHours !== undefined) validateAllowedHours(value.allowedHours)
    if (value.stops !== undefined) validateStopFlags(value.stops)
  } catch (error) { fail('POLICY_INVALID', error instanceof Error ? error.message : '操作別の設定が不正です') }
}
export function changePolicyFor(settings: Settings): ChangePolicy {
  const value = (settings as Settings & { changePolicy?: ChangePolicy }).changePolicy ?? defaultChangePolicy()
  validateChangePolicy(value)
  return { ...structuredClone(value), fieldRules: { ...defaultChangePolicy().fieldRules, ...value.fieldRules } }
}
/** Policy updates invalidate queued work; only the owner's trusted setting UI may call this. */
export async function setChangePolicyFromUI(context: ChangeContext, event: Event, next: Omit<ChangePolicy, 'epoch'>): Promise<ChangePolicy> {
  context=freeze(structuredClone(context)); next=freeze(structuredClone(next))
  trustedHumanEvent(context,event)
  return db.transaction('rw', db.settings, async () => {
    const settings = await currentSettings(context)
    const previous = changePolicyFor(settings)
    // The N09 table, time windows and stop switches change only through S20 (dry run + native click); this legacy setter must not drop or widen them.
    if (['operations','allowedHours','stops'].some(key=>Object.hasOwn(next,key))||previous.operations||previous.allowedHours||previous.stops) fail('PREVIEW_REQUIRED','操作別の自動化設定は「自動化と承認」画面で試算を確認して保存してください')
    const policy = { ...structuredClone(next), epoch: previous.epoch + 1 }
    validateChangePolicy(policy)
    await db.settings.put({ ...settings, changePolicy: policy } as Settings & { changePolicy: ChangePolicy })
    return policy
  })
}
function validateContext(context: ChangeContext) {
  if (!context || !id(context.ownerId) || !id(context.datasetId) || !context.principal || !id(context.principal.id) || !['human','coach','external-agent'].includes(context.principal.kind) || context.principal.model != null && (typeof context.principal.model!=='string'||context.principal.model.length>200) || context.principal.kind === 'human' && context.principal.id !== context.ownerId || !Array.isArray(context.allowedFields) || context.allowedFields.some(field => !taskChangeFields.includes(field)) || !Array.isArray(context.sourceRevisions) || context.sourceRevisions.some(source => !record(source) || !exactKeys(source,['id','revision']) || !id(source.id) || !integer(source.revision,0,Number.MAX_SAFE_INTEGER)) || new Set(context.sourceRevisions.map(source=>source.id)).size !== context.sourceRevisions.length) fail('UNAUTHORIZED','この領域の変更は許可されていません')
  if(context.fieldOrigins!==undefined&&(!record(context.fieldOrigins)||Object.entries(context.fieldOrigins).some(([field,origin])=>!taskChangeFields.includes(field as TaskChangeField)||!['human','agent_proposal','human_override','user_instruction_via_agent'].includes(origin))))fail('UNAUTHORIZED','変更項目の由来が不正です')
}
async function currentSettings(context: ChangeContext): Promise<Settings> {
  validateContext(context)
  const settings = await db.settings.get('main')
  if (!settings || settings.profileId !== context.ownerId || settings.datasetId !== context.datasetId) fail('UNAUTHORIZED','この領域の変更は許可されていません')
  return settings
}
/** Owner-only native click/submit; agents, coach principals and synthetic events cannot pass. */
export function assertTrustedOwnerEvent(context: ChangeContext, event: Event) { trustedHumanEvent(context, event) }
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
  if (!record(value) || !Object.keys(value).length || Object.keys(value).some(field => !taskChangeFields.includes(field as TaskChangeField))) fail('UNSUPPORTED_FIELD','タイトル・メモ・予定日・期限・本人指定ポイントだけを編集できます。完了・配分・系列・権限には別の操作が必要です。')
  if (Object.hasOwn(value,'title') && (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 300)) fail('INVALID_INPUT','タイトルは1〜300文字で入力してください')
  if (Object.hasOwn(value,'notes') && (typeof value.notes !== 'string' || value.notes.length > 50000)) fail('INVALID_INPUT','メモは50,000文字以内で入力してください')
  for (const field of ['scheduledDate','dueDate'] as const) if (Object.hasOwn(value,field)) {
    if (value[field] !== null && typeof value[field] !== 'string') fail('INVALID_INPUT','日付が不正です')
    try { validateDate(value[field] as string|null,'日付') } catch { fail('INVALID_INPUT','日付が不正です') }
  }
  if (Object.hasOwn(value,'manualPoints') && !integer(value.manualPoints,0,100000)) fail('INVALID_INPUT','本人指定ポイントは0〜100000の整数にしてください')
  if (Object.hasOwn(value,'dueAt') && value.dueAt !== null && (!record(value.dueAt) || !exactKeys(value.dueAt,['at','timezone']) || typeof value.dueAt.at !== 'string' || typeof value.dueAt.timezone !== 'string')) fail('INVALID_INPUT','締め切り時刻はUTC時刻とタイムゾーンで指定してください')
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
async function verifyProposal(value: PreparedChangeSet): Promise<PreparedChangeSet> {
  if (!record(value) || !exactKeys(value,['version','id','principal','ownerId','datasetId','policyEpoch','sourcePermissionRevision','aiEnabledAtPrepare','sourceRevisions','createdAt','expiresAt','changes','reason','instruction','digest'])) fail('INVALID_CHANGE_SET','変更案の形式が不正です')
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
  if (prepared.principal.kind !== 'human' && (!settings.aiEnabled || !policy.aiChangesEnabled || deniedOperation(policy,prepared.changes.flatMap(change=>change.fields)))) fail('CHANGES_STOPPED','AIによる変更は停止しています')
  if (Date.parse(prepared.expiresAt) <= Date.now()) fail('EXPIRED','変更案の確認期限が切れました。差分を作り直してください')
  return policy
}
const requiresInstruction = (changes: TaskChange[]) => changes.some(change=>change.fields.some(field=>['title','dueDate','dueAt','manualPoints'].includes(field)))
const instructionRequests = (changes: TaskChange[]): TaskChangeRequest[] => changes.map(change=>({taskId:change.taskId,expectedRevision:change.baseRevision,patch:change.patch}))
function verifyInstruction(prepared: PreparedChangeSet, context: ChangeContext, settings: Settings) {
  if (requiresInstruction(prepared.changes) || prepared.instruction) {
    try { assertTaskInstruction(prepared.instruction,instructionRequests(prepared.changes),context,settings) }
    catch (error) { fail('USER_INSTRUCTION_REQUIRED',error instanceof Error?error.message:'本人の指示を確認してください') }
  }
}
async function ownedTaskContainer(task:Task,ownerId:string) {
  if (task.containerId) { const container=await db.containers.get(task.containerId); if(!container||container.deletedAt||container.ownerId!==ownerId) fail('UNAUTHORIZED','このタスクの所属領域を編集する権限がありません') }
}
function values(task:Task):TaskChangeValues { return {title:task.title,notes:task.notes,scheduledDate:task.scheduledDate,dueDate:task.dueDate,dueAt:task.dueAt&&task.dueTimezone?{at:task.dueAt,timezone:task.dueTimezone}:null,manualPoints:task.score.manualPoints} }
function changedCharacters(before: string, after: string) {
  let prefix = 0, suffix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  while (suffix < before.length-prefix && suffix < after.length-prefix && before[before.length-1-suffix] === after[after.length-1-suffix]) suffix++
  return Math.max(before.length-prefix-suffix,after.length-prefix-suffix)
}
function deniedOperation(policy: ChangePolicy, fields: TaskChangeField[]): OperationGroup | null {
  const rules=automationRulesFor(policy)
  return operationsForFields(fields).find(operation=>rules.find(rule=>rule.operation===operation)?.mode==='deny') ?? null
}
/** N09 order: stop → per-operation deny → instruction/protection → per-operation approval → bounds (amount/time/count). */
export function decideChangePolicy(prepared: PreparedChangeSet, policy: ChangePolicy, context: ChangeDecisionContext = {}): ChangePolicyDecision {
  validateChangePolicy(policy)
  const agent = prepared.principal.kind !== 'human', rules = automationRulesFor(policy), fields = prepared.changes.flatMap(change => change.fields), operations = operationsForFields(fields)
  const protectedFields = [...new Set(prepared.changes.flatMap(change => change.fields.filter(field => field==='manualPoints'||field==='dueDate'||field==='dueAt'||policy.locks[field] === 'locked_until_human_approval' || agent && policy.locks[field] === 'protect_from_autonomous')))]
  const rule = (operation: OperationGroup) => rules.find(item => item.operation === operation)!
  if (agent && !policy.aiChangesEnabled) return {status:'denied',reason:'AIによる変更は停止しています',protectedFields}
  const denied = agent ? operations.find(operation => rule(operation).mode === 'deny') : undefined
  if (denied) return {status:'denied',reason:denied==='task.text'||denied==='task.schedule'?`AIによる変更は停止しています（${OPERATION_INFO[denied].label}）`:`この項目の代理変更は停止しています（${OPERATION_INFO[denied].label}）`,protectedFields}
  if (agent && fields.includes('title') && policy.fieldRules?.title === 'deny') return {status:'denied',reason:'この項目の代理変更は停止しています（タイトル）',protectedFields}
  if (requiresInstruction(prepared.changes)) return {status:'awaiting_approval',reason:'本人が指定したタイトル・期限・ポイントの変更は毎回内容を確認します',protectedFields}
  if (!agent || operations.some(operation => rule(operation).mode !== 'auto_within_bounds') || protectedFields.length) return {status:'awaiting_approval',reason:protectedFields.length?'保護された項目の本人確認が必要です':'この変更の本人確認が必要です',protectedFields}
  if (prepared.changes.length > policy.bounds.maxTasks) return {status:'awaiting_approval',reason:'自動変更の件数上限を超えています',protectedFields}
  for (const change of prepared.changes) {
    if (change.fields.includes('notes') && changedCharacters(change.before.notes,change.after.notes) > policy.bounds.maxNotesCharacters) return {status:'awaiting_approval',reason:'メモの自動変更量を超えています',protectedFields}
    if (change.fields.includes('scheduledDate')) {
      const a=change.before.scheduledDate,b=change.after.scheduledDate,limit=rule('task.schedule').max_schedule_days_delta??policy.bounds.maxScheduledDayShift
      if (!a || !b || Math.abs(Date.parse(`${a}T00:00:00Z`)-Date.parse(`${b}T00:00:00Z`))/86400000 > limit) return {status:'awaiting_approval',reason:'予定日の自動移動範囲を超えています',protectedFields}
    }
  }
  const at = context.at ?? new Date().toISOString(), timezone = context.timezone ?? ownerTimezone()
  for (const operation of operations) {
    const hours = policy.allowedHours?.[operation]
    if (!withinAllowedHours(at,timezone,hours)) return {status:'awaiting_approval',reason:`自動変更を許可した時間帯（${hours!.start}〜${hours!.end}）の外です`,protectedFields}
    const adding = prepared.changes.filter(change => operationsForFields(change.fields).includes(operation)).length
    if (context.autoCountToday && (context.autoCountToday[operation] ?? 0) + adding > rule(operation).max_daily_count) return {status:'awaiting_approval',reason:`今日の自動変更の上限（${OPERATION_INFO[operation].label} ${rule(operation).max_daily_count}件）に達しています`,protectedFields}
  }
  return {status:'auto',reason:'本人が設定した自動変更の範囲内です',protectedFields}
}
/** Today's automatic agent changes from audits, inside the caller's transaction, counted across entrances. */
export async function autoChangeCountsToday(at = new Date().toISOString(), timezone = ownerTimezone()): Promise<Partial<Record<OperationGroup, number>>> {
  const recent = await db.audits.where('at').above(new Date(Date.parse(at)-50*60*60*1000).toISOString()).toArray()
  // A clock moved back must not reopen the bound: count the day of the latest audit when it is ahead of now.
  return autoChangeCounts(recent,recent.reduce((latest,audit)=>audit.at>latest?audit.at:latest,at),timezone)
}

export async function prepareTaskChanges(requests: TaskChangeRequest[], context: ChangeContext, reason = '選択したタスクの変更', instruction:VerifiedTaskInstruction|null=null): Promise<PreparedChangeSet> {
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
  const payload = await db.transaction('r',db.tasks,db.settings,db.containers,db.tripBundles,async()=>{
    const settings = await currentSettings(context), policy=changePolicyFor(settings)
    if (context.principal.kind !== 'human' && (!settings.aiEnabled || !policy.aiChangesEnabled || deniedOperation(policy,requests.flatMap(request=>Object.keys(request.patch) as TaskChangeField[])))) fail('CHANGES_STOPPED','AIによる変更は停止しています')
    const changes: TaskChange[] = []
    for (const request of requests) {
      const task=await db.tasks.get(request.taskId)
      if (!task || task.deletedAt) fail('UNAUTHORIZED','この領域の変更は許可されていません')
      await ownedTaskContainer(task,context.ownerId)
      if (task.revision!==request.expectedRevision) fail('CONFLICT','タスクが更新されています。新しい版で差分を作り直してください')
      const before=values(task),after:TaskChangeValues={...before,...request.patch,...(request.patch.title!==undefined?{title:request.patch.title.trim()}:{})}
      // A clock deadline and a different deadline day never coexist; moving or clearing the day needs an explicit clock decision.
      if(after.dueAt||before.dueAt&&!Object.hasOwn(request.patch,'dueAt')&&after.dueDate!==before.dueDate){try{validateTaskDue({dueDate:after.dueDate,dueAt:after.dueAt?.at??null,dueTimezone:after.dueAt?.timezone??null})}catch(error){fail('INVALID_INPUT',`${error instanceof Error?error.message:'締め切りが不正です'}。時刻付きの締め切りは日付と時刻を一緒に指定してください`)}}
      const scoreAfter=Object.hasOwn(request.patch,'manualPoints')?{...task.score,mode:'manual' as const,manualPoints:request.patch.manualPoints!}:structuredClone(task.score)
      validateTaskInput({...task,...after,score:scoreAfter})
      const fields=taskChangeFields.filter(field=>Object.hasOwn(request.patch,field)&&(canonicalJSON(before[field])!==canonicalJSON(after[field])||field==='manualPoints'&&task.score.mode!=='manual'))
      if (!fields.length) fail('NO_CHANGE','変更する内容がありません')
      if(fields.includes('manualPoints')) assertTripTaskScoreChangeAllowed(task.id,task.score,scoreAfter,await db.tripBundles.toArray())
      const fieldOrigins=Object.fromEntries(fields.map(field=>[field,context.principal.kind==='human'?'human':context.fieldOrigins?.[field]==='human_override'?'human_override':instruction?'user_instruction_via_agent':'agent_proposal']))
      changes.push({taskId:task.id,baseRevision:task.revision,title:task.title,before,after,fields,patch:request.patch,scoreBefore:structuredClone(task.score),scoreAfter,assessmentBefore:task.assessmentId,effectivePointsBefore:task.effectivePoints,fieldOrigins})
    }
    if(requiresInstruction(changes)||instruction){
      try { assertTaskInstruction(instruction,requests,context,settings) }
      catch(error){fail('USER_INSTRUCTION_REQUIRED',error instanceof Error?error.message:'本人の指示を確認してください')}
      if(changes.some((change,index)=>canonicalJSON(change.scoreBefore)!==canonicalJSON(instruction.changes[index].scoreBefore))) fail('CONFLICT','本人指示を確認した後にポイントの状態が変わりました')
    }
    if(context.principal.kind!=='human'&&(changes.some(change=>change.fields.includes('title'))&&policy.fieldRules?.title==='deny'||deniedOperation(policy,changes.flatMap(change=>change.fields))))fail('CHANGES_STOPPED','この項目の代理変更は停止しています')
    const createdAt=now()
    return {version:1 as const,id:uid(),principal:principal(context.principal),ownerId:context.ownerId,datasetId:context.datasetId,policyEpoch:policy.epoch,sourcePermissionRevision:policy.sourcePermissionRevision,aiEnabledAtPrepare:settings.aiEnabled,sourceRevisions:structuredClone(context.sourceRevisions.slice().sort(sourceOrder)),createdAt,expiresAt:instruction?.expiresAt??new Date(Date.now()+24*60*60*1000).toISOString(),changes,reason,instruction}
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
  verifyInstruction(prepared,context,settings)
  const decision=decideChangePolicy(prepared,policy)
  if (decision.status==='denied') fail('CHANGES_STOPPED',decision.reason)
  if (checkedProtectedFields.some(field=>!taskChangeFields.includes(field)) || decision.protectedFields.some(field=>!checkedProtectedFields.includes(field))) fail('PROTECTED_FIELD_APPROVAL_REQUIRED','保護された項目を個別に確認してください')
  const grant=Object.freeze({id:uid(),changeSetId:prepared.id,digest:prepared.digest,approvedBy:context.ownerId,expiresAt:prepared.expiresAt})
  approvals.set(grant,{proposalId:prepared.id,digest:prepared.digest,policyEpoch:prepared.policyEpoch,sourcePermissionRevision:prepared.sourcePermissionRevision,userId:context.ownerId,checkedFields:[...checkedProtectedFields],consumed:false})
  return grant
}

/** Audit-only facts supplied by the command bus (entrance/basis/commandId); never authority. */
export type ChangeTrace = { entrance: string; basis: string; commandId: string; label?: string | null }
export async function applyChangeSet(value: PreparedChangeSet, approval: UIChangeApproval | null, context: ChangeContext, requestKey: string, trace: ChangeTrace | null = null): Promise<ChangeReceipt> {
  const enclosing=Dexie.currentTransaction
  context=freeze(structuredClone(context))
  validateContext(context)
  if (!id(requestKey)) fail('INVALID_REQUEST_KEY','実行キーを指定してください')
  const prepared=await verifyProposal(value)
  const requestStorageKey=`changeset:request:${await Dexie.waitFor(contentDigest({principalId:context.principal.id,requestKey}))}`
  const appliedStorageKey=`changeset:applied:${prepared.id}`
  const receipt=await db.transaction('rw',[db.tasks,db.settings,db.commands,db.audits,db.assessments,db.tripBundles,db.containers],async()=>{
    if (proposals.get(prepared.id)!==prepared) fail('UNVERIFIED_CHANGE_SET','この変更案は取り消されました')
    const settings=await currentSettings(context),policy=authorizeProposal(prepared,context,settings)
    verifyInstruction(prepared,context,settings)
    const at=now(),timezone=ownerTimezone()
    const decision=decideChangePolicy(prepared,policy,{at,timezone,autoCountToday:await autoChangeCountsToday(at,timezone)})
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
    if (tasks.some((task,index)=>!task || task.deletedAt || task.revision!==prepared.changes[index].baseRevision || canonicalJSON(values(task))!==canonicalJSON(prepared.changes[index].before) || canonicalJSON(task.score)!==canonicalJSON(prepared.changes[index].scoreBefore)||task.assessmentId!==prepared.changes[index].assessmentBefore||task.effectivePoints!==prepared.changes[index].effectivePointsBefore)) fail('CONFLICT','タスクが更新されています。新しい版で差分を確認してください')
    const revisions:ChangeReceipt['revisions']=[],undoLink=undoLinks.get(prepared.id)
    // An owner undo without a caller trace is still recorded in the current format (S21 entrance and basis).
    const undoCommandId = typeof undoLink === 'string' ? undoLink : undoLink ? Object.values(undoLink)[0] : undefined
    const traced: ChangeTrace | null = trace ?? (undoCommandId ? { entrance: 'ui_human', basis: 'app_instruction', commandId: `undo:${undoCommandId}`, label: null } : null)
    for (const [index,change] of prepared.changes.entries()) {
      const task=tasks[index]!
      await ownedTaskContainer(task,context.ownerId)
      let assessmentId=task.assessmentId
      const scoreChanged=change.fields.includes('manualPoints')
      const result=calculateScore(change.scoreAfter)
      if(scoreChanged){
        assertTripTaskScoreChangeAllowed(task.id,task.score,change.scoreAfter,await db.tripBundles.toArray())
        assessmentId=uid()
        const agent=prepared.principal.kind!=='human'
        await db.assessments.add({id:assessmentId,taskId:task.id,score:structuredClone(change.scoreAfter),result,createdAt:at,origin:agent?'user_instruction_via_agent':'human',ruleVersion:'v1',...(agent?{instruction:{id:prepared.instruction!.id,digest:prepared.instruction!.digest,ownerId:prepared.ownerId,datasetId:prepared.datasetId,actorId:prepared.principal.id,actorKind:prepared.principal.kind as 'coach'|'external-agent',model:prepared.principal.model??null,taskRevision:task.revision,approvedBy:grant!.userId}}:{})})
      }
      const {manualPoints:_manualPoints,dueAt,...after}=change.after
      await db.tasks.put({...task,...after,...(dueAt||task.dueAt?{dueAt:dueAt?.at??null,dueTimezone:dueAt?.timezone??null}:{}),score:structuredClone(change.scoreAfter),assessmentId,effectivePoints:result.effective,firstScheduledDate:task.firstScheduledDate??task.scheduledDate??change.after.scheduledDate,revision:task.revision+1,updatedAt:at})
      await cancelCoachNotificationTarget(task.id,at)
      revisions.push({taskId:task.id,revision:task.revision+1})
      await db.audits.add({id:uid(),taskId:task.id,operation:'changeset.update',at,detail:JSON.stringify({changeSetId:prepared.id,digest:prepared.digest,principal:prepared.principal,decision:grant?'approved':'auto',operations:operationsForFields(change.fields),...(undoLink?{undoOf:typeof undoLink==='string'?undoLink:undoLink[task.id]}:{}),...(traced?{entrance:String(traced.entrance).slice(0,40),basis:String(traced.basis).slice(0,40),commandId:String(traced.commandId).slice(0,200),...(traced.label?{label:String(traced.label).slice(0,100)}:{})}:{}),origin:prepared.principal.kind==='human'?'human':prepared.instruction?'user_instruction_via_agent':'agent_proposal',approvedBy:grant?.userId??null,policyEpoch:policy.epoch,sourcePermissionRevision:policy.sourcePermissionRevision,sourceRevisions:prepared.sourceRevisions,instruction:prepared.instruction,before:change.before,after:change.after,scoreBefore:change.scoreBefore,scoreAfter:change.scoreAfter,assessmentBefore:task.assessmentId,assessmentAfter:assessmentId,fieldOrigins:change.fieldOrigins,reason:prepared.reason,undo:{expectedRevision:task.revision+1,patch:Object.fromEntries(change.fields.map(field=>[field,change.before[field]])),...(scoreChanged?{score:change.scoreBefore,requiresNewInstruction:true}:{})}})})
    }
    const result:ChangeReceipt={changeSetId:prepared.id,digest:prepared.digest,taskIds:prepared.changes.map(change=>change.taskId),revisions,appliedAt:at}
    const resultId=JSON.stringify(result)
    await db.commands.add({key:appliedStorageKey,hash:prepared.digest,resultId,at})
    await db.commands.add({key:requestStorageKey,hash:prepared.digest,resultId,at})
    return result
  })
  if (approval) { const grant=approvals.get(approval); if(grant) { if(enclosing){let root=enclosing;while(root.parent)root=root.parent;root.on('complete',()=>{grant.consumed=true})}else grant.consumed=true } }
  return receipt
}

export type UndoRediff = { field: TaskChangeField; recorded: unknown; current: unknown; restore: unknown }
export type UndoPreparation = { status: 'prepared'; auditId: string; prepared: PreparedChangeSet } | { status: 'conflict'; auditId: string; taskId: string; rediff: UndoRediff[] } | { status: 'already_undone'; auditId: string }
/** Owner-approved inverse ChangeSet built from the stored undo patch at the current revision; completions and the ledger are never touched. */
export async function prepareUndoFromAudit(auditId: string, context: ChangeContext, instruction: VerifiedTaskInstruction|null = null): Promise<UndoPreparation> {
  return prepareUndoFromAudits([auditId],context,instruction)
}
/** Inverse of several task rows of ONE earlier ChangeSet (e.g. a replan that moved 2 tasks), applied atomically after the owner's click. */
export async function prepareUndoFromAudits(auditIds: string[], context: ChangeContext, instruction: VerifiedTaskInstruction|null = null): Promise<UndoPreparation> {
  context=freeze(structuredClone(context)); validateContext(context)
  if (context.principal.kind!=='human') fail('HUMAN_APPROVAL_REQUIRED','取り消しは本人の確認画面から行います')
  if (!Array.isArray(auditIds)||!auditIds.length||auditIds.length>50||new Set(auditIds).size!==auditIds.length) fail('UNDO_UNAVAILABLE','取り消せる変更記録がありません')
  const found=await db.transaction('r',db.audits,db.tasks,db.settings,async()=>{
    await currentSettings(context)
    const rows:{auditId:string;task:Task;fact:ChangeAuditFact}[]=[],seen:ChangeAuditFact[]=[]
    for (const auditId of auditIds) {
      const audit=await db.audits.get(auditId),fact=audit?changeAuditFact(audit):null
      if (!fact||!fact.taskId||!fact.undo||!record(fact.undo.patch)||!fact.fields.length||fact.undoOf) fail('UNDO_UNAVAILABLE','取り消せる変更記録がありません')
      // Ordinary owner edits are reverted by editing; owner-approved coach-screen changes may be undone from the coach.
      if (!coachMediatedChange(fact)) fail('UNDO_UNAVAILABLE','本人の変更は通常のタスク編集で戻してください')
      if (seen.length&&(fact.changeSetId!==seen[0].changeSetId||seen.some(item=>item.taskId===fact.taskId))) fail('UNDO_UNAVAILABLE','一つの変更の分だけ取り消せます')
      seen.push(fact)
      // Rows already undone one by one are skipped; the rest of the same ChangeSet stays undoable.
      if ((await db.audits.where('taskId').equals(fact.taskId).toArray()).some(item=>changeAuditFact(item)?.undoOf===auditId)) continue
      const task=await db.tasks.get(fact.taskId)
      if (!task||task.deletedAt) fail('UNDO_UNAVAILABLE','対象のタスクがありません')
      const current=values(task)
      // A later edit is never overwritten: the owner sees a re-diff instead.
      if (task.revision!==fact.undo.expectedRevision||fact.fields.some(field=>canonicalJSON(current[field])!==canonicalJSON(fact.after[field]??null))) return {status:'conflict' as const,auditId,taskId:task.id,rediff:fact.fields.map(field=>({field,recorded:fact.after[field]??null,current:current[field],restore:fact.undo!.patch[field]??null}))}
      rows.push({auditId,task,fact})
    }
    if (!rows.length) return {status:'already_undone' as const,auditId:auditIds[0]}
    return {status:'ready' as const,rows}
  })
  if (found.status==='already_undone') return {status:'already_undone',auditId:found.auditId}
  if (found.status==='conflict') return {status:'conflict',auditId:found.auditId,taskId:found.taskId,rediff:found.rediff}
  for (const {fact} of found.rows) {
    const undo=fact.undo!
    if (undo.requiresNewInstruction) {
      const before=undo.score as ScoreInput|undefined
      if (!before||before.mode!=='manual'||!Number.isInteger(before.manualPoints)) fail('UNDO_UNAVAILABLE','元の点数方式へは自動で戻せません。タスク編集で本人が設定してください。完了記録と実績台帳は変わりません。')
      if (!instruction) fail('USER_INSTRUCTION_REQUIRED','点数の取り消しには本人の新しい指示が必要です。完了記録と実績台帳は変わりません。')
    }
    if (!instruction&&fact.fields.some(field=>field==='title'||field==='dueDate'||field==='dueAt'||field==='manualPoints')) fail('USER_INSTRUCTION_REQUIRED','タイトル・本当の締め切りの取り消しには本人の新しい指示が必要です。タスク編集で本人が直接戻すこともできます。')
  }
  const first=found.rows[0].fact,label=first.principal.kind==='human'?'コーチ経由の変更の取り消し':'代理変更の取り消し'
  const prepared=await prepareTaskChanges(found.rows.map(({task,fact})=>({taskId:task.id,expectedRevision:task.revision,patch:structuredClone(fact.undo!.patch) as TaskChangePatch})),{...context,allowedFields:[...new Set(found.rows.flatMap(row=>row.fact.fields))]},`${label}（元の変更 ${first.changeSetId.slice(0,8)}）`,instruction)
  undoLinks.set(prepared.id,found.rows.length===1?found.rows[0].auditId:Object.fromEntries(found.rows.map(row=>[row.task.id,row.auditId])))
  return {status:'prepared',auditId:found.rows[0].auditId,prepared}
}
