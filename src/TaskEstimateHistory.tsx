import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import type { Assessment, Task, WorkSession } from './domain'
import { estimateHistory } from './estimate-history'
import { unionSessionMinutes } from './time-tracking'

const minutes = (value: number | null) => value === null ? '未設定' : `${value}分`
const origin: Record<Assessment['origin'], string> = { human: '本人の保存', routine: 'ルーティンから作成', user_instruction_via_agent: '本人の指示を代理入力' }
export function EstimateHistoryTable({ task, assessments, sessions }: { task: Task; assessments: Assessment[]; sessions: WorkSession[] }) {
  const [limit, setLimit] = useState(50)
  const entries = estimateHistory(task, assessments), recorded = sessions.filter(row => row.taskId === task.id)
  return <details className="task-materials"><summary>保存済みの見積履歴（{entries.length}件）</summary>
    <p className="muted">保存した評価ごとの作業・移動の内訳です。入力中の値は保存するまで履歴に入りません。同じ日時の行は編集順を確定できません。</p>
    {recorded.length > 0 ? <p>記録済みの実作業時間: {unionSessionMinutes(recorded)}分（重なる区間は一度だけ集計）</p> : <p className="muted">実作業時間の記録はまだありません。</p>}
    {entries.length ? <div style={{ overflowX: 'auto' }}><table className="handoff-table"><thead><tr><th scope="col">保存日時</th><th scope="col">作業</th><th scope="col">移動</th><th scope="col">合計</th><th scope="col">保存元</th></tr></thead><tbody>{entries.slice(0, limit).map(row => <tr key={row.id}><th scope="row">{new Date(row.at).toLocaleString('ja-JP')}{row.current && <span className="status-tag">現在の保存値</span>}</th><td>{minutes(row.workMinutes)}</td><td>{minutes(row.travelMinutes)}</td><td>{row.totalMinutes === null ? `未設定を含む（分かっている分 ${row.knownMinutes}分）` : minutes(row.totalMinutes)}</td><td>{origin[row.origin]}</td></tr>)}</tbody></table></div> : <p className="muted">保存済みの見積履歴はありません。</p>}
    {entries.length > limit && <button type="button" className="secondary-button" onClick={() => setLimit(current => current + 50)}>さらに50件表示（残り{entries.length - limit}件）</button>}
  </details>
}
export default function TaskEstimateHistory({ task }: { task: Task | null }) {
  const rows = useLiveQuery<{ assessments: Assessment[]; sessions: WorkSession[] } | null>(() => task ? db.transaction('r', [db.assessments, db.sessions], async () => ({ assessments: await db.assessments.where('taskId').equals(task.id).toArray(), sessions: await db.sessions.where('taskId').equals(task.id).toArray() })) : null, [task?.id])
  if (!task || !rows) return null
  return <EstimateHistoryTable key={task.id} task={task} assessments={rows.assessments} sessions={rows.sessions} />
}
