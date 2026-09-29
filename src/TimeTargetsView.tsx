import { useState } from 'react'
import { addDays, today, type Container, type Settings, type Task, type WorkSession } from './domain'
import { createTimeTarget, removeTimeTarget, timeTargetProgress } from './progress'

export default function TimeTargetsView({ settings, containers, tasks, sessions, run }: { settings: Settings; containers: Container[]; tasks: Task[]; sessions: WorkSession[]; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [containerId, setContainerId] = useState('')
  const [startDate, setStartDate] = useState(() => today())
  const [endDate, setEndDate] = useState(() => addDays(today(), 6))
  const [targetHours, setTargetHours] = useState('3')
  const available = containers.filter(container => !container.deletedAt && container.ownerId === settings.profileId)
  return <section className="card list-card time-targets"><div className="card-heading"><div><span className="eyebrow">TIME TARGETS</span><h2>作業時間の目標</h2></div></div>
    <p className="muted">対象のカテゴリ・プロジェクトと期間を選び、実際の作業区間を重複を除いて集計します。</p>
    <div className="form-grid">
      <label className="field">対象<select value={containerId} onChange={event => setContainerId(event.target.value)}><option value="">選択してください</option>{available.map(container => <option key={container.id} value={container.id}>{container.name}</option>)}</select></label>
      <label className="field">目標時間<input type="number" min={1} max={1666} step={0.5} value={targetHours} onChange={event => setTargetHours(event.target.value)} /></label>
      <label className="field">開始日<input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></label>
      <label className="field">終了日<input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></label>
    </div>
    <button className="secondary-button" disabled={!containerId || !targetHours || Number(targetHours) <= 0} onClick={() => run(() => createTimeTarget(containerId, startDate, endDate, Math.round(Number(targetHours) * 60)), '時間目標を保存しました')}>時間目標を追加</button>
    {(settings.timeTargets ?? []).map(target => {
      const progress = timeTargetProgress(target, tasks, containers, sessions)
      return <div className="time-target-row" key={target.id}><strong>{available.find(item => item.id === target.containerId)?.name ?? '削除済みの対象'} · {target.startDate}〜{target.endDate}</strong><span>{progress.minutes} / {progress.targetMinutes}分（{progress.percent}%）</span><progress value={progress.minutes} max={progress.targetMinutes} /><button className="text-button" onClick={() => run(() => removeTimeTarget(target.id), '時間目標を削除しました')}>削除</button></div>
    })}
  </section>
}
