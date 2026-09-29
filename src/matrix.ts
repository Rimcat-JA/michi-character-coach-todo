import type { SmartList, Task } from './domain'
import { urgency } from './planning'
import { querySmartList } from './smart-lists'

export type MatrixAxis = 'importance' | 'urgency' | `smart:${string}`
export type MatrixCell = { row: string; column: string; tasks: Task[]; points: number }

function axis(task: Task, kind: MatrixAxis, date: string, matched: Set<string>): string {
  if (kind === 'importance') return ['低', '通常', '高', '最優先'][task.importance] ?? '通常'
  if (kind === 'urgency') return urgency(task, date)
  return matched.has(task.id) ? '該当' : '非該当'
}

export function buildMatrix(tasks: Task[], rowAxis: MatrixAxis, columnAxis: MatrixAxis, date: string, lists: SmartList[], ownerId: string) {
  const available = (axis: MatrixAxis) => axis === 'importance' ? ['低', '通常', '高', '最優先'] : axis === 'urgency' ? ['期限超過', '今日', '近日', '先', '期限なし'] : ['該当', '非該当']
  const matchIds = (axis: MatrixAxis) => {
    if (!axis.startsWith('smart:')) return new Set<string>()
    const list = lists.find(item => item.id === axis.slice(6) && item.ownerId === ownerId)
    if (!list) throw new Error('MatrixのSmart Listにアクセスできません')
    return new Set(querySmartList(list, tasks, ownerId).map(task => task.id))
  }
  const rowMatches = matchIds(rowAxis), columnMatches = matchIds(columnAxis)
  const unique = [...new Map(tasks.filter(task => !task.deletedAt && task.status === 'open').map(task => [task.id, task])).values()]
  const rows = available(rowAxis), columns = available(columnAxis)
  const cells: MatrixCell[] = rows.flatMap(row => columns.map(column => ({ row, column, tasks: [], points: 0 })))
  const byKey = new Map(cells.map(cell => [`${cell.row}\u0000${cell.column}`, cell]))
  for (const task of unique) {
    const row = axis(task, rowAxis, date, rowMatches), column = axis(task, columnAxis, date, columnMatches)
    const cell = byKey.get(`${row}\u0000${column}`)
    if (!cell) throw new Error('Matrixの区分が不正です')
    cell.tasks.push(task)
    cell.points += task.effectivePoints ?? 0
  }
  return { rows, columns, cells, taskIds: unique.map(task => task.id), points: unique.reduce((sum, task) => sum + (task.effectivePoints ?? 0), 0) }
}
