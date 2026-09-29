import type { Task } from './domain'

export function truncateTasks(tasks: Task[], limit: number | null) {
  if (limit !== null && ![5, 10, 20, 50].includes(limit)) throw new Error('表示件数が不正です')
  const shown = limit === null ? tasks : tasks.slice(0, limit)
  return { shown, remaining: tasks.length - shown.length, total: tasks.length }
}
