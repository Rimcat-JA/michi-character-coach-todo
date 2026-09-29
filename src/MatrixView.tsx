import { useState } from 'react'
import type { SmartList, Task } from './domain'
import { buildMatrix, type MatrixAxis } from './matrix'

export function MatrixView({ tasks, lists, ownerId, date, onEdit }: { tasks: Task[]; lists: SmartList[]; ownerId: string; date: string; onEdit: (task: Task) => void }) {
  const [rowAxis, setRowAxis] = useState<MatrixAxis>('importance')
  const [columnAxis, setColumnAxis] = useState<MatrixAxis>('urgency')
  const own = lists.filter(list => list.ownerId === ownerId)
  const options: { value: MatrixAxis; label: string }[] = [{ value: 'importance', label: '重要度' }, { value: 'urgency', label: '緊急度' }, ...own.map(list => ({ value: `smart:${list.id}` as MatrixAxis, label: `Smart List: ${list.name}` }))]
  const resolvedRow = options.some(option => option.value === rowAxis) ? rowAxis : 'importance'
  const resolvedColumn = options.some(option => option.value === columnAxis) ? columnAxis : 'urgency'
  const matrix = buildMatrix(tasks, resolvedRow, resolvedColumn, date, own, ownerId)
  return <details className="card matrix-panel"><summary>Matrix：重要度と緊急度などで見る</summary><div className="matrix-body"><div className="matrix-controls"><label className="field">行<select value={resolvedRow} onChange={event => setRowAxis(event.target.value as MatrixAxis)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label className="field">列<select value={resolvedColumn} onChange={event => setColumnAxis(event.target.value as MatrixAxis)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><strong>{matrix.taskIds.length}件 · {matrix.points}pt</strong></div><div className="matrix-grid">{matrix.cells.map(cell => <div className="matrix-cell" key={`${cell.row}:${cell.column}`}><strong>{cell.row} × {cell.column}</strong><small>{cell.tasks.length}件 · {cell.points}pt</small>{cell.tasks.map(task => <button key={task.id} className="text-button" onClick={() => onEdit(task)}>{task.title}</button>)}</div>)}</div></div></details>
}
