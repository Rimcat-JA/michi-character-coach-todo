import type { Task, TaskDependency, ThemeRule } from './domain'
import { executableTasks } from './dependencies'
import { rankTasksByTheme } from './themes'

export function reviewDueTasks(tasks: Task[], date: string): Task[] {
  return tasks.filter(task => !task.deletedAt && task.status === 'open' && task.reviewDate !== null && task.reviewDate <= date)
    .sort((a, b) => a.reviewDate!.localeCompare(b.reviewDate!) || b.importance - a.importance)
}

export function suggestedTasks(tasks: Task[], date: string, limit = 3, dependencies: TaskDependency[] = [], now = new Date().toISOString(), themeRules: ThemeRule[] = []): Task[] {
  const eligible = executableTasks(tasks, dependencies).filter(task => !task.backburner && (!task.snoozedUntil || task.snoozedUntil <= now) && (!task.availableFrom || task.availableFrom <= date) && (!task.deferredUntil || task.deferredUntil <= date))
  return (themeRules.length ? rankTasksByTheme(eligible, date, themeRules) : eligible.sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || b.importance - a.importance)).slice(0, limit)
}

export function contextSuggestions(tasks: Task[], date: string, energy: number | null, focus: number | null, dependencies: TaskDependency[] = [], now = new Date().toISOString(), themeRules: ThemeRule[] = []) {
  const candidates = suggestedTasks(tasks, date, tasks.length, dependencies, now, themeRules)
  const matches: Task[] = [], unknown: Task[] = []
  for (const task of candidates) {
    if ((energy !== null && task.energyNeed != null && task.energyNeed > energy) || (focus !== null && task.focusNeed != null && task.focusNeed > focus)) continue
    if ((energy !== null && task.energyNeed == null) || (focus !== null && task.focusNeed == null)) unknown.push(task)
    else matches.push(task)
  }
  return { matches, unknown }
}

export function urgency(task: Pick<Task, 'dueDate'>, date: string): '期限超過' | '今日' | '近日' | '先' | '期限なし' {
  if (!task.dueDate) return '期限なし'
  const days = Math.round((Date.parse(`${task.dueDate}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86400000)
  return days < 0 ? '期限超過' : days === 0 ? '今日' : days <= 3 ? '近日' : '先'
}

export function sortTasks(tasks: Task[], field: 'scheduled' | 'frog' | 'weight') {
  const result = [...tasks]
  if (field === 'scheduled') return result.sort((a, b) => (a.scheduledDate ?? '9999').localeCompare(b.scheduledDate ?? '9999') || b.updatedAt.localeCompare(a.updatedAt))
  return result.sort((a, b) => (b[field] ?? -1) - (a[field] ?? -1) || b.updatedAt.localeCompare(a.updatedAt))
}

export function nextAvailableDate(task: Task): string | null {
  return [task.availableFrom, task.deferredUntil ?? null].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null
}

export function filterTasksByDates(tasks: Task[], targetDate: string | null, dueDate: string | null) {
  return tasks.filter(task => (!targetDate || task.targetDate === targetDate) && (!dueDate || task.dueDate === dueDate))
}

export function dayCapacity(tasks: Task[], minutesLimit: number, pointsLimit: number) {
  const minutes = tasks.reduce((sum, task) => sum + (task.score.minutes ?? 0), 0)
  const points = tasks.reduce((sum, task) => sum + (task.effectivePoints ?? 0), 0)
  return { minutes, points, minutesLimit, pointsLimit, unknownMinutes: tasks.filter(task => task.score.minutes === null).length, unknownPoints: tasks.filter(task => task.effectivePoints === null).length, overMinutes: minutes > minutesLimit, overPoints: points > pointsLimit }
}
