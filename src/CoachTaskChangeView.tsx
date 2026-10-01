import { useEffect, useRef, useState } from 'react'
import ChangeSetPreview from './ChangeSetPreview'
import { cancelChangeSet, changePolicyFor, prepareTaskChanges, taskChangeFields, type ChangeContext, type ChangeReceipt, type PreparedChangeSet, type TaskChangeField, type TaskChangePatch, type TaskFieldOrigin } from './change-set'
import { parseCoachTaskChange, prepareCoachTaskChange, prepareCoachTaskRequest, type CoachTaskSnapshot } from './coach-task-change'
import { confirmTaskInstructionFromUI } from './task-user-instruction'
import { egressNotice } from './egress-policy'
import { taskDueAt, taskDueTime, today, type Settings, type Task } from './domain'

type Draft = { snapshot:CoachTaskSnapshot; title:string; notes:string; scheduledDate:string|null; dueDate:string|null; dueTime:string; dueZone:string; points:string; fields:TaskChangeField[]; origin:'manual'|'ai'; model:string|null; fieldOrigins:Partial<Record<TaskChangeField,TaskFieldOrigin>> }
type Preview = { prepared:PreparedChangeSet; actor:ChangeContext }
const labels:Record<TaskChangeField,string>={title:'タイトル',notes:'メモ',scheduledDate:'予定日',dueDate:'本当の締め切り',dueAt:'締め切り時刻',manualPoints:'本人指定ポイント'}
const fromTask=(task:Task):Draft=>({snapshot:{id:task.id,title:task.title,notes:task.notes,scheduledDate:task.scheduledDate,dueDate:task.dueDate,revision:task.revision,scoreMode:task.score.mode,manualPoints:task.score.mode==='manual'||task.score.mode==='allocated'?task.score.manualPoints:null},title:task.title,notes:task.notes,scheduledDate:task.scheduledDate,dueDate:task.dueDate,dueTime:taskDueTime(task)??'',dueZone:task.dueTimezone??Intl.DateTimeFormat().resolvedOptions().timeZone,points:task.score.mode==='manual'&&task.score.manualPoints!==null?String(task.score.manualPoints):'',fields:[],origin:'manual',model:null,fieldOrigins:{}})

export default function CoachTaskChangeView({selectedTask,settings,onEdit,onApplied}:{selectedTask:Task|undefined;settings:Settings;onEdit?:(task:Task)=>void;onApplied?:(receipt:ChangeReceipt)=>void}){
  const [instruction,setInstruction]=useState('')
  const [savedDraft,setDraft]=useState<Draft|null>(null)
  const draft=savedDraft??(selectedTask?fromTask(selectedTask):null)
  const [preview,setPreview]=useState<Preview|null>(null)
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('')
  const generation=useRef(0)
  const policy=changePolicyFor(settings)
  const common={ownerId:settings.profileId,datasetId:settings.datasetId,allowedFields:[...taskChangeFields],sourceRevisions:[]}
  const human:ChangeContext={...common,principal:{id:settings.profileId,kind:'human'}}
  const bridge=window.michiAI?.proposeTaskChange
  const aiAvailable=Boolean(settings.aiEnabled&&settings.aiModel&&bridge)
  const stale=Boolean(draft&&(!selectedTask||draft.snapshot.id!==selectedTask.id||draft.snapshot.revision!==selectedTask.revision))
  useEffect(()=>{generation.current++},[selectedTask?.id,selectedTask?.revision,settings.aiEnabled,settings.aiModel,policy.epoch,policy.sourcePermissionRevision,settings.datasetId,settings.profileId])
  useEffect(()=>{
    if(preview&&(settings.aiEnabled!==preview.prepared.aiEnabledAtPrepare||policy.epoch!==preview.prepared.policyEpoch||policy.sourcePermissionRevision!==preview.prepared.sourcePermissionRevision||settings.datasetId!==preview.prepared.datasetId||settings.profileId!==preview.prepared.ownerId||selectedTask?.id!==preview.prepared.changes[0].taskId||selectedTask?.revision!==preview.prepared.changes[0].baseRevision)){
      let active=true
      const context:ChangeContext={principal:{id:settings.profileId,kind:'human'},ownerId:settings.profileId,datasetId:settings.datasetId,allowedFields:[...taskChangeFields],sourceRevisions:[]}
      void cancelChangeSet(preview.prepared,context).catch(()=>undefined).then(()=>{if(active){setPreview(current=>current?.prepared.id===preview.prepared.id?null:current);setNotice('タスクまたは利用許可が変わったため、本人指示と確認をやり直してください。相談文と入力欄は残っています。')}})
      return()=>{active=false}
    }
  },[preview,selectedTask?.id,selectedTask?.revision,settings.aiEnabled,policy.epoch,policy.sourcePermissionRevision,settings.datasetId,settings.profileId])
  function edit(field:TaskChangeField,value:string|null){setDraft(current=>{const base=current??draft;if(!base)return null;return{...base,[field==='manualPoints'?'points':field==='dueAt'?'dueTime':field]:field==='dueAt'?value??'':value,fields:base.fields.includes(field)?base.fields:[...base.fields,field],fieldOrigins:{...base.fieldOrigins,[field]:base.origin==='ai'?'human_override':'human'}}});setNotice('入力した値を確認してから差分を作ってください。')}
  function toggle(field:TaskChangeField,enabled:boolean){setDraft(current=>{const base=current??draft;return base?{...base,fields:enabled?[...new Set([...base.fields,field])]:base.fields.filter(value=>value!==field)}:null})}
  function reload(){if(selectedTask){setDraft(fromTask(selectedTask));setNotice('選択タスクの現在値を読み込みました。本人入力として新しい変更を指定できます。相談文は残っています。')}}
  async function ask(){
    if(!selectedTask){setNotice('変更するタスクを一つ選択してください');return}
    if(!aiAvailable){setNotice('AIは停止中、または利用できません。相談文と本人入力は利用できます。');return}
    const base=fromTask(selectedTask),referenceDate=today(),model=settings.aiModel!,token=++generation.current
    setBusy(true);setNotice('')
    try{
      const {request,egress}=await prepareCoachTaskRequest(selectedTask,instruction,model,referenceDate,Intl.DateTimeFormat().resolvedOptions().timeZone)
      if(token!==generation.current)throw new Error('送信前に対象・版・AI設定が変わりました。新しい内容で相談してください。')
      const answer=await bridge!(request)
      if(token!==generation.current)throw new Error('候補待ちの間に対象・版・AI設定が変わりました。新しい内容で相談してください。')
      const proposal=parseCoachTaskChange(answer,base.snapshot,instruction,referenceDate)
      const fields=Object.keys(proposal.patch) as TaskChangeField[]
      setDraft({...base,...proposal.patch,points:proposal.patch.manualPoints===undefined?base.points:String(proposal.patch.manualPoints),fields,origin:'ai',model,fieldOrigins:Object.fromEntries(fields.map(field=>[field,'agent_proposal']))})
      setNotice(`変更候補を作りました。まだ適用していません。本人の指定値を確認してください。${egressNotice(egress)??''}`)
    }catch(error){setNotice(`${error instanceof Error?error.message:String(error)} 相談文と入力欄は残っています。`)}
    finally{setBusy(false)}
  }
  function draftPatch():TaskChangePatch{
    if(!draft)throw new Error('対象を選択してください')
    const patch:TaskChangePatch={}
    for(const field of draft.fields){
      if(field==='manualPoints'){if(!draft.points.trim()||!Number.isInteger(Number(draft.points))||Number(draft.points)<0||Number(draft.points)>100000)throw new Error('本人が指定するポイントを0〜100000の整数で入力してください');patch.manualPoints=Number(draft.points)}
      else if(field==='title')patch.title=draft.title.trim()
      else if(field==='notes')patch.notes=draft.notes
      else if(field==='dueAt')patch.dueAt=draft.dueDate&&draft.dueTime?{at:taskDueAt(draft.dueDate,draft.dueTime,draft.dueZone),timezone:draft.dueZone}:null
      else patch[field]=draft[field]
    }
    // Moving or clearing the day of a clock deadline carries the clock along; the preview asks to confirm it separately.
    if(patch.dueDate!==undefined&&!draft.fields.includes('dueAt')&&selectedTask?.dueAt)patch.dueAt=patch.dueDate&&draft.dueTime?{at:taskDueAt(patch.dueDate,draft.dueTime,draft.dueZone),timezone:draft.dueZone}:null
    return patch
  }
  async function prepare(event:Event){
    if(!draft||!selectedTask||stale)return
    const actor:ChangeContext=draft.origin==='ai'?{...common,principal:{id:'app-coach',kind:'coach',model:draft.model},fieldOrigins:draft.fieldOrigins}:human
    setBusy(true);setNotice('')
    try{
      const patch=draftPatch(),requests=[{taskId:draft.snapshot.id,expectedRevision:draft.snapshot.revision,patch}]
      const verified=draft.fields.some(field=>['title','dueDate','dueAt','manualPoints'].includes(field))||patch.dueAt!==undefined?await confirmTaskInstructionFromUI({message:instruction.trim()||'本人が選択タスクの入力欄に指定した値を変更する',referenceDate:today(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,changes:requests},human,event):null
      const prepared=draft.origin==='ai'?await prepareCoachTaskChange({targetId:draft.snapshot.id,targetRevision:draft.snapshot.revision,patch,reason:''},selectedTask,actor,verified):await prepareTaskChanges(requests,actor,'本人が指定した対象と値の変更（まだ適用していません）',verified)
      setPreview({prepared,actor});setNotice('本人の指定値に結び付く差分を用意しました。最終確認ボタンで適用します。')
    }catch(error){setNotice(error instanceof Error?error.message:String(error))}
    finally{setBusy(false)}
  }
  function applied(receipt:ChangeReceipt){const changed=preview?.prepared.changes[0],revision=receipt.revisions.find(item=>item.taskId===changed?.taskId)?.revision;if(changed&&revision)setDraft(current=>current?{...current,...changed.after,points:changed.scoreAfter.manualPoints===null?'':String(changed.scoreAfter.manualPoints),snapshot:{...current.snapshot,...changed.after,scoreMode:changed.scoreAfter.mode,manualPoints:changed.scoreAfter.manualPoints,revision},fields:[],origin:'manual',model:null,fieldOrigins:{}}:current);setPreview(null);setNotice(`変更を保存しました。確定したタスク：${receipt.taskIds.length}件。`);onApplied?.(receipt)}
  const disabled=busy||Boolean(preview)
  return <section className="card coach-task-change" aria-label="選んだタスクの変更相談">
    <h3>選んだタスクの変更相談</h3>
    {selectedTask?<p>対象：<strong>{selectedTask.title}</strong>（版 {selectedTask.revision}）</p>:<p>変更するタスクを一つ選んでください。</p>}
    <label className="field">相談文<textarea aria-label="既存タスクの変更相談" rows={3} maxLength={4000} value={instruction} disabled={disabled} onChange={event=>setInstruction(event.target.value)} placeholder="例：明日に移して / この25ptを30ptへ変更して"/></label>
    <p className="muted">AIには相談文と選択タスクの名前・予定日・期限・版を送ります。メモと点数は、その変更を指定した場合だけ送ります。資料から検出したタスクの引用（資料の根拠）はメモに含めず、送りません。</p>
    <button type="button" className="secondary-button" disabled={!selectedTask||!instruction.trim()||disabled} onClick={ask}>{busy?'変更案を用意しています…':'AIで変更候補を作る'}</button>
    {draft&&<div className="coach-task-manual"><h4>本人の指定値を確認</h4><small>対象：{draft.snapshot.title}（版 {draft.snapshot.revision}）{draft.origin==='ai'?` · AI候補 ${draft.model}`:' · 本人入力'}</small>
      {stale&&<p role="alert">対象または版が変わりました。現在値を読み込んでから変更を指定してください。</p>}
      <div className="form-grid">{taskChangeFields.map(field=><label className={`field ${field==='notes'||field==='title'?'full-field':''}`} key={field}><span><input type="checkbox" aria-label={`${labels[field]}変更を含める`} checked={draft.fields.includes(field)} disabled={disabled} onChange={event=>toggle(field,event.target.checked)}/> {labels[field]}を変更する</span>{field==='notes'?<textarea aria-label="変更候補のメモ" rows={3} maxLength={50000} value={draft.notes} disabled={disabled} onChange={event=>edit(field,event.target.value)}/>:field==='manualPoints'?<><input aria-label="変更候補の本人指定ポイント" type="number" min={0} max={100000} step={1} value={draft.points} disabled={disabled} onChange={event=>edit(field,event.target.value)} /><small>現在：{selectedTask?.effectivePoints??'未設定'}pt · {draft.snapshot.scoreMode}。変更後は本人指定の manual。0ptも確定値です。</small></>:field==='dueAt'?<><input aria-label="変更候補の締め切り時刻" type="time" value={draft.dueTime} disabled={disabled||!draft.dueDate} onChange={event=>edit(field,event.target.value||null)}/><small>{draft.dueZone}。空欄は時刻なしの締め切り</small></>:<input aria-label={`変更候補の${labels[field]}`} type={field==='title'?'text':'date'} maxLength={field==='title'?300:undefined} value={draft[field]??''} disabled={disabled} onChange={event=>edit(field,field==='title'?event.target.value:event.target.value||null)}/>} {draft.fieldOrigins[field]==='human_override'&&<small>AI候補を本人が修正</small>}</label>)}</div>
      {draft.fields.includes('manualPoints')&&draft.snapshot.scoreMode!=='manual'&&<p role="alert">ポイントの方式を {draft.snapshot.scoreMode} から manual へ変更します。配分された共通外出のポイントはここから変更できません。</p>}
      {draft.fields.includes('dueDate')&&<p role="alert">本当の締め切りを変更します。予定日の移動とは別の指定です。</p>}
      {draft.scheduledDate&&draft.dueDate&&draft.scheduledDate>draft.dueDate&&<p role="alert">候補の予定日は本当の締め切りより後です。</p>}
      <p className="muted">タイトル・期限・点数は、ここに表示した本人の指定値をボタン操作で確定し、続く差分画面で承認します。完了実績の点数は変わりません。</p>
      <div className="coach-task-change-actions"><button type="button" className="text-button" disabled={!selectedTask||disabled} onClick={reload}>選択タスクの現在値を読み込む</button><button type="button" className="primary-button" disabled={disabled||stale||!draft.fields.length} onClick={event=>void prepare(event.nativeEvent)}>本人の指定値を確定して差分を作る</button></div>
      {draft.origin==='ai'&&!settings.aiEnabled&&<p>AI候補の代理適用は停止中です。現在値を読み込み、本人入力で新しい変更を作れます。</p>}
    </div>}
    {onEdit&&selectedTask&&<button type="button" className="text-button" disabled={disabled} onClick={()=>onEdit(selectedTask)}>通常のタスク編集を開く</button>}
    {notice&&<p role="status">{notice}</p>}
    {preview&&<ChangeSetPreview key={preview.prepared.id} prepared={preview.prepared} policy={policy} actorContext={preview.actor} humanContext={human} onApplied={applied} onCancel={()=>{setPreview(null);setNotice('変更案を取り消しました。タスクは変更していません。')}}/>}
  </section>
}
