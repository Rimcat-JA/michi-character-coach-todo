import { useEffect, useState } from 'react'
import type { Settings } from './domain'
import type { AIStatus } from './ai'
import { featureEnabled, FEATURE_REGISTRY, type PanelFeatureId } from './features'
import { stopConnection, type ConnectionKind } from './external-connection'
import { reduceAuthority } from './automation-control'
import { changePolicyFor } from './change-set'
import type { FileBridgeGateway, FileBridgeStatus } from './file-bridge-types'
import type { LocalActionGateway, LocalActionStatus } from './local-action-types'
import type { GitHubAchievementsGateway } from './github-publish-types'
import { getBrowserVoiceMediaController, type VoiceMediaController, type VoiceMediaState } from './voice-media'
import { loadConnectionStatus, runRowStop, stopAIProcessingRow, UNPROVIDED_CONNECTIONS, type RowStopState } from './feature-connections'

export type ConnectionGateways = { fileBridge?: FileBridgeGateway; localActions?: LocalActionGateway; github?: GitHubAchievementsGateway }
type Row = { id: string; label: string; display: string; data: string; authority: string; background: string; stop: ((event: Event) => Promise<RowStopState>) | null; feature: PanelFeatureId | null; stopLabel?: string; note?: string }
function nativeClick(event: Event) { return event instanceof Event && event.isTrusted && event.type === 'click' }
const stateLabel: Record<RowStopState, string> = { stopped: '停止しました', unconfirmed: '停止未確認（接続状態を確認してください）', not_available: 'この環境には接続がありません' }
export function ConnectionStopButton({ kind, gateways, label = 'この接続だけ停止' }: { kind: ConnectionKind; gateways?: ConnectionGateways; label?: string }) {
  const [state, setState] = useState<RowStopState | 'refused' | null>(null)
  const host = gateways ? { michiFileBridge: gateways.fileBridge, michiLocalActions: gateways.localActions, michiGitHubAchievements: gateways.github } : undefined
  return <><button type="button" className="secondary-button" onClick={event => { const native = event.nativeEvent; if (!nativeClick(native)) { setState('refused'); return } void runRowStop(() => stopConnection(kind, host)).then(setState) }}>{label}</button>{state && <small role="status">{state === 'refused' ? '本人の停止ボタンから操作してください' : stateLabel[state]}</small>}</>
}
export default function FeatureConnectionsView({ settings, taskCount, gateways, voice, aiStatus }: { settings: Settings; taskCount: number; gateways?: ConnectionGateways; voice?: VoiceMediaController; aiStatus?: AIStatus | null }) {
  const host = typeof window === 'undefined' ? undefined : window as unknown as { michiFileBridge?: FileBridgeGateway; michiLocalActions?: LocalActionGateway; michiGitHubAchievements?: GitHubAchievementsGateway; michiAI?: { status(): Promise<AIStatus> } }
  const fileBridge = gateways ? gateways.fileBridge : host?.michiFileBridge, localActions = gateways ? gateways.localActions : host?.michiLocalActions, github = gateways ? gateways.github : host?.michiGitHubAchievements
  const [bridge, setBridge] = useState<FileBridgeStatus | null>(null), [actions, setActions] = useState<LocalActionStatus | null>(null), [githubState, setGithubState] = useState(''), [ai, setAi] = useState<AIStatus | null>(aiStatus ?? null)
  const [media, setMedia] = useState<VoiceMediaState | null>(() => voice?.snapshot() ?? null), [results, setResults] = useState<Record<string, RowStopState | 'refused'>>({}), [refresh, setRefresh] = useState(0)
  const policy = changePolicyFor(settings), hidden = settings.hiddenFeatures
  useEffect(() => {
    let alive = true
    void loadConnectionStatus({ fileBridge, localActions }).then(([bridgeResult, actionsResult]) => { if (!alive) return; setBridge(bridgeResult.status === 'fulfilled' ? bridgeResult.value ?? null : null); setActions(actionsResult.status === 'fulfilled' ? actionsResult.value ?? null : null) })
    if (!aiStatus) void host?.michiAI?.status().then(value => { if (alive) setAi(value) }).catch(() => undefined)
    return () => { alive = false }
  }, [fileBridge, localActions, aiStatus, host, refresh])
  useEffect(() => { const controller = voice ?? (typeof window === 'undefined' ? null : getBrowserVoiceMediaController()); return controller?.subscribe(setMedia) }, [voice])
  const shown = (id: PanelFeatureId) => featureEnabled(hidden, id) ? '表示' : '非表示（データ・接続は維持）'
  const playing = media && (media.speech !== 'idle' || media.music === 'playing' || ['permission', 'recording', 'transcribing'].includes(media.input))
  const connectionHost = gateways ? { michiFileBridge: gateways.fileBridge, michiLocalActions: gateways.localActions, michiGitHubAchievements: gateways.github } : undefined
  const rows: Row[] = [
    { id: 'ai', label: 'OpenRouter AI', feature: null, display: featureEnabled(hidden, 'coach') ? 'コーチ画面に表示' : 'コーチ画面は非表示', data: ai?.configured ? 'APIキー保存済み（Windowsの暗号化保存・バックアップ対象外）' : 'APIキーなし', authority: settings.aiEnabled ? `ON（${settings.aiModel ?? 'モデル未設定'}）` : 'OFF', background: 'なし（本人が送信したときだけ）', stop: settings.aiEnabled ? stopAIProcessingRow : null, stopLabel: 'AI処理を停止（他の接続も取り消し）', note: 'AIを止めると、ファイル接続/MCP・PC操作・GitHubの接続も取り消され、未確定の変更案は無効になります（登録済みのPC操作は再開後に再登録が必要です）。' },
    { id: 'fileBridge', label: FEATURE_REGISTRY.fileBridge.label, feature: 'fileBridge', display: shown('fileBridge'), data: bridge?.registration ? `選択タスク ${bridge.registration.task_ids.length}件・結果 ${bridge.results.length}件` : '接続なし', authority: !fileBridge ? 'この環境では未提供' : bridge?.connected ? bridge.registration?.client.grant.mutation_mode === 'auto_within_bounds' ? `接続中・範囲内自動を委任（${bridge.registration.client.grant.automation?.max_schedule_shift_days}日以内・1日${bridge.registration.client.grant.automation?.max_operations_per_day}件）` : '接続中・毎回本人承認' : '未接続', background: 'なし（受信箱の確認時だけ処理）', stop: fileBridge ? async () => runRowStop(() => stopConnection('fileBridge', connectionHost)) : null },
    { id: 'localActions', label: FEATURE_REGISTRY.localActions.label, feature: 'localActions', display: shown('localActions'), data: actions ? `登録 ${actions.definitions.length}件・実行結果 ${actions.results.length}件` : '登録なし', authority: !localActions ? 'この環境では未提供' : actions?.enabled ? '有効・毎回本人のクリックで実行' : '停止', background: 'なし（自動triggerは未実装）', stop: localActions ? async () => runRowStop(() => stopConnection('localActions', connectionHost)) : null },
    { id: 'github', label: FEATURE_REGISTRY.achievements.label, feature: 'achievements', display: shown('achievements'), data: '証拠・公開記録はこの端末に保存', authority: !github ? 'この環境では未提供' : githubState ? `状態: ${githubState}` : '未確認（確認するとGitHubに接続します）', background: 'アプリ表示中に結果不明の公開だけ照合（新規送信なし）。状態確認はGitHubに接続します', stop: github ? async () => runRowStop(() => stopConnection('github', connectionHost)) : null },
    { id: 'notifications', label: '通知・Bug Me', feature: null, display: '設定・今日の画面', data: `予約 ${settings.reminderState?.rules.length ?? 0}件・タスク ${taskCount}件は通知停止でも残ります`, authority: settings.notifications ? 'OS通知を許可' : 'アプリ内のみ', background: policy.stops?.notifications ? '停止中' : 'アプリ表示中に1分ごとに確認', stop: policy.stops?.notifications ? null : async () => runRowStop(() => reduceAuthority('notifications', 'connections')) },
    { id: 'voice', label: FEATURE_REGISTRY.voice.label, feature: 'voice', display: shown('voice'), data: '音源・録音は保存しません（起動中のみ）', authority: 'マイクは本人の開始操作のときだけ', background: playing ? '動作中' : '停止中', stop: async () => runRowStop(async () => { (voice ?? getBrowserVoiceMediaController()).stopAll() }) },
  ]
  return <section className="card setting-section connection-settings" aria-label="接続とバックグラウンド">
    <h2>接続とバックグラウンド</h2>
    <p className="muted">機能ごとに、表示・保存データ・権限と接続・バックグラウンド処理を分けて表示します。個別停止はその接続だけを止め、他の接続は変えません。OpenRouter AIの停止はAI処理停止と同じで、epochを進め、ファイル接続/MCP・PC操作・GitHubの接続も取り消します（再開時は再設定が必要）。</p>
    <div className="connection-rows">{rows.map(row => <article key={row.id} className="connection-row"><h3>{row.label}</h3><dl><dt>表示</dt><dd>{row.display}</dd><dt>保存データ</dt><dd>{row.data}</dd><dt>権限・接続</dt><dd>{row.authority}</dd><dt>バックグラウンド</dt><dd>{row.background}</dd></dl>{row.stop && <button type="button" className="secondary-button" onClick={event => { const native = event.nativeEvent; if (!nativeClick(native)) { setResults(current => ({ ...current, [row.id]: 'refused' })); return } void row.stop!(native).then(state => { setResults(current => ({ ...current, [row.id]: state })); setRefresh(value => value + 1) }) }}>{row.stopLabel ?? '個別停止'}</button>}{row.id === 'github' && github && <button type="button" className="secondary-button" onClick={event => { if (!nativeClick(event.nativeEvent)) return; void github.status().then(value => setGithubState(String((value as { state?: string }).state ?? '') || '不明')).catch(() => setGithubState('確認できませんでした')) }}>GitHubに接続して状態を確認</button>}{row.note && <p className="muted">{row.note}</p>}{results[row.id] && <small role="status">{results[row.id] === 'refused' ? '本人の停止ボタンから操作してください' : stateLabel[results[row.id] as RowStopState]}</small>}</article>)}
      {UNPROVIDED_CONNECTIONS.map(name => <article key={name} className="connection-row unprovided"><h3>{name}</h3><p>この版では未提供（接続・自動処理なし）</p></article>)}
    </div>
    <p className="muted">外部へ送信済みの依頼は、停止しても取り消せない場合があります。</p>
  </section>
}
