import { ConflictError, newTaskInput } from './commands'
import { db } from './db'
import { calculateScore, emptyScore, uid, type Assessment, type AssessmentInstruction, type Task } from './domain'
import { synchronizeAllocationCompletion } from './allocation-completion'
import { recordHumanCommand } from './command-bus'
import { assertTripTaskScoreChangeAllowed } from './trip-bundles'

export type ResistanceReason = 'unclear' | 'large' | 'waiting' | 'priority' | 'difficult' | 'instruction'
export type BreakdownStep = { title: string; points: number }
export type BreakdownProposal = { id: string; taskId: string; parentRevision: number; reason: ResistanceReason; steps: BreakdownStep[] }
/** Who allocated the parent's points. Agent splits carry the owner's confirmed instruction (N03). */
export type SplitProvenance = { origin: 'human' } | { origin: 'user_instruction_via_agent'; instruction: AssessmentInstruction; audit: Record<string, unknown> }

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

/** Tables the split core writes; callers open one rw transaction over all of them. */
export const taskSplitTables = () => [db.tasks, db.assessments, db.completions, db.checklistItems, db.audits, db.commands, db.tripBundles, db.settings]
export function validateSplitSteps(steps: BreakdownStep[]): BreakdownStep[] {
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 20) throw new Error('分割は2〜20件で指定してください')
  const normalized = steps.map(step => ({ title: typeof step?.title === 'string' ? step.title.trim() : '', points: step?.points }))
  if (normalized.some(step => !step.title || step.title.length > 300 || !Number.isInteger(step.points) || step.points < 0 || step.points > 100000)) throw new Error('各手順の名前と配分ポイントを確認してください')
  return normalized
}
/**
 * Shared transactional core of the human wizard and proxy split ChangeSets (N03).
 * The `breakdown:<id>` receipt and generation keys are what allocation-completion verifies later.
 */
export async function applyTaskSplitInTransaction(parent: Task, steps: BreakdownStep[], splitId: string, hash: string, provenance: SplitProvenance, summary: string): Promise<string[]> {
  if (!parent || parent.deletedAt || parent.status !== 'open') throw new Error('未完了の親タスクが必要です')
  if (!['manual', 'allocated'].includes(parent.score.mode) || parent.score.manualPoints === null) throw new Error('親の確定ポイントから配分してください')
  const total = steps.reduce((sum, step) => sum + step.points, 0)
  if (total !== parent.score.manualPoints) throw new Error(`配分合計を親の残り${parent.score.manualPoints}ptに合わせてください`)
  const at = new Date().toISOString()
  const parentScore = { ...parent.score, manualPoints: 0 }
  assertTripTaskScoreChangeAllowed(parent.id, parent.score, parentScore, await db.tripBundles.toArray())
  const origin = provenance.origin, instruction = provenance.origin === 'user_instruction_via_agent' ? provenance.instruction : null
  const assessmentFor = (id: string, taskId: string, score: Assessment['score']): Assessment => instruction ? { id, taskId, score, result: calculateScore(score), createdAt: at, origin: 'user_instruction_via_agent', ruleVersion: 'v1', instruction: { ...instruction, taskRevision: taskId === parent.id ? parent.revision : 1 } } : { id, taskId, score, result: calculateScore(score), createdAt: at, origin: 'human', ruleVersion: 'v1' }
  const parentAssessmentId = uid()
  const ids: string[] = []
  await db.tasks.put({ ...parent, score: parentScore, effectivePoints: 0, assessmentId: parentAssessmentId, revision: parent.revision + 1, updatedAt: at })
  await db.assessments.add(assessmentFor(parentAssessmentId, parent.id, parentScore))
  await synchronizeAllocationCompletion(parent, parentAssessmentId, 0)
  for (const [index, step] of steps.entries()) {
    const id = uid(), itemId = uid(), assessmentId = uid()
    const score = { ...emptyScore(), mode: 'allocated' as const, manualPoints: step.points }
    const result = calculateScore(score)
    const child: Task = { ...newTaskInput(), id, generationKey: `breakdown:${splitId}:${index}`, routineId: null, title: step.title, notes: '', project: parent.project, containerId: parent.containerId ?? null, labels: [...parent.labels], scheduledDate: parent.scheduledDate, dueDate: parent.dueDate, ...(parent.dueAt ? { dueAt: parent.dueAt, dueTimezone: parent.dueTimezone ?? null } : {}), targetDate: parent.targetDate, reviewDate: null, availableFrom: parent.availableFrom, importance: parent.importance, score, effectivePoints: result.effective, assessmentId, status: 'open', revision: 1, createdAt: at, updatedAt: at, deletedAt: null }
    await db.tasks.add(child)
    await db.assessments.add(assessmentFor(assessmentId, id, score))
    await db.checklistItems.add({ id: itemId, taskId: parent.id, text: step.title, done: false, convertedTaskId: id, createdAt: at, updatedAt: at })
    await db.audits.add({ id: uid(), taskId: id, operation: 'create_from_breakdown', at, detail: `親タスク ${parent.id} の分割案 ${splitId} から作成` })
    ids.push(id)
  }
  const before = { manualPoints: parent.score.manualPoints, scoreMode: parent.score.mode, effectivePoints: parent.effectivePoints, children: [] as unknown[] }
  const after = { manualPoints: 0, scoreMode: parentScore.mode, effectivePoints: 0, children: steps.map((step, index) => ({ taskId: ids[index], title: step.title, points: step.points })) }
  if (origin === 'human') await recordHumanCommand({ operation: 'breakdown', taskId: parent.id, commandKey: `breakdown:${splitId}`, before, after, revisionBefore: parent.revision, revisionAfter: parent.revision + 1, summary, at, extra: { splitId, total, parentAssessmentBefore: parent.assessmentId, parentAssessmentAfter: parentAssessmentId } })
  else await db.audits.add({ id: uid(), taskId: parent.id, operation: 'breakdown', at, detail: JSON.stringify({ schema: 'command.audit/1', ...provenance.audit, operation: 'task.split', splitId, total, revisionBefore: parent.revision, revisionAfter: parent.revision + 1, fields: ['manualPoints', 'children'], before, after, parentAssessmentBefore: parent.assessmentId, parentAssessmentAfter: parentAssessmentId, summary }) })
  await db.commands.add({ key: `breakdown:${splitId}`, hash, resultId: JSON.stringify(ids), at })
  return ids
}

/** audit: coach-mediated splits record their origin and the digest of the person's instruction. */
export async function applyBreakdownProposal(proposal: BreakdownProposal, audit?: { origin: 'coach_split_from_instruction'; instructionDigest: string }): Promise<string[]> {
  if (!proposal.id || !proposal.taskId || !stepNames[proposal.reason] || (proposal.reason === 'instruction') !== Boolean(audit)) throw new Error('分割案が不正です')
  const steps = validateSplitSteps(proposal.steps)
  const hash = JSON.stringify({ operation: 'breakdown', proposal: { ...proposal, steps } })
  return db.transaction('rw', taskSplitTables(), async () => {
    const prior = await db.commands.get(`breakdown:${proposal.id}`)
    if (prior) {
      if (prior.hash !== hash) throw new Error('同じ分割案を変更して再採用できません')
      return JSON.parse(prior.resultId) as string[]
    }
    const parent = await db.tasks.get(proposal.taskId)
    if (!parent || parent.deletedAt || parent.status !== 'open') throw new Error('未完了の親タスクが必要です')
    if (parent.revision !== proposal.parentRevision) throw new ConflictError()
    if (audit) {
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
        const child: Task = { ...newTaskInput(), id, generationKey: `breakdown:${proposal.id}:${index}`, routineId: null, title: step.title, notes: '', project: parent.project, containerId: parent.containerId ?? null, labels: [...parent.labels], scheduledDate: parent.scheduledDate, dueDate: parent.dueDate, ...(parent.dueAt ? { dueAt: parent.dueAt, dueTimezone: parent.dueTimezone ?? null } : {}), targetDate: parent.targetDate, reviewDate: null, availableFrom: parent.availableFrom, importance: parent.importance, score, effectivePoints: result.effective, assessmentId, status: 'open', revision: 1, createdAt: at, updatedAt: at, deletedAt: null }
        await db.tasks.add(child)
        await db.assessments.add({ id: assessmentId, taskId: id, score, result, createdAt: at, origin: 'human', ruleVersion: 'v1' })
        await db.checklistItems.add({ id: itemId, taskId: parent.id, text: step.title, done: false, convertedTaskId: id, createdAt: at, updatedAt: at })
        await db.audits.add({ id: uid(), taskId: id, operation: 'create_from_breakdown', at, detail: `親タスク ${parent.id} の分割案 ${proposal.id} から作成` })
        ids.push(id)
      }
      await db.audits.add({ id: uid(), taskId: parent.id, operation: 'breakdown', at, detail: `${proposal.reason}: ${total}ptを${ids.length}件へ配分 · origin=${audit.origin} · instruction=${audit.instructionDigest}` })
      await db.commands.add({ key: `breakdown:${proposal.id}`, hash, resultId: JSON.stringify(ids), at })
      return ids
    }
    const total = steps.reduce((sum, step) => sum + step.points, 0)
    return applyTaskSplitInTransaction(parent, steps, proposal.id, hash, { origin: 'human' }, `${proposal.reason}: ${total}ptを${steps.length}件へ配分`)
  })
}
