import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { changePolicyFor } from './change-set'
import { sourceDb as db, type ContextSource } from './source-library'
import { applyDetectionCreateFromUI, applyDetectionRecurrenceFromUI, detectObligationsForSource, discardDetectionRun, groundedDetectionDue, isLiveDetectionRun, prepareDetectionCreate, prepareDetectionFromUI, prepareDetectionRecurrenceFromUI, savedDetectionRuns, type DetectionCreationReceipt, type DetectionRun, type DetectionTransport, type PreparedDetectionCreate } from './detection-run'
import type { DetectionChange } from './detection-contract'
import type { Settings, Task } from './domain'
import { loadCalendarRulesState } from './calendar-rules-save'
import { calendarTimeAt } from './calendar-resolver'
import RoutineAssistView from './RoutineAssistView'

type Props={settings:Settings;tasks:Task[];onEdit?:(task:Task)=>void;onCreated?:(receipt:DetectionCreationReceipt)=>void}
type Bridge={detectObligations?:DetectionTransport['detect'];verifyObligations?:DetectionTransport['verify']}
const actionNames:Record<DetectionChange['action'],string>={create:'新規作業の候補',update:'既存タスクの変更候補',cancel:'既存タスクの取消候補',report_completion:'既存タスクの完了報告',define_recurrence:'周期の定義候補'}
const basisNames:Record<DetectionChange['basis'],string>={explicit_request:'本人への具体的な依頼',self_commitment:'本人の明示した約束',documented_obligation:'対象が確認された文書の義務',approved_rule:'本人承認済みルール'}
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error)
function sourceUsable(source:ContextSource,settings:Settings,at:number){return source.ownerId===settings.profileId&&!source.deletedAt&&(!source.retentionUntil||Date.parse(source.retentionUntil)>at)&&source.permissions.acquire&&source.permissions.retain&&source.permissions.index&&source.permissions.aiEgress&&Boolean(settings.aiModel&&source.allowedModels.includes(settings.aiModel))}

function DetectionSourceForm({source,settings,tasks,onDetected,at}:{source:ContextSource;settings:Settings;tasks:Task[];onDetected:(run:DetectionRun)=>void;at:number}){
  const [aliases,setAliases]=useState(''),[authorIsOwner,setAuthorIsOwner]=useState(false),[includeExisting,setIncludeExisting]=useState(false),[identityChecked,setIdentityChecked]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('')
  const bridge=window.michiAI as Bridge|undefined
  const available=Boolean(settings.aiEnabled&&settings.aiModel&&bridge?.detectObligations&&bridge?.verifyObligations&&sourceUsable(source,settings,at))
  async function detect(event:Event){
    if(!available||!identityChecked||busy)return
    setBusy(true);setNotice('選択資料を検出し、候補ごとに別の呼び出しで根拠を検証しています。タスクはまだ作りません。')
    try{
      const prepared=await prepareDetectionFromUI(source.id,source.revision,settings.aiModel!,{confirmedAliases:aliases.split(',').map(value=>value.trim()).filter(Boolean),authorIsOwner,existingTaskIds:includeExisting?tasks.filter(task=>!task.deletedAt).slice(0,100).map(task=>task.id):[]},event)
      const result=await detectObligationsForSource(prepared,{detect:bridge!.detectObligations!,verify:bridge!.verifyObligations!})
      onDetected(result);setNotice(`検出 ${result.candidates.length}件、追加の確認事項 ${result.reviewItems.length}件をInboxに保存しました。タスクの登録・実績への加点はしていません。`)
    }catch(error){setNotice(`${errorText(error)} 入力した確認情報は残っています。`)}
    finally{setBusy(false)}
  }
  return <div className="setting-section">
    <p>資料：<strong>{source.title}</strong> · 内容版 {source.latestRevision} · 許可版 {source.permissionRevision}</p>
    <p className="muted">本人が取り込んだ {source.coverage.fromDate}〜{source.coverage.toDate} の範囲です。表示名・CC・チャンネル参加を本人担当の証拠にはしません。</p>
    <label className="field">この資料で本人を表す確認済みの表記（カンマ区切り）<input aria-label="検出資料の本人表記" maxLength={1000} value={aliases} disabled={busy} placeholder="例：Karinさん,Karin" onChange={event=>{setAliases(event.target.value);setIdentityChecked(false)}}/></label>
    <label><input type="checkbox" checked={authorIsOwner} disabled={busy} onChange={event=>{setAuthorIsOwner(event.target.checked);setIdentityChecked(false)}}/> この資料全体の執筆者は本人と確認できる（他人の発言を含む会話では選ばない）</label>
    <label><input type="checkbox" checked={includeExisting} disabled={busy} onChange={event=>setIncludeExisting(event.target.checked)}/> 既存タスクのタイトル・期限・ID・版を照合へ送る（最大100件、メモと点数は送らない）</label>
    <label><input type="checkbox" aria-label="義務検出の本人対応を確認" checked={identityChecked} disabled={busy} onChange={event=>setIdentityChecked(event.target.checked)}/> 本人対応を確認した。選んだ資料の本文と上記の照合情報を {settings.aiModel??'設定モデル'} へ送る</label>
    <p className="muted">検出は新しい作業の提案をしません。任意・仮定・他人担当・完了済み・撤回済み・予定だけの記載を除外します。所属・履修・契約や承認済みルールの対応が未設定なら、確認事項として扱います。</p>
    <button type="button" className="secondary-button" disabled={!available||!identityChecked||busy} onClick={event=>void detect(event.nativeEvent)}>{busy?'検出と検証を待っています…':'この資料の義務を検出・検証してInboxへ'}</button>
    {!settings.aiEnabled&&<p className="muted">AIは停止中です。資料の原文は資料ライブラリで閲覧し、タスクを手動入力できます。</p>}
    {notice&&<p role="status">{notice}</p>}
  </div>
}

function DetectionRunCard({run,source,settings,tasks,onEdit,onCreated,onDiscard,at}:{run:DetectionRun;source:ContextSource|undefined;settings:Settings;tasks:Task[];onEdit?:Props['onEdit'];onCreated?:Props['onCreated'];onDiscard:(id:string)=>void;at:number}){
  const [prepared,setPrepared]=useState<PreparedDetectionCreate|null>(null),[checked,setChecked]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[created,setCreated]=useState<string[]>([])
  const [recurrenceId,setRecurrenceId]=useState<string|null>(null),[adoptedRecurrences,setAdoptedRecurrences]=useState<string[]>([])
  const calendarState=useLiveQuery(()=>loadCalendarRulesState(),[settings.profileId,settings.datasetId])
  const policy=changePolicyFor(settings)
  const current=Boolean(source&&sourceUsable(source,settings,at)&&settings.aiEnabled&&run.detectorModel===settings.aiModel&&run.ownerId===settings.profileId&&run.datasetId===settings.datasetId&&run.policyEpoch===policy.epoch&&run.sourcePermissionRevision===policy.sourcePermissionRevision&&run.source.sourceRevision===source.revision&&run.source.snapshotRevision===source.latestRevision&&run.source.permissionRevision===source.permissionRevision&&Date.parse(run.expiresAt)>at)
  const sessionLive=current&&isLiveDetectionRun(run)
  const recurrence=run.candidates.find(candidate=>candidate.id===recurrenceId&&candidate.change.action==='define_recurrence')
  async function prepare(candidateId:string){setBusy(true);setNotice('');try{setPrepared(await prepareDetectionCreate(run,candidateId));setChecked(false)}catch(error){setNotice(errorText(error))}finally{setBusy(false)}}
  async function apply(event:Event){
    if(!prepared||!checked||busy||!sessionLive)return
    setBusy(true);setNotice('')
    try{const receipt=await applyDetectionCreateFromUI(run,prepared,prepared.digest,event);setCreated(current=>[...current,receipt.candidateId]);setPrepared(null);setChecked(false);setNotice(`登録結果を受領しました。本人が確認した作業を ${receipt.taskIds.length} 件保存しました。`);onCreated?.(receipt)}catch(error){setNotice(errorText(error))}finally{setBusy(false)}
  }
  async function discard(){setBusy(true);try{await discardDetectionRun(run);onDiscard(run.id)}catch(error){setNotice(errorText(error))}finally{setBusy(false)}}
  return <article className="card setting-section">
    <div className="card-heading"><h3>{source?.title??'資料の検出履歴'} · 検出 {run.candidates.length}件 / 確認事項 {run.reviewItems.length}件</h3><button type="button" className="text-button" disabled={busy} onClick={discard}>この検出を破棄</button></div>
    <p className="muted">検出：{run.detectorModel} / 検証：{run.verifierModel}（同じモデルの別呼び出し）。独立モデルと保留評価のゲートは未通過。本人確認専用で、自動登録はできません。</p>
    <p className="muted">{run.coverageNotice}</p>
    {!current?<p role="alert">資料・許可・AI設定または版が変わったため、この候補は失効しました。資料を再確認して検出し直してください。</p>:<>
      {!sessionLive&&<p role="alert">保存済みの履歴を表示しています。承認権限は保存・復元しません。登録するには資料をもう一度検出してください。</p>}
      {run.candidates.map(candidate=>{
        const change=candidate.change,target=tasks.find(task=>task.id===change.target_task_id),targetStale=Boolean(change.target_task_id&&(!target||target.revision!==change.expected_revision))
        return <div className="setting-section" key={candidate.id}>
          <h4>{actionNames[change.action]}：{change.title??target?.title??'対象を確認'}</h4>
          <p>{basisNames[change.basis]} · {candidate.reason}</p>
          {change.action==='create'?<p>期限：{change.due.kind==='date'?change.due.value:change.due.kind==='datetime'?`${change.due.value}（原文と同じ時刻・タイムゾーンなら時刻付きで登録）`:change.due.kind==='unresolved'?'未確定（登録時に期限は空欄）':'記載なし'} · 点数・時間・優先度は推定しません。</p>:change.action==='define_recurrence'?<>
            <p>周期の原文：{change.recurrence?.raw}。本人が対象・参加条件・名前付きカレンダー・有効期間・時刻を選び、設定だけを確認できます。</p>
            <p className="muted">周期の設定保存と、タスク・占有予定への反映は別に承認します。点数や準備作業は推定しません。</p>
            {change.due.kind==='datetime'&&(groundedDetectionDue(change)?<p role="alert">時刻付きの本当の期限（原文：{change.due.raw}）は日付や予定時刻へ省略しません。周期の確認で、作業の形に締切日と原文と同じ締切時刻を本人が選んだ場合だけ採用できます。</p>:<p role="alert">期限の時刻は検証済みの原文で確認できない未確定の値です。この候補からは採用できません。締め切りは原文を確認して本人が手動で入力してください。</p>)}
          </>:<>
            <p>既存対象：{target?.title??change.target_task_id??'未確定'} · 候補の基準版 {change.expected_revision??'なし'}</p>
            {change.action==='update'&&<p>変更する項目：{change.change_fields.join(', ')}{change.change_fields.includes('due')?` / 期限 ${target?.dueDate??'未設定'} → ${change.due.value??change.due.raw??'未確定'}`:''}</p>}
            {change.action==='cancel'&&<p>現在 {target?.status??'不明'} → 取消の確認候補。タスクはまだ取り消していません。</p>}
            {change.action==='report_completion'&&<p>現在 {target?.status??'不明'} → 完了報告の確認候補。完了登録と加点はしていません。</p>}
            <p className="muted">期限・取消・完了の変更はこのInboxから適用できません。原文と既存内容を確認し、本人が手動編集してください。</p>
            {targetStale&&<p role="alert">対象タスクの版が変わっています。現在のタスクを確認してください。</p>}
            {onEdit&&target&&<button type="button" className="text-button" disabled={busy} onClick={()=>onEdit(target)}>既存タスクを本人が確認・編集</button>}
          </>}
          <details><summary>根拠の原文と検証</summary>{change.evidence.map((evidence,index)=><blockquote key={index}><p style={{whiteSpace:'pre-wrap'}}>{evidence.quote}</p><small>{evidence.source_id} / 内容版 {evidence.revision} / {evidence.span_id} / 支持項目 {evidence.supports.join(', ')}</small></blockquote>)}{candidate.verification?.checks.map(check=><p key={check.field}>検証判定 {check.field}: {check.verdict} · 参照 {check.source_refs.join(', ')}</p>)}</details>
          {created.includes(candidate.id)?<p>登録結果を受領した候補です。</p>:candidate.status==='ready-for-review'&&change.action==='create'&&<button type="button" className="secondary-button" disabled={!sessionLive||busy||Boolean(prepared)} onClick={()=>void prepare(candidate.id)}>タスクにする内容を確認</button>}
          {adoptedRecurrences.includes(candidate.id)?<p>周期の設定結果を受領した候補です。発生回への反映は共通カレンダーで別に確認してください。</p>:candidate.status==='ready-for-review'&&change.action==='define_recurrence'&&<button type="button" className="secondary-button" disabled={!sessionLive||busy||Boolean(prepared)||Boolean(recurrenceId)} onClick={()=>setRecurrenceId(candidate.id)}>周期の設定を確認</button>}
        </div>
      })}
      {run.reviewItems.length>0&&<div className="setting-section"><h4>検出を確定するための確認事項</h4>{run.reviewItems.map((item,index)=><p key={index}>{item.question} <small>({item.reason})</small></p>)}<p className="muted">確認事項は作業タスクではありません。件数やポイントに数えません。</p></div>}
      {run.candidates.length===0&&<p>この取得範囲から登録候補は検出されませんでした。未取得範囲の義務の有無は不明です。</p>}
      {run.ignored.length>0&&<details><summary>除外した記載 {run.ignored.length}件</summary>{run.ignored.map((item,index)=><p key={index}>{item.source_id} · {item.reason}</p>)}</details>}
      {prepared&&sessionLive&&<div className="card setting-section">
        <h4>本人がこの内容を登録</h4><p>作業：{prepared.assisted.inputs[0].title}</p><p>本当の期限：{prepared.assisted.inputs[0].dueDate??'未設定'}{prepared.assisted.inputs[0].dueAt&&prepared.assisted.inputs[0].dueTimezone?` ${calendarTimeAt(prepared.assisted.inputs[0].dueAt,prepared.assisted.inputs[0].dueTimezone)}（${prepared.assisted.inputs[0].dueTimezone}）`:''} / 予定日：未設定 / 必要ポイント：未評価</p><p className="muted">資料の引用{prepared.evidence.length}件はメモに複写せず、タスクの「資料の根拠」に保存します。資料の削除・期限切れ・保存/索引許可の取消で引用も消去し、外部AIへは資料の許可があるコーチ会話だけで送ります。</p>
        <label><input type="checkbox" aria-label="検出候補の根拠と本人担当を承認" checked={checked} disabled={busy} onChange={event=>setChecked(event.target.checked)}/> 行為・本人担当・現在も必要であること・原文の根拠・期限の意味を確認し、この候補の登録を承認する</label>
        <div className="export-buttons"><button type="button" className="primary-button" disabled={busy||!checked} onClick={event=>void apply(event.nativeEvent)}>確認したこの候補を登録</button><button type="button" className="text-button" disabled={busy} onClick={()=>{setPrepared(null);setChecked(false)}}>登録確認を戻す</button></div>
      </div>}
      {recurrence&&calendarState&&sessionLive&&<RoutineAssistView key={recurrence.id} state={calendarState} settings={settings} heading="検証済み周期の本人採用" allowAI={false} sourceSuggestion={{message:`${recurrence.change.title}\n${recurrence.change.recurrence!.raw}`,prepare:(input,event)=>prepareDetectionRecurrenceFromUI(run,recurrence.id,input,event),apply:(proposal,digest,event)=>applyDetectionRecurrenceFromUI(run,recurrence.id,proposal,digest,event)}} onSaved={()=>{setAdoptedRecurrences(current=>[...current,recurrence.id]);setRecurrenceId(null);setNotice('本人が確認した周期の設定を受領しました。タスク・予定への反映は共通カレンダーで別に確認してください。')}} onCancel={()=>setRecurrenceId(null)}/>}
    </>}
    {notice&&<p role="status">{notice}</p>}
  </article>
}

export default function DetectionInboxView({settings,tasks,onEdit,onCreated}:Props){
  const [selectedId,setSelectedId]=useState(''),[sessionRuns,setSessionRuns]=useState<DetectionRun[]>([]),[hidden,setHidden]=useState<string[]>([])
  const [at,setAt]=useState(()=>Date.now())
  useEffect(()=>{const timer=window.setInterval(()=>setAt(Date.now()),30000);return()=>window.clearInterval(timer)},[])
  const sources=useLiveQuery(()=>db.contextSources.where('ownerId').equals(settings.profileId).toArray(),[settings.profileId])??[]
  const saved=useLiveQuery(()=>savedDetectionRuns(settings.profileId),[settings.profileId])??[]
  const available=sources.filter(source=>sourceUsable(source,settings,at)),selected=available.find(source=>source.id===selectedId)
  const runs=[...sessionRuns,...saved.filter(run=>!sessionRuns.some(active=>active.id===run.id))].filter(run=>!hidden.includes(run.id)&&run.ownerId===settings.profileId)
  return <section className="card setting-section detection-inbox">
    <h2>資料からの義務検出・候補Inbox</h2>
    <p>資料に既にある必要な作業を検出し、別の検証呼び出しで根拠を確認します。未登録の候補と確認事項はタスク件数・ポイントに含めません。</p>
    <label className="field">検出する資料を一つ選択<select aria-label="義務検出の対象資料" value={selected?.id??''} onChange={event=>setSelectedId(event.target.value)}><option value="">資料を選択</option>{available.map(source=><option key={source.id} value={source.id}>{source.title}（内容版{source.latestRevision}）</option>)}</select></label>
    {available.length===0&&<p className="muted">資料ライブラリで取得・保存・索引・設定モデルへのAI送信を許可した資料を選んでください。</p>}
    {selected&&<DetectionSourceForm key={`${selected.id}:${selected.revision}`} source={selected} settings={settings} tasks={tasks} at={at} onDetected={run=>setSessionRuns(current=>[run,...current])}/>}
    {runs.map(run=><DetectionRunCard key={run.id} run={run} source={sources.find(source=>source.id===run.source.sourceId)} settings={settings} tasks={tasks} at={at} onEdit={onEdit} onCreated={onCreated} onDiscard={id=>{setHidden(current=>[...current,id]);setSessionRuns(current=>current.filter(run=>run.id!==id))}}/>)}
  </section>
}
