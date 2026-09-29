import { useState } from 'react'
import type { Task } from './domain'
import { printTaskRows } from './printing'

export default function PrintPreview({ tasks, onClose }: { tasks: Task[]; onClose: () => void }) {
  const [startDate, setStartDate] = useState(''), [endDate, setEndDate] = useState('')
  let rows: ReturnType<typeof printTaskRows> = [], error = ''
  try { rows = printTaskRows(tasks, startDate, endDate) } catch (caught) { error = caught instanceof Error ? caught.message : String(caught) }
  const totalPoints = rows.reduce((sum, row) => sum + (row.points ?? 0), 0)
  return <div className="print-overlay" role="dialog" aria-modal="true" aria-label="印刷プレビュー"><div className="print-sheet">
    <div className="print-controls"><h2>選択したタスクを印刷</h2><p>タスク名・カテゴリ・日付・必要ポイントだけを印刷します。メモ、資料本文、リンクは含めません。</p><div className="form-grid"><label className="field">期間開始<input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></label><label className="field">期間終了<input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></label></div>{error && <p role="alert">{error}</p>}<button className="primary-button" disabled={!!error || rows.length === 0} onClick={() => window.print()}>印刷・PDF保存</button><button className="secondary-button" onClick={onClose}>閉じる</button></div>
    <header><h1>michi · タスク一覧</h1><p>期間：{startDate || '指定なし'} 〜 {endDate || '指定なし'} · {rows.length}件 · 確定 {totalPoints}pt · 未設定 {rows.filter(row => row.points === null).length}件</p></header>
    <table><thead><tr><th>No.</th><th>タスク</th><th>カテゴリ</th><th>予定日</th><th>期限</th><th>必要pt</th></tr></thead><tbody>{rows.map((row, index) => <tr key={row.id}><td>{index + 1}</td><td>{row.title}</td><td>{row.project || 'Inbox'}</td><td>{row.scheduledDate ?? '—'}</td><td>{row.dueDate ?? '—'}</td><td>{row.points === null ? '未設定' : row.points}</td></tr>)}</tbody></table>
  </div></div>
}
