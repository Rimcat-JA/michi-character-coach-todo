import { CloudOff, ShieldCheck } from 'lucide-react'
import type { NetworkPolicy, Settings } from './domain'
import { capabilityLabel, capabilityRows, type CapabilityRow } from './capabilities'
import { networkPolicyLabel, setNetworkPolicy, type NetworkStatus } from './runtime-profile'
import { useCapabilityEnvironment } from './use-capabilities'

type Run = (fn: () => Promise<unknown>, success?: string) => Promise<boolean>
const purposeLabels = { openrouter: 'OpenRouter', github: 'GitHub', webhook: 'Webhook' } as const

export function CapabilityTable({ rows, electron }: { rows: CapabilityRow[]; electron: boolean }) {
  return <table className="capability-table"><thead><tr><th>機能</th><th>サーバーなし・通信なし</th><th>条件・動作</th></tr></thead><tbody>{rows.map(row => <tr key={row.id} data-capability={row.id}><td>{row.feature}</td><td><span className={`status-tag capability-${row.state}`}>{capabilityLabel(row.state, electron)}</span></td><td>{row.detail}</td></tr>)}</tbody></table>
}
export function NetworkCounters({ network }: { network: NetworkStatus | null }) {
  if (!network) return <p className="muted">通信の記録はWindowsデスクトップ版で表示します。ブラウザ版はこのアプリから外部AI・GitHubへ接続しません。</p>
  return <p className="muted" data-network-counters>このアプリの外部通信（今回の起動後）: {(Object.keys(purposeLabels) as (keyof typeof purposeLabels)[]).map(purpose => `${purposeLabels[purpose]} 送信${network.counters[purpose].attempts}回・設定で遮断${network.counters[purpose].blockedOffline}回`).join(' / ')}。OSや他のアプリの通信は対象外です。</p>
}

export default function CapabilityView({ settings, run }: { settings: Settings; run: Run }) {
  const { env } = useCapabilityEnvironment(settings), rows = capabilityRows(env)
  const choose = (policy: NetworkPolicy) => run(() => setNetworkPolicy(policy), policy === 'offline_only' ? 'オフライン専用にしました' : '必要な時だけ通信を許可しました')
  return <section className="card setting-section capability-view">
    <div className="setting-heading"><ShieldCheck size={20} /><div><h2>端末単独で使える機能</h2><p>この端末のデータが正本です。サーバー・アカウント・APIキーなしで使えます。{env.online ? '' : '現在ネットワークに接続していません。'}</p></div></div>
    <fieldset className="network-policy"><legend>通信の許可</legend>{(['offline_only', 'explicit_online'] as const).map(policy => <label key={policy}><input type="radio" name="network-policy" value={policy} checked={env.policy === policy} onChange={() => void choose(policy)} /> {networkPolicyLabel(policy)}</label>)}<small>どちらでもタスクの正本はこの端末です。サーバー接続（自分のPC・クラウド）はこの版では未提供です。</small></fieldset>
    <p className="muted">接続ごとの状態・今回の起動後の送信回数・個別停止は「接続とバックグラウンド」に表示します。</p>
    <CapabilityTable rows={rows} electron={env.electron} />
  </section>
}

/** S01-lite: shown until the owner picks. Nothing is required to start, and server modes are shown, not hidden. */
export function RuntimeChoiceCard({ run }: { run: Run }) {
  return <section className="card runtime-choice" aria-label="この端末での使い方">
    <div className="setting-heading"><CloudOff size={20} /><div><h2>この端末での使い方</h2><p>アカウント・APIキー・サーバーURLなしで、この端末だけで使えます。データはこの端末に保存されます。</p></div></div>
    <div className="export-buttons"><button className="primary-button" onClick={() => void run(() => setNetworkPolicy('offline_only'), 'この端末だけで始めます（オフライン専用）')}>この端末だけで始める</button><button className="secondary-button" onClick={() => void run(() => setNetworkPolicy('explicit_online'), 'この端末だけで始めます（必要な時だけ通信）')}>この端末だけで始め、必要な時だけ通信を許可</button><button className="secondary-button" disabled>自分のPCサーバーへ接続（未提供）</button><button className="secondary-button" disabled>クラウドへ接続（未提供）</button></div>
    <small className="muted">選ぶまではオフライン専用として扱います。あとから設定の「通信の許可」で変更できます。</small>
  </section>
}
