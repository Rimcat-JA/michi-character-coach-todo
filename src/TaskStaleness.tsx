import { today, type Task } from './domain'
import { taskStaleness } from './staleness'

export default function TaskStaleness({ task }: { task: Task | null }) {
  if (!task) return null
  const value = taskStaleness(task, today())
  return <section className="task-materials"><h3>経過の目安</h3><p>初回予定日：{value.firstScheduledDate ?? '未設定'} · 初回予定日から：{value.daysSinceFirstScheduled === null ? '未設定' : `${value.daysSinceFirstScheduled}日`} · 最終更新から：{value.daysSinceUpdate}日</p></section>
}
