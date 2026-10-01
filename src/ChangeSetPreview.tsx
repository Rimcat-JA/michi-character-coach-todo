import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { applyChangeSet, approveChangeSetFromUI, autoChangeCountsToday, cancelChangeSet, decideChangePolicy, taskChangeValueText, type ChangeContext, type ChangePolicy, type ChangeReceipt, type PreparedChangeSet, type TaskChangeField } from './change-set'
import { cancelCommand, ENTRANCE_LABELS as entranceLabels, grantDecision, outcomeNotice, submitCommand, type CommandOutcome, type PreparedCommand } from './command-bus'
import { db } from './db'

const labels: Record<TaskChangeField,string> = {title:'タイトル',notes:'メモ',scheduledDate:'予定日',dueDate:'本当の締め切り',dueAt:'締め切り時刻',manualPoints:'本人指定ポイント'}
/**
 * The one approval card for task edits from every entrance. With `command` the shared bus approves and applies;
 * `onApprove` lets the file entrance wrap the same approval in its main-process lease.
 */
export default function ChangeSetPreview({ prepared, policy, actorContext, humanContext, onApplied, onCancel, command, onApprove, approveAttributes }: {
  prepared: PreparedChangeSet; policy: ChangePolicy; actorContext: ChangeContext; humanContext: ChangeContext
  onApplied: (receipt: ChangeReceipt)=>void; onCancel: ()=>void
  command?: PreparedCommand; onApprove?: (event: Event, checked: TaskChangeField[])=>Promise<void>; approveAttributes?: Record<string,string>
}) {
  const [checks,setChecks]=useState<{digest:string;fields:TaskChangeField[]}>({digest:prepared.digest,fields:[]})
  const checked=checks.digest===prepared.digest?checks.fields:[]
  const [busy,setBusy]=useState(false)
  const [notice,setNotice]=useState('')
  const requestKey=`ui:${prepared.id}`
  // Same engine and today's automatic count as the apply transaction, which re-decides anyway.
  const counts=useLiveQuery(()=>autoChangeCountsToday(),[])
  // A connection grant that requires approval (or a narrower auto bound) never shows the automatic button.
  const decision=grantDecision(decideChangePolicy(prepared,policy,counts?{autoCountToday:counts}:{}),prepared,command?.actor.grant??null)
  const receiptOf=(outcome:CommandOutcome):ChangeReceipt=>({changeSetId:outcome.receipt!.changeSetId,digest:outcome.receipt!.digest,taskIds:outcome.receipt!.taskIds,revisions:[],appliedAt:outcome.receipt!.appliedAt})
  async function submit(event: Event|null) {
    if(busy)return
    setBusy(true);setNotice('')
    try {
      if(onApprove&&event){await onApprove(event,checked);return}
      if(command){const outcome=await submitCommand(command,{event,checkedProtectedFields:checked,requestKey});if(outcome.state==='applied')onApplied({...receiptOf(outcome),revisions:await revisionsOf(outcome)});else setNotice(outcomeNotice(outcome));return}
      const approval=event?await approveChangeSetFromUI(prepared,humanContext,event,checked):null
      onApplied(await applyChangeSet(prepared,approval,actorContext,requestKey))
    } catch(error) { setNotice(error instanceof Error?`${error.message}${'code' in error&&typeof error.code==='string'?`（${error.code}）`:''}`:String(error)) }
    finally {setBusy(false)}
  }
  async function revisionsOf(outcome:CommandOutcome) {
    return (await Promise.all((outcome.receipt?.taskIds??[]).map(async taskId=>({taskId,revision:(await db.tasks.get(taskId))?.revision??0})))).filter(item=>item.revision>0)
  }
  async function cancel() {
    if(busy)return
    setBusy(true)
    try {if(command)await cancelCommand(command);else await cancelChangeSet(prepared,humanContext);onCancel()}
    catch(error){setNotice(error instanceof Error?error.message:String(error))}
    finally{setBusy(false)}
  }
  return <section className="card change-set-preview" aria-label="変更内容の確認">
    <h3>変更内容の確認</h3>
    <p>{prepared.changes.length}件のタスクを編集します。今回の操作者：{prepared.principal.kind==='human'?'本人':prepared.principal.kind==='coach'?'アプリ内コーチ':'外部エージェント'}{prepared.principal.model?`（${prepared.principal.model}）`:''}{command?` · 入口：${entranceLabels[command.actor.entrance]}${command.actor.label?`（${command.actor.label}・自己申告）`:''}`:''}</p>
    <p className="muted">{prepared.reason}</p>
    {prepared.changes.map(change=><article key={change.taskId} className="change-set-task"><h4>{change.title}</h4><small>確認する対象：版 {change.baseRevision}</small>{change.fields.map(field=><div className="change-set-comparison" key={field}><strong>{labels[field]}</strong><div><small>変更前</small><p style={{whiteSpace:'pre-wrap'}}>{field==='manualPoints'?`${change.effectivePointsBefore??'未設定'} pt · ${change.scoreBefore.mode}`:taskChangeValueText(change.before[field])}</p></div><div><small>変更後</small><p style={{whiteSpace:'pre-wrap'}}>{field==='manualPoints'?`${change.after.manualPoints} pt · ${change.scoreAfter.mode}`:taskChangeValueText(change.after[field])}</p></div>{change.fieldOrigins[field]==='human_override'&&<small>AI候補を本人が修正した値</small>}</div>)}</article>)}
    {prepared.instruction&&<p>本人の指定値を対象と版へ結び付けて確認済みです。指示の確認日時：{new Date(prepared.instruction.issuedAt).toLocaleString('ja-JP')}。</p>}
    <p>点数を変更すると新しい評価履歴を追加します。既存の完了記録と実績台帳は保持します。</p>
    <p className="muted">確認期限：{new Date(prepared.expiresAt).toLocaleString('ja-JP')}。確認後にタスクや利用許可が変わった場合は、差分を作り直します。</p>
    {decision.protectedFields.map(field=><label key={field} className="field"><span><input type="checkbox" aria-label={`${labels[field]}の保護を今回だけ解除`} checked={checked.includes(field)} disabled={busy} onChange={event=>setChecks({digest:prepared.digest,fields:event.target.checked?[...checked,field]:checked.filter(item=>item!==field)})} /> {labels[field]}の保護を確認し、今回の変更だけを許可する</span></label>)}
    <p role="status">{notice||decision.reason}</p>
    <div className="change-set-actions"><button type="button" className="secondary-button" disabled={busy} onClick={cancel}>取消</button>{decision.status==='auto'&&!onApprove?<button type="button" className="primary-button" disabled={busy} onClick={()=>void submit(null)}>設定範囲内の変更を適用</button>:<button type="button" {...approveAttributes} className="primary-button" disabled={busy||decision.status==='denied'||decision.protectedFields.some(field=>!checked.includes(field))} onClick={event=>void submit(event.nativeEvent)}>{busy?'適用しています…':'この変更だけを承認して適用'}</button>}</div>
  </section>
}
