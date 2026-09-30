import { useState } from 'react'
import type { Task } from './domain'
import { prepareTripBundle, type TripAttributes, type TripBundle, type TripBundleProposal } from './trip-bundles'

type Props = { tasks: Task[]; bundles: TripBundle[]; onApply: (proposal: TripBundleProposal, confirmedManualIds: string[]) => Promise<unknown>; onRemove?: (bundle: TripBundle) => Promise<unknown> }
const attributesFromTask = (task: Task): TripAttributes => ({ minutes: task.score.minutes, difficulty: task.score.difficulty, uncertainty: task.score.uncertainty, coordination: task.score.coordination, physical: task.score.physical })
const scales = [['difficulty', '難しさ', 4], ['uncertainty', '不確実さ', 3], ['coordination', '対人調整', 3], ['physical', '身体負荷', 3]] as const

export default function TripBundlesView({ tasks, bundles, onApply, onRemove }: Props) {
  const [title, setTitle] = useState('')
  const [travel, setTravel] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [draftAttributes, setDraftAttributes] = useState<Record<string, TripAttributes>>({})
  const [proposal, setProposal] = useState<TripBundleProposal | null>(null)
  const [manualAllocation, setManualAllocation] = useState<Record<string, string> | null>(null)
  const [manualConfirmed, setManualConfirmed] = useState<string[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const eligible = tasks.filter(task => !task.deletedAt && task.status === 'open' && task.score.mode !== 'allocated' && !bundles.some(bundle => bundle.members.some(member => member.taskId === task.id)))
  const canApply = proposal && !manualAllocation && proposal.manualConfirmationIds.every(id => manualConfirmed.includes(id))

  function invalidate() { setProposal(null); setManualAllocation(null); setManualConfirmed([]); setError(''); setNotice('') }
  function choose(task: Task, included: boolean) {
    invalidate()
    setSelected(current => included ? [...current, task.id] : current.filter(id => id !== task.id))
    setDraftAttributes(current => ({ ...current, [task.id]: current[task.id] ?? attributesFromTask(task) }))
  }
  function editAttribute(taskId: string, key: keyof TripAttributes, value: number | null) {
    invalidate(); setDraftAttributes(current => ({ ...current, [taskId]: { ...current[taskId], [key]: value } }))
  }
  async function preview() {
    setError(''); setNotice(''); setSaving(true)
    try {
      const next = await prepareTripBundle(tasks, { title, travelMinutes: Number(travel), members: selected.map(taskId => ({ taskId, attributes: draftAttributes[taskId] })) })
      setProposal(next); setManualAllocation(null); setManualConfirmed([])
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setSaving(false) }
  }
  async function updateAllocation() {
    if (!proposal || !manualAllocation) return
    setError(''); setSaving(true)
    try {
      const allocations = Object.fromEntries(proposal.members.map(member => [member.taskId, manualAllocation[member.taskId] === '' ? NaN : Number(manualAllocation[member.taskId])]))
      const next = await prepareTripBundle(tasks, { ...proposal.input, allocationMode: 'manual', allocations }, proposal.id)
      setProposal(next); setManualAllocation(null); setManualConfirmed([])
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setSaving(false) }
  }
  async function apply() {
    if (!proposal || !canApply) return
    setError(''); setSaving(true)
    try {
      await onApply(proposal, [...manualConfirmed])
      setProposal(null); setSelected([]); setDraftAttributes({}); setManualConfirmed([]); setManualAllocation(null); setTitle(''); setTravel('')
      setNotice('共通外出と必要ポイントの配分をこの端末に保存しました。')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setSaving(false) }
  }
  async function remove(bundle: TripBundle) {
    if (!onRemove) return
    setError(''); setSaving(true)
    try { await onRemove(bundle); invalidate(); setNotice('まとめを取り消し、各タスクの以前のポイント設定を戻しました。') }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setSaving(false) }
  }

  return <section className="card trip-bundles">
    <h2>同じ外出へまとめる</h2>
    <p>1回の外出で行うタスクを選び、共通の移動時間と外出加点を一度だけ計算します。保存前に配分を確認できます。</p>
    <div className="form-grid">
      <label className="field">外出の名前<input maxLength={200} value={title} disabled={saving} onChange={event => { invalidate(); setTitle(event.target.value) }} placeholder="図書館と買い物" /></label>
      <label className="field">共通の移動時間（分）<input type="number" min={0} max={10080} step={1} value={travel} disabled={saving} onChange={event => { invalidate(); setTravel(event.target.value) }} placeholder="移動なしなら0" /></label>
    </div>
    <fieldset disabled={saving}><legend>同じ外出で行う未完了タスク</legend>
      {eligible.length ? eligible.map(task => <div className="trip-bundle-task" key={task.id}>
        <label><input type="checkbox" checked={selected.includes(task.id)} onChange={event => choose(task, event.target.checked)} /> {task.title} <small>{task.effectivePoints === null ? '必要pt未設定' : `${task.effectivePoints}pt`} · {task.score.mode === 'manual' ? '手動' : '式／未設定'}</small></label>
        {selected.includes(task.id) && <div className="form-grid">
          <label className="field">{task.title}の作業分数<input type="number" min={0} max={10080} step={1} value={draftAttributes[task.id]?.minutes ?? ''} onChange={event => editAttribute(task.id, 'minutes', event.target.value === '' ? null : Number(event.target.value))} placeholder="不明な場合は確認してください" /></label>
          {scales.map(([key, label, max]) => <label className="field" key={key}>{task.title}の{label}<select value={draftAttributes[task.id]?.[key] ?? ''} onChange={event => editAttribute(task.id, key, event.target.value === '' ? null : Number(event.target.value))}><option value="">不明</option>{Array.from({ length: max + 1 }, (_, value) => <option key={value} value={value}>{value}</option>)}</select></label>)}
        </div>}
      </div>) : <p className="muted">未完了で、まだ別の予算や外出に配分されていないタスクを登録してください。</p>}
    </fieldset>
    <button className="secondary-button" disabled={saving || !selected.length || !title.trim() || travel === ''} onClick={preview}>配分案を計算</button>
    {error && <p className="form-error" role="alert">エラー: {error}</p>}
    {notice && <p role="status">{notice}</p>}
    {proposal && <div className="trip-bundle-preview">
      <h3>{proposal.input.title}の配分案</h3>
      <p>合計 {proposal.totalPoints}pt · 作業と共通移動 {proposal.totalMinutes}分。外出の加点10ptと最低20ptは外出全体に一度だけ適用します。</p>
      <div className="table-scroll"><table><thead><tr><th>タスク</th><th>現在</th><th>単独なら</th><th>今回の配分</th><th>移動の配分</th></tr></thead><tbody>
        {proposal.members.map(member => <tr key={member.taskId}><td>{tasks.find(task => task.id === member.taskId)?.title ?? member.taskId}</td><td>{member.previousEffectivePoints === null ? '未設定' : `${member.previousEffectivePoints}pt`}</td><td>{member.standalonePoints}pt</td><td>{manualAllocation ? <input type="number" min={0} max={100000} step={1} aria-label={`${tasks.find(task => task.id === member.taskId)?.title}の配分ポイント`} value={manualAllocation[member.taskId]} disabled={saving} onChange={event => setManualAllocation(current => current ? { ...current, [member.taskId]: event.target.value } : null)} /> : `${member.allocatedPoints}pt`}</td><td>{member.allocatedTravelMinutes}分</td></tr>)}
      </tbody></table></div>
      <p className="muted">「単独なら」は各タスクが同じ {proposal.input.travelMinutes}分の移動をそれぞれ行う場合です。今回は移動分数もタスクへ配分し、合計を一度だけ数えます。必要ポイントの配分を保存してもタスクは完了しません。</p>
      {manualAllocation ? <><p>手動配分の合計を {proposal.totalPoints}pt に合わせてください。0ptも指定できます。</p><button className="secondary-button" disabled={saving} onClick={updateAllocation}>指定した配分で案を更新</button><button className="text-button" disabled={saving} onClick={() => setManualAllocation(null)}>配分の編集を取り消す</button></> : <button className="secondary-button" disabled={saving} onClick={() => { setManualAllocation(Object.fromEntries(proposal.members.map(member => [member.taskId, String(member.allocatedPoints)]))); setManualConfirmed([]); setError('') }}>配分を手動で指定</button>}
      {!manualAllocation && proposal.manualConfirmationIds.map(taskId => {
        const member = proposal.members.find(row => row.taskId === taskId)!
        return <label className="field" key={taskId}><span><input type="checkbox" disabled={saving} checked={manualConfirmed.includes(taskId)} onChange={event => setManualConfirmed(current => event.target.checked ? [...current, taskId] : current.filter(id => id !== taskId))} /> {tasks.find(task => task.id === taskId)?.title}の手動 {member.previousScore.manualPoints}pt を今回の配分 {member.allocatedPoints}pt に切り替えることを確認しました</span></label>
      })}
      <p className="muted">手動ポイントの項目は、切り替える項目ごとの確認が必要です。最初のタスクを完了した後は、まとめの構成と配分を固定します。</p>
      <button className="primary-button" disabled={saving || !canApply} onClick={apply}>{saving ? '保存中…' : '確認した配分をこの端末に保存'}</button>
      <button className="text-button" disabled={saving} onClick={invalidate}>案を破棄</button>
    </div>}
    <div className="divider" /><h3>保存済みの共通外出</h3>
    {bundles.length ? bundles.map(bundle => <div className="trip-bundle-saved" key={bundle.id}>
      <h4>{bundle.title} · {bundle.totalPoints}pt</h4><p>作業と共通移動 {bundle.totalMinutes}分 · 共通移動 {bundle.travelMinutes}分 · 式 {bundle.ruleVersion} · {bundle.frozenAt ? '一部完了により構成・配分を固定済み' : '未完了'}</p>
      <ul>{bundle.members.map(member => <li key={member.taskId}>{tasks.find(task => task.id === member.taskId)?.title ?? '参照先のタスク'}: 単独なら {member.standalonePoints}pt ／ 今回 {member.allocatedPoints}pt · 移動 {member.allocatedTravelMinutes}分 · {tasks.find(task => task.id === member.taskId)?.status === 'completed' ? '完了' : '未完了'}</li>)}</ul>
      {onRemove && <button className="secondary-button" disabled={saving || Boolean(bundle.frozenAt) || bundle.members.some(member => tasks.find(task => task.id === member.taskId)?.status === 'completed')} onClick={() => remove(bundle)}>まとめを取り消して以前の設定に戻す</button>}
    </div>) : <p className="muted">保存済みの共通外出はありません。</p>}
  </section>
}
