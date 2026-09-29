import { ConflictError } from './commands'
import { db } from './db'
import { uid, validateDate, type Completion, type Container, type Goal, type GoalCheckIn, type Habit, type Task, type WorkSession } from './domain'
import { unionSessionMinutes } from './time-tracking'

type GoalInput = Pick<Goal, 'title' | 'description' | 'parentId' | 'dueDate' | 'containerId' | 'taskIds' | 'habitIds' | 'manualPercent' | 'checkInCadence' | 'checkInQuestion'>

export async function createGoal(input: GoalInput): Promise<string> {
  const title = input.title.trim()
  if (!title || title.length > 200 || input.description.length > 10000 || input.checkInQuestion.length > 500) throw new Error('目標の名前・説明・質問を確認してください')
  validateDate(input.dueDate, '目標日')
  if (input.manualPercent !== null && (!Number.isInteger(input.manualPercent) || input.manualPercent < 0 || input.manualPercent > 100)) throw new Error('進捗率は0〜100で指定してください')
  if (input.checkInCadence !== null && !['weekly', 'monthly'].includes(input.checkInCadence)) throw new Error('チェックイン周期が不正です')
  if (new Set(input.taskIds).size !== input.taskIds.length || new Set(input.habitIds).size !== input.habitIds.length || input.taskIds.length > 200 || input.habitIds.length > 100) throw new Error('関連先が重複・過多です')
  return db.transaction('rw', [db.goals, db.tasks, db.habits, db.containers, db.settings], async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('設定がありません')
    if (input.parentId) {
      const parent = await db.goals.get(input.parentId)
      if (!parent || parent.deletedAt || parent.ownerId !== settings.profileId) throw new Error('上位目標がありません')
    }
    if (input.containerId) {
      const container = await db.containers.get(input.containerId)
      if (!container || container.deletedAt || container.ownerId !== settings.profileId) throw new Error('関連プロジェクトがありません')
    }
    for (const taskId of input.taskIds) if (!await db.tasks.get(taskId)) throw new Error('関連タスクがありません')
    for (const habitId of input.habitIds) {
      const habit = await db.habits.get(habitId)
      if (!habit || habit.ownerId !== settings.profileId) throw new Error('関連習慣がありません')
    }
    const id = uid(), at = new Date().toISOString()
    await db.goals.add({ ...input, id, ownerId: settings.profileId, title, revision: 1, createdAt: at, updatedAt: at, deletedAt: null })
    return id
  })
}

export async function updateGoalProgress(id: string, revision: number, percent: number | null): Promise<void> {
  if (percent !== null && (!Number.isInteger(percent) || percent < 0 || percent > 100)) throw new Error('進捗率は0〜100で指定してください')
  await db.transaction('rw', db.goals, async () => {
    const goal = await db.goals.get(id)
    if (!goal || goal.deletedAt) throw new Error('目標がありません')
    if (goal.revision !== revision) throw new ConflictError()
    await db.goals.put({ ...goal, manualPercent: percent, revision: revision + 1, updatedAt: new Date().toISOString() })
  })
}

function insideContainer(task: Task, target: string, containers: Container[]): boolean {
  const byId = new Map(containers.map(container => [container.id, container]))
  let cursor = task.containerId ?? null
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    if (cursor === target) return true
    seen.add(cursor); cursor = byId.get(cursor)?.parentId ?? null
  }
  return false
}

export function goalTaskIds(goal: Goal, goals: Goal[], tasks: Task[], containers: Container[], habits: Habit[]): Set<string> {
  const ids = new Set<string>(), visited = new Set<string>(), byId = new Map(goals.map(item => [item.id, item]))
  function collect(current: Goal) {
    if (visited.has(current.id) || current.deletedAt) return
    visited.add(current.id)
    current.taskIds.forEach(id => ids.add(id))
    if (current.containerId) tasks.filter(task => insideContainer(task, current.containerId!, containers)).forEach(task => ids.add(task.id))
    const routineIds = new Set(habits.filter(habit => current.habitIds.includes(habit.id) && habit.routineId).map(habit => habit.routineId))
    tasks.filter(task => task.routineId && routineIds.has(task.routineId)).forEach(task => ids.add(task.id))
    goals.filter(item => item.parentId === current.id).forEach(child => { const known = byId.get(child.id); if (known) collect(known) })
  }
  collect(goal)
  return ids
}

export function goalProgress(goal: Goal, goals: Goal[], tasks: Task[], containers: Container[], habits: Habit[], completions: Completion[], sessions: WorkSession[]) {
  const ids = goalTaskIds(goal, goals, tasks, containers, habits)
  const completed = completions.filter(item => ids.has(item.taskId) && item.currentAt)
  return { linkedTasks: ids.size, completedTasks: completed.length, points: completed.reduce((sum, item) => sum + (item.netPoints ?? 0), 0), minutes: unionSessionMinutes(sessions.filter(session => ids.has(session.taskId))), manualPercent: goal.manualPercent }
}

export function allGoalsPoints(goals: Goal[], tasks: Task[], containers: Container[], habits: Habit[], completions: Completion[]): number {
  const ids = new Set(goals.flatMap(goal => [...goalTaskIds(goal, goals, tasks, containers, habits)]))
  return completions.filter(item => ids.has(item.taskId) && item.currentAt).reduce((sum, item) => sum + (item.netPoints ?? 0), 0)
}

export async function createGoalCheckIn(goalId: string, date: string, answer: string, summary: string | null = null): Promise<string> {
  validateDate(date, 'チェックイン日')
  if (!answer.trim() || answer.length > 10000 || (summary !== null && summary.length > 10000)) throw new Error('回答・要約を確認してください')
  return db.transaction('rw', [db.goals, db.goalCheckIns, db.settings], async () => {
    const goal = await db.goals.get(goalId), settings = await db.settings.get('main')
    if (!goal || goal.deletedAt || goal.ownerId !== settings?.profileId) throw new Error('目標がありません')
    const id = uid(), at = new Date().toISOString()
    await db.goalCheckIns.add({ id, goalId, date, answer: answer.trim(), summary: summary?.trim() || null, summaryOrigin: summary?.trim() ? 'human' : null, summaryRevision: 1, history: [], createdAt: at, updatedAt: at, deletedAt: null })
    return id
  })
}

export async function reviseGoalCheckIn(id: string, expectedRevision: number, answer: string, summary: string | null): Promise<void> {
  if (!answer.trim() || answer.length > 10000 || (summary !== null && summary.length > 10000)) throw new Error('回答・要約を確認してください')
  await db.transaction('rw', db.goalCheckIns, async () => {
    const current = await db.goalCheckIns.get(id)
    if (!current || current.deletedAt) throw new Error('チェックインがありません')
    if (current.summaryRevision !== expectedRevision) throw new ConflictError()
    const at = new Date().toISOString()
    await db.goalCheckIns.put({ ...current, answer: answer.trim(), summary: summary?.trim() || null, summaryOrigin: summary?.trim() ? 'human' : null, summaryRevision: current.summaryRevision + 1, history: [...current.history, { summary: current.summary, at: current.updatedAt }], updatedAt: at })
  })
}

export async function deleteGoalCheckIn(id: string, expectedRevision: number): Promise<void> {
  await db.transaction('rw', db.goalCheckIns, async () => {
    const current = await db.goalCheckIns.get(id)
    if (!current || current.deletedAt) return
    if (current.summaryRevision !== expectedRevision) throw new ConflictError()
    await db.goalCheckIns.put({ ...current, deletedAt: new Date().toISOString(), summaryRevision: current.summaryRevision + 1 })
  })
}

export function currentCheckInContext(checkIns: GoalCheckIn[], goalId: string): { answer: string; summary: string | null; date: string }[] {
  return checkIns.filter(item => item.goalId === goalId && !item.deletedAt).sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)).map(item => ({ answer: item.answer, summary: item.summary, date: item.date }))
}
