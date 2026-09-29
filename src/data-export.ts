import type { Task } from './domain'

const csvCell = (value: unknown) => {
  const raw = value === null || value === undefined ? '' : String(value)
  const safe = /^[\s]*[=+\-@]/.test(raw) ? `'${raw}` : raw
  return `"${safe.replaceAll('"', '""')}"`
}

export function tasksToCsv(tasks: Task[]): string {
  const columns = ['id', 'title', 'notes', 'project', 'labels', 'scheduledDate', 'dueDate', 'targetDate', 'reviewDate', 'availableFrom', 'importance', 'scoreMode', 'effectivePoints', 'status', 'deletedAt'] as const
  const rows = tasks.map(task => [task.id, task.title, task.notes, task.project, task.labels.join(', '), task.scheduledDate, task.dueDate, task.targetDate, task.reviewDate, task.availableFrom, task.importance, task.score.mode, task.effectivePoints, task.status, task.deletedAt])
  return [columns.map(csvCell).join(','), ...rows.map(row => row.map(csvCell).join(','))].join('\r\n') + '\r\n'
}

const icsText = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll(',', '\\,').replaceAll(';', '\\;')
const icsDate = (value: string) => value.replaceAll('-', '')
function foldIcs(line: string): string {
  const encoder = new TextEncoder()
  const parts: string[] = []
  let current = '', bytes = 0
  for (const char of line) {
    const size = encoder.encode(char).length
    if (bytes + size > 75) { parts.push(current); current = ' '; bytes = 1 }
    current += char; bytes += size
  }
  parts.push(current)
  return parts.join('\r\n')
}

export function tasksToIcs(tasks: Task[], exportedAt = new Date().toISOString()): string {
  const stamp = exportedAt.replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}Z$/, 'Z')
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//michi//Character Coach ToDo//JA']
  for (const task of tasks) {
    if (task.deletedAt || (!task.scheduledDate && !task.dueDate)) continue
    lines.push('BEGIN:VTODO', `UID:${task.id}@michi.local`, `DTSTAMP:${stamp}`, `SUMMARY:${icsText(task.title)}`)
    if (task.scheduledDate) lines.push(`DTSTART;VALUE=DATE:${icsDate(task.scheduledDate)}`)
    if (task.dueDate) lines.push(`DUE;VALUE=DATE:${icsDate(task.dueDate)}`)
    lines.push(`STATUS:${task.status === 'completed' ? 'COMPLETED' : 'NEEDS-ACTION'}`, 'END:VTODO')
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldIcs).join('\r\n') + '\r\n'
}
