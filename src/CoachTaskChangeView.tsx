import { useEffect, useState } from 'react'
import ChangeSetPreview from './ChangeSetPreview'
import { cancelChangeSet, changePolicyFor, prepareTaskChanges, type ChangeContext, type ChangeReceipt, type PreparedChangeSet } from './change-set'
import { createCoachTaskRequest, parseCoachTaskChange, prepareCoachTaskChange, type CoachTaskChangeRequest, type CoachTaskSnapshot } from './coach-task-change'
import { today, type Settings, type Task } from './domain'

type Draft = { snapshot:CoachTaskSnapshot; notes:string; scheduledDate:string|null; changeNotes:boolean; changeDate:boolean; origin:'manual'|'ai'; model:string|null }
type Preview = { prepared:PreparedChangeSet; actor:ChangeContext }
const fromTask=(task:Task):Draft=>({snapshot:{id:task.id,title:task.title,notes:task.notes,scheduledDate:task.scheduledDate,dueDate:task.dueDate,revision:task.revision},notes:task.notes,scheduledDate:task.scheduledDate,changeNotes:false,changeDate:false,origin:'manual',model:null})

export default function CoachTaskChangeView({selectedTask,settings,onEdit,onApplied}:{selectedTask:Task|undefined;settings:Settings;onEdit?:(task:Task)=>void;onApplied?:(receipt:ChangeReceipt)=>void}){
  const [instruction,setInstruction]=useState('')
  const [savedDraft,setDraft]=useState<Draft|null>(null)
  const draft=savedDraft??(selectedTask?fromTask(selectedTask):null)
  const [preview,setPreview]=useState<Preview|null>(null)
  const [busy,setBusy]=useState(false)
  const [notice,setNotice]=useState('')
  const policy=changePolicyFor(settings)
  const common={ownerId:settings.profileId,datasetId:settings.datasetId,allowedFields:['notes','scheduledDate'] as ChangeContext['allowedFields'],sourceRevisions:[]}
  const human:ChangeContext={...common,principal:{id:settings.profileId,kind:'human'}}
  const bridge=(window.michiAI as typeof window.michiAI & {proposeTaskChange?:(request:CoachTaskChangeRequest)=>Promise<string>})?.proposeTaskChange
  const aiAvailable=Boolean(settings.aiEnabled&&settings.aiModel&&bridge)
  const stale=Boolean(draft&&(!selectedTask||draft.snapshot.id!==selectedTask.id||draft.snapshot.revision!==selectedTask.revision))
  useEffect(()=>{
    if(preview&&(settings.aiEnabled!==preview.prepared.aiEnabledAtPrepare||policy.epoch!==preview.prepared.policyEpoch||policy.sourcePermissionRevision!==preview.prepared.sourcePermissionRevision||selectedTask?.id!==preview.prepared.changes[0].taskId||selectedTask?.revision!==preview.prepared.changes[0].baseRevision)){
      let active=true
      const context:ChangeContext={principal:{id:settings.profileId,kind:'human'},ownerId:settings.profileId,datasetId:settings.datasetId,allowedFields:['notes','scheduledDate'],sourceRevisions:[]}
      void cancelChangeSet(preview.prepared,context).catch(()=>undefined).then(()=>{
        if(active){setPreview(current=>current?.prepared.id===preview.prepared.id?null:current);setNotice('タスクまたは利用許可が変わったため、確認をやり直してください。相談文と手動欄は残っています。')}
      })
      return()=>{active=false}
    }
  },[preview,selectedTask?.id,selectedTask?.revision,settings.aiEnabled,policy.epoch,policy.sourcePermissionRevision,settings.datasetId,settings.profileId])
  function edit(change:Partial<Draft>){setDraft(current=>{const value=current??draft;return value?{...value,...change,origin:'manual'}:null});setNotice('手動欄を編集しました。変更案を確認してから適用してください。')}
  function reload(){if(selectedTask){setDraft(fromTask(selectedTask));setNotice('選択したタスクの現在の値を手動欄へ読み込みました。相談文は残っています。')}}
  async function ask(){
    if(!selectedTask){setNotice('変更するタスクを一つ選択してください');return}
    if(!aiAvailable){
      setNotice('AIは停止中、または利用できません。相談文は残っています。手動欄で変更案を作れます。');return
    }
    const snapshot=fromTask(selectedTask).snapshot,referenceDate=today(),model=settings.aiModel!
    setBusy(true);setNotice('')
    try{
      const request=createCoachTaskRequest(snapshot,instruction,model,referenceDate,Intl.DateTimeFormat().resolvedOptions().timeZone)
      const answer=await bridge!(request)
      const proposal=parseCoachTaskChange(answer,snapshot,instruction,referenceDate)
      setDraft({snapshot,notes:proposal.patch.notes??snapshot.notes,scheduledDate:Object.hasOwn(proposal.patch,'scheduledDate')?proposal.patch.scheduledDate!:snapshot.scheduledDate,changeNotes:Object.hasOwn(proposal.patch,'notes'),changeDate:Object.hasOwn(proposal.patch,'scheduledDate'),origin:'ai',model})
      setNotice('選択したタスクの変更候補を作りました。まだ適用していません。値を確認してください。')
    }catch(error){setNotice(`${error instanceof Error?error.message:String(error)} 相談文と手動欄は残っています。`)}
    finally{setBusy(false)}
  }
  async function prepare(){
    if(!draft||!selectedTask||stale)return
    const patch={...(draft.changeNotes?{notes:draft.notes}:{}),...(draft.changeDate?{scheduledDate:draft.scheduledDate}:{})}
    const actor:ChangeContext=draft.origin==='ai'?{...common,principal:{id:'app-coach',kind:'coach',model:draft.model}}:human
    setBusy(true);setNotice('')
    try{
      const prepared=draft.origin==='ai'?await prepareCoachTaskChange({targetId:draft.snapshot.id,targetRevision:draft.snapshot.revision,patch,reason:''},selectedTask,actor):await prepareTaskChanges([{taskId:draft.snapshot.id,expectedRevision:draft.snapshot.revision,patch}],actor,draft.model?`AI候補（${draft.model}）を本人が編集して確認する変更`:'本人が手動欄から確認する変更')
      setPreview({prepared,actor});setNotice('差分を用意しました。確認ボタンで適用します。')
    }catch(error){setNotice(error instanceof Error?error.message:String(error))}
    finally{setBusy(false)}
  }
  function applied(receipt:ChangeReceipt){
    const changed=preview?.prepared.changes[0],revision=receipt.revisions.find(item=>item.taskId===changed?.taskId)?.revision
    if(changed&&revision)setDraft(current=>current&&({...current,snapshot:{...current.snapshot,notes:changed.after.notes,scheduledDate:changed.after.scheduledDate,revision},notes:changed.after.notes,scheduledDate:changed.after.scheduledDate,changeNotes:false,changeDate:false,origin:'manual',model:null}))
    setPreview(null);setNotice(`変更を適用しました。確定したタスク：${receipt.taskIds.length}件。`);onApplied?.(receipt)
  }
  return <section className="card coach-task-change">
    <h3>選んだタスクの変更相談</h3>
    {selectedTask?<p>対象：<strong>{selectedTask.title}</strong>（版 {selectedTask.revision}）</p>:<p>上の対象選択から、変更するタスクを一つ選んでください。</p>}
    <label className="field">相談文<textarea aria-label="既存タスクの変更相談" rows={3} maxLength={4000} value={instruction} disabled={busy||Boolean(preview)} onChange={event=>setInstruction(event.target.value)} placeholder="例：明日に移して / メモに持ち物を追記して"/></label>
    <p className="muted">AIには、この相談文と選択したタスクのタイトル・予定日・締め切り・版だけを送ります。メモ変更を指定した場合は、そのメモも送ります。</p>
    <button type="button" className="secondary-button" disabled={!selectedTask||!instruction.trim()||busy||Boolean(preview)} onClick={ask}>{busy?'変更案を用意しています…':'AIで変更候補を作る'}</button>
    {draft&&<div className="coach-task-manual">
      <h4>手動で確認・再計画</h4><small>候補の対象：{draft.snapshot.title}（版 {draft.snapshot.revision}）</small>
      {stale&&<p role="alert">候補作成後に選択タスクまたは版が変わりました。現在の値を読み込んでから確認してください。</p>}
      <div className="form-grid"><label className="field"><span><input type="checkbox" aria-label="予定日変更を含める" checked={draft.changeDate} disabled={busy||Boolean(preview)} onChange={event=>edit({changeDate:event.target.checked})}/> 予定日を変更する</span><input aria-label="変更候補の予定日" type="date" value={draft.scheduledDate??''} disabled={busy||Boolean(preview)} onChange={event=>edit({scheduledDate:event.target.value||null,changeDate:true})}/></label><label className="field full-field"><span><input type="checkbox" aria-label="メモ変更を含める" checked={draft.changeNotes} disabled={busy||Boolean(preview)} onChange={event=>edit({changeNotes:event.target.checked})}/> メモを変更する</span><textarea aria-label="変更候補のメモ" maxLength={50000} rows={3} value={draft.notes} disabled={busy||Boolean(preview)} onChange={event=>edit({notes:event.target.value,changeNotes:true})}/></label></div>
      {draft.changeDate&&draft.scheduledDate&&draft.snapshot.dueDate&&draft.scheduledDate>draft.snapshot.dueDate&&<p role="alert">候補の予定日は本当の締め切りより後です。期限を確認してから判断してください。</p>}
      <div className="coach-task-change-actions"><button type="button" className="text-button" disabled={!selectedTask||busy||Boolean(preview)} onClick={reload}>選択タスクの現在値を読み込む</button>{draft.origin==='ai'&&!settings.aiEnabled&&<button type="button" className="secondary-button" disabled={busy||Boolean(preview)} onClick={()=>edit({})}>候補を手動入力として確認する</button>}<button type="button" className="primary-button" disabled={busy||Boolean(preview)||stale||!draft.changeNotes&&!draft.changeDate} onClick={prepare}>変更内容を確認</button></div>
    </div>}
    {onEdit&&selectedTask&&<button type="button" className="text-button" disabled={busy||Boolean(preview)} onClick={()=>onEdit(selectedTask)}>点数・期限・完了はタスクを手動編集</button>}
    {notice&&<p role="status">{notice}</p>}
    {preview&&<ChangeSetPreview key={preview.prepared.id} prepared={preview.prepared} policy={policy} actorContext={preview.actor} humanContext={human} onApplied={applied} onCancel={()=>{setPreview(null);setNotice('変更案を取り消しました。タスクは変更していません。')}}/>}
  </section>
}
