import { useEffect, useRef, useState } from 'react'
import ChangeSetPreview from './ChangeSetPreview'
import TaskSplitPreview from './TaskSplitPreview'
import { changePolicyFor, taskChangeFields, type ChangeContext, type ChangeReceipt, type TaskChangeField, type TaskChangePatch, type TaskFieldOrigin } from './change-set'
import { cancelCommand, outcomeNotice, changeContextFor, humanContextFor, prepareCommand, toCommandPayload, uiCoachActor, uiHumanActor, type PreparedCommand } from './command-bus'
import { confirmSplitCommandFromUI, type SplitChildDraft } from './task-split-change'
import { parseCoachSplit, parseCoachTaskChange, prepareCoachSplitRequest, prepareCoachTaskRequest, scheduleOnlyPatch, type CoachTaskSnapshot } from './coach-task-change'
import { confirmTaskInstructionFromUI } from './task-user-instruction'
import { egressNotice } from './egress-policy'
import { taskDueAt, taskDueTime, today, uid, type Settings, type Task } from './domain'

type Draft = { snapshot:CoachTaskSnapshot; title:string; notes:string; scheduledDate:string|null; dueDate:string|null; dueTime:string; dueZone:string; points:string; fields:TaskChangeField[]; origin:'manual'|'ai'; model:string|null; fieldOrigins:Partial<Record<TaskChangeField,TaskFieldOrigin>> }
/** S06 goes through the K12 bus like file and MCP, so the same authority yields the same result. */
type Preview = { command:PreparedCommand }
type SplitDraft = { taskId:string; revision:number; model:string; children:SplitChildDraft[] }
const labels:Record<TaskChangeField,string>={title:'タイトル',notes:'メモ',scheduledDate:'予定日',dueDate:'本当の締め切り',dueAt:'締め切り時刻',manualPoints:'本人指定ポイント'}
const fromTask=(task:Task):Draft=>({snapshot:{id:task.id,title:task.title,notes:task.notes,scheduledDate:task.scheduledDate,dueDate:task.dueDate,revision:task.revision,scoreMode:task.score.mode,manualPoints:task.score.mode==='manual'||task.score.mode==='allocated'?task.score.manualPoints:null},title:task.title,notes:task.notes,scheduledDate:task.scheduledDate,dueDate:task.dueDate,dueTime:taskDueTime(task)??'',dueZone:task.dueTimezone??Intl.DateTimeFormat().resolvedOptions().timeZone,points:task.score.mode==='manual'&&task.score.manualPoints!==null?String(task.score.manualPoints):'',fields:[],origin:'manual',model:null,fieldOrigins:{}})

function scheduleOnlyDraft(task:Task|undefined,instruction:string):{draft:Draft|null;notice:string}{
  if(!task)return{draft:null,notice:''}
  const result=scheduleOnlyPatch(task,instruction,today())
  return{draft:result.scheduledDate?{...fromTask(task),scheduledDate:result.scheduledDate,fields:['scheduledDate'],fieldOrigins:{scheduledDate:'human'}}:null,notice:result.notice}
}
export default function CoachTaskChangeView({selectedTask,settings,onEdit,onApplied,initialInstruction}:{selectedTask:Task|undefined;settings:Settings;onEdit?:(task:Task)=>void;onApplied?:(receipt:ChangeReceipt)=>void;initialInstruction?:string}){
  const [instruction,setInstruction]=useState(initialInstruction??'')
  const [initial]=useState(()=>scheduleOnlyDraft(selectedTask,initialInstruction??''))
  const [savedDraft,setDraft]=useState<Draft|null>(initial.draft)
  const draft=savedDraft??(selectedTask?fromTask(selectedTask):null)
  const [preview,setPreview]=useState<Preview|null>(null)
  const [splitDraft,setSplitDraft]=useState<SplitDraft|null>(null),[splitPreview,setSplitPreview]=useState<PreparedCommand|null>(null)
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(initial.notice)
  const generation=useRef(0)
  const policy=changePolicyFor(settings)
  const common={ownerId:settings.profileId,datasetId:settings.datasetId,allowedFields:[...taskChangeFields],sourceRevisions:[]}
  const human:ChangeContext={...common,principal:{id:settings.profileId,kind:'human'}}
  const bridge=window.michiAI?.proposeTaskChange,splitBridge=window.michiAI?.proposeTaskSplit
  const aiAvailable=Boolean(settings.aiEnabled&&settings.aiModel&&bridge)
  const stale=Boolean(draft&&(!selectedTask||draft.snapshot.id!==selectedTask.id||draft.snapshot.revision!==selectedTask.revision))
  useEffect(()=>{generation.current++},[selectedTask?.id,selectedTask?.revision,settings.aiEnabled,settings.aiConnectionEpoch,settings.aiModel,policy.epoch,policy.sourcePermissionRevision,settings.datasetId,settings.profileId])
  useEffect(()=>{
    const prepared=preview?.command.changeSet
    if(preview&&prepared&&(settings.aiEnabled!==prepared.aiEnabledAtPrepare||(settings.aiConnectionEpoch??0)!==prepared.processingEpoch||policy.epoch!==prepared.policyEpoch||policy.sourcePermissionRevision!==prepared.sourcePermissionRevision||settings.datasetId!==prepared.datasetId||settings.profileId!==prepared.ownerId||selectedTask?.id!==prepared.changes[0].taskId||selectedTask?.revision!==prepared.changes[0].baseRevision)){
      let active=true
      void cancelCommand(preview.command).catch(()=>undefined).then(()=>{if(active){setPreview(current=>current?.command.id===preview.command.id?null:current);setNotice('タスクまたは利用許可が変わったため、本人指示と確認をやり直してください。相談文と入力欄は残っています。')}})
      return()=>{active=false}
    }
  },[preview,selectedTask?.id,selectedTask?.revision,settings.aiEnabled,settings.aiConnectionEpoch,policy.epoch,policy.sourcePermissionRevision,settings.datasetId,settings.profileId])
  useEffect(()=>{
    const target=splitPreview?.envelope
    if(splitPreview&&target&&(selectedTask?.id!==target.target_id||selectedTask?.revision!==target.expected_revision||!settings.aiEnabled)){
      let active=true
      void cancelCommand(splitPreview).catch(()=>undefined).then(()=>{if(active){setSplitPreview(current=>current?.id===splitPreview.id?null:current);setNotice('タスクまたはAI設定が変わったため、分割の確認をやり直してください。相談文は残っています。')}})
      return()=>{active=false}
    }
  },[splitPreview,selectedTask?.id,selectedTask?.revision,settings.aiEnabled])
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
    if(draft.snapshot.id!==selectedTask.id||draft.snapshot.revision!==selectedTask.revision){setNotice('選択したタスクまたは版が変わりました。新しい内容から変更案を作り直してください。');return}
    const actor=draft.origin==='ai'?uiCoachActor(settings,draft.model,{fieldOrigins:draft.fieldOrigins}):uiHumanActor(settings)
    setBusy(true);setNotice('')
    try{
      const patch=draftPatch(),requests=[{taskId:draft.snapshot.id,expectedRevision:draft.snapshot.revision,patch}]
      const verified=draft.fields.some(field=>['title','dueDate','dueAt','manualPoints'].includes(field))||patch.dueAt!==undefined?await confirmTaskInstructionFromUI({message:instruction.trim()||'本人が選択タスクの入力欄に指定した値を変更する',referenceDate:today(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,changes:requests},human,event):null
      const fields=Object.keys(patch).map(field=>labels[field as TaskChangeField]).join('・')
      const {outcome,prepared}=await prepareCommand({schema_version:'1',command_id:uid(),type:'task.update',target_id:draft.snapshot.id,expected_revision:draft.snapshot.revision,payload:toCommandPayload(patch),basis:{kind:'app_instruction'}},actor,{...(verified?{instruction:verified}:{}),reason:draft.origin==='ai'?`選択したタスクの${fields}を変更するコーチ候補（まだ適用していません）`:'本人が指定した対象と値の変更（まだ適用していません）'})
      if(!prepared?.changeSet){if(prepared)await cancelCommand(prepared);setNotice(outcomeNotice(outcome));return}
      setPreview({command:prepared});setNotice('本人の指定値に結び付く差分を用意しました。最終確認ボタンで適用します。')
    }catch(error){setNotice(error instanceof Error?error.message:String(error))}
    finally{setBusy(false)}
  }
  function applied(receipt:ChangeReceipt){const changed=preview?.command.changeSet?.changes[0],revision=receipt.revisions.find(item=>item.taskId===changed?.taskId)?.revision;if(changed&&revision)setDraft(current=>current?{...current,...changed.after,points:changed.scoreAfter.manualPoints===null?'':String(changed.scoreAfter.manualPoints),snapshot:{...current.snapshot,...changed.after,scoreMode:changed.scoreAfter.mode,manualPoints:changed.scoreAfter.manualPoints,revision},fields:[],origin:'manual',model:null,fieldOrigins:{}}:current);setPreview(null);setNotice(`変更を保存しました。確定したタスク：${receipt.taskIds.length}件。`);onApplied?.(receipt)}
  async function askSplit(){
    if(!selectedTask){setNotice('分割するタスクを一つ選択してください');return}
    if(!settings.aiEnabled||!settings.aiModel||!splitBridge){setNotice('AIは停止中、または分割候補を利用できません。分割は通常のタスク編集の分割ウィザードで本人が行えます。');return}
    const model=settings.aiModel,token=++generation.current,target={id:selectedTask.id,revision:selectedTask.revision}
    setBusy(true);setNotice('');setSplitDraft(null)
    try{
      // Vague requests stop here: nothing is sent and no change is prepared.
      const request=await prepareCoachSplitRequest(selectedTask,instruction,model)
      if(token!==generation.current)throw new Error('送信前に対象・版・AI設定が変わりました。新しい内容で相談してください。')
      const answer=await splitBridge(request)
      if(token!==generation.current)throw new Error('候補待ちの間に対象・版・AI設定が変わりました。新しい内容で相談してください。')
      const proposal=parseCoachSplit(answer,target,instruction)
      if(proposal.status==='needs_confirmation'){setNotice(`${proposal.reason} 変更案は作っていません。`);return}
      setSplitDraft({taskId:target.id,revision:target.revision,model,children:proposal.children})
      setNotice(`分割候補を作りました。まだ適用していません。${proposal.notices.join(' ')}`)
    }catch(error){setNotice(`${error instanceof Error?error.message:String(error)} 相談文は残っています。`)}
    finally{setBusy(false)}
  }
  function editSplit(index:number,patch:Partial<SplitChildDraft>){setSplitDraft(current=>current?{...current,children:current.children.map((child,i)=>i===index?{...child,...patch}:child)}:current)}
  async function prepareSplit(event:Event){
    if(!splitDraft||!selectedTask||selectedTask.id!==splitDraft.taskId||selectedTask.revision!==splitDraft.revision){setNotice('対象または版が変わりました。分割候補を作り直してください。');return}
    setBusy(true);setNotice('')
    try{
      const actor=uiCoachActor(settings,splitDraft.model)
      const first=await prepareCommand({schema_version:'1',command_id:uid(),type:'task.split',target_id:splitDraft.taskId,expected_revision:splitDraft.revision,payload:{children:splitDraft.children.map(child=>({title:child.title,points:child.points}))},basis:{kind:'app_instruction'}},actor,{reason:'コーチの分割候補（本人が配分を確認します）'})
      if(!first.prepared){setNotice(outcomeNotice(first.outcome));return}
      const confirmed=await confirmSplitCommandFromUI(first.prepared,splitDraft.children,event,instruction)
      if(!confirmed.prepared){await cancelCommand(first.prepared);setNotice(outcomeNotice(confirmed.outcome));return}
      setSplitPreview(confirmed.prepared);setNotice('本人の配分に結び付く分割差分を用意しました。保護の確認と最終確認ボタンで適用します。')
    }catch(error){setNotice(error instanceof Error?error.message:String(error))}
    finally{setBusy(false)}
  }
  const splitSum=splitDraft?.children.reduce((sum,child)=>sum+(child.points??0),0)??0
  const disabled=busy||Boolean(preview)||Boolean(splitPreview)
  return <section className="card coach-task-change" aria-label="選んだタスクの変更相談">
    <h3>選んだタスクの変更相談</h3>
    {selectedTask?<p>対象：<strong>{selectedTask.title}</strong>（版 {selectedTask.revision}）</p>:<p>変更するタスクを一つ選んでください。</p>}
    <label className="field">相談文<textarea aria-label="既存タスクの変更相談" rows={3} maxLength={4000} value={instruction} disabled={disabled} onChange={event=>setInstruction(event.target.value)} placeholder="例：明日に移して / この25ptを30ptへ変更して"/></label>
    <p className="muted">AIには相談文と選択タスクの名前・予定日・期限・版を送ります。メモと点数は、その変更を指定した場合だけ送ります。資料から検出したタスクの引用（資料の根拠）はメモに含めず、送りません。</p>
    <div className="coach-task-change-actions"><button type="button" className="secondary-button" disabled={!selectedTask||!instruction.trim()||disabled} onClick={ask}>{busy?'変更案を用意しています…':'AIで変更候補を作る'}</button><button type="button" className="text-button" disabled={!selectedTask||!instruction.trim()||disabled} onClick={()=>{const result=scheduleOnlyDraft(selectedTask,instruction);if(result.draft)setDraft(result.draft);setNotice(result.notice)}}>相談文の日付を予定日に入れる（AIなし）</button>{splitBridge&&<button type="button" className="secondary-button" disabled={!selectedTask||!instruction.trim()||disabled||!['manual','allocated'].includes(selectedTask.score.mode)} onClick={()=>void askSplit()}>AIで分割候補を作る</button>}</div>
    {splitDraft&&!splitPreview&&<div className="coach-task-manual" aria-label="分割候補の本人確認"><h4>分割の名前と配分を確認</h4><small>子タスクの名前は相談文の言葉だけ、ポイントは相談文に書いた整数だけを候補にします。未設定のポイントは本人が入力します。</small>
      {splitDraft.children.map((child,index)=><div className="breakdown-row" key={index}><input aria-label={`子タスク${index+1}の名前`} maxLength={300} value={child.title} disabled={disabled} onChange={event=>editSplit(index,{title:event.target.value,titleOrigin:'human'})}/><input aria-label={`子タスク${index+1}のポイント`} type="number" min={0} max={100000} step={1} value={child.points??''} disabled={disabled} onChange={event=>editSplit(index,{points:event.target.value===''?null:Number(event.target.value),pointsOrigin:'human'})}/><span>pt</span></div>)}
      <p>配分合計：{splitSum} / {selectedTask?.score.manualPoints??'?'}pt{splitDraft.children.some(child=>child.points===null)?'（未入力あり）':''}</p>
      <div className="coach-task-change-actions"><button type="button" className="text-button" disabled={disabled} onClick={()=>{setSplitDraft(null);setNotice('分割候補を閉じました。タスクは変更していません。')}}>分割候補を閉じる</button><button type="button" className="primary-button" disabled={disabled||splitDraft.children.some(child=>child.points===null||!child.title.trim())} onClick={event=>void prepareSplit(event.nativeEvent)}>本人の配分を確定して分割差分を作る</button></div>
    </div>}
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
    {splitPreview&&<TaskSplitPreview key={splitPreview.id} command={splitPreview} onApplied={taskIds=>{setSplitPreview(null);setSplitDraft(null);setNotice(`分割を保存しました。子タスク${Math.max(0,taskIds.length-1)}件を作成しました。`)}} onCancel={()=>{setSplitPreview(null);setNotice('分割案を取り消しました。タスクは変更していません。')}}/>}
    {preview?.command.changeSet&&<ChangeSetPreview key={preview.command.id} prepared={preview.command.changeSet} policy={policy} actorContext={changeContextFor(preview.command.actor)} humanContext={humanContextFor(preview.command.actor)} command={preview.command} onApplied={applied} onCancel={()=>{setPreview(null);setNotice('変更案を取り消しました。タスクは変更していません。')}}/>}
  </section>
}
