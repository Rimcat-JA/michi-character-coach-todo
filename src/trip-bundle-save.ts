import type { EntityTable } from 'dexie'
import { canonicalJSON } from './canonical'
import { ConflictError } from './commands'
import { db } from './db'
import { calculateScore, uid, type Assessment, type Settings } from './domain'
import { assertTripBundleCanRemove, tripBundleFromProposal, tripMemberScore, validateTripBundleProposal, type TripBundle, type TripBundleProposal } from './trip-bundles'

const tripDB = db as typeof db & { tripBundles: EntityTable<TripBundle, 'id'> }
const bundleTable = () => {
  if (!tripDB.tripBundles) throw new Error('共通外出の保存先がありません。アプリを更新してください')
  return tripDB.tripBundles
}
type Context = Pick<Settings, 'profileId' | 'datasetId'>
async function context(): Promise<Context> {
  const settings = await db.settings.get('main')
  if (!settings) throw new Error('設定がありません')
  return { profileId: settings.profileId, datasetId: settings.datasetId }
}
function assertContext(current: Settings | undefined, expected: Context) {
  if (!current || current.profileId !== expected.profileId || current.datasetId !== expected.datasetId) throw new Error('保存先の利用者またはデータセットが変わりました。案を作り直してください')
}

export async function applyTripBundle(proposal: TripBundleProposal, confirmedManualIds: string[]): Promise<string> {
  const candidate = structuredClone(proposal), confirmations = structuredClone(confirmedManualIds)
  const captured = await context(), trips = bundleTable()
  const key = `trip-create:${candidate.id}`
  const hash = canonicalJSON({ operation: 'trip_bundle.create', context: captured, proposal: candidate, confirmedManualIds: [...confirmations].sort() })
  const prior = await db.commands.get(key)
  if (prior && prior.hash !== hash) throw new Error('IDEMPOTENCY_MISMATCH')
  if (!prior) await validateTripBundleProposal(candidate, await db.tasks.toArray(), await trips.toArray(), confirmations)

  return db.transaction('rw', [db.settings, db.tasks, db.assessments, trips, db.completions, db.audits, db.commands], async () => {
    assertContext(await db.settings.get('main'), captured)
    const receipt = await db.commands.get(key)
    if (receipt) {
      if (receipt.hash !== hash) throw new Error('IDEMPOTENCY_MISMATCH')
      return receipt.resultId
    }
    const tasks = await db.tasks.bulkGet(candidate.members.map(member => member.taskId)), existing = await trips.toArray()
    if (existing.some(bundle => bundle.id === candidate.id || bundle.members.some(member => candidate.members.some(row => row.taskId === member.taskId)))) throw new Error('タスクは既に別の共通外出へまとめられています')
    for (const [index, member] of candidate.members.entries()) {
      const task = tasks[index]
      if (!task || task.deletedAt || task.status !== 'open' || task.score.mode === 'allocated' || task.revision !== member.baseRevision || canonicalJSON(task.score) !== canonicalJSON(member.previousScore) || task.effectivePoints !== member.previousEffectivePoints) throw new ConflictError()
    }
    const at = new Date().toISOString(), bundle = tripBundleFromProposal(candidate, captured.profileId, at)
    for (const [index, member] of bundle.members.entries()) {
      const task = tasks[index]!, completion = await db.completions.where('taskId').equals(task.id).first()
      if (completion?.currentAt) throw new Error('完了状態が変わりました。共通外出案を作り直してください')
      if (completion) {
        member.previousCompletion = { completionId: completion.id, hadLastConfirmedPoints: completion.lastConfirmedPoints !== undefined, lastConfirmedPoints: completion.lastConfirmedPoints ?? null }
        await db.completions.put({ ...completion, lastConfirmedPoints: member.allocatedPoints })
      }
      const score = tripMemberScore(member), result = calculateScore(score), assessmentId = uid()
      const assessment: Assessment = { id: assessmentId, taskId: task.id, score, result, createdAt: at, origin: 'human', ruleVersion: 'v1' }
      await db.assessments.add(assessment)
      await db.tasks.put({ ...task, score, effectivePoints: result.effective, assessmentId, revision: task.revision + 1, updatedAt: at })
      await db.audits.add({ id: uid(), taskId: task.id, operation: 'trip_bundle.allocate', at, detail: `${bundle.id}: ${member.previousEffectivePoints ?? '未設定'}ptから${member.allocatedPoints}ptへ配分${member.previousScore.mode === 'manual' ? '（本人が手動値の切替を確認）' : ''}` })
    }
    await trips.add(bundle)
    await db.audits.add({ id: uid(), taskId: null, operation: 'trip_bundle.create', at, detail: `${bundle.id}: ${bundle.members.length}件・${bundle.totalPoints}pt・共通移動${bundle.travelMinutes}分` })
    await db.commands.add({ key, hash, resultId: bundle.id, at })
    return bundle.id
  })
}

export async function removeTripBundle(bundleId: string, expectedRevision: number): Promise<string> {
  if (typeof bundleId !== 'string' || !bundleId || !Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('共通外出のIDと版を確認してください')
  const captured = await context(), trips = bundleTable()
  const key = `trip-remove:${bundleId}:${expectedRevision}`, hash = canonicalJSON({ operation: 'trip_bundle.remove', context: captured, bundleId, expectedRevision })
  return db.transaction('rw', [db.settings, db.tasks, db.assessments, trips, db.completions, db.audits, db.commands], async () => {
    assertContext(await db.settings.get('main'), captured)
    const receipt = await db.commands.get(key)
    if (receipt) {
      if (receipt.hash !== hash) throw new Error('IDEMPOTENCY_MISMATCH')
      return receipt.resultId
    }
    const bundle = await trips.get(bundleId)
    if (!bundle || bundle.ownerId !== captured.profileId) throw new Error('共通外出がありません')
    if (bundle.revision !== expectedRevision) throw new ConflictError()
    const tasks = await db.tasks.bulkGet(bundle.members.map(member => member.taskId))
    assertTripBundleCanRemove(bundle, tasks.filter(task => task !== undefined))
    for (const [index, member] of bundle.members.entries()) {
      const task = tasks[index]
      if (!task || task.status !== 'open' || canonicalJSON(task.score) !== canonicalJSON(tripMemberScore(member)) || task.effectivePoints !== member.allocatedPoints) throw new ConflictError()
    }
    const at = new Date().toISOString()
    for (const [index, member] of bundle.members.entries()) {
      const task = tasks[index]!, completion = await db.completions.where('taskId').equals(task.id).first()
      if (completion?.currentAt || (completion && !member.previousCompletion)) throw new Error('完了履歴があるため、共通外出の構成と配分を取り消せません')
      if (member.previousCompletion) {
        if (!completion || completion.id !== member.previousCompletion.completionId) throw new ConflictError()
        const restored = { ...completion }
        if (member.previousCompletion.hadLastConfirmedPoints) restored.lastConfirmedPoints = member.previousCompletion.lastConfirmedPoints
        else delete restored.lastConfirmedPoints
        await db.completions.put(restored)
      }
      const score = { ...member.previousScore }, result = calculateScore(score), assessmentId = uid()
      await db.assessments.add({ id: assessmentId, taskId: task.id, score, result, createdAt: at, origin: 'human', ruleVersion: 'v1' })
      await db.tasks.put({ ...task, score, effectivePoints: member.previousEffectivePoints, assessmentId, revision: task.revision + 1, updatedAt: at })
      await db.audits.add({ id: uid(), taskId: task.id, operation: 'trip_bundle.restore', at, detail: `${bundle.id}: 以前の${member.previousScore.mode}設定を復元` })
    }
    await trips.delete(bundleId)
    await db.audits.add({ id: uid(), taskId: null, operation: 'trip_bundle.remove', at, detail: `${bundleId}: 未完了の共通外出を取消` })
    await db.commands.add({ key, hash, resultId: bundleId, at })
    return bundleId
  })
}
