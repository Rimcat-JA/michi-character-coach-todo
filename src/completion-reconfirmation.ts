import Dexie from 'dexie'
import { db } from './db'
import { canonicalJSON, contentDigest } from './canonical'
import { changePolicyFor } from './change-set'
import { calculateScore, uid, type Assessment, type Audit, type ChecklistItem, type CommandReceipt, type Completion, type Container, type LedgerEntry, type Settings, type Task } from './domain'
import type { TripBundle } from './trip-bundles'
import { validCompletionLedgerEntry, validReconfirmationAssessment, validReconfirmedPoints } from './completion-reconfirmation-integrity'

export type CompletionReconfirmationInput = { taskId: string; expectedRevision: number; completionId: string; points: number; reason: string }
export type CompletionReconfirmationChild = { id: string; title: string; status: 'open' | 'completed'; deleted: boolean; estimatePoints: number | null; activePoints: number | null; hasActiveCompletion: boolean; relation: 'verified' | 'unresolved' }
export type CompletionReconfirmationPreview = {
  task: { id: string; title: string; revision: number; estimatePoints: number | null; scoreMode: Task['score']['mode'] }
  completion: { id: string; originalAt: string; originalPoints: number | null; originalTitle: string; originalProject: string; currentTimezone: string | null; cachedPoints: number | null; cachedPointsMissing: boolean }
  cancellation: { status: 'known' | 'unknown'; points: number | null; at: string | null; reason: string }
  allocation: { hasChildren: boolean; parentRemainder: number | null; children: CompletionReconfirmationChild[]; issues: string[]; combinedEstimatePoints: number | null; combinedActivePoints: number | null; proposedCombinedActivePoints: number | null; proposedCombinedEstimatePoints: number | null }
  trips: { id: string; title: string; frozenAt: string | null; totalPoints: number }[]
  displayTimezone: string; requiresImpactAcknowledgement: boolean
}
export type PreparedCompletionReconfirmation = Readonly<{ version: 1; id: string; nonce: string; ownerId: string; datasetId: string; policyEpoch: number; sourcePermissionRevision: number; createdAt: string; expiresAt: string; input: CompletionReconfirmationInput; snapshotDigest: string; preview: CompletionReconfirmationPreview; digest: string }>
export type UICompletionReconfirmationApproval = Readonly<{ id: string; proposalId: string; digest: string; approvedBy: string; expiresAt: string }>
export type CompletionReconfirmationReceipt = { taskId: string; completionId: string; revision: number; points: number; assessmentId: string; appliedAt: string }
export type ReconfirmationSnapshot = { ownerId: string; datasetId: string; policyEpoch: number; sourcePermissionRevision: number; displayTimezone: string; settings: Settings; task: Task; completion: Completion; ledger: LedgerEntry[]; assessments: Assessment[]; links: ChecklistItem[]; children: Task[]; childCompletions: Completion[]; childLedger: LedgerEntry[]; commands: CommandReceipt[]; origins: Audit[]; trips: TripBundle[]; containers: Container[] }
type Registered = { prepared: PreparedCompletionReconfirmation; generation: number }
type Grant = { prepared: PreparedCompletionReconfirmation; generation: number; consumed: boolean }
const registered = new Map<string, Registered>()
let approvals = new WeakMap<UICompletionReconfirmationApproval, Grant>(), generation = 0
function fail(message: string): never { throw new Error(message) }
const sorted = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
function native(event: Event) {
  if (!(event instanceof Event) || !event.isTrusted || !['click', 'submit'].includes(event.type)) fail('本人が実績の確認ボタンから操作してください')
  const getter = Object.getOwnPropertyDescriptor(Event.prototype, 'type')?.get
  try { if (!getter || !['click', 'submit'].includes(getter.call(event))) throw new Error() } catch { fail('本人が実績の確認ボタンから操作してください') }
}
export function clearCompletionReconfirmationAuthority() { generation++; registered.clear(); approvals = new WeakMap() }
export function cancelCompletionReconfirmation(prepared: PreparedCompletionReconfirmation) { if (registered.get(prepared.id)?.prepared === prepared) registered.delete(prepared.id) }
function validateInput(input: CompletionReconfirmationInput) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 5 || !['taskId', 'expectedRevision', 'completionId', 'points', 'reason'].every(key => Object.hasOwn(input, key)) || typeof input.taskId !== 'string' || !input.taskId || input.taskId.length > 200 || typeof input.completionId !== 'string' || !input.completionId || input.completionId.length > 200 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || !Number.isInteger(input.points) || input.points < 0 || input.points > 100000 || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 2000) fail('対象の実績・版・0〜100000の整数ポイント・1〜2000文字の理由を本人が指定してください')
}
export function assertNativeReconfirmationEvent(event: Event) { native(event) }
/** Must run in a transaction containing all the returned facts. */
export async function loadReconfirmationSnapshot(input: CompletionReconfirmationInput): Promise<ReconfirmationSnapshot> {
  const settings = await db.settings.get('main')
  if (!settings) fail('この保存先の本人を確認してください')
  const task = await db.tasks.get(input.taskId), completion = await db.completions.get(input.completionId)
  if (!task || task.deletedAt || task.status !== 'open' || task.revision !== input.expectedRevision || !Number.isSafeInteger(task.revision + 1) || !completion || completion.taskId !== task.id || completion.currentAt !== null || completion.netPoints !== null) fail('取消した実績と未完了タスクの対象・版を確認し直してください')
  const validPoints = (value: unknown) => value === null || Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100000
  if (!validPoints(completion.originalPoints) || completion.lastConfirmedPoints !== undefined && !validPoints(completion.lastConfirmedPoints) || !Number.isFinite(Date.parse(completion.originalAt)) || !['pending', 'confirmed'].includes(completion.scoreState)) fail('取消した実績の元の記録を確認してください')
  const ledger = await db.ledger.where('completionId').equals(completion.id).toArray()
  if (ledger.some(row => !validCompletionLedgerEntry(row, task.id, completion.id)) || ledger.reduce((sum, row) => sum + row.delta, 0) !== 0) fail('取消した実績と過去の台帳が一致しません。元の記録を確認してください')
  const links = await db.checklistItems.where('taskId').equals(task.id).toArray()
  const childIds = [...new Set(links.map(row => row.convertedTaskId).filter((id): id is string => Boolean(id && id !== task.id)))]
  const children = (await db.tasks.bulkGet(childIds)).filter((row): row is Task => Boolean(row))
  const childCompletions = await db.completions.where('taskId').anyOf(childIds).toArray(), childCompletionIds = childCompletions.map(row => row.id)
  const childLedger = childCompletionIds.length ? await db.ledger.where('completionId').anyOf(childCompletionIds).toArray() : []
  const relatedTaskIds = [task.id, ...childIds]
  const assessments = await db.assessments.where('taskId').anyOf(relatedTaskIds).toArray()
  const current = assessments.find(row => row.id === task.assessmentId)
  if (!current || current.taskId !== task.id || canonicalJSON(current.score) !== canonicalJSON(task.score) || canonicalJSON(calculateScore(task.score)) !== canonicalJSON(current.result) || current.result.effective !== task.effectivePoints) fail('保存済みの現在見積と評価を確認してください')
  for (const entry of ledger.filter(row => row.assessmentId !== undefined)) {
    const reference = assessments.find(row => row.id === entry.assessmentId)
    if (entry.kind !== 'restore' || !validReconfirmationAssessment(reference, task.id) || reference.score.manualPoints !== entry.delta) fail('再確認した実績と評価参照が一致しません')
  }
  if (completion.reconfirmedAssessmentId !== undefined && (!ledger.some(row => row.assessmentId === completion.reconfirmedAssessmentId) || !validReconfirmedPoints(completion.lastConfirmedPoints))) fail('再確認した取消済み実績の評価参照と保存値を確認してください')
  const origins = await db.audits.where('taskId').anyOf(relatedTaskIds).toArray()
  const commandKeys = children.map(child => child.generationKey.match(/^breakdown:(.+):(\d+)$/)?.[1]).filter((id): id is string => Boolean(id)).map(id => `breakdown:${id}`)
  const commands = (await db.commands.bulkGet([...new Set(commandKeys)])).filter((row): row is CommandReceipt => Boolean(row))
  const containerIds = [...new Set([task, ...children].map(row => row.containerId).filter((id): id is string => Boolean(id)))], containers = (await db.containers.bulkGet(containerIds)).filter((row): row is Container => Boolean(row))
  if (task.containerId && !containers.some(row => row.id === task.containerId && row.ownerId === settings.profileId)) fail('このタスクの本人領域を確認してください')
  const trips = (await db.tripBundles.toArray()).filter(row => row.members.some(member => relatedTaskIds.includes(member.taskId)))
  if (trips.some(row => row.members.some(member => member.taskId === task.id) && row.ownerId !== settings.profileId)) fail('このタスクの外出まとめの本人領域を確認してください')
  const policy = changePolicyFor(settings)
  return { ownerId: settings.profileId, datasetId: settings.datasetId, policyEpoch: policy.epoch, sourcePermissionRevision: policy.sourcePermissionRevision, displayTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone, settings, task, completion, ledger: sorted(ledger), assessments: sorted(assessments), links: sorted(links), children: sorted(children), childCompletions: sorted(childCompletions), childLedger: sorted(childLedger), commands: commands.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0), origins: sorted(origins), trips: sorted(trips), containers: sorted(containers) }
}
export const reconfirmationTables = () => [db.settings, db.tasks, db.completions, db.ledger, db.assessments, db.checklistItems, db.audits, db.commands, db.tripBundles, db.containers]
function preview(input: CompletionReconfirmationInput, state: ReconfirmationSnapshot): CompletionReconfirmationPreview {
  const { task, completion } = state, issues: string[] = [], children: CompletionReconfirmationChild[] = []
  const reversals = state.ledger.filter(row => row.kind === 'reverse'), latestTime = Math.max(...reversals.map(row => Date.parse(row.at)))
  const latest = reversals.filter(row => Date.parse(row.at) === latestTime)
  const known = latest.length === 1 && Number.isFinite(latestTime) && latest[0].delta <= 0 && state.ledger.every(row => row === latest[0] || Date.parse(row.at) < latestTime)
  const cancellation = known ? { status: 'known' as const, points: -latest[0].delta, at: latest[0].at, reason: '時系列が一意な直近の取消台帳から表示' } : { status: 'unknown' as const, points: null, at: null, reason: '取消の台帳がないか順序が一意でないため、取消前の実加点は不明です' }
  for (const link of state.links.filter(row => row.convertedTaskId)) {
    const child = state.children.find(row => row.id === link.convertedTaskId)
    if (!child || child.id === task.id) { issues.push(`項目「${link.text}」の子タスク参照を確認できません`); continue }
    if (children.some(row => row.id === child.id)) { issues.push('同じ子タスクへの重複した参照があります'); continue }
    const checklistOrigins = state.origins.filter(row => row.taskId === child.id && row.operation === 'create_from_checklist')
    let verified = child.generationKey === `checklist:${link.id}` && checklistOrigins.length > 0 && checklistOrigins.every(row => row.detail === `親タスク ${task.id} の項目から作成`)
    const match = child.generationKey.match(/^breakdown:(.+):(\d+)$/)
    if (!verified && match) {
      const command = state.commands.find(row => row.key === `breakdown:${match[1]}`)
      try { if (command) { const payload = JSON.parse(command.hash), ids = JSON.parse(command.resultId); verified = payload.operation === 'breakdown' && payload.proposal?.id === match[1] && payload.proposal?.taskId === task.id && Array.isArray(ids) && ids[Number(match[2])] === child.id } } catch { /* Display an unresolved relation rather than guessing a budget. */ }
    }
    const accessible = !child.containerId || state.containers.some(row => row.id === child.containerId && row.ownerId === state.ownerId)
    const actual = state.childCompletions.find(row => row.taskId === child.id), active = Boolean(actual?.currentAt)
    const entries = state.childLedger.filter(row => row.completionId === actual?.id)
    const actualConsistent = Boolean(actual?.currentAt) === (child.status === 'completed') && (!actual || entries.every(row => validCompletionLedgerEntry(row, child.id, actual.id)) && entries.reduce((sum, row) => sum + row.delta, 0) === (actual.currentAt ? actual.netPoints ?? 0 : 0))
    if (!verified || !accessible || !actualConsistent) issues.push('子の配分元・本人領域または実績が未確認です')
    children.push({ id: child.id, title: accessible ? child.title : '確認できない子タスク', status: child.status, deleted: Boolean(child.deletedAt), estimatePoints: accessible ? child.effectivePoints : null, activePoints: active && accessible && actualConsistent ? actual!.netPoints : null, hasActiveCompletion: active, relation: verified && accessible && actualConsistent ? 'verified' : 'unresolved' })
  }
  const allocationHistory = state.origins.some(row => row.taskId === task.id && ['allocate_points', 'breakdown'].includes(row.operation))
  if (allocationHistory && !children.length) issues.push('配分履歴に対応する子の参照がありません')
  const hasChildren = allocationHistory || state.links.some(row => Boolean(row.convertedTaskId))
  const parentRemainder = ['manual', 'allocated'].includes(task.score.mode) ? task.effectivePoints : null
  const sum = (values: (number | null)[]) => issues.length || values.some(value => value === null) ? null : values.reduce<number>((total, value) => total + value!, 0)
  const childEstimate = sum(children.map(row => row.estimatePoints)), childActive = sum(children.map(row => row.hasActiveCompletion ? row.activePoints : 0))
  const plus = (amount: number | null, other: number | null) => amount === null || other === null ? null : amount + other
  const trips = state.trips.filter(row => row.members.some(member => member.taskId === task.id)).map(row => ({ id: row.id, title: row.title, frozenAt: row.frozenAt, totalPoints: row.totalPoints }))
  return { task: { id: task.id, title: task.title, revision: task.revision, estimatePoints: task.effectivePoints, scoreMode: task.score.mode }, completion: { id: completion.id, originalAt: completion.originalAt, originalPoints: completion.originalPoints, originalTitle: completion.title, originalProject: completion.project, currentTimezone: completion.timezone ?? null, cachedPoints: completion.lastConfirmedPoints ?? null, cachedPointsMissing: completion.lastConfirmedPoints === undefined }, cancellation, allocation: { hasChildren, parentRemainder, children, issues, combinedEstimatePoints: plus(task.effectivePoints, childEstimate), combinedActivePoints: childActive, proposedCombinedActivePoints: plus(input.points, childActive), proposedCombinedEstimatePoints: plus(input.points, childEstimate) }, trips, displayTimezone: state.displayTimezone, requiresImpactAcknowledgement: hasChildren || issues.length > 0 || trips.some(row => row.frozenAt === null) }
}
export async function prepareCompletionReconfirmationFromUI(input: CompletionReconfirmationInput, event: Event): Promise<PreparedCompletionReconfirmation> {
  native(event); input = structuredClone(input); validateInput(input); input.reason = input.reason.trim()
  const startGeneration = generation
  for (const [id, value] of registered) if (Date.parse(value.prepared.expiresAt) <= Date.now()) registered.delete(id)
  if (registered.size >= 100) fail('未適用の実績確認案が多すぎます。確認案を整理してください')
  const payload = await db.transaction('r', reconfirmationTables(), async () => {
    const state = await loadReconfirmationSnapshot(input), createdAt = new Date().toISOString()
    return { version: 1 as const, id: uid(), nonce: uid(), ownerId: state.ownerId, datasetId: state.datasetId, policyEpoch: state.policyEpoch, sourcePermissionRevision: state.sourcePermissionRevision, createdAt, expiresAt: new Date(Date.now() + 86400000).toISOString(), input, snapshotDigest: await Dexie.waitFor(contentDigest(state)), preview: preview(input, state) }
  })
  const prepared = freeze({ ...payload, digest: await contentDigest(payload) })
  if (generation !== startGeneration) fail('確認中に保存先や承認権限が変わりました。もう一度確認してください')
  if (registered.size >= 100) fail('未適用の実績確認案が多すぎます。確認案を整理してください')
  registered.set(prepared.id, { prepared, generation }); return prepared
}
export function assertCompletionReconfirmationAuthority(prepared: PreparedCompletionReconfirmation, settings: Settings) {
  const value = prepared && registered.get(prepared.id), policy = changePolicyFor(settings)
  if (!value || value.prepared !== prepared || value.generation !== generation) fail('登録済みの本人実績確認案ではありません')
  if (prepared.ownerId !== settings.profileId || prepared.datasetId !== settings.datasetId || prepared.policyEpoch !== policy.epoch || prepared.sourcePermissionRevision !== policy.sourcePermissionRevision || Date.parse(prepared.expiresAt) <= Date.now()) { registered.delete(prepared.id); fail('実績確認の本人・保存先・権限または期限が変わりました') }
}
export async function assertCompletionReconfirmationSnapshot(prepared: PreparedCompletionReconfirmation) {
  const state = await loadReconfirmationSnapshot(prepared.input)
  if (await Dexie.waitFor(contentDigest(state)) !== prepared.snapshotDigest) fail('確認後に実績・現在見積・子タスクや根拠が変わりました。確認し直してください')
  return state
}
export async function approveCompletionReconfirmationFromUI(prepared: PreparedCompletionReconfirmation, digest: string, event: Event, checked: { points: boolean; impact: boolean }): Promise<UICompletionReconfirmationApproval> {
  native(event)
  const startGeneration = generation
  if (!prepared || !checked || checked.points !== true || prepared.preview.requiresImpactAcknowledgement && checked.impact !== true || digest !== prepared.digest) fail('本人のポイント・理由と表示した配分への影響を確認してください')
  await db.transaction('r', reconfirmationTables(), async () => {
    const settings = await db.settings.get('main'); if (!settings) fail('本人の保存先がありません')
    assertCompletionReconfirmationAuthority(prepared, settings); await assertCompletionReconfirmationSnapshot(prepared)
    assertCompletionReconfirmationAuthority(prepared, settings)
  })
  if (generation !== startGeneration || registered.get(prepared.id)?.prepared !== prepared) fail('確認中に実績確認案が失効しました')
  const grant = freeze({ id: uid(), proposalId: prepared.id, digest: prepared.digest, approvedBy: prepared.ownerId, expiresAt: prepared.expiresAt })
  approvals.set(grant, { prepared, generation, consumed: false }); return grant
}
export function assertCompletionReconfirmationApproval(prepared: PreparedCompletionReconfirmation, approval: UICompletionReconfirmationApproval, allowConsumed: boolean) {
  const grant = approval && approvals.get(approval)
  if (!grant || grant.prepared !== prepared || grant.generation !== generation || grant.consumed && !allowConsumed) fail('この実績確認案の本人承認がありません、または既に使用されています')
}
export function consumeCompletionReconfirmationApproval(approval: UICompletionReconfirmationApproval) { const value = approvals.get(approval); if (value) value.consumed = true }
