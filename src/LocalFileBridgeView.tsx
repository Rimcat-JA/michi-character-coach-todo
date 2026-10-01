import { useEffect, useMemo, useState } from 'react'
import { changePolicyFor, decideChangePolicy, type TaskChangeField } from './change-set'
import { createFileBridgeController, type FileBridgeApplicationOutcome, type PreparedFileBridgeApplication } from './file-bridge-commands'
import { updateAIConnection } from './ai-connection'
import type { FileBridgeField, FileBridgeGateway, FileBridgeHost, FileBridgeInboxEntry, FileBridgeStatus, FileBridgeWindow } from './file-bridge-types'
import type { Settings, Task } from './domain'

const labels:Record<FileBridgeField,string>={title:'タスク名',notes:'メモ',scheduled_date:'予定日'}
const changeLabels:Record<TaskChangeField,string>={title:'タイトル',notes:'メモ',scheduledDate:'予定日',dueDate:'締め切り',manualPoints:'ポイント'}
export default function LocalFileBridgeView({settings,tasks,gateway,onApplied}: {settings:Settings;tasks:Task[];gateway?:FileBridgeGateway;onApplied?:(receipt:FileBridgeApplicationOutcome['receipt'])=>void}) {
  const connection=gateway??(window as FileBridgeWindow).michiFileBridge
  const controller=useMemo(()=>connection?createFileBridgeController(connection):null,[connection])
  const policy=changePolicyFor(settings),scopeKey=`${settings.profileId}:${settings.datasetId}:${policy.epoch}:${policy.sourcePermissionRevision}:${settings.aiEnabled}`
  const [view,setView]=useState<{scopeKey:string;status:FileBridgeStatus|null;entries:FileBridgeInboxEntry[];prepared:PreparedFileBridgeApplication|null;outcome:FileBridgeApplicationOutcome|null}>({scopeKey,status:null,entries:[],prepared:null,outcome:null})
  const [taskIds,setTaskIds]=useState<string[]>([]),[fields,setFields]=useState<FileBridgeField[]>(['title']),[host,setHost]=useState<FileBridgeHost>('codex'),[hours,setHours]=useState(1)
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[checks,setChecks]=useState<{digest:string;fields:TaskChangeField[]}>({digest:'',fields:[]})
  const [mcpConfig,setMcpConfig]=useState<{scopeKey:string;root:string;json:string}|null>(null)
  const visible=view.scopeKey===scopeKey,prepared=visible?view.prepared:null,status=visible?view.status:null,entries=visible?view.entries:[],outcome=visible?view.outcome:null
  const decision=prepared?.changeSet?decideChangePolicy(prepared.changeSet,policy):null,checked=prepared&&checks.digest===prepared.digest?checks.fields:[]
  useEffect(()=>{
    if(!controller)return
    controller.clearAuthority()
    let active=true
    void controller.refresh().then(status=>{if(active)setView({scopeKey,status,entries:[],prepared:null,outcome:null})}).catch(error=>{if(active)setNotice(error instanceof Error?error.message:String(error))})
    return()=>{active=false;controller.clearAuthority()}
  },[controller,scopeKey])
  async function run(action:()=>Promise<void>) {if(busy)return;setBusy(true);setNotice('');try{await action()}catch(error){setNotice(error instanceof Error?error.message:String(error))}finally{setBusy(false)}}
  function replaceStatus(status:FileBridgeStatus) {setView({scopeKey,status,entries:[],prepared:null,outcome:null})}
  async function scan() {if(!controller)return;const scanned=await controller.scanInbox();setView({scopeKey,...scanned,prepared:null,outcome:null})}
  async function approve(event:Event) {
    if(!controller||!prepared)return
    const result=await controller.applyFromUI(prepared,event,checked)
    setView(previous=>({...previous,outcome:result}));onApplied?.(result.receipt)
    setNotice(result.resultPending?'変更は保存済みです。結果ファイルの書き出しを再試行してください。':'変更を保存し、結果ファイルを記録しました。')
  }
  return <section className="card" aria-label="ローカルエージェント接続">
    <h3>ローカルエージェント接続</h3>
    <p>選んだタスクをフォルダーで共有し、外部エージェントの作成・変更案をこの画面で確認できます。</p>
    {!controller?<p role="status">この環境ではローカル接続を利用できません。Windowsアプリで接続設定を開いてください。</p>:<>
      <p className="muted">外部クライアントがこのフォルダーを読み書きする設定は、利用するクライアント側で行います。外部サービスへの実接続は、この画面での登録だけでは完了しません。</p>
      {!settings.aiEnabled||!policy.aiChangesEnabled?<p role="status">AIによる変更は停止しています。タスクの手動編集は利用できます。</p>:null}
      {settings.aiEnabled?<button type="button" className="secondary-button" disabled={busy} onClick={event=>{const native=event.nativeEvent;void run(async()=>{if(!(native instanceof Event)||!native.isTrusted||native.type!=='click')throw new Error('本人の停止ボタンから操作してください。');await updateAIConnection(false);setNotice('AI処理を停止し、外部コーチの接続許可を取り消しました。')})}}>AIと外部コーチを停止</button>:null}
      {!settings.aiEnabled?<div><p>このフォルダー接続はOpenRouterのAPIキーなしで利用できます。共有する内容と変更案は、この画面で本人が選んで確認します。OpenRouterへの送信は、キーを設定して個別のAI操作を選んだ場合に行います。</p><button type="button" className="secondary-button" disabled={busy} onClick={event=>{const native=event.nativeEvent;void run(async()=>{if(!(native instanceof Event)||!native.isTrusted||native.type!=='click')throw new Error('本人の有効化ボタンから操作してください。');await updateAIConnection(true);setNotice('AI処理を有効にしました。共有する項目とタスクを選んで接続してください。')})}}>外部コーチ用にAI処理を有効にする</button></div>:null}
      <details open={!status?.connected}><summary>共有する項目とタスク</summary>
        <p>選択した内容をフォルダーへ書き出します。このフォルダーを渡す相手は内容を読めます。</p>
        <label className="field"><span>利用するクライアント</span><select value={host} disabled={busy} onChange={event=>setHost(event.target.value as FileBridgeHost)}><option value="codex">Codex</option><option value="claude_code">Claude Code</option><option value="chatgpt">ChatGPT</option><option value="claude">Claude</option><option value="other">その他</option></select></label>
        <label className="field"><span>許可の有効時間</span><select value={hours} disabled={busy} onChange={event=>setHours(Number(event.target.value))}>{[1,4,12,24].map(value=><option key={value} value={value}>{value}時間</option>)}</select></label>
        <fieldset disabled={busy}><legend>共有する項目</legend>{(['title','notes','scheduled_date'] as FileBridgeField[]).map(field=><label key={field} className="field"><span><input type="checkbox" checked={fields.includes(field)} onChange={event=>setFields(event.target.checked?[...fields,field]:fields.filter(item=>item!==field))}/> {labels[field]}</span></label>)}</fieldset>
        <fieldset disabled={busy}><legend>共有するタスク（最大100件）</legend>{tasks.filter(task=>!task.deletedAt&&task.status==='open').map(task=><label key={task.id} className="field"><span><input type="checkbox" checked={taskIds.includes(task.id)} onChange={event=>setTaskIds(event.target.checked?[...taskIds,task.id]:taskIds.filter(id=>id!==task.id))}/> {task.title}</span></label>)}</fieldset>
        <p>変更案は毎回本人が承認します。新規作成では点数と締め切りを未設定にします。</p>
        <button type="button" data-file-bridge-configure="true" className="primary-button" disabled={busy||!fields.length||taskIds.length>100||!settings.aiEnabled||!policy.aiChangesEnabled} onClick={event=>{const native=event.nativeEvent;void run(async()=>replaceStatus(await controller.configure({intendedHost:host,taskIds,fields,lifetimeHours:hours},native)))}}>選択した範囲だけを許可して接続</button>
      </details>
      {status?.connected&&status.registration?<div>
        <h4>登録した接続</h4><p>{status.registration.client.intended_host} / {status.root}</p>
        <p>タスク{status.registration.task_ids.length}件、共有項目：{status.registration.client.grant.fields.map(field=>labels[field]).join('・')}。1日{status.registration.client.grant.max_operations_per_day}件まで、予定日の移動は{status.registration.client.grant.max_schedule_shift_days}日まで。</p>
        <p className="muted">有効期限：{new Date(status.registration.client.grant.expires_at).toLocaleString('ja-JP')}。接続版 {status.registration.client.revision} / 許可版 {status.registration.client.grant_epoch}</p>
        <div className="change-set-actions"><button type="button" data-file-bridge-export={status.registration.client.id} className="secondary-button" disabled={busy||!settings.aiEnabled} onClick={event=>{const native=event.nativeEvent;void run(async()=>replaceStatus(await controller.exportSnapshot(native)))}}>選択タスクの現在の内容を書き出す</button><button type="button" data-file-bridge-disconnect={status.registration.client.id} className="secondary-button" disabled={busy} onClick={event=>{const native=event.nativeEvent;void run(async()=>replaceStatus(await controller.disconnect(native)))}}>この接続の許可を取り消す</button></div>
        {status.snapshot?<p>確認用データ：{new Date(status.snapshot.generated_at).toLocaleString('ja-JP')}、{Object.keys(status.snapshot.entity_revisions).length}件。<small className="muted">識別子 {status.snapshot.snapshot_id} / 内容hash {status.snapshot.view_sha256.slice(0,12)}</small></p>:<p>現在のタスクを書き出してから、外部クライアントで案を作成してください。</p>}
        {connection?.mcpConfiguration&&status.snapshot?<details><summary>stdio対応MCPクライアントへ接続</summary><p>Codex・Claude Code等のローカルMCP設定に登録します。読み取りは選択した項目だけ、変更はこのアプリで毎回承認します。クライアントへの設定と起動は別操作です。ChatGPT等のクラウド接続・HTTPサーバーは未提供です。</p><button type="button" className="secondary-button" disabled={busy} onClick={()=>void run(async()=>setMcpConfig({scopeKey,root:status.root!,json:JSON.stringify(await connection.mcpConfiguration!(),null,2)}))}>この接続のMCP設定を表示</button>{mcpConfig?.scopeKey===scopeKey&&mcpConfig.root===status.root?<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{mcpConfig.json}</pre>:null}<p className="muted">外部ツールの結果ファイルは未検証コピーとして返します。実保存と署名の確認はアプリの結果欄で行ってください。既に共有したコピーは取消後も相手側に残ることがあります。</p></details>:null}
        <button type="button" className="secondary-button" disabled={busy||!status.snapshot} onClick={()=>void run(scan)}>受信箱と結果を更新</button>
      </div>:null}
      <p className="muted">{status?.notice}</p>
      {entries.length?<div><h4>受信した案</h4>{entries.map(entry=><article key={entry.filename}><strong>{entry.filename}</strong>{entry.state==='rejected'?<p>受付拒否：{entry.error}</p>:entry.state==='finished'?<p>{entry.result.state==='applied'?'保存結果を確認済み':entry.result.state==='unknown'?'結果未確定。再実行せず保存履歴を確認してください。':'実行失敗'}</p>:<div><p>{entry.prepared.command.type==='task.create'?'タスクの新規作成':'既存タスクのメモ・予定日変更'} / 本人の承認待ち</p><button type="button" className="secondary-button" disabled={busy||Boolean(outcome)} onClick={()=>void run(async()=>{const proposal=await controller.prepare(entry.reference);setView(previous=>({...previous,prepared:proposal,outcome:null}))})}>内容を確認</button></div>}</article>)}</div>:null}
      {prepared?<section className="change-set-preview" aria-label="外部コマンドの本人確認"><h4>今回だけ許可する内容</h4>
        {prepared.changeSet?prepared.changeSet.changes.map(change=><article className="change-set-task" key={change.taskId}><h4>{change.title}</h4><small>対象の版 {change.baseRevision}</small>{change.fields.map(field=><div className="change-set-comparison" key={field}><strong>{changeLabels[field]}</strong><div><small>変更前</small><p style={{whiteSpace:'pre-wrap'}}>{change.before[field]??'未設定'}</p></div><div><small>変更後</small><p style={{whiteSpace:'pre-wrap'}}>{change.after[field]??'未設定'}</p></div></div>)}</article>):prepared.assisted?.inputs.map((input,index)=><article key={index}><h4>{input.title}</h4><p style={{whiteSpace:'pre-wrap'}}>{input.notes}</p><p>予定日：{input.scheduledDate??'未設定'} / 点数：未設定 / 締め切り：未設定</p></article>)}
        <p className="muted">接続 {prepared.registration.client.intended_host}。確認期限 {new Date(prepared.entry.prepared.expiresAt).toLocaleString('ja-JP')}。変更内容 {prepared.digest.slice(0,12)}</p>
        {decision?.protectedFields.map(field=><label className="field" key={field}><span><input type="checkbox" checked={checked.includes(field)} disabled={busy||Boolean(outcome)} onChange={event=>setChecks({digest:prepared.digest,fields:event.target.checked?[...checked,field]:checked.filter(item=>item!==field)})}/> {changeLabels[field]}の保護を確認し、今回だけ許可する</span></label>)}
        {!outcome?<button type="button" data-file-bridge-approve={prepared.reference} className="primary-button" disabled={busy||decision?.status==='denied'||decision?.protectedFields.some(field=>!checked.includes(field))||!settings.aiEnabled} onClick={event=>{const native=event.nativeEvent;void run(()=>approve(native))}}>この内容だけを承認して保存</button>:outcome.resultPending?<button type="button" className="secondary-button" disabled={busy} onClick={event=>{const native=event.nativeEvent;void run(async()=>{const result=await controller.retryResultFromUI(prepared,native);setView(previous=>({...previous,outcome:result}));setNotice(result.resultPending?'変更は保存済みです。結果ファイルは未確認です。':'結果ファイルを記録しました。')})}}>保存済み結果の書き出しを再試行</button>:<p>保存と結果ファイルの記録を確認しました。</p>}
      </section>:null}
      {status?.results.length?<details><summary>結果ファイル（{status.results.length}件）</summary>{status.results.map(result=><p key={result.command_id}>{result.command_id}：{result.state==='applied'?'保存を確認済み':result.state==='unknown'?'結果未確定':'失敗'}</p>)}</details>:null}
    </>}
    <p role="status">{notice||(!controller?'接続機能は未接続です。':busy?'確認しています…':'')}</p>
  </section>
}
