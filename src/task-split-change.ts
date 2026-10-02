import { authorityMatches, processingAllowed, processingEpoch } from './external-authority'
import Dexie from 'dexie'
import { db } from './db'
import { canonicalJSON, contentDigest } from './canonical'
import { uid, type AssessmentInstruction, type ScoreInput, type Settings, type Task } from './domain'
import { ChangeSetError, changePolicyFor, type ChangeContext, type ChangePolicyDecision, type ChangePrincipal, type ChangeTrace, type SourceRevision } from './change-set'
import { operationMode } from './automation-policy'
import { applyTaskSplitInTransaction, taskSplitTables, validateSplitSteps } from './breakdown'
import { assertTripTaskScoreChangeAllowed } from './trip-bundles'
import { assertPendingCommand, changeContextFor, commandOutcome, humanContextFor, registerCommandType, reprepareCommand, type CommandEnvelope, type CommandPreparation, type PreparedCommand } from './command-bus'

/** N03 proxy split: a reviewable change kind with the ChangeSet guarantees (digest, native approval, one transaction). */
export type SplitValueOrigin = 'owner_text' | 'human' | 'agent_proposal'
export type SplitChildDraft = { title: string; points: number | null; titleOrigin: SplitValueOrigin; pointsOrigin: SplitValueOrigin | null }
export type SplitChild = { key: string; title: string; points: number; titleOrigin: SplitValueOrigin; pointsOrigin: SplitValueOrigin }
export type SplitValuesInput = { taskId: string; expectedRevision: number; children: SplitChildDraft[]; message: string }
export type VerifiedSplitInstruction = Readonly<{
  version: 1; id: string; nonce: string; ownerId: string; datasetId: string; policyEpoch: number; sourcePermissionRevision: number
  issuedAt: string; expiresAt: string; messageDigest: string; taskId: string; expectedRevision: number; parentScoreBefore: ScoreInput; children: SplitChild[]; digest: string
}>
export type PreparedTaskSplit = Readonly<{
  version: 1; kind: 'task.split'; id: string; principal: ChangePrincipal; ownerId: string; datasetId: string; policyEpoch: number; sourcePermissionRevision: number; aiEnabledAtPrepare: boolean; processingEpoch: number; sourceRevisions: SourceRevision[]
  createdAt: string; expiresAt: string; taskId: string; baseRevision: number; parentTitle: string; parentScoreBefore: ScoreInput; parentAssessmentBefore: string; parentEffectiveBefore: number | null
  children: SplitChild[]; total: number; instruction: VerifiedSplitInstruction; reason: string; digest: string
}>
export type TaskSplitApproval = Readonly<{ id: string; splitId: string; digest: string; approvedBy: string; expiresAt: string }>
export type TaskSplitReceipt = { changeSetId: string; digest: string; parentId: string; childIds: string[]; appliedAt: string }

function fail(code: string, message: string): never { throw new ChangeSetError(code, message) }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) }
const issued = new Map<string, VerifiedSplitInstruction>()
const proposals = new Map<string, PreparedTaskSplit>()
const approvals = new WeakMap<TaskSplitApproval, { splitId: string; digest: string; userId: string; policyEpoch: number; consumed: boolean }>()
export function clearTaskSplitAuthority(options: {coachOnly?: boolean; externalOnly?: boolean; clientId?: string} = {}) { if(options.coachOnly||options.externalOnly||options.clientId){for(const [id,value] of proposals)if(authorityMatches(value.principal,options))proposals.delete(id)}else{issued.clear(); proposals.clear()} }
function ownerEvent(context: ChangeContext, event: Event) {
  if (context.principal.kind !== 'human' || context.principal.id !== context.ownerId || !(event instanceof Event) || !event.isTrusted || !['click', 'submit'].includes(event.type)) fail('HUMAN_APPROVAL_REQUIRED', 'アプリの本人確認ボタンから操作してください')
  const getter = Object.getOwnPropertyDescriptor(Event.prototype, 'type')?.get
  try { if (!getter || !['click', 'submit'].includes(getter.call(event))) throw new Error() } catch { fail('HUMAN_APPROVAL_REQUIRED', 'アプリの本人確認ボタンから操作してください') }
}
async function settingsFor(context: ChangeContext): Promise<Settings> {
  const settings = await db.settings.get('main')
  if (!settings || settings.profileId !== context.ownerId || settings.datasetId !== context.datasetId || !['human', 'coach', 'external-agent'].includes(context.principal.kind) || context.principal.kind === 'human' && context.principal.id !== context.ownerId) fail('UNAUTHORIZED', 'この領域の変更は許可されていません')
  return settings
}
/** Splits move manual points, so agents need AI on, changes on and both the split and manual-points operations not denied (N09). */
export function splitPolicyDecision(settings: Settings, principal: ChangePrincipal): ChangePolicyDecision {
  const policy = changePolicyFor(settings)
  if (principal.kind !== 'human' && (!processingAllowed(settings, principal) || !policy.aiChangesEnabled || operationMode(policy, 'task.split') === 'deny' || operationMode(policy, 'task.manual_points') === 'deny')) return { status: 'denied', reason: 'AIによるタスクの分割は停止しています（自動化設定）', protectedFields: ['manualPoints'] }
  return { status: 'awaiting_approval', reason: 'タスクの分割は毎回本人が配分を確認します', protectedFields: ['manualPoints'] }
}
async function ownedContainer(task: Task, ownerId: string) {
  if (task.containerId) { const container = await db.containers.get(task.containerId); if (!container || container.deletedAt || container.ownerId !== ownerId) fail('UNAUTHORIZED', 'このタスクの所属領域を編集する権限がありません') }
}
async function splittable(task: Task | undefined, revision: number, ownerId: string): Promise<Task> {
  if (!task || task.deletedAt) fail('UNAUTHORIZED', 'この領域の変更は許可されていません')
  await ownedContainer(task, ownerId)
  if (task.revision !== revision) fail('CONFLICT', 'タスクが更新されています。新しい版で分割案を作り直してください')
  if (task.status !== 'open' || !['manual', 'allocated'].includes(task.score.mode) || !Number.isInteger(task.score.manualPoints)) fail('SPLIT_NOT_ALLOWED', '未完了で本人がポイントを確定したタスクだけを分割できます')
  try { assertTripTaskScoreChangeAllowed(task.id, task.score, { ...task.score, manualPoints: 0 }, await db.tripBundles.toArray()) } catch { fail('SPLIT_NOT_ALLOWED', '共通外出に配分したタスクは分割できません。まとめを取り消してから分割してください') }
  return task
}
function children(values: SplitChildDraft[]): SplitChild[] {
  if (!Array.isArray(values) || values.length < 2 || values.length > 20) fail('SPLIT_INVALID', '分割は2〜20件で指定してください')
  if (values.some(child => !record(child) || child.points === null)) fail('SPLIT_ALLOCATION_REQUIRED', '各子タスクの配分ポイントを本人が入力してください')
  const origins: SplitValueOrigin[] = ['owner_text', 'human', 'agent_proposal']
  if (values.some(child => !origins.includes(child.titleOrigin) || !origins.includes(child.pointsOrigin!))) fail('SPLIT_INVALID', '分割値の由来が不正です')
  let steps
  try { steps = validateSplitSteps(values.map(child => ({ title: child.title, points: child.points! }))) } catch (error) { fail('SPLIT_INVALID', error instanceof Error ? error.message : '分割値が不正です') }
  return steps.map((step, index) => ({ key: `child-${index + 1}`, title: step.title, points: step.points, titleOrigin: values[index].titleOrigin, pointsOrigin: values[index].pointsOrigin! }))
}

/** The owner's native click fixes the exact titles and points; model output alone never allocates points. */
export async function confirmSplitValuesFromUI(input: SplitValuesInput, ownerContext: ChangeContext, event: Event): Promise<VerifiedSplitInstruction> {
  ownerEvent(ownerContext, event)
  if (!record(input) || typeof input.taskId !== 'string' || !Number.isSafeInteger(input.expectedRevision) || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 4000) fail('INVALID_INPUT', '分割する対象と本人の指示を確認してください')
  for (const [key, value] of issued) if (Date.parse(value.expiresAt) <= Date.now()) issued.delete(key)
  const confirmed = children(structuredClone(input.children))
  const payload = await db.transaction('r', [db.tasks, db.settings, db.containers, db.tripBundles], async () => {
    const settings = await settingsFor(ownerContext), task = await splittable(await db.tasks.get(input.taskId), input.expectedRevision, ownerContext.ownerId)
    const total = confirmed.reduce((sum, child) => sum + child.points, 0)
    if (total !== task.score.manualPoints) fail('SPLIT_INVALID', `配分合計を親の${task.score.manualPoints}ptに合わせてください（現在${total}pt）`)
    const policy = changePolicyFor(settings), issuedAt = new Date().toISOString()
    return { version: 1 as const, id: uid(), nonce: uid(), ownerId: settings.profileId, datasetId: settings.datasetId, policyEpoch: policy.epoch, sourcePermissionRevision: policy.sourcePermissionRevision, issuedAt, expiresAt: new Date(Date.now() + 86400000).toISOString(), messageDigest: await Dexie.waitFor(contentDigest(input.message)), taskId: task.id, expectedRevision: task.revision, parentScoreBefore: structuredClone(task.score), children: confirmed }
  })
  const value = freeze({ ...payload, digest: await contentDigest(payload) })
  issued.set(value.id, value)
  return value
}
function assertInstruction(value: VerifiedSplitInstruction, settings: Settings) {
  const policy = changePolicyFor(settings)
  if (!value || issued.get(value.id) !== value || value.ownerId !== settings.profileId || value.datasetId !== settings.datasetId) fail('USER_INSTRUCTION_REQUIRED', '本人が分割の指定値をアプリで確定してください')
  if (value.policyEpoch !== policy.epoch || value.sourcePermissionRevision !== policy.sourcePermissionRevision) fail('POLICY_CHANGED', '指定値の確認後にAIまたは権限設定が変わりました。分割案を作り直してください')
  if (Date.parse(value.expiresAt) <= Date.now()) fail('EXPIRED', '分割の指定値の確認期限が切れました')
}
function authorize(prepared: PreparedTaskSplit, context: ChangeContext, settings: Settings, asApprover: boolean) {
  const policy = changePolicyFor(settings)
  if (prepared.ownerId !== context.ownerId || prepared.datasetId !== context.datasetId || !asApprover && canonicalJSON({ ...context.principal, model: context.principal.model ?? null }) !== canonicalJSON(prepared.principal)) fail('UNAUTHORIZED', 'この分割案を実行する権限がありません')
  if (policy.epoch !== prepared.policyEpoch || processingAllowed(settings, prepared.principal) !== prepared.aiEnabledAtPrepare || processingEpoch(settings, prepared.principal) !== prepared.processingEpoch) fail('POLICY_CHANGED', '分割案の作成後にAIまたは権限設定が変わりました。差分を作り直してください')
  if (policy.sourcePermissionRevision !== prepared.sourcePermissionRevision) fail('POLICY_CHANGED', '利用許可が変わりました。差分を作り直してください')
  if (splitPolicyDecision(settings, prepared.principal).status === 'denied') fail('CHANGES_STOPPED', 'AIによる変更は停止しています')
  if (Date.parse(prepared.expiresAt) <= Date.now()) fail('EXPIRED', '分割案の確認期限が切れました。差分を作り直してください')
  assertInstruction(prepared.instruction, settings)
}
async function verify(value: PreparedTaskSplit): Promise<PreparedTaskSplit> {
  const saved = record(value) ? proposals.get(value.id as string) : undefined
  if (!saved) fail('UNVERIFIED_CHANGE_SET', 'この分割案をアプリで作り直してください')
  const { digest, ...payload } = structuredClone(value)
  if (digest !== saved.digest || digest !== await Dexie.waitFor(contentDigest(payload))) fail('DIGEST_MISMATCH', '確認した分割内容が変わりました。差分を作り直してください')
  return saved
}

export async function prepareTaskSplit(instruction: VerifiedSplitInstruction, context: ChangeContext, reason = '選択したタスクの分割（まだ適用していません）'): Promise<PreparedTaskSplit> {
  for (const [key, value] of proposals) if (Date.parse(value.expiresAt) <= Date.now()) proposals.delete(key)
  if (typeof reason !== 'string' || reason.length > 1000) fail('INVALID_INPUT', '分割理由は1,000文字以内にしてください')
  const payload = await db.transaction('r', [db.tasks, db.settings, db.containers, db.tripBundles], async () => {
    const settings = await settingsFor(context)
    if (splitPolicyDecision(settings, context.principal).status === 'denied') fail('CHANGES_STOPPED', 'AIによる変更は停止しています')
    assertInstruction(instruction, settings)
    const task = await splittable(await db.tasks.get(instruction.taskId), instruction.expectedRevision, context.ownerId)
    if (canonicalJSON(task.score) !== canonicalJSON(instruction.parentScoreBefore)) fail('CONFLICT', '本人指示を確認した後にポイントの状態が変わりました')
    const total = instruction.children.reduce((sum, child) => sum + child.points, 0)
    if (total !== task.score.manualPoints) fail('SPLIT_INVALID', `配分合計を親の${task.score.manualPoints}ptに合わせてください`)
    const policy = changePolicyFor(settings), createdAt = new Date().toISOString()
    return { version: 1 as const, kind: 'task.split' as const, id: uid(), principal: { id: context.principal.id, kind: context.principal.kind, model: context.principal.model ?? null }, ownerId: context.ownerId, datasetId: context.datasetId, policyEpoch: policy.epoch, sourcePermissionRevision: policy.sourcePermissionRevision, aiEnabledAtPrepare: processingAllowed(settings, context.principal), processingEpoch: processingEpoch(settings, context.principal), sourceRevisions: structuredClone(context.sourceRevisions), createdAt, expiresAt: instruction.expiresAt, taskId: task.id, baseRevision: task.revision, parentTitle: task.title, parentScoreBefore: structuredClone(task.score), parentAssessmentBefore: task.assessmentId, parentEffectiveBefore: task.effectivePoints, children: structuredClone(instruction.children), total, instruction, reason }
  })
  const prepared = freeze({ ...payload, digest: await contentDigest(payload) })
  proposals.set(prepared.id, prepared)
  return prepared
}
export async function cancelTaskSplit(value: PreparedTaskSplit) { const saved = proposals.get(value?.id); if (saved === value) proposals.delete(value.id) }
export async function approveTaskSplitFromUI(value: PreparedTaskSplit, ownerContext: ChangeContext, event: Event, checked: string[] = []): Promise<TaskSplitApproval> {
  ownerEvent(ownerContext, event)
  const prepared = await verify(value), settings = await settingsFor(ownerContext)
  authorize(prepared, ownerContext, settings, true)
  if (!checked.includes('manualPoints')) fail('PROTECTED_FIELD_APPROVAL_REQUIRED', '本人指定ポイントの保護を個別に確認してください')
  const grant = Object.freeze({ id: uid(), splitId: prepared.id, digest: prepared.digest, approvedBy: ownerContext.ownerId, expiresAt: prepared.expiresAt })
  approvals.set(grant, { splitId: prepared.id, digest: prepared.digest, userId: ownerContext.ownerId, policyEpoch: prepared.policyEpoch, consumed: false })
  return grant
}
/** Never automatic: a split always needs the owner's approval of this exact digest. */
export async function applyTaskSplit(value: PreparedTaskSplit, approval: TaskSplitApproval | null, context: ChangeContext, requestKey: string, trace: ChangeTrace | null = null): Promise<TaskSplitReceipt> {
  if (typeof requestKey !== 'string' || !requestKey || requestKey.length > 200) fail('INVALID_REQUEST_KEY', '実行キーを指定してください')
  const prepared = await verify(value)
  const requestStorageKey = `split:request:${await Dexie.waitFor(contentDigest({ principalId: context.principal.id, requestKey }))}`, appliedStorageKey = `split:applied:${prepared.id}`
  const receipt = await db.transaction('rw', [...taskSplitTables(), db.containers], async () => {
    if (proposals.get(prepared.id) !== prepared) fail('UNVERIFIED_CHANGE_SET', 'この分割案は取り消されました')
    const settings = await settingsFor(context)
    authorize(prepared, context, settings, false)
    const grant = approval ? approvals.get(approval) : undefined
    if (!grant) fail('HUMAN_APPROVAL_REQUIRED', 'この分割を本人が確認してください')
    if (grant.splitId !== prepared.id || grant.digest !== prepared.digest || grant.userId !== context.ownerId || grant.policyEpoch !== prepared.policyEpoch) fail('INVALID_APPROVAL', 'この分割に対する本人承認が確認できません')
    for (const key of [requestStorageKey, appliedStorageKey]) {
      const prior = await db.commands.get(key)
      if (prior) { if (prior.hash !== prepared.digest) fail('IDEMPOTENCY_MISMATCH', '同じ実行キーが別の分割内容に使われています'); if (key === appliedStorageKey) await db.commands.add({ key: requestStorageKey, hash: prepared.digest, resultId: prior.resultId, at: prior.at }); return JSON.parse(prior.resultId) as TaskSplitReceipt }
    }
    if (grant.consumed) fail('APPROVAL_CONSUMED', 'この本人承認は既に使用されています')
    const parent = await splittable(await db.tasks.get(prepared.taskId), prepared.baseRevision, context.ownerId)
    if (canonicalJSON(parent.score) !== canonicalJSON(prepared.parentScoreBefore) || parent.assessmentId !== prepared.parentAssessmentBefore || parent.effectivePoints !== prepared.parentEffectiveBefore) fail('CONFLICT', 'タスクが更新されています。新しい版で分割を確認してください')
    const steps = prepared.children.map(child => ({ title: child.title, points: child.points }))
    const hash = JSON.stringify({ operation: 'breakdown', proposal: { id: prepared.id, taskId: parent.id, parentRevision: prepared.baseRevision, reason: 'proxy_split', steps }, digest: prepared.digest })
    const agent = prepared.principal.kind !== 'human'
    const audit = { entrance: trace?.entrance ?? (agent ? 'ui_coach' : 'ui_human'), basis: trace?.basis ?? 'app_instruction', commandId: trace?.commandId ?? null, ...(trace?.label ? { label: trace.label } : {}), principal: prepared.principal, decision: 'approved', approvedBy: grant.userId, changeSetId: prepared.id, digest: prepared.digest, policyEpoch: prepared.policyEpoch, sourcePermissionRevision: prepared.sourcePermissionRevision, origin: agent ? 'user_instruction_via_agent' : 'human', instructionId: prepared.instruction.id, instructionDigest: prepared.instruction.digest, childOrigins: prepared.children.map(child => ({ key: child.key, titleOrigin: child.titleOrigin, pointsOrigin: child.pointsOrigin })), reason: prepared.reason }
    const instruction: AssessmentInstruction | null = agent ? { id: prepared.instruction.id, digest: prepared.instruction.digest, ownerId: prepared.ownerId, datasetId: prepared.datasetId, actorId: prepared.principal.id, actorKind: prepared.principal.kind as 'coach' | 'external-agent', model: prepared.principal.model ?? null, taskRevision: parent.revision, approvedBy: grant.userId } : null
    const summary = `${prepared.total}ptを${steps.length}件へ配分（${agent ? '代理分割・本人承認' : '本人の分割'}）`
    const childIds = await applyTaskSplitInTransaction(parent, steps, prepared.id, hash, instruction ? { origin: 'user_instruction_via_agent', instruction, audit } : { origin: 'human' }, summary)
    const at = (await db.tasks.get(parent.id))!.updatedAt
    const result: TaskSplitReceipt = { changeSetId: prepared.id, digest: prepared.digest, parentId: parent.id, childIds, appliedAt: at }
    await db.commands.add({ key: appliedStorageKey, hash: prepared.digest, resultId: JSON.stringify(result), at })
    await db.commands.add({ key: requestStorageKey, hash: prepared.digest, resultId: JSON.stringify(result), at })
    return result
  })
  const grant = approval ? approvals.get(approval) : undefined
  if (grant) grant.consumed = true
  return receipt
}

/** Envelope payload {children:[{title, points|null}]}; external values stay proposals until the owner confirms them. */
function validateEnvelope(envelope: CommandEnvelope) {
  const payload = envelope.payload
  if (typeof envelope.target_id !== 'string' || !envelope.target_id || envelope.target_id.length > 200 || !Number.isSafeInteger(envelope.expected_revision) || envelope.expected_revision! < 1) fail('INVALID_TARGET', '分割する親タスクと版を指定してください')
  if (Object.keys(payload).length !== 1 || !Array.isArray(payload.children)) fail('UNSUPPORTED_FIELD', '分割は子タスクの名前とポイントだけを指定できます')
  const list = payload.children as unknown[]
  if (list.length < 2 || list.length > 20 || list.some(child => !record(child) || Object.keys(child).length !== 2 || !Object.hasOwn(child, 'title') || !Object.hasOwn(child, 'points') || typeof child.title !== 'string' || !child.title.trim() || child.title.length > 300 || child.points !== null && (!Number.isSafeInteger(child.points) || Number(child.points) < 0 || Number(child.points) > 100000))) fail('INVALID_PAYLOAD', '分割は2〜20件の名前と0以上の整数ポイント（または未設定）で指定してください')
}
export type SplitCommandBody = { stage: 'owner_values'; proposed: { title: string; points: number | null }[] } | { stage: 'review'; split: PreparedTaskSplit }
export const splitBody = (prepared: PreparedCommand) => prepared.body as SplitCommandBody
registerCommandType({
  type: 'task.split',
  validate: validateEnvelope,
  async prepare(envelope, actor, options) {
    if (options.instruction) {
      const split = await prepareTaskSplit(options.instruction as VerifiedSplitInstruction, changeContextFor(actor), options.reason)
      if (split.taskId !== envelope.target_id || split.baseRevision !== envelope.expected_revision) { await cancelTaskSplit(split); fail('CONFLICT', '分割する親タスクまたは版が変わりました') }
      return { stage: 'review', body: { stage: 'review', split }, expiresAt: split.expiresAt, reason: split.reason }
    }
    const context = changeContextFor(actor), settings = await settingsFor(context)
    if (splitPolicyDecision(settings, context.principal).status === 'denied') fail('CHANGES_STOPPED', 'AIによる変更は停止しています')
    await db.transaction('r', [db.tasks, db.containers, db.tripBundles], async () => { await splittable(await db.tasks.get(envelope.target_id!), envelope.expected_revision!, actor.ownerId) })
    return { stage: 'owner_values', body: { stage: 'owner_values', proposed: structuredClone(envelope.payload.children as { title: string; points: number | null }[]) }, expiresAt: new Date(Date.now() + 86400000).toISOString(), reason: options.reason ?? '分割の指定値を本人が確認するまで保存しません' }
  },
  decide(prepared, settings) { return splitPolicyDecision(settings, prepared.actor.principal) },
  async approve(prepared, event, checked) {
    const body = splitBody(prepared)
    if (body.stage !== 'review') fail('USER_INSTRUCTION_REQUIRED', '本人が分割の指定値を確定してください')
    return approveTaskSplitFromUI(body.split, humanContextFor(prepared.actor), event, checked)
  },
  async apply(prepared, approval, requestKey, trace) {
    const body = splitBody(prepared)
    if (body.stage !== 'review') fail('USER_INSTRUCTION_REQUIRED', '本人が分割の指定値を確定してください')
    const receipt = await applyTaskSplit(body.split, approval as TaskSplitApproval | null, changeContextFor(prepared.actor), requestKey, trace)
    return { changeSetId: receipt.changeSetId, digest: receipt.digest, taskIds: [receipt.parentId, ...receipt.childIds], appliedAt: receipt.appliedAt }
  },
  async cancel(prepared) { const body = splitBody(prepared); if (body.stage === 'review') await cancelTaskSplit(body.split) },
  fields: () => ['manualPoints'],
})
/** Owner confirms (and may complete) the proposed allocation of a pending split command. */
export async function confirmSplitCommandFromUI(prepared: PreparedCommand, values: SplitChildDraft[], event: Event, message: string): Promise<CommandPreparation> {
  try {
    const saved = assertPendingCommand(prepared)
    if (saved.envelope.type !== 'task.split' || splitBody(saved).stage !== 'owner_values') fail('NO_CHANGE', '本人が確認する分割値はありません')
    const instruction = await confirmSplitValuesFromUI({ taskId: saved.envelope.target_id!, expectedRevision: saved.envelope.expected_revision!, children: values, message: message.trim() || '届いた分割案の名前と配分を本人が確認して確定する' }, humanContextFor(saved.actor), event)
    return reprepareCommand(saved, instruction, `${saved.reason}（本人が配分を確認済み）`)
  } catch (error) {
    return { outcome: commandOutcome(error, { commandId: prepared?.envelope?.command_id ?? null, entrance: prepared?.actor?.entrance ?? null }), prepared: null }
  }
}
