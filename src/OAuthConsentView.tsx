import { useEffect, useState } from 'react'
import { externalAIFor } from './external-authority'
import type { Settings } from './domain'

type OAuthPending = { id: string; clientId: string; redirectUri: string; expiresAt: number }
type OAuthClient = { clientId: string; label: string; redirectPaths: string[]; createdAt: string; active: boolean; intendedHost: string | null }
type OAuthStatus = { enabled: boolean; endpoint: string | null; pending: OAuthPending[]; clients: OAuthClient[] }
type OAuthGateway = {
  status: () => Promise<OAuthStatus>
  setEnabled: (enabled: boolean) => Promise<unknown>
  register: (request: { clientId: string }) => Promise<unknown>
  unregister: (request: { clientId: string }) => Promise<unknown>
  consent: (request: { pendingId: string; allow: boolean }) => Promise<unknown>
  onConsentRequested: (callback: (value: unknown) => void) => () => void
}

/** S26 owner consent: opt-in loopback HTTP/OAuth. Tokens never leave the encrypted store as raw values. */
export default function OAuthConsentView({ settings }: { settings: Settings }) {
  const external = externalAIFor(settings)
  const gateway = (window as Window & { michiOAuth?: OAuthGateway }).michiOAuth
  const [status, setStatus] = useState<OAuthStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  async function refresh() {
    if (!gateway) return
    try { setStatus(await gateway.status()) } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }
  useEffect(() => {
    if (!gateway) return
    void refresh()
    const stop = gateway.onConsentRequested(() => { void refresh() })
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => { stop(); clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.profileId, settings.datasetId])
  async function run(action: () => Promise<unknown>, done: string) {
    if (busy) return
    setBusy(true)
    setNotice('')
    try { await action(); await refresh(); setNotice(done) } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  if (!gateway) return null
  const grantOf = (clientId: string) => external.clients.find((row) => row.registration.client.id === clientId)?.registration.client.grant
  return (
    <section className="card" aria-label="PC接続（HTTP・ループバック）">
      <h3>PC接続（HTTP・ループバック）</h3>
      <p>このPC上（127.0.0.1）だけでOAuthとMCPを受け付けます。既定OFF、事前登録した接続だけ、公開や外部hostへの到達はありません。</p>
      <button type="button" data-oauth-enable="" className="secondary-button" disabled={busy} onClick={() => void run(() => gateway.setEnabled(!status?.enabled), status?.enabled ? 'ループバック接続を停止しました。' : 'ループバック接続を開始しました。')}>{status?.enabled ? 'ループバック接続を停止' : 'ループバック接続を開始'}</button>
      {status?.endpoint ? <p>受付中：{status.endpoint}（このPCからのみ）</p> : null}
      <div>
        <h4>事前登録する接続</h4>
        {external.clients.filter((row) => row.status === 'active').map((row) => {
          const id = row.registration.client.id
          const registered = status?.clients.some((item) => item.clientId === id)
          return (
            <article key={id}>
              <p>{row.registration.client.intended_host} / {id.slice(0, 8)}</p>
              {registered
                ? <button type="button" data-oauth-register={id} className="secondary-button" disabled={busy} onClick={() => void run(() => gateway.unregister({ clientId: id }), '事前登録を取り消しました。')}>事前登録を取消</button>
                : <button type="button" data-oauth-register={id} className="secondary-button" disabled={busy} onClick={() => void run(() => gateway.register({ clientId: id }), '事前登録しました。')}>この接続を事前登録</button>}
            </article>
          )
        })}
      </div>
      {status && status.pending.length ? (
        <div>
          <h4>承認待ちの接続要求</h4>
          {status.pending.map((item) => {
            const grant = grantOf(item.clientId)
            return (
              <article key={item.id}>
                <p>未確認のクライアント（{item.clientId.slice(0, 8)}）が接続を求めています。</p>
                <p>戻り先：{item.redirectUri}</p>
                {grant ? <p>許可範囲：{grant.keys.join('・')}／項目：{grant.fields.join('・')}／1日{grant.max_operations_per_day}件</p> : <p>許可範囲を確認できません。</p>}
                <button type="button" data-oauth-allow={item.id} className="primary-button" disabled={busy} onClick={() => void run(() => gateway.consent({ pendingId: item.id, allow: true }), '接続を承認しました。')}>承認する</button>
                <button type="button" data-oauth-deny={item.id} className="secondary-button" disabled={busy} onClick={() => void run(() => gateway.consent({ pendingId: item.id, allow: false }), '接続を拒否しました。')}>拒否する</button>
              </article>
            )
          })}
        </div>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  )
}
