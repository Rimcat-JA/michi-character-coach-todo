import Dexie from 'dexie'
import { db } from './db'
import { contentDigest } from './canonical'
import { calculateScore, today, uid, type Assessment } from './domain'
import { freezeTripBundle } from './trip-bundles'
import { cancelCoachNotificationTarget } from './coach-notification-save'
import { validCompletionLedgerEntry, validReconfirmationAssessment } from './completion-reconfirmation-integrity'
import { assertCompletionReconfirmationApproval, assertCompletionReconfirmationAuthority, assertCompletionReconfirmationSnapshot, assertNativeReconfirmationEvent, consumeCompletionReconfirmationApproval, reconfirmationTables, type CompletionReconfirmationReceipt, type PreparedCompletionReconfirmation, type UICompletionReconfirmationApproval } from './completion-reconfirmation'

async function validateReplayResult(resultId: string, prepared: PreparedCompletionReconfirmation): Promise<CompletionReconfirmationReceipt> {
  const invalid = () => new Error('保存済みの再確認結果と実績・評価の根拠が一致しません')
  let receipt: CompletionReconfirmationReceipt
  try { receipt = JSON.parse(resultId) } catch { throw invalid() }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || Object.keys(receipt).length !== 6 || !['taskId', 'completionId', 'revision', 'points', 'assessmentId', 'appliedAt'].every(key => Object.hasOwn(receipt, key)) || receipt.taskId !== prepared.input.taskId || receipt.completionId !== prepared.input.completionId || receipt.revision !== prepared.input.expectedRevision + 1 || receipt.points !== prepared.input.points || typeof receipt.assessmentId !== 'string' || !receipt.assessmentId || typeof receipt.appliedAt !== 'string' || !Number.isFinite(Date.parse(receipt.appliedAt))) throw invalid()
  const reference = await db.assessments.get(receipt.assessmentId), completion = await db.completions.get(receipt.completionId), original = prepared.preview.completion
  if (!validReconfirmationAssessment(reference, receipt.taskId) || reference.result.effective !== receipt.points || reference.createdAt !== receipt.appliedAt || !completion || completion.taskId !== receipt.taskId || completion.originalAt !== original.originalAt || completion.originalPoints !== original.originalPoints || completion.title !== original.originalTitle || completion.project !== original.originalProject) throw invalid()
  const ledger = await db.ledger.where('completionId').equals(receipt.completionId).toArray()
  if (!ledger.some(row => validCompletionLedgerEntry(row, receipt.taskId, receipt.completionId) && row.kind === 'restore' && row.assessmentId === receipt.assessmentId && row.delta === receipt.points && row.at === receipt.appliedAt && row.reason === prepared.input.reason)) throw invalid()
  const audits = await db.audits.where('taskId').equals(receipt.taskId).toArray()
  if (!audits.some(row => { try { const detail = JSON.parse(row.detail); return row.operation === 'completion.reconfirmed' && row.at === receipt.appliedAt && detail.proposalId === prepared.id && detail.digest === prepared.digest && detail.ownerId === prepared.ownerId && detail.datasetId === prepared.datasetId && detail.completionId === receipt.completionId && detail.newAssessmentId === receipt.assessmentId && detail.newPoints === receipt.points && detail.reason === prepared.input.reason } catch { return false } })) throw invalid()
  return receipt
}

export async function applyCompletionReconfirmationFromUI(prepared: PreparedCompletionReconfirmation, approval: UICompletionReconfirmationApproval, event: Event, requestKey = prepared.id): Promise<CompletionReconfirmationReceipt> {
  assertNativeReconfirmationEvent(event)
  if (typeof requestKey !== 'string' || !requestKey || requestKey.length > 200) throw new Error('実績再確認の実行キーが不正です')
  const enclosing = Dexie.currentTransaction
  const result = await db.transaction('rw', reconfirmationTables(), async () => {
    const settings = await db.settings.get('main'); if (!settings) throw new Error('本人の保存先がありません')
    assertCompletionReconfirmationAuthority(prepared, settings); assertCompletionReconfirmationApproval(prepared, approval, true)
    const { digest, ...payload } = prepared
    if (await Dexie.waitFor(contentDigest(payload)) !== digest) throw new Error('確認済みの実績案が変更されました')
    assertCompletionReconfirmationAuthority(prepared, settings); assertCompletionReconfirmationApproval(prepared, approval, true)
    const requestStorageKey = `reconfirmation:request:${await Dexie.waitFor(contentDigest({ ownerId: prepared.ownerId, datasetId: prepared.datasetId, requestKey }))}`, appliedKey = `reconfirmation:applied:${prepared.id}`
    const request = await db.commands.get(requestStorageKey), applied = await db.commands.get(appliedKey)
    assertCompletionReconfirmationAuthority(prepared, settings); assertCompletionReconfirmationApproval(prepared, approval, true)
    if (request) { if (request.hash !== prepared.digest) throw new Error('同じ実行キーを別の再確認内容に使えません'); const prior = await validateReplayResult(request.resultId, prepared); assertCompletionReconfirmationAuthority(prepared, settings); assertCompletionReconfirmationApproval(prepared, approval, true); return prior }
    if (applied) { if (applied.hash !== prepared.digest) throw new Error('適用済み実績案が一致しません'); const prior = await validateReplayResult(applied.resultId, prepared); assertCompletionReconfirmationAuthority(prepared, settings); assertCompletionReconfirmationApproval(prepared, approval, true); await db.commands.add({ key: requestStorageKey, hash: prepared.digest, resultId: applied.resultId, at: new Date().toISOString() }); assertCompletionReconfirmationAuthority(prepared, settings); assertCompletionReconfirmationApproval(prepared, approval, true); return prior }
    assertCompletionReconfirmationApproval(prepared, approval, false)
    const state = await assertCompletionReconfirmationSnapshot(prepared)
    assertCompletionReconfirmationAuthority(prepared, settings); assertCompletionReconfirmationApproval(prepared, approval, false)
    const at = new Date().toISOString(), { task, completion } = state, assessmentId = uid(), score = { ...structuredClone(task.score), mode: 'manual' as const, manualPoints: prepared.input.points }
    const assessment: Assessment = { id: assessmentId, taskId: task.id, score, result: calculateScore(score), createdAt: at, origin: 'human', ruleVersion: 'v1' }
    await db.assessments.add(assessment)
    await db.completions.put({ ...completion, currentAt: at, localDate: today(new Date(at)), timezone: state.displayTimezone, netPoints: prepared.input.points, lastConfirmedPoints: prepared.input.points, scoreState: 'confirmed', reconfirmedAssessmentId: assessmentId })
    await db.ledger.add({ id: uid(), completionId: completion.id, taskId: task.id, kind: 'restore', delta: prepared.input.points, at, reason: prepared.input.reason, assessmentId })
    await db.tasks.put({ ...task, status: 'completed', revision: task.revision + 1, updatedAt: at })
    for (const bundle of state.trips) if (bundle.members.some(member => member.taskId === task.id) && !bundle.frozenAt) await db.tripBundles.put(freezeTripBundle(bundle, task.id, at))
    await cancelCoachNotificationTarget(task.id, at)
    await db.audits.add({ id: uid(), taskId: task.id, operation: 'completion.reconfirmed', at, detail: JSON.stringify({ proposalId: prepared.id, digest: prepared.digest, ownerId: prepared.ownerId, datasetId: prepared.datasetId, completionId: completion.id, previousStoredPoints: completion.lastConfirmedPoints ?? null, previousStoredPointsMissing: completion.lastConfirmedPoints === undefined, newPoints: prepared.input.points, reason: prepared.input.reason, futureAssessmentId: task.assessmentId, newAssessmentId: assessmentId, originalAt: completion.originalAt, originalPoints: completion.originalPoints, policyEpoch: prepared.policyEpoch, sourcePermissionRevision: prepared.sourcePermissionRevision, allocation: prepared.preview.allocation }) })
    const receipt: CompletionReconfirmationReceipt = { taskId: task.id, completionId: completion.id, revision: task.revision + 1, points: prepared.input.points, assessmentId, appliedAt: at }, resultId = JSON.stringify(receipt)
    await db.commands.add({ key: appliedKey, hash: prepared.digest, resultId, at })
    await db.commands.add({ key: requestStorageKey, hash: prepared.digest, resultId, at })
    assertCompletionReconfirmationAuthority(prepared, settings); assertCompletionReconfirmationApproval(prepared, approval, false)
    return receipt
  })
  if (enclosing) { let root = enclosing; while (root.parent) root = root.parent; root.on('complete', () => consumeCompletionReconfirmationApproval(approval)) } else consumeCompletionReconfirmationApproval(approval)
  return result
}
