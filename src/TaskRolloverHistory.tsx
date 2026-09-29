import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import type { Task } from './domain'

export default function TaskRolloverHistory({ task }: { task: Task | null }) {
  const entries = useLiveQuery(() => task ? db.rollovers.where('taskId').equals(task.id).toArray() : [], [task?.id]) ?? []
  if (!task || !entries.length) return null
  const ordered = [...entries].sort((a, b) => a.fromDate.localeCompare(b.fromDate))
  return <section className="task-materials"><h3>繰越履歴</h3><p>初回予定日：{task.firstScheduledDate ?? ordered[0].fromDate}</p>{ordered.map(entry => <div className="material-entry" key={entry.id}>{entry.fromDate} → {entry.toDate}</div>)}</section>
}
