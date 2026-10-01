import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { sourceDb as db, spanLocation, type ContextSource } from './source-library'
import { applyDetectionCreateFromUI, applyDetectionRecurrenceFromUI, detectionContextChoices, detectionRunCurrent, detectionVerifierModel, detectObligationsForSource, discardDetectionRun, dismissDetectionCandidate, groundedDetectionDue, isLiveDetectionRun, prepareDetectionCreate, prepareDetectionRecurrenceFromUI, prepareThreadDetectionFromUI, reconsiderDetectedObligation, runSources, savedDetectionRuns, verifierIndependence, type DetectionCreationReceipt, type DetectionRun, type DetectionTransport, type PreparedDetectionCreate } from './detection-run'
import type { DetectionChange } from './detection-contract'
import type { Settings, Task } from './domain'
import { loadCalendarRulesState } from './calendar-rules-save'
import { calendarTimeAt, type CalendarRulesState } from './calendar-resolver'
import { linkedTaskIdsForSources } from './detection-ledger'
import RoutineAssistView from './RoutineAssistView'

type Props={settings:Settings;tasks:Task[];onEdit?:(task:Task)=>void;onCreated?:(receipt:DetectionCreationReceipt)=>void}
type Bridge={detectObligations?:DetectionTransport['detect'];verifyObligations?:DetectionTransport['verify']}
const actionNames:Record<DetectionChange['action'],string>={create:'新規作業の候補',update:'既存タスクの変更候補',cancel:'既存タスクの取消候補',report_completion:'既存タスクの完了報告',define_recurrence:'周期の定義候補'}
const basisNames:Record<DetectionChange['basis'],string>={explicit_request:'本人への具体的な依頼',self_commitment:'本人の明示した約束',documented_obligation:'対象が確認された文書の義務',approved_rule:'本人承認済みルール'}
const independenceNames={'same-model':'同じモデルの別呼び出し','different-model':'別モデル（同じ提供元）','different-provider':'別モデル（別の提供元）'}
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error)
function sourceUsable(source:ContextSource,settings:Settings,at:number){const verifier=detectionVerifierModel(settings);return source.ownerId===settings.profileId&&!source.deletedAt&&(!source.retentionUntil||Date.parse(source.retentionUntil)>at)&&source.permissions.acquire&&source.permissions.retain&&source.permissions.index&&source.permissions.aiEgress&&Boolean(settings.aiModel&&source.allowedModels.includes(settings.aiModel)&&verifier&&source.allowedModels.includes(verifier))}
const sameConversation=(left:ContextSource,right:ContextSource)=>Boolean(left.conversation&&left.provider===right.provider&&left.conversation===right.conversation)

function DetectionSourceForm({source,sources,settings,tasks,calendarState,onDetected,at}:{source:ContextSource;sources:ContextSource[];settings:Settings;tasks:Task[];calendarState:CalendarRulesState|undefined;onDetected:(run:DetectionRun)=>void;at:number}){
  const [aliases,setAliases]=useState(''),[authorIsOwner,setAuthorIsOwner]=useState(false),[includeExisting,setIncludeExisting]=useState(false),[includeLinked,setIncludeLinked]=useState(false),[identityChecked,setIdentityChecked]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('')
  const [threadIds,setThreadIds]=useState<string[]>([]),[bindingIds,setBindingIds]=useState<string[]>([]),[ruleIds,setRuleIds]=useState<string[]>([])
  const bridge=window.michiAI as Bridge|undefined,verifier=detectionVerifierModel(settings)
  const thread=sources.filter(row=>row.id!==source.id&&sameConversation(row,source)&&sourceUsable(row,settings,at)).sort((left,right)=>left.date.localeCompare(right.date)||(left.externalId??'').localeCompare(right.externalId??''))
  const chosen=[source,...thread.filter(row=>threadIds.includes(row.id))]
  const from=chosen.map(row=>row.coverage.fromDate).sort()[0],to=chosen.map(row=>row.coverage.toDate).sort().pop()!
  const choices=detectionContextChoices(calendarState,settings.profileId,from,to)
  const linked=useLiveQuery(()=>linkedTaskIdsForSources(settings.profileId,[source.id,...thread.map(row=>row.id)]),[settings.profileId,source.id,thread.map(row=>row.id).join(',')])??[]
  const available=Boolean(settings.aiEnabled&&settings.aiModel&&bridge?.detectObligations&&bridge?.verifyObligations&&sourceUsable(source,settings,at))
  const toggle=(list:string[],id:string,on:boolean)=>on?[...list,id]:list.filter(item=>item!==id)
  async function detect(event:Event){
    if(!available||!identityChecked||busy)return
    setBusy(true);setNotice('選択資料を検出し、候補ごとに別の呼び出しで根拠を検証しています。タスクはまだ作りません。')
    try{
      const existing=[...new Set([...(includeExisting?tasks.filter(task=>!task.deletedAt).map(task=>task.id):[]),...(includeLinked?linked:[])])].slice(0,100)
      const prepared=await prepareThreadDetectionFromUI(chosen.map(row=>({sourceId:row.id,expectedRevision:row.revision})),settings.aiModel!,{confirmedAliases:aliases.split(',').map(value=>value.trim()).filter(Boolean),authorIsOwner,existingTaskIds:existing,bindingIds,ruleIds},event)
      const result=await detectObligationsForSource(prepared,{detect:bridge!.detectObligations!,verify:bridge!.verifyObligations!})
      onDetected(result);setNotice(`検出 ${result.candidates.length}件、追加の確認事項 ${result.reviewItems.length}件をInboxに保存しました。タスクの登録・実績への加点はしていません。`)
    }catch(error){setNotice(`${errorText(error)} 入力した確認情報は残っています。`)}
    finally{setBusy(false)}
  }
  return <div className="setting-section">
    <p>資料：<strong>{source.title}</strong> · 内容版 {source.latestRevision} · 許可版 {source.permissionRevision}</p>
    <p className="muted">本人が取り込んだ {source.coverage.fromDate}〜{source.coverage.toDate} の範囲です。表示名・CC・チャンネル参加を本人担当の証拠にはしません。</p>
    {thread.length>0&&<details open><summary>同じ会話の前後の資料も含める（{threadIds.length}/{thread.length}件を選択）</summary><p className="muted">後の訂正・取消を検出器が見られるよう、同じ会話から本人が選んだ資料だけを日時順にまとめて送ります（最大20件・合計50,000文字）。</p>{thread.slice(0,19).map(row=><label key={row.id} style={{display:'block'}}><input type="checkbox" aria-label={`同じ会話の資料を含める ${row.title}`} checked={threadIds.includes(row.id)} disabled={busy} onChange={event=>{setThreadIds(current=>toggle(current,row.id,event.target.checked));setIdentityChecked(false)}}/> {row.date} · {row.title}</label>)}</details>}
    {(choices.bindings.length>0||choices.rules.length>0)&&<details><summary>適用根拠として送る所属・承認済みルール（本人が選択、既定は未選択）</summary>
      {choices.bindings.map(item=><label key={item.id} style={{display:'block'}}><input type="checkbox" aria-label={`所属を照合に含める ${item.description}`} checked={bindingIds.includes(item.id)} disabled={busy} onChange={event=>{setBindingIds(current=>toggle(current,item.id,event.target.checked));setIdentityChecked(false)}}/> 所属：{item.description}</label>)}
      {choices.rules.map(item=><label key={item.id} style={{display:'block'}}><input type="checkbox" aria-label={`承認済みルールを照合に含める ${item.description}`} checked={ruleIds.includes(item.id)} disabled={busy} onChange={event=>{setRuleIds(current=>toggle(current,item.id,event.target.checked));setIdentityChecked(false)}}/> ルール：{item.description}</label>)}
      <p className="muted">共通カレンダーで本人が確認した所属と、本人承認済みの有効なルールだけを表示します。資料本文から所属やルールを推定しません。送るのは名前と期間だけです。</p></details>}
    <label className="field">この資料で本人を表す確認済みの表記（カンマ区切り）<input aria-label="検出資料の本人表記" maxLength={1000} value={aliases} disabled={busy} placeholder="例：Karinさん,Karin" onChange={event=>{setAliases(event.target.value);setIdentityChecked(false)}}/></label>
    <label><input type="checkbox" checked={authorIsOwner} disabled={busy} onChange={event=>{setAuthorIsOwner(event.target.checked);setIdentityChecked(false)}}/> 選んだ資料全体の執筆者は本人と確認できる（他人の発言を含む会話では選ばない）</label>
    <label><input type="checkbox" checked={includeExisting} disabled={busy} onChange={event=>setIncludeExisting(event.target.checked)}/> 既存タスクのタイトル・期限・ID・版を照合へ送る（最大100件、メモと点数は送らない）</label>
    {linked.length>0&&<label><input type="checkbox" aria-label="同じ会話で反映済みのタスクを照合に含める" checked={includeLinked} disabled={busy} onChange={event=>setIncludeLinked(event.target.checked)}/> 同じ会話の根拠から反映済みのタスク {linked.length}件を照合へ送る（題名・期限・ID・版だけ）</label>}
    <p className="muted">検出：{settings.aiModel??'未設定'} / 検証：{verifier??'未設定'}（{settings.aiModel&&verifier?independenceNames[verifierIndependence(settings.aiModel,verifier)]:'未設定'}）。資料の許可モデルに両方が必要です。</p>
    <label><input type="checkbox" aria-label="義務検出の本人対応を確認" checked={identityChecked} disabled={busy} onChange={event=>setIdentityChecked(event.target.checked)}/> 本人対応を確認した。選んだ資料{chosen.length}件の本文と上記の照合情報を {settings.aiModel??'設定モデル'}{verifier&&verifier!==settings.aiModel?` と検証用の ${verifier}`:''} へ送る</label>
    <p className="muted">検出は新しい作業の提案をしません。任意・仮定・他人担当・完了済み・撤回済み・予定だけの記載を除外します。所属・履修・契約や承認済みルールの対応が未選択なら、確認事項として扱います。</p>
    <button type="button" className="secondary-button" disabled={!available||!identityChecked||busy} onClick={event=>void detect(event.nativeEvent)}>{busy?'検出と検証を待っています…':'この資料の義務を検出・検証してInboxへ'}</button>
    {!settings.aiEnabled&&<p className="muted">AIは停止中です。資料の原文は資料ライブラリで閲覧し、タスクを手動入力できます。</p>}
    {notice&&<p role="status">{notice}</p>}
  </div>
}

function DetectionRunCard({run,sources,settings,tasks,calendarState,onEdit,onCreated,onDiscard,at}:{run:DetectionRun;sources:ContextSource[];settings:Settings;tasks:Task[];calendarState:CalendarRulesState|undefined;onEdit?:Props['onEdit'];onCreated?:Props['onCreated'];onDiscard:(id:string)=>void;at:number}){
  const [prepared,setPrepared]=useState<PreparedDetectionCreate|null>(null),[checked,setChecked]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[created,setCreated]=useState<string[]>([])
  const [recurrenceId,setRecurrenceId]=useState<string|null>(null),[adoptedRecurrences,setAdoptedRecurrences]=useState<string[]>([])
  const guards=runSources(run),source=sources.find(row=>row.id===run.source.sourceId)
  const ledger=useLiveQuery(async()=>new Map((await db.detectedObligations.where('ownerId').equals(run.ownerId).toArray()).map(row=>[row.canonicalKey,row])),[run.ownerId])
  const snapshots=useLiveQuery(async()=>(await db.contextSnapshots.bulkGet(guards.map(guard=>`${guard.sourceId}:${guard.snapshotRevision}`))).filter(Boolean),[run.id])??[]
  const current=detectionRunCurrent(run,settings,sources,calendarState,at)
  const sessionLive=current&&isLiveDetectionRun(run)
  const recurrence=run.candidates.find(candidate=>candidate.id===recurrenceId&&candidate.change.action==='define_recurrence')
  const independence=run.verifierIndependence??'same-model'
  async function prepare(candidateId:string){setBusy(true);setNotice('');try{setPrepared(await prepareDetectionCreate(run,candidateId));setChecked(false)}catch(error){setNotice(errorText(error))}finally{setBusy(false)}}
  async function apply(event:Event){
    if(!prepared||!checked||busy||!sessionLive)return
    setBusy(true);setNotice('')
    try{const receipt=await applyDetectionCreateFromUI(run,prepared,prepared.digest,event);setCreated(current=>[...current,receipt.candidateId]);setPrepared(null);setChecked(false);setNotice(`登録結果を受領しました。本人が確認した作業を ${receipt.taskIds.length} 件保存しました。`);onCreated?.(receipt)}catch(error){setNotice(errorText(error))}finally{setBusy(false)}
  }
  async function dismiss(candidateId:string,event:Event){setBusy(true);setNotice('');try{await dismissDetectionCandidate(run,candidateId,event);if(prepared?.candidateId===candidateId){setPrepared(null);setChecked(false)}setNotice('この根拠を不要として記録しました。同じ根拠は再検出・再取込しても採用候補にしません。')}catch(error){setNotice(errorText(error))}finally{setBusy(false)}}
  async function reconsider(key:string,revision:number,event:Event){setBusy(true);setNotice('');try{await reconsiderDetectedObligation(key,revision,event);setNotice('本人が再検討に戻しました。検証済みの候補なら登録内容を確認できます。')}catch(error){setNotice(errorText(error))}finally{setBusy(false)}}
  async function discard(){setBusy(true);try{await discardDetectionRun(run);onDiscard(run.id)}catch(error){setNotice(errorText(error))}finally{setBusy(false)}}
  const applicability=(change:DetectionChange)=>{
    const binding=change.applicability_ref?calendarState?.bindings.find(item=>item.id===change.applicability_ref):undefined,rule=change.rule_ref?calendarState?.rules.find(item=>item.id===change.rule_ref):undefined
    const parts=[change.applicability_ref?`所属 ${binding?`${calendarState?.contexts.find(item=>item.id===binding.contextId)?.name??binding.id}（${binding.confirmed?'確認済み':'未確認'}）`:`${change.applicability_ref}（現在は見つかりません）`}`:null,change.rule_ref?`ルール ${rule?`${rule.title}（${rule.enabled&&rule.originBasis==='user_approved_rule'?'承認済み':'停止または未承認'}）`:`${change.rule_ref}（現在は見つかりません）`}`:null].filter(Boolean)
    return parts.length?`適用根拠: ${parts.join(' / ')}`:null
  }
  const location=(sourceId:string,spanId:string)=>spanLocation(snapshots.find(row=>row!.sourceId===sourceId),spanId)
  return <article className="card setting-section">
    <div className="card-heading"><h3>{source?.title??'資料の検出履歴'}{guards.length>1?` ほか${guards.length-1}件`:''} · 検出 {run.candidates.length}件 / 確認事項 {run.reviewItems.length}件</h3><button type="button" className="text-button" disabled={busy} onClick={discard}>この検出を破棄</button></div>
    <p className="muted">検出：{run.detectorModel} / 検証：{independence==='same-model'?'同じモデル':'別モデル'}（{run.verifierModel}・{independenceNames[independence]}）。評価: 回帰例のみ・独立モデルの保留評価は未通過。本人確認専用で、自動登録はできません。</p>
    <p className="muted">{run.coverageNotice}</p>
    {!current?<p role="alert">資料・許可・AI設定・検証モデル・所属/ルールの確認または版が変わったため、この候補は失効しました。資料を再確認して検出し直してください。</p>:<>
      {!sessionLive&&<p role="alert">保存済みの履歴を表示しています。承認権限は保存・復元しません。登録するには資料をもう一度検出してください。</p>}
      {run.candidates.map(candidate=>{
        const change=candidate.change,target=tasks.find(task=>task.id===change.target_task_id),targetStale=Boolean(change.target_task_id&&(!target||target.revision!==change.expected_revision))
        const obligation=candidate.obligationKey?ledger?.get(candidate.obligationKey):undefined,linkedTask=obligation?.linkedTaskId?tasks.find(task=>task.id===obligation.linkedTaskId):undefined
        const suppressed=obligation?.state==='dismissed'||obligation?.state==='linked'||created.includes(candidate.id)
        return <div className="setting-section" key={candidate.id}>
          <h4>{actionNames[change.action]}：{change.title??target?.title??'対象を確認'}</h4>
          <p>{basisNames[change.basis]} · {candidate.reason}</p>
          {applicability(change)&&<p>{applicability(change)}</p>}
          {obligation?.state==='dismissed'&&<p role="note">抑制済み：以前に本人が不要とした根拠です。採用できません。</p>}
          {obligation?.state==='linked'&&<p role="note">反映済み: {linkedTask?.title??'タスク'}。同じ根拠から新規作成しません。</p>}
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
          <details><summary>根拠の原文と検証</summary>{change.evidence.map((evidence,index)=>{const place=location(evidence.source_id,evidence.span_id);return <blockquote key={index}><p style={{whiteSpace:'pre-wrap'}}>{evidence.quote}</p><small>{place?`${place} · `:''}{evidence.source_id} / 内容版 {evidence.revision} / {evidence.span_id} / 支持項目 {evidence.supports.join(', ')}</small></blockquote>})}{candidate.verification?.checks.map(check=><p key={check.field}>検証判定 {check.field}: {check.verdict} · 参照 {check.source_refs.join(', ')}</p>)}</details>
          {created.includes(candidate.id)?<p>登録結果を受領した候補です。</p>:!suppressed&&candidate.status==='ready-for-review'&&change.action==='create'&&<button type="button" className="secondary-button" disabled={!sessionLive||busy||Boolean(prepared)} onClick={()=>void prepare(candidate.id)}>タスクにする内容を確認</button>}
          {adoptedRecurrences.includes(candidate.id)?<p>周期の設定結果を受領した候補です。発生回への反映は共通カレンダーで別に確認してください。</p>:candidate.status==='ready-for-review'&&change.action==='define_recurrence'&&<button type="button" className="secondary-button" disabled={!sessionLive||busy||Boolean(prepared)||Boolean(recurrenceId)} onClick={()=>setRecurrenceId(candidate.id)}>周期の設定を確認</button>}
          {candidate.obligationKey&&!obligation?.state?.match(/^(dismissed|linked)$/)&&!created.includes(candidate.id)&&<button type="button" className="text-button" disabled={busy} onClick={event=>void dismiss(candidate.id,event.nativeEvent)}>不要（今後この根拠を候補にしない）</button>}
          {obligation?.state==='dismissed'&&<button type="button" className="text-button" disabled={busy} onClick={event=>void reconsider(obligation.canonicalKey,obligation.revision,event.nativeEvent)}>再検討する</button>}
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
  // Read-only: the calendar is changed only from its own screens.
  const calendarState=useLiveQuery(()=>loadCalendarRulesState().catch(()=>undefined),[settings.profileId,settings.datasetId])
  const available=sources.filter(source=>sourceUsable(source,settings,at)),selected=available.find(source=>source.id===selectedId)
  const runs=[...sessionRuns,...saved.filter(run=>!sessionRuns.some(active=>active.id===run.id))].filter(run=>!hidden.includes(run.id)&&run.ownerId===settings.profileId)
  return <section className="card setting-section detection-inbox">
    <h2>資料からの義務検出・候補Inbox</h2>
    <p>資料に既にある必要な作業を検出し、別の検証呼び出しで根拠を確認します。未登録の候補と確認事項はタスク件数・ポイントに含めません。</p>
    <label className="field">検出する資料を一つ選択<select aria-label="義務検出の対象資料" value={selected?.id??''} onChange={event=>setSelectedId(event.target.value)}><option value="">資料を選択</option>{available.map(source=><option key={source.id} value={source.id}>{source.title}（内容版{source.latestRevision}）</option>)}</select></label>
    {available.length===0&&<p className="muted">資料ライブラリで取得・保存・索引・設定モデル（検証用モデルを設定した場合はそれも）へのAI送信を許可した資料を選んでください。</p>}
    {selected&&<DetectionSourceForm key={`${selected.id}:${selected.revision}`} source={selected} sources={sources} settings={settings} tasks={tasks} calendarState={calendarState} at={at} onDetected={run=>setSessionRuns(current=>[run,...current])}/>}
    {runs.map(run=><DetectionRunCard key={run.id} run={run} sources={sources} settings={settings} tasks={tasks} calendarState={calendarState} at={at} onEdit={onEdit} onCreated={onCreated} onDiscard={id=>{setHidden(current=>[...current,id]);setSessionRuns(current=>current.filter(run=>run.id!==id))}}/>)}
  </section>
}
