import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { changePolicyFor, type TaskChangeField } from './change-set'
import { createFileBridgeController, fileBridgeAutomationAllowed, type FileBridgeApplicationOutcome, type PreparedFileBridgeApplication } from './file-bridge-commands'
import { egressNotice } from './egress-policy'
import { runExternalSelftest, setExternalAIEnabled } from './external-ai'
import { mcpHostReferences } from './mcp-host-reference'
import type { AppMCPGateway } from './external-tools-runtime'
import { externalAIFor } from './external-authority'
import { db } from './db'
import ChangeSetPreview from './ChangeSetPreview'
import TaskSplitPreview from './TaskSplitPreview'
import { humanContextFor, changeContextFor } from './command-bus'
import { splitBody, type SplitChildDraft } from './task-split-change'
import { externallyEditableTrigger, routineBody } from './routine-external-change'
import { calendarRuleEditorDefinition } from './calendar-rule-editor'
import type { FileBridgeField, FileBridgeGateway, FileBridgeHost, FileBridgeInboxEntry, FileBridgeResult, FileBridgeStatus, FileBridgeWindow } from './file-bridge-types'
import type { CalendarRule } from './calendar-resolver'
import type { Settings, Task } from './domain'

const labels:Record<FileBridgeField,string>={title:'タスク名',notes:'メモ',scheduled_date:'予定日',due_date:'本当の締め切り',manual_points:'本人指定ポイント'}
const valueFields:FileBridgeField[]=['title','due_date','manual_points']
const resultLabels:Record<FileBridgeResult['state'],string>={applied:'保存を確認済み',unknown:'結果未確定。再実行せず保存履歴を確認してください。',failed:'実行失敗',denied:'拒否',conflict:'競合',expired:'期限切れ・権限変更',rejected:'受付拒否'}
const resultText=(result:FileBridgeResult)=>`${resultLabels[result.state]}${result.code?`（${result.code}）`:''}`
const weekdayNames=['日','月','火','水','木','金','土']
function triggerText(trigger:CalendarRule['trigger']) {
  if(trigger.kind==='weekly')return `毎週${trigger.weekdays.map(day=>weekdayNames[day]).join('・')}曜 ${trigger.time}`
  if(trigger.kind==='monthly_business')return `毎月${trigger.from==='end'?'最終から':''}第${trigger.ordinal}営業日 ${trigger.time}`
  if(trigger.kind==='activity_relative')return `活動の${trigger.edge==='start'?'開始':'終了'}から${trigger.offsetDays}日・${trigger.offsetMinutes}分`
  return trigger.kind==='rrule'?`RRULE ${trigger.rrule}`:`完了から${trigger.afterDays}日後 ${trigger.time}`
}
export default function LocalFileBridgeView({settings,tasks,gateway,onApplied}: {settings:Settings;tasks:Task[];gateway?:FileBridgeGateway;onApplied?:(receipt:FileBridgeApplicationOutcome['receipt'])=>void}) {
  const connection=gateway??(window as FileBridgeWindow).michiFileBridge
  const controller=useMemo(()=>connection?createFileBridgeController(connection):null,[connection])
  const external=externalAIFor(settings),policy=changePolicyFor(settings),scopeKey=`${settings.profileId}:${settings.datasetId}:${policy.epoch}:${policy.sourcePermissionRevision}:${external.enabled}:${external.epoch}`
  const [view,setView]=useState<{scopeKey:string;status:FileBridgeStatus|null;entries:FileBridgeInboxEntry[];prepared:PreparedFileBridgeApplication|null;outcome:FileBridgeApplicationOutcome|null}>({scopeKey,status:null,entries:[],prepared:null,outcome:null})
  const [taskIds,setTaskIds]=useState<string[]>([]),[fields,setFields]=useState<FileBridgeField[]>(['title']),[host,setHost]=useState<FileBridgeHost>('codex'),[hours,setHours]=useState(1)
  const [allowSplit,setAllowSplit]=useState(false),[ruleIds,setRuleIds]=useState<string[]>([])
  const [allowHistory,setAllowHistory]=useState(false),[allowRoutinePreview,setAllowRoutinePreview]=useState(false),[allowContextRead,setAllowContextRead]=useState(false),[allowExternalContext,setAllowExternalContext]=useState(false),[allowDetection,setAllowDetection]=useState(false),[allowHandoffPrepare,setAllowHandoffPrepare]=useState(false),[allowHandoffs,setAllowHandoffs]=useState(false)
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('')
  const [valueMessage,setValueMessage]=useState(''),[splitDraft,setSplitDraft]=useState<{id:string;children:SplitChildDraft[]}|null>(null)
  const [mcpConfig,setMcpConfig]=useState<{scopeKey:string;root:string;json:string;cli:string;references:ReturnType<typeof mcpHostReferences>}|null>(null)
  const [autoMode,setAutoMode]=useState(false),[autoDays,setAutoDays]=useState(2),[autoCount,setAutoCount]=useState(5)
  const [grantEdit,setGrantEdit]=useState<{clientId:string;revision:number;expiresAt:string}|null>(null),[grantDays,setGrantDays]=useState(7),[grantCount,setGrantCount]=useState(20)
  const [appConfig,setAppConfig]=useState<{scopeKey:string;clientId:string;json:string}|null>(null)
  const appMCP=(window as Window&{michiAppMCP?:AppMCPGateway}).michiAppMCP
  const autoAllowed=fileBridgeAutomationAllowed(policy,fields,autoDays)
  const rules=useLiveQuery(async()=>(await db.calendarRules.get('main'))?.rules??[],[])??[],editableRules=rules.filter(rule=>externallyEditableTrigger(calendarRuleEditorDefinition(rule).trigger))
  const visible=view.scopeKey===scopeKey,prepared=visible?view.prepared:null,status=visible?view.status:null,entries=visible?view.entries:[],outcome=visible?view.outcome:null
  useEffect(()=>{
    if(!controller)return
    let active=true
    // Queued commands get a signed reason before authority is dropped; the controller names CHANGES_STOPPED only when every granted operation is now denied.
    void controller.closePending().catch(()=>undefined).then(()=>{controller.clearAuthority();return controller.refresh()}).then(status=>{if(active)setView({scopeKey,status,entries:[],prepared:null,outcome:null})}).catch(error=>{if(active)setNotice(error instanceof Error?error.message:String(error))})
    return()=>{active=false}
  },[controller,scopeKey])
  useEffect(()=>()=>{controller?.clearAuthority()},[controller])
  async function run(action:()=>Promise<void>) {if(busy)return;setBusy(true);setNotice('');try{await action()}catch(error){setNotice(error instanceof Error?`${error.message}${'code' in error&&typeof error.code==='string'?`（${error.code}）`:''}`:String(error))}finally{setBusy(false)}}
  function replaceStatus(status:FileBridgeStatus) {setView({scopeKey,status,entries:[],prepared:null,outcome:null});setAppConfig(null);setGrantEdit(null)}
  function editGrant(){
    const reg=status?.registration;if(!reg)return
    const grant=reg.client.grant
    setTaskIds([...reg.task_ids]);setFields([...grant.fields]);setRuleIds([...(reg.rule_ids??[])]);setAllowSplit(grant.keys.includes('tasks:split'));setHost(reg.client.intended_host)
    setAllowHistory(grant.keys.includes('history:read'));setAllowRoutinePreview(grant.keys.includes('routines:read'));setAllowContextRead(grant.keys.includes('context:read'));setAllowExternalContext(grant.allow_external_context);setAllowDetection(grant.keys.includes('detection:request'));setAllowHandoffPrepare(grant.keys.includes('handoff:prepare'));setAllowHandoffs(grant.allow_handoffs)
    setAutoMode(Boolean(grant.automation));setAutoDays(grant.automation?.max_schedule_shift_days??2);setAutoCount(grant.automation?.max_operations_per_day??5);setGrantDays(grant.max_schedule_shift_days);setGrantCount(grant.max_operations_per_day)
    setGrantEdit({clientId:reg.client.id,revision:reg.client.revision,expiresAt:grant.expires_at});setNotice('現在の許可を編集欄へ読み込みました。更新すると、この接続の古い変更案と資格情報が失効します。')
  }
  async function reviseGrant(event:Event){
    if(!controller||!grantEdit)return
    try{replaceStatus(await controller.revise({clientId:grantEdit.clientId,expectedRevision:grantEdit.revision,taskIds,fields,expiresAt:grantEdit.expiresAt,automation:autoMode&&autoAllowed?{maxScheduleShiftDays:autoDays,maxOperationsPerDay:autoCount}:null,maxScheduleShiftDays:grantDays,maxOperationsPerDay:grantCount,allowSplit,ruleIds,allowHistory,allowRoutinePreview,allowContextRead,allowExternalContext,allowDetection,allowHandoffPrepare,allowHandoffs},event));setNotice('この接続の許可を更新しました。書出しとMCP設定を更新してください。共有済みコピーは相手側に残る場合があります。')}
    catch(error){replaceStatus(await controller.refresh());throw error}
  }
  async function scan() {
    if(!controller)return
    let scanned=await controller.scanInbox(),applied=0,waiting=0
    // Owner-delegated auto grant only: the shared N09 engine and main's signed bounds decide; anything else waits for approval.
    if(scanned.status.registration?.client.grant.mutation_mode==='auto_within_bounds'){
      for(const entry of scanned.entries)if(entry.state==='awaiting_approval'){try{const proposal=await controller.prepare(entry.reference);const result=await controller.applyAutomatically(proposal);applied++;onApplied?.(result.receipt)}catch{waiting++}}
      if(applied)scanned=await controller.scanInbox()
    }
    setView({scopeKey,...scanned,prepared:null,outcome:null})
    if(applied||waiting)setNotice(`範囲内の${applied}件を自動適用しました。${waiting}件は本人の確認待ちです。自動適用した変更は「変更の履歴」から取り消せます。`)
  }
  function show(next:PreparedFileBridgeApplication) {setView(previous=>({...previous,prepared:next,outcome:null}));setSplitDraft(null)}
  async function approve(event:Event,checked:TaskChangeField[]) {
    if(!controller||!prepared)return
    const result=await controller.applyFromUI(prepared,event,checked)
    setView(previous=>({...previous,outcome:result}));onApplied?.(result.receipt)
    setNotice(result.resultPending?'変更は保存済みです。結果ファイルの書き出しを再試行してください。':`変更を保存し、結果ファイルを記録しました。${prepared.command.envelope.type==='routine.change'?'発生回の反映は「繰り返し」画面で別に確認してください。':''}`)
  }
  const command=prepared?.command??null,approveAttributes=prepared?{'data-file-bridge-approve':prepared.reference}:undefined
  const target=command?.envelope.target_id?tasks.find(task=>task.id===command.envelope.target_id):undefined
  const split=command?.envelope.type==='task.split'?splitBody(command):null,routine=command?.envelope.type==='routine.change'?routineBody(command):null
  const draftChildren=split?.stage==='owner_values'?(splitDraft?.id===command!.id?splitDraft.children:split.proposed.map(child=>({title:child.title,points:child.points,titleOrigin:'agent_proposal' as const,pointsOrigin:child.points===null?null:'agent_proposal' as const}))):[]
  const draftSum=draftChildren.reduce((sum,child)=>sum+(child.points??0),0)
  function editChild(index:number,patch:Partial<SplitChildDraft>) {if(!command)return;setSplitDraft({id:command.id,children:draftChildren.map((child,i)=>i===index?{...child,...patch}:child)})}
  return <section className="card" aria-label="ローカルエージェント接続">
    <h3>ローカルエージェント接続</h3>
    <p>選んだタスクをフォルダーで共有し、外部エージェントの作成・変更案をこの画面で確認できます。</p>
    {!controller?<p role="status">この環境ではローカル接続を利用できません。Windowsアプリで接続設定を開いてください。</p>:<>
      <p className="muted">外部クライアントがこのフォルダーを読み書きする設定は、利用するクライアント側で行います。外部サービスへの実接続は、この画面での登録だけでは完了しません。</p>
      {!external.enabled||!policy.aiChangesEnabled?<p role="status">AIによる変更は停止しています。タスクの手動編集は利用できます。</p>:null}
      <button type="button" className="secondary-button" disabled={busy} onClick={event=>{const native=event.nativeEvent;void run(async()=>{await setExternalAIEnabled(!external.enabled,native);setNotice(external.enabled?'外部AIの接続許可を取り消しました。アプリ内コーチと通知の設定は維持します。':'外部AIを有効にしました。共有するタスク・項目と期限を選んで接続してください。')})}}>{external.enabled?'外部AIを停止':'外部AIを有効にする'}</button>
      <p className="muted">外部AIとアプリ内コーチは別々に許可します。この接続にOpenRouterのキーは不要です。外部AIの停止はコーチのキー・ON/OFF・通知を変更しません。共有したコピーは相手側に残る場合があります。</p>
      {connection?.selectClient&&external.clients.some(client=>client.status==='active')?<div aria-label="外部AIの接続一覧"><h4>登録した接続を選ぶ</h4>{external.clients.filter(client=>client.status==='active').map(client=><button type="button" key={client.registration.client.id} className="secondary-button" disabled={busy||status?.registration?.client.id===client.registration.client.id} onClick={()=>void run(async()=>replaceStatus(await controller.selectClient(client.registration.client.id)))}>{client.registration.client.intended_host} / {client.registration.client.id.slice(0,8)}（{client.shippingState==='integration_verified'?'実host確認済':'ローカル実装・実host未確認'}）</button>)}</div>:null}
      {connection?.selftest&&external.clients.length?<details><summary>接続のローカル自己診断</summary><p>アプリからstdioプロセスを起動して、共有コピーの読み取り・取消を確認します。外部hostの認証や書き込みの確認にはなりません。</p>{external.clients.map(client=>{const id=client.registration.client.id,last=client.capabilityChecks.at(-1),labels={not_tested:'未試験',verified_local:'ローカル確認',verified_synthetic:'模擬host確認',verified_real:'実host確認',failed:'失敗'};return <article key={id}><p>{client.registration.client.intended_host} / {id.slice(0,8)}：{client.status==='active'?'有効':'取消・再認証待ち'}</p>{last?<p>認証：{labels[last.auth]} / 読み取り：{labels[last.read]} / 書き込み：{labels[last.write]} / 取消：{labels[last.revoke]}（{new Date(last.checkedAt).toLocaleString('ja-JP')}）</p>:<p>能力確認の記録はありません。</p>}<button type="button" className="secondary-button" disabled={busy||client.status==='needs_reauth'||client.status==='active'&&(!external.enabled||!status?.snapshot||status.registration?.client.id!==id)} onClick={()=>void run(async()=>{const result=await runExternalSelftest(connection,id,client.status==='active'?'read':'revoke');setNotice(result.code?`ローカル自己診断：${result.code}`:'ローカル自己診断を記録しました。実hostの接続は未確認です。')})}>{client.status==='active'?'読み取りを自己診断':'取消を自己診断'}</button></article>})}</details>:null}
      <details open={!status?.connected}><summary>共有する項目とタスク</summary>
        <p>選択した内容をフォルダーへ書き出します。このフォルダーを渡す相手は内容を読めます。資料から検出したタスクの引用（資料の根拠・旧形式メモの引用行）は書き出しません。</p>
        <label className="field"><span>利用するクライアント</span><select value={host} disabled={busy} onChange={event=>setHost(event.target.value as FileBridgeHost)}><option value="codex">Codex</option><option value="claude_code">Claude Code</option><option value="chatgpt">ChatGPT</option><option value="claude">Claude</option><option value="other">その他</option></select></label>
        <label className="field"><span>許可の有効時間</span><select value={hours} disabled={busy} onChange={event=>{const value=Number(event.target.value);setHours(value);setGrantEdit(previous=>previous?{...previous,expiresAt:new Date(Date.now()+value*3600000).toISOString()}:null)}}>{[1,4,12,24].map(value=><option key={value} value={value}>{value}時間</option>)}</select></label>
        <fieldset disabled={busy}><legend>共有・変更依頼を受ける項目</legend>{(['title','notes','scheduled_date','due_date','manual_points'] as FileBridgeField[]).map(field=><label key={field} className="field"><span><input type="checkbox" checked={fields.includes(field)} onChange={event=>setFields(event.target.checked?[...fields,field]:fields.filter(item=>item!==field))}/> {labels[field]}{valueFields.includes(field)?'（依頼のたびに本人が値を確認）':''}</span></label>)}</fieldset>
        <label className="field"><span><input type="checkbox" checked={allowSplit} disabled={busy} onChange={event=>setAllowSplit(event.target.checked)}/> 選択タスクの分割案を受け付ける（配分は毎回本人が確認）</span></label>
        {editableRules.length?<fieldset disabled={busy}><legend>周期の変更案を受け付ける系列（名称・点数は変更不可。RRULE・完了起点の系列は対象外）</legend>{editableRules.map(rule=><label key={rule.id} className="field"><span><input type="checkbox" checked={ruleIds.includes(rule.id)} onChange={event=>setRuleIds(event.target.checked?[...ruleIds,rule.id]:ruleIds.filter(id=>id!==rule.id))}/> {calendarRuleEditorDefinition(rule).title}（{triggerText(calendarRuleEditorDefinition(rule).trigger)}）</span></label>)}</fieldset>:null}
        <fieldset disabled={busy}><legend>追加の参照・共有範囲（既定OFF。ONは本人同意の記録になり、改訂時の拡大は本人確認ボタンが必要）</legend>
          <label className="field"><span><input type="checkbox" checked={allowHistory} onChange={event=>setAllowHistory(event.target.checked)}/> 完了履歴の集計参照を許可する（件数・点数・作業時間のみ）</span></label>
          <label className="field"><span><input type="checkbox" checked={allowRoutinePreview} onChange={event=>setAllowRoutinePreview(event.target.checked)}/> 周期ルールの次回プレビューを許可する（保存はしない）</span></label>
          <label className="field"><span><input type="checkbox" checked={allowContextRead} onChange={event=>setAllowContextRead(event.target.checked)}/> 開示許可済み資料の引用検索を許可する（許可した資料のみ）</span></label>
          <label className="field"><span><input type="checkbox" checked={allowExternalContext} onChange={event=>setAllowExternalContext(event.target.checked)}/> 外部AIへの引用受取りを許可する（OFFのままでは引用は空で返る）</span></label>
          <label className="field"><span><input type="checkbox" checked={allowDetection} onChange={event=>setAllowDetection(event.target.checked)}/> 検出runの準備・参照を許可する（推論は開始しない。費用承認は別途）</span></label>
          <label className="field"><span><input type="checkbox" checked={allowHandoffPrepare} onChange={event=>setAllowHandoffPrepare(event.target.checked)}/> 引継ぎ下書きの作成を許可する（保存は本人の受入後のみ）</span></label>
          <label className="field"><span><input type="checkbox" checked={allowHandoffs} onChange={event=>setAllowHandoffs(event.target.checked)}/> 他接続向け共有の受取先になることを許可する</span></label>
        </fieldset>
        <fieldset disabled={busy}><legend>共有するタスク（最大100件）</legend>{tasks.filter(task=>!task.deletedAt&&task.status==='open').map(task=><label key={task.id} className="field"><span><input type="checkbox" checked={taskIds.includes(task.id)} onChange={event=>setTaskIds(event.target.checked?[...taskIds,task.id]:taskIds.filter(id=>id!==task.id))}/> {task.title}</span></label>)}</fieldset>
        <p>変更案は本人が確認します。下で自動適用を委任したメモ・予定日は、その範囲内だけ承認なしで保存します。新規作成では点数と締め切りを未設定にします。完了・取消・削除・実績訂正・権限の変更は受け付けません。</p>
        <fieldset disabled={busy}><legend>範囲内の自動適用（任意）</legend><label className="field"><span><input type="checkbox" checked={autoMode&&autoAllowed} disabled={!autoAllowed} onChange={event=>setAutoMode(event.target.checked)}/> 範囲内のメモ・予定日の変更は承認なしで適用する</span></label>
          <div className="form-grid"><label className="field">予定日を動かせる日数<input type="number" min={0} max={7} step={1} value={autoDays} onChange={event=>setAutoDays(Number(event.target.value))}/></label><label className="field">1日の自動件数<input type="number" min={1} max={20} step={1} value={autoCount} onChange={event=>setAutoCount(Number(event.target.value))}/></label></div>
          <small>{autoAllowed?'自動適用は許可した範囲のメモ・予定日だけです。タイトル・期限・点数・新規作成と範囲外の変更は毎回本人が確認します。':'自動化設定（S20）でメモ・予定日を「範囲内で自動」にし、共有項目でメモか予定日を選ぶと使えます。'}</small></fieldset>
        <button type="button" data-file-bridge-configure="true" className="primary-button" disabled={busy||!fields.length||taskIds.length>100||!external.enabled||!policy.aiChangesEnabled} onClick={event=>{const native=event.nativeEvent;void run(async()=>replaceStatus(await controller.configure({intendedHost:host,taskIds,fields,lifetimeHours:hours,allowSplit,ruleIds,allowHistory,allowRoutinePreview,allowContextRead,allowExternalContext,allowDetection,allowHandoffPrepare,allowHandoffs,automation:autoMode&&autoAllowed?{maxScheduleShiftDays:autoDays,maxOperationsPerDay:autoCount}:null},native)))}}>選択した範囲だけを許可して接続</button>
        {connection?.revise&&status?.registration?<div><button type="button" className="secondary-button" disabled={busy} onClick={editGrant}>現在の許可を編集欄へ読み込む</button>{grantEdit?.clientId===status.registration.client.id&&grantEdit.revision===status.registration.client.revision?<><p>接続 {grantEdit.clientId.slice(0,8)}・版 {grantEdit.revision} を更新します。上のタスク・項目・自動化の選択を使います。有効期限：{new Date(grantEdit.expiresAt).toLocaleString('ja-JP')}。有効時間の選択を変えると期限も更新します。</p><div className="form-grid"><label className="field">承認できる予定日移動の上限<input type="number" min={0} max={31} step={1} value={grantDays} disabled={busy} onChange={event=>setGrantDays(Number(event.target.value))}/></label><label className="field">1日の接続操作上限<input type="number" min={0} max={100} step={1} value={grantCount} disabled={busy} onChange={event=>setGrantCount(Number(event.target.value))}/></label></div><p className="muted">範囲の縮小はすぐ反映できます。共有の追加・期限や上限の拡大・自動適用の追加は、下の本人確認ボタンから行います。更新に失敗した場合、この接続を停止します。他の接続は継続します。</p><button type="button" data-file-bridge-revise={grantEdit.clientId} className="primary-button" disabled={busy||taskIds.length>100||!external.enabled||!policy.aiChangesEnabled} onClick={event=>{const native=event.nativeEvent;void run(()=>reviseGrant(native))}}>この接続の許可を更新</button></>:null}</div>:null}
      </details>
      {status?.connected&&status.registration?<div>
        <h4>登録した接続</h4><p>{status.registration.client.intended_host} / {status.root}</p>
        <p>タスク{status.registration.task_ids.length}件、共有項目：{status.registration.client.grant.fields.map(field=>labels[field]).join('・')}{status.registration.client.grant.keys.includes('tasks:split')?'・分割案':''}{status.registration.client.grant.keys.includes('history:read')?'・履歴集計':''}{status.registration.client.grant.keys.includes('routines:read')?'・周期プレビュー':''}{status.registration.client.grant.keys.includes('context:read')?'・引用検索':''}{status.registration.client.grant.allow_external_context?'・引用受取':''}{status.registration.client.grant.keys.includes('detection:request')?'・検出run':''}{status.registration.client.grant.keys.includes('handoff:prepare')?'・引継下書き':''}{status.registration.client.grant.allow_handoffs?'・共有受取':''}{status.registration.rule_ids?.length?`・周期${status.registration.rule_ids.length}系列`:''}。1日{status.registration.client.grant.max_operations_per_day}件まで、予定日の移動は{status.registration.client.grant.max_schedule_shift_days}日まで。{status.registration.client.grant.automation?`範囲内自動：予定日±${status.registration.client.grant.automation.max_schedule_shift_days}日・1日${status.registration.client.grant.automation.max_operations_per_day}件まで。それ以外は本人承認。`:'すべて本人承認。'}</p>
        <p className="muted">有効期限：{new Date(status.registration.client.grant.expires_at).toLocaleString('ja-JP')}。接続版 {status.registration.client.revision} / 許可版 {status.registration.client.grant_epoch}</p>
        {appMCP?<details><summary>実行中アプリのMCP設定</summary><p>選択したタスクの検索・取得、点数プレビュー、変更案の準備・送信・結果確認ができます。送信した案は最新の書出しを使い、この画面の受信箱から共通の確認手順で保存します。15種類の定義のうち8種類に対応しています。新規作成の点数、ラベル、時刻付き期限、引継ぎと参照根拠は未対応です。ローカルの接続資格情報を含むので、この接続を渡す相手だけに設定してください。設定の再表示・アプリ再起動・取消で旧資格情報は無効になります。</p><button type="button" className="secondary-button" disabled={busy||!external.enabled} onClick={()=>void run(async()=>setAppConfig({scopeKey,clientId:status.registration!.client.id,json:JSON.stringify(await appMCP.configuration({clientId:status.registration!.client.id}),null,2)}))}>この接続のアプリMCP設定を表示・資格情報を更新</button>{appConfig?.scopeKey===scopeKey&&appConfig.clientId===status.registration.client.id?<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{appConfig.json}</pre>:null}</details>:null}
        <div className="change-set-actions"><button type="button" data-file-bridge-export={status.registration.client.id} className="secondary-button" disabled={busy||!external.enabled} onClick={event=>{const native=event.nativeEvent;void run(async()=>{replaceStatus(await controller.exportSnapshot(native));const withheld=controller.lastEgress();if(withheld&&(withheld.withheldQuotes||withheld.notesWithheld))setNotice(egressNotice({withheldQuotes:withheld.withheldQuotes,notesWithheld:withheld.notesWithheld>0},'書出し')!)})}}>選択タスクの現在の内容を書き出す</button><button type="button" data-file-bridge-disconnect={status.registration.client.id} className="secondary-button" disabled={busy} onClick={event=>{const native=event.nativeEvent;void run(async()=>replaceStatus(await controller.disconnect(native)))}}>この接続の許可を取り消す</button></div>
        {status.snapshot?<p>確認用データ：{new Date(status.snapshot.generated_at).toLocaleString('ja-JP')}、{Object.keys(status.snapshot.entity_revisions).length}件。<small className="muted">識別子 {status.snapshot.snapshot_id} / 内容hash {status.snapshot.view_sha256.slice(0,12)}</small></p>:<p>現在のタスクを書き出してから、外部クライアントで案を作成してください。</p>}
        {connection?.mcpConfiguration&&status.snapshot?<details><summary>stdio対応MCPクライアントへ接続</summary><p>Codex・Claude Code等のローカルMCP設定に登録します。読み取りは選択した項目だけ、変更はこのアプリで毎回承認します。クライアントへの設定と起動は別操作です。ChatGPT等のクラウド接続・HTTPサーバーは未提供です。</p><button type="button" className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{const config=await connection.mcpConfiguration!(), entry=config.mcpServers.michi, quote=(value:string)=>"'"+value.replace(/'/g,"''")+"'", cli=entry.args[0].replace(/michi-mcp\.mjs$/, 'michi-cli.mjs');setMcpConfig({scopeKey,root:status.root!,json:JSON.stringify(config,null,2),references:mcpHostReferences(config),cli:["$env:ELECTRON_RUN_AS_NODE = '1'",...['validate','submit'].map(mode=>`& ${quote(entry.command)} ${quote(cli)} ${mode} --bridge ${quote(status.root!)}`)].join('\n')})})}>この接続のMCP設定を表示</button>{mcpConfig?.scopeKey===scopeKey&&mcpConfig.root===status.root?<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{mcpConfig.json}</pre>:null}{mcpConfig?.scopeKey===scopeKey&&mcpConfig.root===status.root?<details><summary>host別の設定手順（未検証の参考）</summary><p>{mcpConfig.references.checkedAt}に公式手順を確認しました。これらのコマンドは実行していません。実hostでの認証・読み取り・変更・取消は別途確認が必要です。</p><h5>Codex CLI</h5><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{mcpConfig.references.codex}</pre><a href={mcpConfig.references.sources.codex} target="_blank" rel="noreferrer">Codex公式手順</a><h5>Claude Code</h5><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{mcpConfig.references.claudeCode}</pre><a href={mcpConfig.references.sources.claudeCode} target="_blank" rel="noreferrer">Claude Code公式手順</a><h5>Gemini CLI（settings.json）</h5><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{mcpConfig.references.gemini}</pre><a href={mcpConfig.references.sources.gemini} target="_blank" rel="noreferrer">Gemini CLI公式手順</a></details>:null}<p className="muted">外部ツールの結果ファイルは未検証コピーとして返します。拒否・競合・期限切れはアプリと同じコードのエラーとして返します。実保存と署名の確認はアプリの結果欄で行ってください。既に共有したコピーは取消後も相手側に残ることがあります。</p></details>:null}
        {status.snapshot?<details><summary>編集用ファイルから変更案を送る</summary><p>edits/tasks/&lt;タスクID&gt;.md を編集してください。ファイルを編集するだけでは保存されません。予定日の null は予定を外し、項目を省略すると現在の値を維持します。締め切り・ポイント・権限は読み取り専用です。書出しを更新すると編集用コピーが置き換わります。</p><p>「MCP設定を表示」で起動元を確認した後、PowerShellで validate → submit を実行し、このアプリで変更を確認します。</p>{mcpConfig?.scopeKey===scopeKey&&mcpConfig.root===status.root?<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{mcpConfig.cli}</pre>:null}</details>:null}
        <button type="button" className="secondary-button" disabled={busy||!status.snapshot} onClick={()=>void run(scan)}>受信箱と結果を更新</button>
      </div>:null}
      <p className="muted">{status?.notice}</p>
      {entries.length?<div><h4>受信した案</h4>{entries.map(entry=><article key={entry.filename}><strong>{entry.filename}</strong>{entry.state==='rejected'?<p>受付拒否：{entry.error}</p>:entry.state==='finished'?<p>{resultText(entry.result)}</p>:<div><p>{{'task.create':'タスクの新規作成','task.update':'既存タスクの変更','task.split':'タスクの分割','routine.change':'系列の周期変更'}[entry.prepared.command.type]}{entry.prepared.command.via==='mcp_stdio'?'（ローカルMCP経由・自己申告）':''} / 本人の承認待ち</p><button type="button" className="secondary-button" disabled={busy||Boolean(outcome)} onClick={()=>void run(async()=>show(await controller.prepare(entry.reference)))}>内容を確認</button></div>}</article>)}</div>:null}
      {prepared&&command?<section className="change-set-preview" aria-label="外部コマンドの本人確認"><h4>今回だけ許可する内容</h4>
        <p className="muted">接続 {prepared.registration.client.intended_host}・入口 {prepared.entrance==='mcp'?'ローカルMCP':'ファイル受信箱'}。確認期限 {new Date(prepared.entry.prepared.expiresAt).toLocaleString('ja-JP')}。変更内容 {prepared.digest.slice(0,12)}</p>
        {command.envelope.type==='task.update'&&command.stage==='owner_values'?<div><p>外部エージェントがタイトル・本当の締め切り・本人指定ポイントの変更を依頼しています。値は依頼であり本人の指示ではありません。次の値で変更する場合だけ、本人が確定してください。</p>
          {command.ownerValues![0]&&Object.entries(command.ownerValues![0].patch).map(([field,value])=><p key={field}>{({title:'タイトル',notes:'メモ',scheduledDate:'予定日',dueDate:'本当の締め切り',manualPoints:'本人指定ポイント'} as Record<string,string>)[field]}：{String(target?(field==='manualPoints'?target.score.manualPoints??'未設定':(target as unknown as Record<string,unknown>)[field]??'未設定'):'?')} → <strong>{String(value??'未設定')}</strong></p>)}
          <label className="field">本人の確認メモ（任意）<input value={valueMessage} maxLength={500} onChange={event=>setValueMessage(event.target.value)}/></label>
          <button type="button" className="primary-button" disabled={busy||!external.enabled} onClick={event=>{const native=event.nativeEvent;void run(async()=>show(await controller.confirmValuesFromUI(prepared,native,valueMessage)))}}>本人の指定値を確定して差分を作る</button></div>
        :command.envelope.type==='task.split'&&split?.stage==='owner_values'?<div><p>外部エージェントの分割案です。名前と配分は提案です。親の{target?.score.manualPoints??'?'}ptと合計を一致させ、本人が値を確定してください。</p>
          {draftChildren.map((child,index)=><div className="breakdown-row" key={index}><input aria-label={`子タスク${index+1}の名前`} maxLength={300} value={child.title} onChange={event=>editChild(index,{title:event.target.value,titleOrigin:'human'})}/><input aria-label={`子タスク${index+1}のポイント`} type="number" min={0} max={100000} step={1} value={child.points??''} onChange={event=>editChild(index,{points:event.target.value===''?null:Number(event.target.value),pointsOrigin:'human'})}/><span>pt</span></div>)}
          <p>配分合計：{draftSum} / {target?.score.manualPoints??'?'}pt{draftChildren.some(child=>child.points===null)?'（未入力あり）':''}</p>
          <button type="button" className="primary-button" disabled={busy||!external.enabled||draftChildren.some(child=>child.points===null||!child.title.trim())} onClick={event=>{const native=event.nativeEvent;void run(async()=>show(await controller.confirmSplitFromUI(prepared,draftChildren,native,'外部エージェントの分割案を本人が確認')))}}>本人の配分を確定して分割差分を作る</button></div>
        :command.envelope.type==='routine.change'&&routine?.stage==='owner_values'?<div><p>系列「{routine.ruleTitle}」（版 {routine.ruleRevision}）の周期を変更する依頼です。名称・点数・手順・完了済みの回は変更しません。</p>
          <p>変更後：<strong>{triggerText(routine.candidate.definition.trigger)}</strong> / 範囲：{routine.candidate.input.scope.kind==='this_and_future'?`${routine.candidate.input.scope.fromDate}以降`:routine.candidate.input.scope.kind==='this_instance'?'今回だけ':'未完了のすべて'}</p>
          <button type="button" className="primary-button" disabled={busy||!external.enabled} onClick={event=>{const native=event.nativeEvent;void run(async()=>show(await controller.confirmRoutineFromUI(prepared,native)))}}>依頼内容を確認して次の回を表示</button></div>
        :command.envelope.type==='routine.change'&&routine?.stage==='review'?<div><h4>保存される設定と次の10回</h4>{routine.assistance.configuration.preview.length?<ol>{routine.assistance.configuration.preview.map(spec=><li key={spec.generationKey}>{spec.title}：{spec.scheduledDate??spec.startAt}</li>)}</ol>:<p>この期間の発生回はありません。</p>}
          <p>この承認で保存するのは周期の設定だけです。タスク・予定への反映は「繰り返し」画面で別に確認して承認します。</p>
          {!outcome?<button type="button" data-file-bridge-approve={prepared.reference} className="primary-button" disabled={busy||!external.enabled} onClick={event=>{const native=event.nativeEvent;void run(()=>approve(native,[]))}}>この周期の設定だけを承認して保存</button>:null}</div>
        :command.envelope.type==='task.split'&&split?.stage==='review'?(!outcome?<TaskSplitPreview key={command.id} command={command} approveAttributes={approveAttributes} onApprove={(event,checked)=>run(()=>approve(event,checked))} onApplied={()=>undefined} onCancel={()=>setView(previous=>({...previous,prepared:null}))}/>:null)
        :command.changeSet?(!outcome?<ChangeSetPreview key={command.id} prepared={command.changeSet} policy={policy} actorContext={changeContextFor(command.actor)} humanContext={humanContextFor(command.actor)} command={command} approveAttributes={approveAttributes} onApprove={(event,checked)=>run(()=>approve(event,checked))} onApplied={()=>undefined} onCancel={()=>setView(previous=>({...previous,prepared:null}))}/>:null)
        :prepared.assisted?<div>{prepared.assisted.inputs.map((input,index)=><article key={index}><h4>{input.title}</h4><p style={{whiteSpace:'pre-wrap'}}>{input.notes}</p><p>予定日：{input.scheduledDate??'未設定'} / 点数：未設定 / 締め切り：未設定</p></article>)}
          {!outcome?<button type="button" data-file-bridge-approve={prepared.reference} className="primary-button" disabled={busy||!external.enabled} onClick={event=>{const native=event.nativeEvent;void run(()=>approve(native,[]))}}>この内容だけを承認して保存</button>:null}</div>:null}
        {outcome?.resultPending?<button type="button" className="secondary-button" disabled={busy} onClick={event=>{const native=event.nativeEvent;void run(async()=>{const result=await controller.retryResultFromUI(prepared,native);setView(previous=>({...previous,outcome:result}));setNotice(result.resultPending?'変更は保存済みです。結果ファイルは未確認です。':'結果ファイルを記録しました。')})}}>保存済み結果の書き出しを再試行</button>:outcome?<p>保存と結果ファイルの記録を確認しました。</p>:null}
      </section>:null}
      {status?.results.length?<details><summary>結果ファイル（{status.results.length}件）</summary>{status.results.map(result=><p key={result.command_id}>{result.command_id}：{resultText(result)}</p>)}</details>:null}
    </>}
    <p role="status">{notice||(!controller?'接続機能は未接続です。':busy?'確認しています…':'')}</p>
  </section>
}
