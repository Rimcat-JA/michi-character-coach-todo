import { db } from './db'
import { today, uid, type SmartList, type Task, type TaskDependency, type ThemeRule } from './domain'
import { suggestedTasks } from './planning'
import { querySmartList } from './smart-lists'

export async function setSpotlight(taskId: string, expectedRevision: number, active: boolean) {
  await db.transaction('rw', db.tasks, db.audits, async () => {
    const task = await db.tasks.get(taskId)
    if (!task || task.deletedAt || task.status !== 'open') throw new Error('Spotlightのタスクがありません')
    if (task.revision !== expectedRevision) throw new Error('別の画面で更新されました')
    const selected = (await db.tasks.toArray()).filter(item => !item.deletedAt && item.status === 'open' && item.spotlightOrder != null && item.id !== taskId)
    if (active && selected.length >= 3) throw new Error('Spotlightは3件までです')
    const order = active ? Math.max(0, ...selected.map(item => item.spotlightOrder ?? 0)) + 1 : null
    const at = new Date().toISOString()
    await db.tasks.put({ ...task, spotlightOrder: order, revision: task.revision + 1, updatedAt: at })
    await db.audits.add({ id: uid(), taskId, operation: 'spotlight', at, detail: active ? `追加 ${order}` : '解除' })
  })
}

export function spotlightTasks(tasks: Task[]) {
  return tasks.filter(task => !task.deletedAt && task.status === 'open' && task.spotlightOrder != null).sort((a, b) => (a.spotlightOrder ?? 999) - (b.spotlightOrder ?? 999) || a.id.localeCompare(b.id))
}

export function choosePair(tasks: Task[], date: string, dependencies: TaskDependency[] = [], now = new Date().toISOString()) {
  const candidates = suggestedTasks(tasks, date, 2, dependencies, now)
  return { candidates, message: candidates.length === 0 ? '実行可能な候補がありません。予定や依存を見直してください。' : candidates.length === 1 ? '候補は1件です。これに取り組むか、再計画してください。' : 'どちらか一つをSpotlightへ追加できます。' }
}

export function suggestedWithReason(tasks: Task[], date: string, dependencies: TaskDependency[] = [], now = new Date().toISOString(), themes: ThemeRule[] = [], focusProjects: string[] = [], savedList?: SmartList, ownerId?: string) {
  const matched = savedList ? new Set(querySmartList(savedList, tasks, ownerId ?? '').map(item => item.id)) : null
  const task = suggestedTasks(tasks, date, tasks.length, dependencies, now, themes, focusProjects).find(item => !matched || matched.has(item.id))
  if (!task) return null
  const reasons = [task.dueDate && task.dueDate <= date ? `期限 ${task.dueDate} が到来` : task.dueDate ? `期限 ${task.dueDate}` : '期限なし', `重要度 ${task.importance}`]
  if (savedList) reasons.push(`保存条件 ${savedList.name}`)
  if (focusProjects.includes(task.project)) reasons.push(`重点プロジェクト ${task.project}`)
  if (dependencies.some(edge => edge.taskId === task.id)) reasons.push('前提タスク完了済み')
  return { task, reasons }
}

export function selectRandomEligible(tasks: Task[], date: string, dependencies: TaskDependency[], seed: number, now = new Date().toISOString()) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('抽選seedが不正です')
  const candidates = suggestedTasks(tasks, date, tasks.length, dependencies, now).sort((a, b) => a.id.localeCompare(b.id))
  return { task: candidates.length ? candidates[seed % candidates.length] : null, candidateIds: candidates.map(task => task.id), seed }
}

export async function drawRandomTask(seed: number, date = today()) {
  return db.transaction('rw', db.tasks, db.taskDependencies, db.audits, async () => {
    const result = selectRandomEligible(await db.tasks.toArray(), date, await db.taskDependencies.toArray(), seed)
    if (result.task) await db.audits.add({ id: uid(), taskId: result.task.id, operation: 'random_choice', at: new Date().toISOString(), detail: JSON.stringify({ seed, candidateIds: result.candidateIds }) })
    return result
  })
}
