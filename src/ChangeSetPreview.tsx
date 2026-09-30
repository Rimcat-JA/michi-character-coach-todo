import { useState } from 'react'
import { applyChangeSet, approveChangeSetFromUI, cancelChangeSet, decideChangePolicy, type ChangeContext, type ChangePolicy, type ChangeReceipt, type PreparedChangeSet, type TaskChangeField } from './change-set'

const labels: Record<TaskChangeField,string> = {notes:'メモ',scheduledDate:'予定日'}
export default function ChangeSetPreview({ prepared, policy, actorContext, humanContext, onApplied, onCancel }: {
  prepared: PreparedChangeSet; policy: ChangePolicy; actorContext: ChangeContext; humanContext: ChangeContext
  onApplied: (receipt: ChangeReceipt)=>void; onCancel: ()=>void
}) {
  const [checks,setChecks]=useState<{digest:string;fields:TaskChangeField[]}>({digest:prepared.digest,fields:[]})
  const checked=checks.digest===prepared.digest?checks.fields:[]
  const [busy,setBusy]=useState(false)
  const [notice,setNotice]=useState('')
  const requestKey=`ui:${prepared.id}`
  const decision=decideChangePolicy(prepared,policy)
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
    {prepared.changes.map(change=><article key={change.taskId} className="change-set-task"><h4>{change.title}</h4><small>確認する対象：版 {change.baseRevision}</small>{change.fields.map(field=><div className="change-set-comparison" key={field}><strong>{labels[field]}</strong><div><small>変更前</small><p style={{whiteSpace:'pre-wrap'}}>{change.before[field]??'未設定'}</p></div><div><small>変更後</small><p style={{whiteSpace:'pre-wrap'}}>{change.after[field]??'未設定'}</p></div></div>)}</article>)}
    <p>必要ポイント、締め切り、完了実績の変更はありません。外部サービスへの書き込みはありません。</p>
    <p className="muted">確認期限：{new Date(prepared.expiresAt).toLocaleString('ja-JP')}。確認後にタスクや利用許可が変わった場合は、差分を作り直します。</p>
    {decision.protectedFields.map(field=><label key={field} className="field"><span><input type="checkbox" aria-label={`${labels[field]}の保護を今回だけ解除`} checked={checked.includes(field)} disabled={busy} onChange={event=>setChecks({digest:prepared.digest,fields:event.target.checked?[...checked,field]:checked.filter(item=>item!==field)})} /> {labels[field]}の保護を確認し、今回の変更だけを許可する</span></label>)}
    <p role="status">{notice||decision.reason}</p>
    <div className="change-set-actions"><button type="button" className="secondary-button" disabled={busy} onClick={cancel}>取消</button>{decision.status==='auto'?<button type="button" className="primary-button" disabled={busy} onClick={automatic}>設定範囲内の変更を適用</button>:<button type="button" className="primary-button" disabled={busy||decision.status==='denied'||decision.protectedFields.some(field=>!checked.includes(field))} onClick={event=>void approve(event.nativeEvent)}>{busy?'適用しています…':'この変更だけを承認して適用'}</button>}</div>
  </section>
}
