import { useState } from 'react'
import { cancelCommand, ENTRANCE_LABELS as entranceLabels, outcomeNotice, submitCommand, type PreparedCommand } from './command-bus'
import { splitBody } from './task-split-change'

const origins = { owner_text: '本人の相談文', human: '本人入力', agent_proposal: '代理の提案を本人が確認' } as const
/** The one split approval card for S06, file and MCP (N03). The protected manual-points check is always required. */
export default function TaskSplitPreview({ command, onApplied, onCancel, onApprove, approveAttributes }: { command: PreparedCommand; onApplied: (taskIds: string[]) => void; onCancel: () => void; onApprove?: (event: Event, checked: 'manualPoints'[]) => Promise<void>; approveAttributes?: Record<string, string> }) {
  const body = splitBody(command), [checked, setChecked] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  if (body.stage !== 'review') return null
  const split = body.split, principal = split.principal
  async function approve(event: Event) {
    if (busy) return
    setBusy(true); setNotice('')
    try {
      if (onApprove) { await onApprove(event, checked ? ['manualPoints'] : []); return }
      const outcome = await submitCommand(command, { event, checkedProtectedFields: checked ? ['manualPoints'] : [], requestKey: `ui:${command.id}` })
      if (outcome.state === 'applied') onApplied(outcome.receipt!.taskIds); else setNotice(outcomeNotice(outcome))
    } catch (error) { setNotice(error instanceof Error ? `${error.message}${'code' in error && typeof error.code === 'string' ? `（${error.code}）` : ''}` : String(error)) }
    finally { setBusy(false) }
  }
  async function cancel() { if (busy) return; await cancelCommand(command, 'owner'); onCancel() }
  return <section className="card change-set-preview task-split-preview" aria-label="分割内容の確認">
    <h3>分割内容の確認</h3>
    <p>今回の操作者：{principal.kind === 'human' ? '本人' : principal.kind === 'coach' ? 'アプリ内コーチ' : '外部エージェント'}{principal.model ? `（${principal.model}）` : ''} · 入口：{entranceLabels[command.actor.entrance]}{command.actor.label ? `（${command.actor.label}・自己申告）` : ''}</p>
    <article className="change-set-task"><h4>{split.parentTitle}</h4><small>確認する対象：版 {split.baseRevision}</small>
      <div className="change-set-comparison"><strong>親の本人指定ポイント</strong><div><small>変更前</small><p>{split.parentScoreBefore.manualPoints} pt · {split.parentScoreBefore.mode}</p></div><div><small>変更後</small><p>0 pt · {split.parentScoreBefore.mode}（子へ配分）</p></div></div>
    </article>
    <ol className="split-children">{split.children.map(child => <li key={child.key}><strong>{child.title}</strong>：{child.points} pt <small>（名前：{origins[child.titleOrigin]} / ポイント：{origins[child.pointsOrigin]}）</small></li>)}</ol>
    <p>配分合計：<strong>{split.total} / {split.parentScoreBefore.manualPoints} pt</strong>。子タスクは配分済みポイントで作成し、チェックリストに結び付けます。</p>
    <p>既存の完了記録と実績台帳は変わりません。子タスクを完了したときだけ、その配分ポイントが台帳に加わります。</p>
    <p className="muted">確認期限：{new Date(split.expiresAt).toLocaleString('ja-JP')}。分割は自動適用しません。</p>
    <label className="field"><span><input type="checkbox" aria-label="本人指定ポイントの保護を今回だけ解除" checked={checked} disabled={busy} onChange={event => setChecked(event.target.checked)} /> 本人指定ポイントの保護を確認し、今回の分割だけを許可する</span></label>
    <p role="status">{notice || 'タスクの分割は毎回本人が配分を確認します'}</p>
    <div className="change-set-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => void cancel()}>取消</button><button type="button" {...approveAttributes} className="primary-button" disabled={busy || !checked} onClick={event => void approve(event.nativeEvent)}>{busy ? '適用しています…' : 'この分割だけを承認して適用'}</button></div>
  </section>
}
