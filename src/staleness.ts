import { today, type Task } from './domain'

function elapsedDays(start: string, date: string) {
  const difference = Date.parse(`${date}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)
  return Math.max(0, Math.round(difference / 86400000))
}

export function taskStaleness(task: Task, date: string) {
  const first = task.firstScheduledDate ?? task.scheduledDate
  const updatedDate = today(new Date(task.updatedAt))
  return { firstScheduledDate: first, daysSinceFirstScheduled: first ? elapsedDays(first, date) : null, daysSinceUpdate: elapsedDays(updatedDate, date) }
}
