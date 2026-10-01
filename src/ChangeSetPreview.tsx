import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { applyChangeSet, approveChangeSetFromUI, autoChangeCountsToday, cancelChangeSet, decideChangePolicy, type ChangeContext, type ChangePolicy, type ChangeReceipt, type PreparedChangeSet, type TaskChangeField } from './change-set'

const labels: Record<TaskChangeField,string> = {title:'タイトル',notes:'メモ',scheduledDate:'予定日',dueDate:'本当の締め切り',manualPoints:'本人指定ポイント'}
export default function ChangeSetPreview({ prepared, policy, actorContext, humanContext, onApplied, onCancel }: {
  prepared: PreparedChangeSet; policy: ChangePolicy; actorContext: ChangeContext; humanContext: ChangeContext
  onApplied: (receipt: ChangeReceipt)=>void; onCancel: ()=>void
}) {
  const [checks,setChecks]=useState<{digest:string;fields:TaskChangeField[]}>({digest:prepared.digest,fields:[]})
  const checked=checks.digest===prepared.digest?checks.fields:[]
  const [busy,setBusy]=useState(false)
  const [notice,setNotice]=useState('')
  const requestKey=`ui:${prepared.id}`
  // Same engine and today's automatic count as the apply transaction, which re-decides anyway.
  const counts=useLiveQuery(()=>autoChangeCountsToday(),[])
  const decision=decideChangePolicy(prepared,policy,counts?{autoCountToday:counts}:{})
  async function approve(event: Event) {
    if(busy)return
    setBusy(true);setNotice('')
    try {
      const approval=await approveChangeSetFromUI(prepared,humanContext,event,checked)
      onApplied(await applyChangeSet(prepared,approval,actorContext,requestKey))
    } catch(error) { setNotice(error instanceof Error?error.message:String(error)) }
    finally {setBusy(false)}
  }
  async function automatic() {
    if(busy)return
    setBusy(true);setNotice('')
    try {onApplied(await applyChangeSet(prepared,null,actorContext,requestKey))}
    catch(error) {setNotice(error instanceof Error?error.message:String(error))}
    finally {setBusy(false)}
  }
  async function cancel() {
    if(busy)return
    setBusy(true)
    try {await cancelChangeSet(prepared,humanContext);onCancel()}
    catch(error){setNotice(error instanceof Error?error.message:String(error))}
    finally{setBusy(false)}
  }
  return <section className="card change-set-preview" aria-label="変更内容の確認">
    <h3>変更内容の確認</h3>
    <p>{prepared.changes.length}件のタスクを編集します。今回の操作者：{prepared.principal.kind==='human'?'本人':prepared.principal.kind==='coach'?'アプリ内コーチ':'外部エージェント'}{prepared.principal.model?`（${prepared.principal.model}）`:''}</p>
    <p className="muted">{prepared.reason}</p>
    {prepared.changes.map(change=><article key={change.taskId} className="change-set-task"><h4>{change.title}</h4><small>確認する対象：版 {change.baseRevision}</small>{change.fields.map(field=><div className="change-set-comparison" key={field}><strong>{labels[field]}</strong><div><small>変更前</small><p style={{whiteSpace:'pre-wrap'}}>{field==='manualPoints'?`${change.effectivePointsBefore??'未設定'} pt · ${change.scoreBefore.mode}`:change.before[field]??'未設定'}</p></div><div><small>変更後</small><p style={{whiteSpace:'pre-wrap'}}>{field==='manualPoints'?`${change.after.manualPoints} pt · ${change.scoreAfter.mode}`:change.after[field]??'未設定'}</p></div>{change.fieldOrigins[field]==='human_override'&&<small>AI候補を本人が修正した値</small>}</div>)}</article>)}
    {prepared.instruction&&<p>本人の指定値を対象と版へ結び付けて確認済みです。指示の確認日時：{new Date(prepared.instruction.issuedAt).toLocaleString('ja-JP')}。</p>}
    <p>点数を変更すると新しい評価履歴を追加します。既存の完了記録と実績台帳は保持します。</p>
    <p className="muted">確認期限：{new Date(prepared.expiresAt).toLocaleString('ja-JP')}。確認後にタスクや利用許可が変わった場合は、差分を作り直します。</p>
    {decision.protectedFields.map(field=><label key={field} className="field"><span><input type="checkbox" aria-label={`${labels[field]}の保護を今回だけ解除`} checked={checked.includes(field)} disabled={busy} onChange={event=>setChecks({digest:prepared.digest,fields:event.target.checked?[...checked,field]:checked.filter(item=>item!==field)})} /> {labels[field]}の保護を確認し、今回の変更だけを許可する</span></label>)}
    <p role="status">{notice||decision.reason}</p>
    <div className="change-set-actions"><button type="button" className="secondary-button" disabled={busy} onClick={cancel}>取消</button>{decision.status==='auto'?<button type="button" className="primary-button" disabled={busy} onClick={automatic}>設定範囲内の変更を適用</button>:<button type="button" className="primary-button" disabled={busy||decision.status==='denied'||decision.protectedFields.some(field=>!checked.includes(field))} onClick={event=>void approve(event.nativeEvent)}>{busy?'適用しています…':'この変更だけを承認して適用'}</button>}</div>
  </section>
}
