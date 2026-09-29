import { validateDate, type Task } from './domain'

export type PrintTaskRow = { id: string; title: string; project: string; scheduledDate: string | null; dueDate: string | null; points: number | null }

export function redactPrintText(value: string): string {
  return value.replace(/sk-(?:or-v1-)?[A-Za-z0-9_-]{20,}/g, '[secret]').replace(/https?:\/\/\S+/g, '[link omitted]')
}

export function printTaskRows(tasks: Task[], startDate: string, endDate: string): PrintTaskRow[] {
  if (startDate) validateDate(startDate, '印刷開始日')
  if (endDate) validateDate(endDate, '印刷終了日')
  if (startDate && endDate && startDate > endDate) throw new Error('印刷期間の終了日は開始日以降にしてください')
  const selected = tasks.filter(task => !task.deletedAt && (!startDate && !endDate || [task.scheduledDate, task.dueDate].some(date => date && (!startDate || date >= startDate) && (!endDate || date <= endDate))))
  return selected.map(task => ({ id: task.id, title: redactPrintText(task.title), project: redactPrintText(task.project), scheduledDate: task.scheduledDate, dueDate: task.dueDate, points: task.effectivePoints }))
}
