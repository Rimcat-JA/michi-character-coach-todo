import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import { addTaskDependency, removeTaskDependency } from './dependencies'
import type { Task } from './domain'

export default function TaskDependencies({ task, onError }: { task: Task | null; onError: (error: unknown) => void }) {
  const [prerequisiteId, setPrerequisiteId] = useState('')
  const tasks = useLiveQuery(() => db.tasks.toArray(), []) ?? []
  const dependencies = useLiveQuery(() => task ? db.taskDependencies.where('taskId').equals(task.id).toArray() : [], [task?.id]) ?? []
  if (!task) return <p className="muted">依存関係はタスク保存後に設定できます。</p>
  const options = tasks.filter(value => value.id !== task.id && !value.deletedAt)
  return <section className="task-materials"><h3>前提タスク</h3><p className="muted">前提が完了するまで、自動候補には表示しません。循環する依存関係は保存できません。</p>
    {dependencies.map(edge => <div className="material-entry" key={edge.id}><span>{tasks.find(value => value.id === edge.dependsOnId)?.title ?? '削除済み'}</span><button className="text-button" onClick={() => removeTaskDependency(edge.id).catch(onError)}>解除</button></div>)}
    <div className="container-create"><select aria-label="追加する前提タスク" value={prerequisiteId} onChange={event => setPrerequisiteId(event.target.value)}><option value="">選択してください</option>{options.map(value => <option key={value.id} value={value.id}>{value.title}</option>)}</select><button className="secondary-button" disabled={!prerequisiteId} onClick={async () => { try { await addTaskDependency(task.id, prerequisiteId); setPrerequisiteId('') } catch (error) { onError(error) } }}>前提を追加</button></div>
  </section>
}
