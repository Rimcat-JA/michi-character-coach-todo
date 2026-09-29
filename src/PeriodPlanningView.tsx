import { useState } from 'react'
import { assignTaskToBucket, createPlanningBucket, periodPointTotals } from './period-planning'
import { today, type PlanningBucket, type Task } from './domain'

const kindName = { week: '週', month: '月', quarter: '四半期' }
export default function PeriodPlanningView({ buckets, tasks, ownerId, run }: { buckets: PlanningBucket[]; tasks: Task[]; ownerId: string; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [kind, setKind] = useState<PlanningBucket['kind']>('quarter'), [date, setDate] = useState(today()), [parentId, setParentId] = useState('')
  const [taskId, setTaskId] = useState(''), [bucketId, setBucketId] = useState('')
  const own = buckets.filter(bucket => bucket.ownerId === ownerId), totals = periodPointTotals(own, tasks)
  const ordered = [...own].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.kind.localeCompare(b.kind))
  const activeTasks = tasks.filter(task => !task.deletedAt)
  async function assign() {
    const task = activeTasks.find(item => item.id === taskId)
    if (task) await run(() => assignTaskToBucket(task.id, task.revision, bucketId || null), '計画枠を更新しました')
  }
  return <>
    <div className="page-heading"><div><span className="eyebrow">PLANNING AHEAD</span><h1>週・月・四半期</h1><p>期間にタスクを置き、日付が未定でも計画を保持します。月へ移しても同じタスクを参照します。</p></div></div>
    <section className="card list-card"><div className="card-heading"><h2>期間を作成</h2></div><div className="container-create"><select aria-label="期間の種類" value={kind} onChange={event => { setKind(event.target.value as PlanningBucket['kind']); setParentId('') }}><option value="quarter">四半期</option><option value="month">月</option><option value="week">週</option></select><input aria-label="含まれる日付" type="date" value={date} onChange={event => setDate(event.target.value)} /><select aria-label="親の期間" value={parentId} onChange={event => setParentId(event.target.value)}><option value="">親なし</option>{own.filter(item => kind === 'month' ? item.kind === 'quarter' : kind === 'week' ? item.kind !== 'week' : false).map(item => <option key={item.id} value={item.id}>{kindName[item.kind]} {item.startDate}〜{item.endDate}</option>)}</select><button className="primary-button" disabled={!date} onClick={() => run(() => createPlanningBucket(kind, date, parentId || null), '計画枠を作成しました')}>作成</button></div></section>
    <section className="card list-card"><div className="card-heading"><h2>タスクを配置</h2></div><div className="container-create"><select aria-label="配置するタスク" value={taskId} onChange={event => setTaskId(event.target.value)}><option value="">選択してください</option>{activeTasks.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><select aria-label="配置先の期間" value={bucketId} onChange={event => setBucketId(event.target.value)}><option value="">期間から外す</option>{ordered.map(item => <option key={item.id} value={item.id}>{kindName[item.kind]} {item.startDate}〜{item.endDate}</option>)}</select><button className="primary-button" disabled={!taskId} onClick={assign}>配置を保存</button></div><p className="muted">予定日と期限は変わりません。</p></section>
    <section className="card list-card"><div className="card-heading"><h2>計画枠</h2></div>{ordered.length ? ordered.map(item => <div className="container-row" key={item.id}><strong>{kindName[item.kind]} {item.startDate}〜{item.endDate}</strong><span>{totals.get(item.id)?.tasks ?? 0}タスク · {totals.get(item.id)?.points ?? 0}pt</span><span>{item.parentId ? '親の期間内' : '最上位'}</span></div>) : <p className="muted">計画枠はまだありません。</p>}</section>
  </>
}
