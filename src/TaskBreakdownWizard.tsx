import { useState } from 'react'
import { applyBreakdownProposal, suggestBreakdown, type BreakdownProposal, type ResistanceReason } from './breakdown'
import type { Task } from './domain'

const reasons: { value: ResistanceReason; label: string }[] = [
  { value: 'unclear', label: '何をすればよいか曖昧' },
  { value: 'large', label: '作業が大きすぎる' },
  { value: 'waiting', label: '誰か・何かを待っている' },
  { value: 'priority', label: '他に優先事項がある' },
  { value: 'difficult', label: '今日は着手しにくい' },
]

export default function TaskBreakdownWizard({ task, onError, onClose }: { task: Task | null; onError: (error: unknown) => void; onClose: () => void }) {
  const [reason, setReason] = useState<ResistanceReason>('large')
  const [proposal, setProposal] = useState<BreakdownProposal | null>(null)
  const [saving, setSaving] = useState(false)
  if (!task || task.status !== 'open') return null
  const canSplit = ['manual', 'allocated'].includes(task.score.mode) && task.score.manualPoints !== null
  const sum = proposal?.steps.reduce((total, step) => total + step.points, 0) ?? 0
  const ready = proposal?.steps.every(step => step.title.trim() && Number.isInteger(step.points) && step.points >= 0) && sum === task.score.manualPoints
  function editStep(index: number, patch: Partial<BreakdownProposal['steps'][number]>) {
    setProposal(current => current ? { ...current, steps: current.steps.map((step, i) => i === index ? { ...step, ...patch } : step) } : null)
  }
  async function apply() {
    if (!proposal) return
    setSaving(true)
    try { await applyBreakdownProposal(proposal); onClose() } catch (error) { onError(error) } finally { setSaving(false) }
  }
  return <section className="task-materials breakdown-wizard">
    <h3>困っているときの作業分割</h3>
    <p>理由から小さな手順案を作れます。案は採用するまで保存されません。</p>
    {!canSplit ? <p className="muted">先に「必要ポイント」タブでポイントを手動で確定して保存してください。</p> : <>
      <label className="field">困っている理由
        <select value={reason} onChange={event => { setReason(event.target.value as ResistanceReason); setProposal(null) }}>
          {reasons.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <button className="secondary-button" onClick={() => setProposal(suggestBreakdown(task, reason))}>分割案を作る</button>
      {proposal && <div className="breakdown-preview">
        <p>親の残り {task.score.manualPoints}pt → 子タスク {proposal.steps.length}件へ配分。親の残りは0ptになります。</p>
        {proposal.steps.map((step, index) => <div className="breakdown-row" key={index}>
          <input aria-label={`手順${index + 1}の名前`} maxLength={300} value={step.title} onChange={event => editStep(index, { title: event.target.value })} />
          <input aria-label={`手順${index + 1}のポイント`} type="number" min={0} max={100000} step={1} value={step.points} onChange={event => editStep(index, { points: event.target.value === '' ? NaN : Number(event.target.value) })} />
          <span>pt</span>
        </div>)}
        <p>配分合計：{Number.isNaN(sum) ? '入力待ち' : sum} / {task.score.manualPoints}pt</p>
        <button className="primary-button" disabled={!ready || saving} onClick={apply}>{saving ? '採用中…' : '内容を確認して分割案を採用'}</button>
        <button className="text-button" onClick={() => setProposal(null)}>案を破棄</button>
      </div>}
    </>}
  </section>
}
