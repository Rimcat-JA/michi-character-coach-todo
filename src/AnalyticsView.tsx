import { useState } from 'react'
import { addDays, today, type Completion, type WorkSession } from './domain'
import { dailyPoints, historicalProjectPoints, periodSummary, pointHeatmap } from './analytics'

export default function AnalyticsView({ completions, sessions }: { completions: Completion[]; sessions: WorkSession[] }) {
  const [startDate, setStartDate] = useState(() => addDays(today(), -29)), [endDate, setEndDate] = useState(() => today()), [selectedDate, setSelectedDate] = useState(() => today())
  const validRange = !!startDate && !!endDate && startDate <= endDate
  const summary = validRange ? periodSummary(completions, sessions, startDate, endDate) : null
  const days = pointHeatmap(completions, today(), 91)
  const selected = dailyPoints(completions, selectedDate)
  const categories = historicalProjectPoints(completions)
  return <><section className="card list-card"><div className="card-heading"><div><span className="eyebrow">ANALYTICS</span><h2>期間別の実績</h2></div></div><div className="form-grid"><label className="field">開始日<input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></label><label className="field">終了日<input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></label></div>{summary ? <p>完了 {summary.completed}件 · 確定 {summary.points}pt · 作業 {summary.minutes}分 · ポイント未設定 {summary.pending}件</p> : <p className="muted">有効な期間を選んでください。</p>}</section>
    <section className="card list-card"><div className="card-heading"><div><span className="eyebrow">POINT HEATMAP</span><h2>完了ポイントのヒートマップ</h2></div></div><p className="muted">過去91日。空白・0pt・未設定・確定ポイントを分けて表示します。</p><div className="point-heatmap">{days.map(day => <button key={day.date} className={`heatmap-day ${day.state}`} title={`${day.date}：${day.points}pt、${day.completed}件、未設定${day.pending}件`} aria-label={`${day.date}の実績`} onClick={() => setSelectedDate(day.date)}>{day.date.slice(8)}</button>)}</div><p className="muted">凡例：□ 実績なし / 0 0pt / ? 未設定 / 濃色 確定pt</p><h3>{selectedDate}：{selected.points}pt · {selected.completed}件{selected.pending ? ` · 未設定${selected.pending}件` : ''}</h3>{selected.details.length ? selected.details.map(item => <div className="heatmap-detail" key={item.taskId}><span>{item.title} · {item.project || 'Inbox'}</span><strong>{item.points === null ? '未設定' : `${item.points}pt`}</strong></div>) : <p className="muted">この日の完了はありません。</p>}</section>
    <section className="card list-card"><div className="card-heading"><h2>完了時カテゴリ別（全期間）</h2></div><p className="muted">現在のタスク分類を変えても、完了時の分類で集計します。</p>{categories.length ? categories.map(row => <div className="heatmap-detail" key={row.project}><span>{row.project} · {row.completed}件{row.pending ? ` · 未設定${row.pending}件` : ''}</span><strong>{row.points}pt</strong></div>) : <p className="muted">完了記録はありません。</p>}</section>
  </>
}
