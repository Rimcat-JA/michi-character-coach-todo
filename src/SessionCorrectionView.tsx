import { useState } from 'react'
import type { Task, WorkSession } from './domain'
import { correctWorkSession } from './time-tracking'

function localInput(iso: string): string {
  const value = new Date(iso)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${value.getFullYear()}-${two(value.getMonth() + 1)}-${two(value.getDate())}T${two(value.getHours())}:${two(value.getMinutes())}:${two(value.getSeconds())}`
}

export default function SessionCorrectionView({ sessions, tasks, run }: { sessions: WorkSession[]; tasks: Task[]; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [selectedId, setSelectedId] = useState(''), [start, setStart] = useState(''), [end, setEnd] = useState(''), [reason, setReason] = useState('')
  const selected = sessions.find(session => session.id === selectedId)
  function choose(id: string) {
    setSelectedId(id)
    const session = sessions.find(item => item.id === id)
    setStart(session ? localInput(session.startedAt) : '')
    setEnd(session ? localInput(session.endedAt) : '')
    setReason('')
  }
  async function save() {
    if (!selected) return
    const ok = await run(() => correctWorkSession(selected.id, selected.revision ?? 1, new Date(start).toISOString(), new Date(end).toISOString(), reason), '作業区間を訂正しました')
    if (ok) choose('')
  }
  return <section className="card list-card session-correction"><div className="card-heading"><h2>作業区間の訂正</h2></div><p className="muted">元区間と理由を履歴に残します。集計には訂正後の区間を使います。</p><label className="field">区間<select value={selectedId} onChange={event => choose(event.target.value)}><option value="">選択してください</option>{[...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(session => <option key={session.id} value={session.id}>{tasks.find(task => task.id === session.taskId)?.title ?? '削除済みタスク'} · {new Date(session.startedAt).toLocaleString('ja-JP')} · {session.minutes}分</option>)}</select></label>{selected && <><div className="form-grid"><label className="field">開始<input type="datetime-local" step={1} value={start} onChange={event => setStart(event.target.value)} /></label><label className="field">終了<input type="datetime-local" step={1} value={end} onChange={event => setEnd(event.target.value)} /></label></div><label className="field">訂正理由<input value={reason} maxLength={300} onChange={event => setReason(event.target.value)} /></label><button className="secondary-button" disabled={!start || !end || !reason.trim()} onClick={save}>区間を訂正</button><p>版 {selected.revision ?? 1} · 過去の区間 {selected.corrections?.length ?? 0}件</p>{(selected.corrections ?? []).map((entry, index) => <p className="muted" key={index}>{new Date(entry.startedAt).toLocaleString('ja-JP')}〜{new Date(entry.endedAt).toLocaleString('ja-JP')} · {entry.minutes}分 · {entry.reason}</p>)}</>}</section>
}
