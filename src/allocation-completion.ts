import { db } from './db'
import { calculateScore, type Completion, type Task } from './domain'

function cancelled(completion: Completion) {
  if (completion.currentAt !== null || completion.netPoints !== null) throw new Error('未完了の親タスクと完了記録が一致しません。配分・再完了前に実績を確認してください')
}

/** Called inside the allocation transaction; earlier awards and their reversals stay unchanged. */
export async function synchronizeAllocationCompletion(parent: Task, assessmentId: string, remainingPoints: number) {
  const completion = await db.completions.where('taskId').equals(parent.id).first()
  if (!completion) return
  cancelled(completion)
  await db.completions.put({ ...completion, lastConfirmedPoints: remainingPoints, allocationAssessmentId: assessmentId })
}

async function allocationDate(parent: Task): Promise<string | null> {
  const links = await db.checklistItems.where('taskId').equals(parent.id).toArray(), dates: string[] = []
  for (const item of links) {
    if (!item.convertedTaskId || item.convertedTaskId === parent.id) continue
    const child = await db.tasks.get(item.convertedTaskId)
    if (!child) continue
    let valid = child.generationKey === `checklist:${item.id}`
    if (valid) {
      const origins = (await db.audits.where('taskId').equals(child.id).toArray()).filter(value => value.operation === 'create_from_checklist')
      if (!origins.length || origins.some(value => value.detail !== `親タスク ${parent.id} の項目から作成`)) throw new Error('配分したチェック項目の元の親と現在の参照が一致しません。実績を確認してください')
    }
    const match = child.generationKey.match(/^breakdown:(.+):(\d+)$/)
    if (!valid && match) {
      const receipt = await db.commands.get(`breakdown:${match[1]}`)
      if (receipt) {
        try {
          const payload = JSON.parse(receipt.hash), ids: unknown = JSON.parse(receipt.resultId)
          valid = payload.operation === 'breakdown' && payload.proposal?.id === match[1] && payload.proposal?.taskId === parent.id && Array.isArray(ids) && ids[Number(match[2])] === child.id
        } catch { /* An unrelated or damaged link is not allocation evidence. */ }
      }
    }
    if (valid) dates.push(child.createdAt)
  }
  if (dates.length) return dates.sort().at(-1)!
  if ((await db.audits.where('taskId').equals(parent.id).toArray()).some(value => ['allocate_points', 'breakdown'].includes(value.operation))) throw new Error('親の配分履歴に対応する子タスク参照がありません。旧ポイントを復活させず実績を確認してください')
  return null
}

type RecompletionPoints = { points: number | null; allocationAssessmentId?: string; repaired: boolean }
export async function allocationAssessmentForFirstCompletion(task: Task): Promise<string | undefined> {
  const allocatedAt = await allocationDate(task)
  if (!allocatedAt) return undefined
  const assessment = await db.assessments.get(task.assessmentId)
  if (assessment?.taskId === task.id && ['manual', 'allocated'].includes(assessment.score.mode)) return assessment.id
  // This marker identifies a new, actual completion; it never supplies its points.
  // Future estimates may already use formula/unset, so retain a historical manual
  // assessment of this genuine allocation parent instead of inferring an amount.
  const historical = (await db.assessments.where('taskId').equals(task.id).toArray()).filter(value => ['manual', 'allocated'].includes(value.score.mode)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const reference = historical.find(value => value.createdAt === allocatedAt) ?? historical[0]
  if (!reference) throw new Error('親タスクの配分評価履歴を確認してください')
  return reference.id
}
/** Existing allocation sync records preserve later human corrections, even with equal or reversed clocks.
 * Only old records without that marker need a bounded reconstruction from genuine allocation links. */
export async function pointsForRecompletion(task: Task, completion: Completion): Promise<RecompletionPoints> {
  cancelled(completion)
  const previous = completion.lastConfirmedPoints !== undefined ? completion.lastConfirmedPoints : task.effectivePoints
  const result = { points: previous, repaired: false }
  if (completion.allocationAssessmentId !== undefined) {
    const assessment = await db.assessments.get(completion.allocationAssessmentId)
    if (!assessment || assessment.taskId !== task.id || !['manual', 'allocated'].includes(assessment.score.mode)) throw new Error('配分後の完了記録を確認してください')
    if (completion.lastConfirmedPoints === undefined) throw new Error('配分後の取消済み確定ポイントがありません。実績を確認してください')
    return result
  }
  const allocatedAt = await allocationDate(task)
  if (!allocatedAt) return result
  if (!['manual', 'allocated'].includes(task.score.mode)) throw new Error('旧版で配分した親の残額が未確定です。実績を確認してから再完了してください')
  const assessment = await db.assessments.get(task.assessmentId)
  if (!assessment || assessment.taskId !== task.id || !['manual', 'allocated'].includes(assessment.score.mode) || task.effectivePoints === null || calculateScore(task.score).effective !== task.effectivePoints) throw new Error('親タスクの配分残額を確認してください')
  const marker = { allocationAssessmentId: task.assessmentId }
  if (previous === task.effectivePoints) return { ...result, ...marker }
  const allocationTime = Date.parse(allocatedAt), originalTime = Date.parse(completion.originalAt)
  const history = await db.ledger.where('completionId').equals(completion.id).toArray()
  const ambiguous = () => new Error('旧版の配分と完了実績の順序を確定できません。過去の加点を変更せず、親の実績を確認してください')
  if (!Number.isFinite(allocationTime) || !Number.isFinite(originalTime) || !history.length || history.some(entry => entry.taskId !== task.id || !Number.isFinite(Date.parse(entry.at)) || Date.parse(entry.at) < originalTime) || history.reduce((sum, entry) => sum + entry.delta, 0) !== 0) throw ambiguous()
  if (!Number.isFinite(Date.parse(assessment.createdAt)) || !Number.isFinite(Date.parse(task.updatedAt)) || Date.parse(assessment.createdAt) < allocationTime || Date.parse(task.updatedAt) < allocationTime) throw ambiguous()
  // A completion made after allocation must originally have used the parent remainder.
  // A differing original amount with an earlier allocation clock cannot establish the order.
  if (originalTime >= allocationTime && completion.originalPoints !== task.effectivePoints) throw ambiguous()
  if (history.some(entry => Date.parse(entry.at) === allocationTime)) throw ambiguous()
  const confirmations = history.filter(entry => ['award', 'restore', 'adjust'].includes(entry.kind))
  const latestConfirmation = Math.max(...confirmations.map(entry => Date.parse(entry.at)))
  const latestReverse = Math.max(...history.filter(entry => entry.kind === 'reverse').map(entry => Date.parse(entry.at)))
  if (!Number.isFinite(latestConfirmation) || !Number.isFinite(latestReverse) || latestReverse < latestConfirmation) throw ambiguous()
  // A legacy restore can repeat the very stale cache being repaired. Only a
  // later explicit correction establishes an intentionally different amount.
  if (history.some(entry => entry.kind === 'adjust' && Date.parse(entry.at) > allocationTime)) return { ...result, ...marker }
  if (originalTime >= allocationTime || history.some(entry => Date.parse(entry.at) > allocationTime)) throw ambiguous()
  return { points: task.effectivePoints, ...marker, repaired: true }
}
