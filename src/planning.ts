import type { Task } from './domain'

export function reviewDueTasks(tasks: Task[], date: string): Task[] {
  return tasks.filter(task => !task.deletedAt && task.status === 'open' && task.reviewDate !== null && task.reviewDate <= date)
    .sort((a, b) => a.reviewDate!.localeCompare(b.reviewDate!) || b.importance - a.importance)
}

export function suggestedTasks(tasks: Task[], date: string, limit = 3): Task[] {
  return tasks.filter(task => !task.deletedAt && task.status === 'open' && (!task.availableFrom || task.availableFrom <= date) && (!task.deferredUntil || task.deferredUntil <= date))
    .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || b.importance - a.importance)
    .slice(0, limit)
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
