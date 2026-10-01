import { useCallback, useEffect, useRef, useState } from 'react'
import type { Completion, LedgerEntry, Settings, Task } from './domain'
import { approveCompletionReconfirmationFromUI, cancelCompletionReconfirmation, prepareCompletionReconfirmationFromUI } from './completion-reconfirmation'
import { applyCompletionReconfirmationFromUI } from './completion-reconfirmation-save'
import { reconfirmationPoints } from './completion-reconfirmation-view-input'
import './CompletionReconfirmationView.css'

type Prepared = Awaited<ReturnType<typeof prepareCompletionReconfirmationFromUI>>
type Receipt = Awaited<ReturnType<typeof applyCompletionReconfirmationFromUI>>
type Preview = Prepared['preview']
type Props = {
  settings: Settings
  tasks: Task[]
  completions: Completion[]
  ledger: LedgerEntry[]
  initialCompletionId?: string | null
  onApplied?: (receipt: Receipt) => void
}

const pointsLabel = (points: number | null) => points === null ? '未設定' : `${points} pt`
const sumLabel = (points: number | null) => points === null ? '合計を確認できません' : `${points} pt`
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const scoreModes = { unset: '未設定', manual: '手動指定', formula: '計算方式', allocated: '配分済み' }

function dateTime(value: string, timezone: string | null) {
  try { return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'medium', timeZone: timezone ?? 'UTC' }).format(new Date(value)) }
  catch { return value }
}

export function ReconfirmationPreview({ preview, points, reason }: { preview: Preview; points: number; reason: string }) {
  const timezone = preview.displayTimezone
  return <div className="reconfirmation-preview">
    <h3>再確定する内容</h3>
    <p>現在のタスク名：<strong>{preview.task.title}</strong></p>
    <dl className="reconfirmation-values">
      <div><dt>最初の完了日時</dt><dd>{dateTime(preview.completion.originalAt, timezone)}<small>表示タイムゾーン：{timezone}</small><small>元の日時：{preview.completion.originalAt}</small><small>完了記録の現在の保存タイムゾーン：{preview.completion.currentTimezone ?? '未保存'}</small></dd></div>
      <div><dt>最初の実績ポイント</dt><dd>{pointsLabel(preview.completion.originalPoints)}</dd></div>
      <div><dt>元の完了時の名前・プロジェクト</dt><dd>{preview.completion.originalTitle}<small>{preview.completion.originalProject || 'プロジェクト未設定'}</small></dd></div>
      <div><dt>取消直前の実加点</dt><dd>{preview.cancellation.status === 'known' ? pointsLabel(preview.cancellation.points) : '履歴から確認できません'}<small>{preview.cancellation.reason}</small>{preview.cancellation.at && <small>取消日時：{dateTime(preview.cancellation.at, timezone)}</small>}</dd></div>
      <div><dt>再完了用の保存値</dt><dd>{preview.completion.cachedPointsMissing ? '保存値なし' : pointsLabel(preview.completion.cachedPoints)}<small>取消直前の実加点とは別の値です。</small></dd></div>
      <div><dt>現在のタスクの将来用見積</dt><dd>{pointsLabel(preview.task.estimatePoints)}<small>{scoreModes[preview.task.scoreMode]}</small></dd></div>
      {preview.allocation.hasChildren && <div><dt>親の手動配分の残額</dt><dd>{preview.allocation.parentRemainder === null ? '手動配分の残額を確認できません' : pointsLabel(preview.allocation.parentRemainder)}</dd></div>}
      <div className="reconfirmation-chosen"><dt>本人が再確定する実績</dt><dd><strong>{points} pt</strong><small className="reconfirmation-reason">理由：{reason}</small></dd></div>
    </dl>
    {preview.allocation.hasChildren && <section className="reconfirmation-children" aria-label="親子への影響">
      <h4>親子への影響</h4>
      <p>この操作は選んだ親の実績を再確定します。表示されている子の実績と、親・子の将来用見積はそのままです。</p>
      <dl className="reconfirmation-values">
        <div><dt>現在有効な親子の実績合計</dt><dd>{sumLabel(preview.allocation.combinedActivePoints)}</dd></div>
        <div><dt>今回の再確定後の親子実績合計</dt><dd>{sumLabel(preview.allocation.proposedCombinedActivePoints)}</dd></div>
        <div><dt>将来用の親子見積合計</dt><dd>{sumLabel(preview.allocation.combinedEstimatePoints)}</dd></div>
      </dl>
      <ul>{preview.allocation.children.map(child => <li key={child.id}>
        <strong>{child.title}</strong><span>{child.deleted ? 'ゴミ箱内' : child.status === 'completed' ? '完了' : '未完了'} / {child.relation === 'verified' ? '親子関係を確認済み' : '親子関係は要確認'}</span>
        <span>現在有効な実績：{child.hasActiveCompletion ? pointsLabel(child.activePoints) : '有効な完了記録なし'}</span>
        <span>将来用の見積：{pointsLabel(child.estimatePoints)}</span>
      </li>)}</ul>
    </section>}
    {preview.trips.length > 0 && <section className="reconfirmation-trips" aria-label="束の配分への影響">
      <h4>束の配分への影響</h4>
      <ul>{preview.trips.map(trip => <li key={trip.id}><strong>{trip.title}</strong><span>束の合計：{trip.totalPoints} pt</span><span>{trip.frozenAt ? `配分は固定済みです。現在の固定を保持します。固定日時：${dateTime(trip.frozenAt, timezone)}` : '今回の実績再確定で、この束の配分を固定します。'}</span></li>)}</ul>
    </section>}
    {preview.allocation.issues.length > 0 && <div className="reconfirmation-issues"><strong>確認が必要な点</strong><ul>{preview.allocation.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div>}
    <p className="muted">同じ完了記録を再確定し、理由と新しい実績評価を保存します。最初の記録は残ります。タスクの将来用ポイントは変更しません。</p>
  </div>
}

export function ReconfirmationTaskEntry({ completion, onOpen }: { completion: Completion | undefined; onOpen: (completionId: string) => void }) {
  if (!completion || completion.currentAt !== null) return null
  return <div className="completion-reconfirmation-entry"><small>再完了用の保存値：{completion.lastConfirmedPoints === undefined ? '保存値なし' : pointsLabel(completion.lastConfirmedPoints)}</small><button className="text-button" onClick={() => onOpen(completion.id)}>実績を再確認</button></div>
}

export default function CompletionReconfirmationView({ settings, tasks, completions, ledger, initialCompletionId = null, onApplied }: Props) {
  const [completionId, setCompletionId] = useState(initialCompletionId ?? '')
  const [points, setPoints] = useState(''), [reason, setReason] = useState('')
  const [savedPrepared, setPrepared] = useState<Prepared | null>(null)
  const [preparedSignature, setPreparedSignature] = useState('')
  const [checked, setChecked] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const sequence = useRef(0), preparedRef = useRef<Prepared | null>(null), sectionRef = useRef<HTMLElement | null>(null)
  const revoke = useCallback(() => {
    sequence.current++
    if (preparedRef.current) cancelCompletionReconfirmation(preparedRef.current)
    preparedRef.current = null
  }, [])
  const signature = JSON.stringify([settings.profileId, settings.datasetId, settings.changePolicy, tasks, completions, ledger])
  const prepared = preparedSignature === signature ? savedPrepared : null
  const eligible = completions.filter(completion => completion.currentAt === null && tasks.some(task => task.id === completion.taskId && task.status === 'open' && !task.deletedAt))
    .sort((a, b) => b.originalAt.localeCompare(a.originalAt))
  const completion = eligible.find(item => item.id === completionId)
  const task = completion ? tasks.find(item => item.id === completion.taskId) : undefined

  useEffect(() => {
    revoke()
    // A changed snapshot must not regain approval if an older snapshot reappears.
    // oxlint-disable-next-line react/set-state-in-effect
    setPreparedSignature('')
    setChecked(false)
    return revoke
  }, [signature, revoke])
  useEffect(() => {
    revoke()
    // An explicit navigation target starts a new, blank owner instruction.
    // oxlint-disable-next-line react/set-state-in-effect
    setCompletionId(initialCompletionId ?? '')
    setPoints(''); setReason(''); setPrepared(null); setChecked(false); setNotice('')
    if (initialCompletionId) sectionRef.current?.scrollIntoView({ block: 'start' })
  }, [initialCompletionId, revoke])
  useEffect(() => {
    if (!prepared) return
    const timer = setTimeout(() => {
      cancelCompletionReconfirmation(prepared)
      if (preparedRef.current === prepared) {
        sequence.current++; preparedRef.current = null; setPrepared(null); setChecked(false)
        setNotice('確認案の有効期限が切れました。入力を確認して、もう一度候補を作ってください。')
      }
    }, Math.max(0, Date.parse(prepared.expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [prepared])

  function changed(action?: () => void) {
    revoke()
    action?.(); setPrepared(null); setPreparedSignature(''); setChecked(false); setNotice('')
  }
  async function prepare(event: Event) {
    if (busy) return
    changed(); const token = ++sequence.current
    setBusy(true)
    try {
      if (!task || !completion) throw new Error('取消済みの完了記録と未完了のタスクを選んでください。')
      const value = reconfirmationPoints(points)
      if (!reason.trim()) throw new Error('再確定する理由を入力してください。')
      if (reason.trim().length > 2000) throw new Error('再確定する理由は2000文字以内で入力してください。入力した理由は残っています。')
      const next = await prepareCompletionReconfirmationFromUI({ taskId: task.id, expectedRevision: task.revision, completionId: completion.id, points: value, reason }, event)
      if (token !== sequence.current) { cancelCompletionReconfirmation(next); throw new Error('確認中に対象や履歴が変わりました。現在の入力を確認して、候補を作り直してください。') }
      preparedRef.current = next; setPrepared(next); setPreparedSignature(signature); setChecked(false)
      setNotice('再確定の候補を作りました。まだ実績は保存していません。')
    } catch (error) { setNotice(errorText(error)) }
    finally { setBusy(false) }
  }
  async function apply(event: Event) {
    if (!prepared || !checked || busy) return
    setBusy(true); setNotice('')
    try {
      const approval = await approveCompletionReconfirmationFromUI(prepared, prepared.digest, event, { points: true, impact: checked })
      const receipt = await applyCompletionReconfirmationFromUI(prepared, approval, event)
      changed(() => { setCompletionId(''); setPoints(''); setReason('') })
      setNotice(`${receipt.points} ptで実績を再確定しました。`); onApplied?.(receipt)
    } catch (error) { changed(); setNotice(`${errorText(error)} 入力は残っています。候補を作り直してください。`) }
    finally { setBusy(false) }
  }

  return <section ref={sectionRef} className="card setting-section completion-reconfirmation" aria-label="取消済み実績の再確認">
    <div className="card-heading"><h2>取消済み実績を再確認</h2></div>
    <p>取消済みの完了を、本人が指定したポイントと理由で再確定できます。表示された元記録と親子への影響を確認してください。</p>
    {eligible.length === 0 && <p className="muted">再確認できる取消済みの実績はありません。対象のタスクは未完了で、ゴミ箱に入っていない必要があります。</p>}
    <div className="reconfirmation-form">
      <label className="field reconfirmation-target">取消済みの完了記録<select aria-label="再確認する取消済み実績" value={completionId} disabled={busy} onChange={event => changed(() => { setCompletionId(event.target.value); setPoints(''); setReason('') })}>
        <option value="">選んでください</option>{eligible.map(item => <option key={item.id} value={item.id}>{tasks.find(current => current.id === item.taskId)?.title ?? item.title}（最初の実績 {pointsLabel(item.originalPoints)}）</option>)}
      </select></label>
      <label className="field">再確定するポイント<input aria-label="再確定するポイント" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" value={points} disabled={busy} onChange={event => changed(() => setPoints(event.target.value))} placeholder="本人が0〜100000を入力" /></label>
      <label className="field reconfirmation-reason-field">再確定する理由<textarea aria-label="再確定する理由" rows={3} value={reason} disabled={busy} onChange={event => changed(() => setReason(event.target.value))} placeholder="現在の実績として、このポイントを確定する理由" /></label>
    </div>
    <div className="reconfirmation-actions"><button className="secondary-button" disabled={busy || !task || !completion} onClick={event => void prepare(event.nativeEvent)}>再確定の候補を確認</button></div>
    {prepared && <>
      <ReconfirmationPreview preview={prepared.preview} points={prepared.input.points} reason={prepared.input.reason} />
      <p className="muted">確認案の有効期限：{dateTime(prepared.expiresAt, prepared.preview.displayTimezone)}</p>
      <label className="reconfirmation-check"><input type="checkbox" aria-label="本人のポイント・理由と親子への影響を確認した" checked={checked} disabled={busy} onChange={event => setChecked(event.target.checked)} /><span>本人のポイント・理由と、表示された元記録・親子への影響{prepared.preview.trips.length > 0 ? '・束の配分固定' : ''}を確認しました。</span></label>
      <div className="reconfirmation-actions"><button className="primary-button" disabled={busy || !checked} onClick={event => void apply(event.nativeEvent)}>この内容で実績を再確定</button><button className="secondary-button" disabled={busy} onClick={() => changed()}>確認案を取り消す</button></div>
    </>}
    {savedPrepared && !prepared && <p role="status">対象や履歴が更新されたため、以前の確認案を取り消しました。入力を確認して候補を作り直してください。</p>}
    {notice && <p className="reconfirmation-notice" role="status">{notice}</p>}
  </section>
}
