import { addDays, today, validateDate, type Completion, type WorkSession } from './domain'
import { unionSessionMinutes } from './time-tracking'

export type DailyPoints = { date: string; points: number; completed: number; pending: number; state: 'empty' | 'zero' | 'pending' | 'points' | 'unsynced'; details: { taskId: string; title: string; project: string; points: number | null }[] }

export function completionDay(item: Completion): string | null {
  return item.currentAt ? item.localDate ?? today(new Date(item.currentAt)) : null
}

export function dailyPoints(completions: Completion[], date: string, unsynced = false): DailyPoints {
  validateDate(date, '集計日')
  if (unsynced) return { date, points: 0, completed: 0, pending: 0, state: 'unsynced', details: [] }
  const byTask = new Map(completions.filter(item => completionDay(item) === date).map(item => [item.taskId, item]))
  const details = [...byTask.values()].map(item => ({ taskId: item.taskId, title: item.title, project: item.project, points: item.netPoints }))
  const points = details.reduce((sum, item) => sum + (item.points ?? 0), 0)
  const pending = details.filter(item => item.points === null).length
  const state = details.length === 0 ? 'empty' : points > 0 ? 'points' : pending ? 'pending' : 'zero'
  return { date, points, completed: details.length, pending, state, details }
}

export function pointHeatmap(completions: Completion[], endDate: string, days: number, unsyncedDates = new Set<string>()): DailyPoints[] {
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('表示日数は1〜366日です')
  return Array.from({ length: days }, (_, index) => dailyPoints(completions, addDays(endDate, index - days + 1), unsyncedDates.has(addDays(endDate, index - days + 1))))
}

export function historicalProjectPoints(completions: Completion[]): { project: string; completed: number; points: number; pending: number }[] {
  const map = new Map<string, { project: string; completed: number; points: number; pending: number }>()
  for (const item of completions.filter(item => item.currentAt)) {
    const project = item.project || 'Inbox', row = map.get(project) ?? { project, completed: 0, points: 0, pending: 0 }
    row.completed++; row.points += item.netPoints ?? 0; if (item.netPoints === null) row.pending++
    map.set(project, row)
  }
  return [...map.values()].sort((a, b) => b.points - a.points || a.project.localeCompare(b.project))
}

export function periodSummary(completions: Completion[], sessions: WorkSession[], startDate: string, endDate: string) {
  validateDate(startDate, '開始日'); validateDate(endDate, '終了日')
  if (endDate < startDate) throw new Error('終了日は開始日以降にしてください')
  const selected = completions.filter(item => { const date = completionDay(item); return date !== null && date >= startDate && date <= endDate })
  const start = new Date(`${startDate}T00:00:00`).getTime(), end = new Date(`${addDays(endDate, 1)}T00:00:00`).getTime()
  const clipped = sessions.flatMap(session => {
    const from = Math.max(start, Date.parse(session.startedAt)), to = Math.min(end, Date.parse(session.endedAt))
    return to > from ? [{ startedAt: new Date(from).toISOString(), endedAt: new Date(to).toISOString() }] : []
  })
  return { completed: selected.length, points: selected.reduce((sum, item) => sum + (item.netPoints ?? 0), 0), pending: selected.filter(item => item.netPoints === null).length, minutes: unionSessionMinutes(clipped) }
}
