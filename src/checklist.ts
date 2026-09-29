import { db } from './db'
import { calculateScore, emptyScore, uid, type Assessment, type ChecklistItem, type Task } from './domain'
import { ConflictError, newTaskInput } from './commands'

const now = () => new Date().toISOString()

export async function addChecklistItem(taskId: string, text: string): Promise<string> {
  const title = text.trim()
  if (!title || title.length > 300) throw new Error('チェック項目は1〜300文字で入力してください')
  return db.transaction('rw', db.tasks, db.checklistItems, async () => {
    const task = await db.tasks.get(taskId)
    if (!task || task.deletedAt) throw new Error('親タスクがありません')
    const id = uid(), at = now()
    await db.checklistItems.add({ id, taskId, text: title, done: false, convertedTaskId: null, createdAt: at, updatedAt: at })
    return id
  })
}

export async function toggleChecklistItem(id: string, done: boolean): Promise<void> {
  await db.transaction('rw', db.checklistItems, async () => {
    const item = await db.checklistItems.get(id)
    if (!item) throw new Error('チェック項目がありません')
    if (item.convertedTaskId) throw new Error('独立タスクになった項目は子タスクで変更してください')
    await db.checklistItems.put({ ...item, done, updatedAt: now() })
  })
}

export async function convertChecklistItem(id: string, expectedParentRevision: number, points: number): Promise<string> {
  if (!Number.isInteger(points) || points < 0 || points > 100000) throw new Error('配分ポイントは0〜100000の整数で指定してください')
  return db.transaction('rw', [db.tasks, db.assessments, db.checklistItems, db.audits], async () => {
    const item = await db.checklistItems.get(id)
    if (!item) throw new Error('チェック項目がありません')
    if (item.convertedTaskId) return item.convertedTaskId
    const parent = await db.tasks.get(item.taskId)
    if (!parent || parent.deletedAt || parent.status !== 'open') throw new Error('未完了の親タスクが必要です')
    if (parent.revision !== expectedParentRevision) throw new ConflictError()
    if (!['manual', 'allocated'].includes(parent.score.mode) || parent.score.manualPoints === null || parent.score.manualPoints < points) throw new Error('親の確定ポイントから配分してください')
    const at = now(), childId = uid(), parentAssessmentId = uid(), childAssessmentId = uid()
    const parentScore = { ...parent.score, manualPoints: parent.score.manualPoints - points }
    const childScore = { ...emptyScore(), mode: 'allocated' as const, manualPoints: points }
    const parentResult = calculateScore(parentScore), childResult = calculateScore(childScore)
    const child: Task = { ...newTaskInput(), id: childId, generationKey: `checklist:${item.id}`, routineId: null, title: item.text, notes: '', project: parent.project, containerId: parent.containerId ?? null, labels: [], scheduledDate: parent.scheduledDate, dueDate: parent.dueDate, targetDate: parent.targetDate, reviewDate: null, availableFrom: parent.availableFrom, importance: parent.importance, score: childScore, effectivePoints: childResult.effective, assessmentId: childAssessmentId, status: 'open', revision: 1, createdAt: at, updatedAt: at, deletedAt: null }
    const assessments: Assessment[] = [
      { id: parentAssessmentId, taskId: parent.id, score: parentScore, result: parentResult, createdAt: at, origin: 'human', ruleVersion: 'v1' },
      { id: childAssessmentId, taskId: childId, score: childScore, result: childResult, createdAt: at, origin: 'human', ruleVersion: 'v1' }
    ]
    await db.tasks.put({ ...parent, score: parentScore, effectivePoints: parentResult.effective, assessmentId: parentAssessmentId, revision: parent.revision + 1, updatedAt: at })
    await db.tasks.add(child)
    await db.assessments.bulkAdd(assessments)
    await db.checklistItems.put({ ...item, convertedTaskId: childId, updatedAt: at })
    await db.audits.bulkAdd([
      { id: uid(), taskId: parent.id, operation: 'allocate_points', at, detail: `${points}ptを子タスクへ配分` },
      { id: uid(), taskId: childId, operation: 'create_from_checklist', at, detail: `親タスク ${parent.id} の項目から作成` }
    ])
    return childId
  })
}

export function checklistProgress(items: ChecklistItem[]): { done: number; total: number } {
  const active = items.filter(item => !item.convertedTaskId)
  return { done: active.filter(item => item.done).length, total: active.length }
}
