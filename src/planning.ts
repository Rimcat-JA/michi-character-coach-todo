import type { Task } from './domain'

export function reviewDueTasks(tasks: Task[], date: string): Task[] {
  return tasks.filter(task => !task.deletedAt && task.status === 'open' && task.reviewDate !== null && task.reviewDate <= date)
    .sort((a, b) => a.reviewDate!.localeCompare(b.reviewDate!) || b.importance - a.importance)
}

export function suggestedTasks(tasks: Task[], date: string, limit = 3): Task[] {
  return tasks.filter(task => !task.deletedAt && task.status === 'open' && (!task.availableFrom || task.availableFrom <= date))
    .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || b.importance - a.importance)
    .slice(0, limit)
}
