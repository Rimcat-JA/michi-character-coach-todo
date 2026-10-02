import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import { changePolicyFor } from './change-set'
import { applyLocalAPICommand, prepareLocalAPICommand, discardLocalAPIPreview } from './local-api-client'
import type { Settings } from './domain'
import type { LocalAPIPending, LocalAPIStatus, LocalAPIWindow } from './local-api-types'
import LocalWebhookView from './LocalWebhookView'
import { noteReceivedCommands } from './command-bus'

export default function LocalAPIView({ settings, gateway }: { settings: Settings; gateway?: LocalAPIWindow }) {
  const p=changePolicyFor(settings)
  return <><LocalAPIViewCard key={`${settings.profileId}:${settings.datasetId}:${p.epoch}:${p.sourcePermissionRevision}`} settings={settings} gateway={gateway} /><LocalWebhookView settings={settings}/></>
}
function LocalAPIViewCard({ settings, gateway }: { settings: Settings; gateway?: LocalAPIWindow }) {
  const connection = gateway ?? (typeof window === 'undefined' ? undefined : window.michiLocalAPI)
  const policy = changePolicyFor(settings), scope = `${settings.profileId}:${settings.datasetId}:${policy.epoch}:${policy.sourcePermissionRevision}`
  const projects = useLiveQuery(() => db.containers.filter(row => row.ownerId === settings.profileId && row.kind === 'project' && !row.deletedAt).toArray(), [settings.profileId], [])
  const [status, setStatus] = useState<LocalAPIStatus | null>(null), [pending, setPending] = useState<LocalAPIPending[]>([])
  const [port, setPort] = useState('0'), [label, setLabel] = useState('ローカル連携'), [access, setAccess] = useState('readonly'), [project, setProject] = useState('')
  const [days, setDays] = useState('7'), [secret, setSecret] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof prepareLocalAPICommand>> | null>(null)
  async function refresh() {
    if (!connection) return
    const state = await connection.request({ action: 'status' }) as LocalAPIStatus
    const rows=await connection.request({ action: 'pending' }) as LocalAPIPending[]
    receive(rows);setStatus(state); setPort(String(state.port)); setPending(rows)
  }
  function receive(rows:LocalAPIPending[]){noteReceivedCommands('api',rows.map(row=>({commandId:row.command.command_id,entrance:'api',type:'task.create',targetId:null,expectedRevision:null,principalId:`localapi:${row.tokenId}`,host:'127.0.0.1',fields:['title','notes',...(row.command.payload.scheduled_date?['scheduledDate']:[])],expiresAt:row.expiresAt})))}
  useEffect(() => {
    let active = true
    if (connection) void Promise.all([connection.request({ action: 'status' }), connection.request({ action: 'pending' })]).then(([status, rows]) => {
      if (active) { receive(rows as LocalAPIPending[]);setStatus(status as LocalAPIStatus); setPort(String((status as LocalAPIStatus).port)); setPending(rows as LocalAPIPending[]) }
    }).catch(error => { if (active) setNotice(error instanceof Error ? error.message : String(error)) })
    return () => { active = false }
  }, [connection, scope])
  useEffect(() => () => { if (preview) discardLocalAPIPreview(preview) }, [preview])
  async function run(action: () => Promise<void>) {
    if (busy || !connection) return
    setBusy(true); setNotice('')
    try { await action() } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  return <section className="card setting-section" aria-label="このPC内のAPI">
    <h3>API・Webhook</h3><p>アプリ起動中・このPC内（127.0.0.1）のみ。Zapier等のクラウドから直接は届きません。新しいタスクはAPI受信箱で毎回確認します。</p>
    {!connection ? <p role="status">ローカルAPIはWindows版で利用できます。</p> : <>
      <p>API：{status?.running ? '起動中' : '停止中'} {status?.url ?? ''}</p>
      <label className="field"><span>ポート（0は自動選択）</span><input type="number" min="0" max="65535" value={port} disabled={busy || status?.running} onChange={event => setPort(event.target.value)} /></label>
      <button type="button" className="secondary-button" data-local-api-configure="server" disabled={busy} onClick={() => void run(async () => {
        setStatus(await connection.request({ action: 'configure', input: { enabled: !status?.running, port: Number(port) } }) as LocalAPIStatus)
        setNotice(status?.running ? 'APIを停止しました。' : 'このPC内のAPIを起動しました。')
      })}>{status?.running ? 'APIを停止' : 'このPC内のAPIを起動'}</button>
      <details><summary>期限付きトークンを発行</summary><p>秘密は発行時の一度だけ表示します。バックアップには入りません。権限や本人が変わると無効になります。</p>
        <label className="field"><span>接続名</span><input value={label} maxLength={100} onChange={event => setLabel(event.target.value)} /></label>
        <label className="field"><span>権限</span><select value={access} onChange={event => setAccess(event.target.value)}><option value="readonly">未完了タスクの読取のみ</option><option value="create">読取・新規作成の提案・結果読取</option></select></label>
        <label className="field"><span>対象プロジェクト</span><select value={project} onChange={event => setProject(event.target.value)}><option value="">全プロジェクト（作成先は未分類）</option>{projects.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
        <label className="field"><span>有効日数（最大90日）</span><input type="number" min="1" max="90" value={days} onChange={event => setDays(event.target.value)} /></label>
        <button type="button" className="secondary-button" data-local-api-configure="token" disabled={busy || !label.trim() || !Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 90} onClick={() => void run(async () => {
          const result = await connection.request({ action: 'issue', input: { label, scopes: access === 'readonly' ? ['tasks:read'] : ['tasks:read', 'tasks:create', 'commands:read'], project_ids: project ? [project] : [], expiresAt: new Date(Date.now() + Number(days) * 86400000).toISOString() } }) as { token: string }
          setSecret(result.token); await refresh(); setNotice('トークンを発行しました。秘密を確認したら表示を閉じてください。')
        })}>この権限と期限で発行</button>
      </details>
      {secret ? <div><label className="field"><span>今回だけ表示するトークン</span><textarea readOnly value={secret} /></label><button type="button" className="secondary-button" onClick={() => setSecret('')}>秘密の表示を閉じる</button></div> : null}
      {status?.tokens.map(token => <article key={token.tokenId}><strong>{token.label}</strong><p>{token.scopes.join(' / ')} / 有効期限 {new Date(token.expiresAt).toLocaleString('ja-JP')} / {token.revokedAt ? '取消済み' : '有効'}</p><p>最終利用：{token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString('ja-JP') : '未利用'}</p>{!token.revokedAt ? <button disabled={busy} type="button" onClick={() => void run(async () => { await connection.request({ action: 'revoke', input: { tokenId: token.tokenId } }); setPreview(null); await refresh(); setNotice('トークンと保留中の承認を取り消しました。') })}>このトークンを取り消す</button> : null}</article>)}
      <h4>API受信箱（{pending.length}件）</h4><p>承認前の提案は今日の負荷・ポイントに加算しません。</p>
      {pending.map(row => <article key={`${row.tokenId}:${row.command.command_id}`}><strong>{row.command.payload.title}</strong><p>接続：{row.label} / 期限 {new Date(row.expiresAt).toLocaleString('ja-JP')}</p><button type="button" className="secondary-button" disabled={busy || !settings.aiEnabled || !policy.aiChangesEnabled} onClick={() => void run(async () => { setPreview(await prepareLocalAPICommand(row)); setNotice('内容を確認してください。まだ登録していません。') })}>作成する内容を確認</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void run(async () => { await connection.request({ action: 'reject', input: { tokenId: row.tokenId, commandId: row.command.command_id, digest: row.digest } }); setPreview(null); await refresh(); setNotice('作成提案を拒否しました。') })}>拒否</button></article>)}
      {preview ? <article aria-label="API作成の確認"><h4>{preview.row.command.payload.title}</h4><p style={{ whiteSpace: 'pre-wrap' }}>{preview.row.command.payload.notes || 'メモなし'}</p><p>予定日：{preview.row.command.payload.scheduled_date ?? '未設定'} / 点数・本当の締め切り：未設定</p><button type="button" className="secondary-button" data-local-api-approve={preview.row.command.command_id} disabled={busy || !settings.aiEnabled || !policy.aiChangesEnabled} onClick={event => { const native = event.nativeEvent; void run(async () => { const result = await applyLocalAPICommand(preview, native, connection); setPreview(null); await refresh(); setNotice(result.resultPending ? 'タスクを1件保存しました。API結果は受信箱の更新で再確認してください。' : 'タスクを1件保存しました。ポイント台帳は変更していません。') }) }}>この内容だけを承認して作成</button><button type="button" className="secondary-button" disabled={busy} onClick={() => setPreview(null)}>確認を閉じる</button></article> : null}
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void run(async () => { setPreview(null); await refresh(); setNotice('APIと受信箱を更新しました。') })}>APIと受信箱を更新</button>
    </>}
    <p role="status">{notice || (busy ? '確認しています…' : '')}</p>
  </section>
}
