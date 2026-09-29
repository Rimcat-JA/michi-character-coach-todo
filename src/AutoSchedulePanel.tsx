import { useState } from 'react'
import { commitDueSchedule, proposeDueSchedule, type DuePlacement, type DueUnplaced } from './due-planner'
import { today, type Settings, type Task, type TaskDependency, type TimeBlock } from './domain'

export default function AutoSchedulePanel({ tasks, dependencies, blocks, settings, run }: { tasks: Task[]; dependencies: TaskDependency[]; blocks: TimeBlock[]; settings: Settings; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [preview, setPreview] = useState<{ placements: DuePlacement[]; unplaced: DueUnplaced[] } | null>(null)
  const byId = new Map(tasks.map(task => [task.id, task]))
  return <section className="card list-card"><div className="card-heading"><div><span className="eyebrow">DUE TASK PLANNER</span><h2>期限タスクの配置案</h2></div><button className="secondary-button" onClick={() => setPreview(proposeDueSchedule(tasks, dependencies, blocks, settings, today()))}>配置案を計算</button></div><p className="muted">期限までの90日以内で、前提・開始可能日・時間・ポイント容量を確認します。確定前はタスクを変更しません。</p>{preview && <><div className="suggestion-list">{preview.placements.map(item => <div className="suggestion" key={item.taskId}><span>{byId.get(item.taskId)?.title ?? 'タスク'} → {item.date}</span></div>)}{preview.unplaced.map(item => <div className="suggestion" key={item.taskId}><span>{byId.get(item.taskId)?.title ?? 'タスク'}：未配置 · {item.reason}</span></div>)}{!preview.placements.length && !preview.unplaced.length && <p className="muted">配置対象の期限タスクはありません。</p>}</div><button className="primary-button" disabled={!preview.placements.length} onClick={async () => { if (await run(() => commitDueSchedule(preview.placements, today()), '配置案を保存しました')) setPreview(null) }}>配置案を保存</button></>}</section>
}
