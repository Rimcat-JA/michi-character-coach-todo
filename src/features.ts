import { NAV_FEATURE_IDS, type NavigationId } from './navigation'
import { db } from './db'

/** In-screen capabilities that can be hidden without stopping their data, connections or background work. */
export const PANEL_FEATURE_IDS = ['voice', 'avatar', 'achievements', 'localActions', 'fileBridge', 'captureImport', 'externalImport'] as const
export type PanelFeatureId = typeof PANEL_FEATURE_IDS[number]
export type FeatureId = Exclude<NavigationId, 'settings'> | PanelFeatureId
export const OPTIONAL_FEATURE_IDS: FeatureId[] = [...NAV_FEATURE_IDS.filter((id): id is Exclude<NavigationId, 'settings'> => id !== 'settings'), ...PANEL_FEATURE_IDS]
export const FEATURE_REGISTRY: Record<PanelFeatureId, { label: string; screen: string; keptWhileHidden: string }> = {
  voice: { label: '音声と音楽', screen: 'コーチ・設定', keptWhileHidden: '再生中の音楽・読み上げは「音声と音楽を停止」を押すまで続きます。会話と下書きは残ります。' },
  avatar: { label: 'キャラクター表示', screen: 'コーチ', keptWhileHidden: 'テキストの会話・タスク操作はそのまま使えます。' },
  achievements: { label: 'GitHub実績', screen: '実績', keptWhileHidden: '証拠・下書き・公開記録とGitHub接続は残ります。接続の停止は個別停止で行います。' },
  localActions: { label: 'PC操作', screen: '設定', keptWhileHidden: '登録済みの操作と実行履歴は残ります。登録の取消は個別停止で行います。' },
  fileBridge: { label: 'ファイル接続/MCP', screen: '設定', keptWhileHidden: '接続・権限・受信箱のファイルは残ります。接続の停止は個別停止で行います。' },
  captureImport: { label: 'Web引用・メール取込', screen: 'ノートと記録', keptWhileHidden: '保存済みの資料は残ります。取込前の確認中の内容は破棄されます。' },
  externalImport: { label: '外部メッセージ取込', screen: 'ノートと記録', keptWhileHidden: '保存済みの資料は残ります。取込前の確認中の内容は破棄されます。' },
}
const hideHooks = new Map<FeatureId, Set<() => void>>()
/** Registers an in-memory authority to revoke when the feature is hidden; showing it again never replays old proposals. */
export function onFeatureHidden(id: FeatureId, revoke: () => void): () => void {
  const hooks = hideHooks.get(id) ?? new Set<() => void>(); hooks.add(revoke); hideHooks.set(id, hooks)
  return () => { hooks.delete(revoke) }
}
/** Runs the revoke hooks of features that just became hidden (individual toggle or workflow preset). */
export function revokeHiddenFeatureAuthority(ids: readonly string[]) {
  for (const id of new Set(ids)) for (const revoke of [...hideHooks.get(id as FeatureId) ?? []]) revoke()
}
export function featureEnabled(hidden: string[] | undefined, id: string): boolean {
  return id === 'settings' || !hidden?.includes(id)
}
/** Display only: never stops audio, invalidates a connection, changes AI/policy or deletes data. */
export async function setFeatureVisible(id: FeatureId, visible: boolean): Promise<void> {
  if (!OPTIONAL_FEATURE_IDS.includes(id)) throw new Error('この機能は非表示にできません')
  if (typeof visible !== 'boolean') throw new Error('表示の指定が不正です')
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('設定がありません')
    const current = settings.hiddenFeatures ?? []
    const hiddenFeatures = visible ? current.filter(value => value !== id) : [...new Set([...current, id])]
    await db.settings.put({ ...settings, hiddenFeatures })
  })
  if (!visible) revokeHiddenFeatureAuthority([id])
}
