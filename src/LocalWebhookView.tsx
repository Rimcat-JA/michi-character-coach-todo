import { useCallback, useEffect, useState } from 'react'
import { db } from './db'
import { changePolicyFor } from './change-set'
import { operationMode } from './automation-policy'
import type { Settings } from './domain'
import type { WebhookEvent, WebhookGateway, WebhookStatus, WebhookSubscription } from './webhook-types'
const events: WebhookEvent[] = ['task.created','task.completed','task.reopened']
export default function LocalWebhookView({ settings, gateway }: { settings: Settings; gateway?: WebhookGateway }) {
  const connection = gateway ?? (typeof window === 'undefined' ? undefined : window.michiWebhooks), p = changePolicyFor(settings)
  return <WebhookCard key={`${settings.profileId}:${settings.datasetId}:${p.epoch}:${p.sourcePermissionRevision}:${settings.aiEnabled}`} settings={settings} connection={connection}/>
}
function WebhookCard({settings,connection}:{settings:Settings;connection?:WebhookGateway}) {
  const [status,setStatus]=useState<WebhookStatus|null>(null), [url,setURL]=useState(''), [selected,setSelected]=useState<WebhookEvent[]>(['task.completed','task.reopened']), [includeTitle,setIncludeTitle]=useState(false), [loopback,setLoopback]=useState(false), [confirmed,setConfirmed]=useState(false), [secret,setSecret]=useState(''), [busy,setBusy]=useState(false), [notice,setNotice]=useState('')
  const policy=changePolicyFor(settings), allowed=settings.aiEnabled&&policy.aiChangesEnabled&&operationMode(policy,'external.write')!=='deny'
  const refresh = useCallback(async () => {
    if (!connection) return
    const value=await connection.request({action:'status'}) as WebhookStatus
    const active=value.subscriptions.filter(s=>!s.revokedAt&&s.ownerId===settings.profileId&&s.datasetId===settings.datasetId&&s.policyEpoch===policy.epoch&&s.sourcePermissionRevision===policy.sourcePermissionRevision)
    await db.transaction('rw',db.settings,db.integrationSettings,db.integrationOutbox,async()=>{
      const current=await db.settings.get('main'),p=current?changePolicyFor(current):null
      if(!current||!p||current.profileId!==settings.profileId||current.datasetId!==settings.datasetId||p.epoch!==policy.epoch||p.sourcePermissionRevision!==policy.sourcePermissionRevision)return
      await db.integrationSettings.put({id:'main',ownerId:settings.profileId,datasetId:settings.datasetId,policyEpoch:policy.epoch,sourcePermissionRevision:policy.sourcePermissionRevision,subscriptions:active.map(({id,events,includeTitle,createdAt})=>({id,events,includeTitle,createdAt}))})
      const settled=new Set(value.settledEventIds)
      await db.integrationOutbox.where('at').below(new Date(Date.now()-7*86400000).toISOString()).filter(row=>settled.has(row.id)).delete()
      setStatus(value)
    })
  },[connection,settings.profileId,settings.datasetId,policy.epoch,policy.sourcePermissionRevision])
  useEffect(()=>{let active=true;const update=()=>{if(active)void refresh().catch(e=>{if(active)setNotice(e instanceof Error?e.message:String(e))})};update();const timer=setInterval(update,5000);return()=>{active=false;clearInterval(timer)}},[refresh])
  async function run(action:()=>Promise<void>){if(busy||!connection)return;setBusy(true);setNotice('');try{await action();await refresh()}catch(e){setNotice(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
  const changed=()=>setConfirmed(false)
  return <section className="card setting-section" aria-label="署名Webhook"><h3>署名Webhook</h3><p>登録したイベントのID・日時・ポイントだけを、確認した受信先へ送ります。メモや引用本文は送りません。通信の許可が「オフライン専用」の間は送信しません。</p>
    {!connection?<p>WebhookはWindows版で利用できます。</p>:<>
      <details><summary>送信先を登録</summary><label className="field"><span>受信先URL（HTTPS）</span><input value={url} disabled={busy} onChange={e=>{setURL(e.target.value);changed()}}/></label>
        <label><input type="checkbox" checked={loopback} onChange={e=>{setLoopback(e.target.checked);changed()}}/>このPC内の受信先（検証用、HTTPの127.0.0.1/localhostのみ）</label>
        <fieldset><legend>送信するイベント</legend>{events.map(event=><label key={event}><input type="checkbox" checked={selected.includes(event)} onChange={e=>{setSelected(old=>e.target.checked?[...old,event]:old.filter(item=>item!==event));changed()}}/>{event}</label>)}</fieldset>
        <label><input type="checkbox" checked={includeTitle} onChange={e=>{setIncludeTitle(e.target.checked);changed()}}/>この送信先にはタスクのタイトルも公開する</label>
        {!confirmed?<button type="button" className="secondary-button" disabled={busy||!url||!selected.length||!allowed} onClick={()=>setConfirmed(true)}>送信先と公開項目を確認</button>:<div><p>送信先：{url}</p><p>イベント：{selected.join(' / ')}</p><p>公開項目：ID・日時・ポイント{includeTitle?'・タイトル':''}。以後この条件のイベントだけを送信します。停止すると未送信分も取り消します。</p><button type="button" className="primary-button" data-webhook-configure="add" disabled={busy||!allowed} onClick={()=>void run(async()=>{const value=await connection.request({action:'add',input:{url,events:selected,includeTitle,loopback}}) as {subscription:WebhookSubscription;secret:string};setSecret(value.secret);setConfirmed(false);setNotice('送信先を登録しました。秘密はこの画面で一度だけ表示します。')})}>この送信先と公開項目だけを許可</button></div>}
      </details>
      {secret?<div><label className="field"><span>受信サーバー用の秘密（hex、再表示できません）</span><textarea readOnly value={secret}/></label><button type="button" className="secondary-button" onClick={()=>setSecret('')}>秘密の表示を閉じる</button></div>:null}
      {status?.subscriptions.map(sub=><article key={sub.id}><strong>{sub.revokedAt?'取消済み':sub.policyEpoch===policy.epoch&&sub.sourcePermissionRevision===policy.sourcePermissionRevision&&allowed?'登録中':'権限変更で停止'}：{sub.url}</strong><p>{sub.events.join(' / ')} / {sub.includeTitle?'タイトル公開あり':'タイトル非公開'}</p>{!sub.revokedAt?<div><button type="button" className="secondary-button" data-webhook-configure={`test:${sub.id}`} disabled={busy||!allowed} onClick={()=>void run(async()=>{await connection.request({action:'test',input:{id:sub.id}});setNotice('署名付きpingの結果を履歴に記録しました。')})}>署名付きpingで一度試験</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{await connection.request({action:'revoke',input:{id:sub.id}});setNotice('この送信先を停止しました。')})}>この送信先を停止</button></div>:null}</article>)}
      <button type="button" className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{await connection.invalidate();setSecret('');setNotice('Webhookをすべて停止しました。')})}>Webhookをすべて停止</button>
      <details><summary>配送履歴（{status?.deliveries.length??0}件）</summary>{status?.deliveries.map(d=><p key={d.id}>{d.event} / {d.state} / 送信 {d.attempts}回 / {d.httpStatus??d.error??''} / {new Date(d.updatedAt).toLocaleString('ja-JP')}</p>)}</details><p className="muted">{status?.notice}</p>
    </>}<p role="status">{notice||(busy?'確認しています…':'')}</p>
  </section>
}
