import { ConflictError, newTaskInput } from './commands'
import { db } from './db'
import { calculateScore, emptyScore, uid, type Assessment, type Task } from './domain'
import { synchronizeAllocationCompletion } from './allocation-completion'

export type ResistanceReason = 'unclear' | 'large' | 'waiting' | 'priority' | 'difficult' | 'instruction'
export type BreakdownStep = { title: string; points: number }
export type BreakdownProposal = { id: string; taskId: string; parentRevision: number; reason: ResistanceReason; steps: BreakdownStep[] }

const stepNames: Record<ResistanceReason, string[]> = {
  unclear: ['何をするか書き出す', '最初の手順を試す', '残りを進める'],
  large: ['最初の小部分を進める', '次の部分を進める', '残りを仕上げる'],
  waiting: ['待っている相手・情報を確認する', '今できる部分を進める', '返答後に残りを進める'],
  priority: ['必要な範囲を決める', '最初の部分を進める', '残りを仕上げる'],
  difficult: ['着手しやすい一歩を決める', '短時間だけ試す', '残りを進める'],
  // Parts named by the person in a coach consultation (coach-split.ts); never suggested by the app.
  instruction: [],
}

export function suggestBreakdown(task: Task, reason: ResistanceReason): BreakdownProposal {
  if (task.deletedAt || task.status !== 'open') throw new Error('未完了のタスクだけ分割できます')
  if (!stepNames[reason].length) throw new Error('分割の理由を選んでください')
  if (!['manual', 'allocated'].includes(task.score.mode) || task.score.manualPoints === null || !Number.isInteger(task.score.manualPoints)) throw new Error('分割前に必要ポイントを手動で確定してください')
  const total = task.score.manualPoints
  const base = Math.floor(total / 3)
  const points = [base, base, total - base * 2]
  return { id: uid(), taskId: task.id, parentRevision: task.revision, reason, steps: stepNames[reason].map((title, index) => ({ title: `${task.title}：${title}`, points: points[index] })) }
}

/** audit: coach-mediated splits record their origin and the digest of the person's instruction. */
export async function applyBreakdownProposal(proposal: BreakdownProposal, audit?: { origin: 'coach_split_from_instruction'; instructionDigest: string }): Promise<string[]> {
  if (!proposal.id || !proposal.taskId || !stepNames[proposal.reason] || (proposal.reason === 'instruction') !== Boolean(audit)) throw new Error('分割案が不正です')
  if (proposal.steps.length < 2 || proposal.steps.length > 20) throw new Error('分割は2〜20件で指定してください')
  const steps = proposal.steps.map(step => ({ title: step.title.trim(), points: step.points }))
  if (steps.some(step => !step.title || step.title.length > 300 || !Number.isInteger(step.points) || step.points < 0 || step.points > 100000)) throw new Error('各手順の名前と配分ポイントを確認してください')
  const hash = JSON.stringify({ operation: 'breakdown', proposal: { ...proposal, steps } })
  return db.transaction('rw', [db.tasks, db.assessments, db.completions, db.checklistItems, db.audits, db.commands, db.tripBundles], async () => {
    const prior = await db.commands.get(`breakdown:${proposal.id}`)
    if (prior) {
      if (prior.hash !== hash) throw new Error('同じ分割案を変更して再採用できません')
      return JSON.parse(prior.resultId) as string[]
    }
    const parent = await db.tasks.get(proposal.taskId)
    if (!parent || parent.deletedAt || parent.status !== 'open') throw new Error('未完了の親タスクが必要です')
    if (parent.revision !== proposal.parentRevision) throw new ConflictError()
    if (!['manual', 'allocated'].includes(parent.score.mode) || parent.score.manualPoints === null) throw new Error('親の確定ポイントから配分してください')
    const total = steps.reduce((sum, step) => sum + step.points, 0)
    if (total !== parent.score.manualPoints) throw new Error(`配分合計を親の残り${parent.score.manualPoints}ptに合わせてください`)
    const at = new Date().toISOString()
    const parentScore = { ...parent.score, manualPoints: 0 }
    assertTripTaskScoreChangeAllowed(parent.id, parent.score, parentScore, await db.tripBundles.toArray())
    const parentAssessmentId = uid()
    const parentAssessment: Assessment = { id: parentAssessmentId, taskId: parent.id, score: parentScore, result: calculateScore(parentScore), createdAt: at, origin: 'human', ruleVersion: 'v1' }
    const ids: string[] = []
    await db.tasks.put({ ...parent, score: parentScore, effectivePoints: 0, assessmentId: parentAssessmentId, revision: parent.revision + 1, updatedAt: at })
    await db.assessments.add(parentAssessment)
    await synchronizeAllocationCompletion(parent, parentAssessmentId, 0)
    for (const [index, step] of steps.entries()) {
      const id = uid(), itemId = uid(), assessmentId = uid()
      const score = { ...emptyScore(), mode: 'allocated' as const, manualPoints: step.points }
      const result = calculateScore(score)
      const child: Task = { ...newTaskInput(), id, generationKey: `breakdown:${proposal.id}:${index}`, routineId: null, title: step.title, notes: '', project: parent.project, containerId: parent.containerId ?? null, labels: [...parent.labels], scheduledDate: parent.scheduledDate, dueDate: parent.dueDate, targetDate: parent.targetDate, reviewDate: null, availableFrom: parent.availableFrom, importance: parent.importance, score, effectivePoints: result.effective, assessmentId, status: 'open', revision: 1, createdAt: at, updatedAt: at, deletedAt: null }
      await db.tasks.add(child)
      await db.assessments.add({ id: assessmentId, taskId: id, score, result, createdAt: at, origin: 'human', ruleVersion: 'v1' })
      await db.checklistItems.add({ id: itemId, taskId: parent.id, text: step.title, done: false, convertedTaskId: id, createdAt: at, updatedAt: at })
      await db.audits.add({ id: uid(), taskId: id, operation: 'create_from_breakdown', at, detail: `親タスク ${parent.id} の分割案 ${proposal.id} から作成` })
      ids.push(id)
    }
    await db.audits.add({ id: uid(), taskId: parent.id, operation: 'breakdown', at, detail: `${proposal.reason}: ${total}ptを${ids.length}件へ配分${audit ? ` · origin=${audit.origin} · instruction=${audit.instructionDigest}` : ''}` })
    await db.commands.add({ key: `breakdown:${proposal.id}`, hash, resultId: JSON.stringify(ids), at })
    return ids
  })
}
import { assertTripTaskScoreChangeAllowed } from './trip-bundles'
