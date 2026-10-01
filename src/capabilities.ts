import type { NetworkPolicy } from './domain'

/** 18.3 capability table, computed for the running build. 'local' is ○ (works with no server and no network). */
export type CapabilityState = 'local' | 'conditional' | 'network' | 'unsupported'
export type CapabilityRow = { id: string; feature: string; state: CapabilityState; detail: string }
export type CapabilityEnvironment = { electron: boolean; policy: NetworkPolicy; online: boolean; aiKeyConfigured: boolean; aiEnabled: boolean; aiModel: boolean; notificationPermission: 'granted' | 'denied' | 'default' | 'unsupported' }

export function capabilityLabel(state: CapabilityState, electron: boolean): string {
  return state === 'local' ? '○' : state === 'conditional' ? '条件付き' : state === 'network' ? '通信が必要' : electron ? 'このPCでは未提供' : 'この環境では未提供'
}
/** The coach only treats live AI as usable when every condition holds; otherwise it says why. */
export function aiAvailability(env: Pick<CapabilityEnvironment, 'electron' | 'policy' | 'online' | 'aiKeyConfigured' | 'aiEnabled' | 'aiModel'>): { state: CapabilityState; ready: boolean; offline: boolean; detail: string } {
  if (!env.electron) return { state: 'unsupported', ready: false, offline: false, detail: 'ブラウザ版は外部AIへ接続しません。端末内の定型文で応答し、下書きは保存できます' }
  const configured = env.aiKeyConfigured && env.aiEnabled && env.aiModel
  if (!configured) return { state: 'conditional', ready: false, offline: false, detail: 'OpenRouterのキーとモデルが未設定、またはAIがOFFです。端末内の定型文で応答します' }
  if (env.policy === 'offline_only') return { state: 'network', ready: false, offline: true, detail: 'AIはオフラインのため利用できません（オフライン専用の設定）。入力は下書きとして保存できます' }
  if (!env.online) return { state: 'network', ready: false, offline: true, detail: 'AIはオフラインのため利用できません（ネットワーク未接続）。入力は下書きとして保存できます' }
  return { state: 'conditional', ready: true, offline: false, detail: '通信を許可済み・接続設定済み。送信前に送る内容を確認します' }
}
export function capabilityRows(env: CapabilityEnvironment): CapabilityRow[] {
  const ai = aiAvailability(env), online = env.policy === 'explicit_online'
  const notifications = `${env.electron ? 'アプリ起動中のみ判定します（WindowsのOS予約通知は未実装のため、終了中は通知しません）' : '開いている間だけ判定します。終了後の指定時刻通知は保証しません'}。${env.notificationPermission === 'denied' ? '通知が拒否されています。ToDoは通常どおり使えます' : '通知を拒否してもToDoは通常どおり使えます'}。確実な送達とは表示しません`
  return [
    { id: 'tasks', feature: 'タスク追加・編集・完了・取消・ゴミ箱', state: 'local', detail: 'この端末のDBで確定します。AIが作成した既存タスクも同じ経路で手動編集できます' },
    { id: 'points', feature: '手動ポイント・式・配分・完了履歴・集計', state: 'local', detail: 'ルールと実績を端末内で確定し、0ptと未設定を区別します' },
    { id: 'views', feature: 'プロジェクト・タグ・依存・Smart List・各ビュー', state: 'local', detail: '共通のローカルクエリと計画エンジンを使います' },
    { id: 'recurrence', feature: '繰り返し・営業日・授業・勤務・シフトの展開', state: 'local', detail: '本人登録・取込済みの根拠だけを展開します。最新の公式情報とは表示しません' },
    { id: 'tracking', feature: '時間計測・習慣・目標・レビュー・ノート', state: 'local', detail: 'タイマー終了でタスクを完了にしません' },
    { id: 'files', feature: 'ファイルの選択・保存・閲覧・手動タスク化', state: 'local', detail: 'ファイル本体が端末にある場合。リンクだけの資料は未取得と表示します' },
    { id: 'history', feature: 'コーチの過去会話・過去検出結果の閲覧', state: 'local', detail: '端末に保存したものだけ。新しいAI出力とは区別します' },
    { id: 'ai', feature: '新しいLLM会話・入力補助・タスク検出', state: ai.state, detail: ai.detail },
    { id: 'reminders', feature: 'コーチの見た目・固定文によるリマインダー', state: 'conditional', detail: notifications },
    { id: 'voice', feature: 'ローカル音声認識・読み上げ', state: 'conditional', detail: '端末内で処理できる認識エンジンと声がある場合だけ。クラウド音声は使いません' },
    { id: 'inbox', feature: 'Gmail/Slack/Teams/Outlook等の新着取得', state: 'unsupported', detail: '保存済み資料の閲覧と手動取込は使えます' },
    { id: 'publish', feature: 'GitHubへの投稿', state: !env.electron ? 'unsupported' : 'network', detail: !env.electron ? 'Windowsデスクトップ版だけで設定できます。下書き・証拠は保存できます' : online ? '本人の確認ボタンから送るときだけ通信します。下書き・証拠は保存でき、成功を捏造しません' : 'オフライン専用の設定のため送信しません。下書き・証拠は保存できます' },
    { id: 'messaging', feature: 'LINE等への送信', state: 'unsupported', detail: '送信機能はありません' },
    { id: 'sync', feature: 'PCとスマホの自動同期・リアルタイム共有', state: 'unsupported', detail: '各端末は独立しています。バックアップファイルで引き継げます' },
    { id: 'backup', feature: '手動エクスポート・バックアップ・復元', state: 'local', detail: 'ローカルファイルへ書き出します。クラウド保存は任意です' },
    { id: 'file-bridge', feature: 'PCでの許可済みファイルブリッジ', state: env.electron ? 'conditional' : 'unsupported', detail: env.electron ? 'アプリ稼働中または明示取込時だけ処理します。アプリDBへの直書きはできません' : 'Windowsデスクトップ版の機能です' },
  ]
}
