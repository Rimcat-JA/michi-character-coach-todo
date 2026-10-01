import type { FileBridgeWindow } from './file-bridge-types'
import type { LocalActionWindow } from './local-action-types'
import type { GitHubAchievementsGateway } from './github-publish-types'

export type ConnectionKind = 'fileBridge' | 'localActions' | 'github'
type ConnectionWindow = { michiFileBridge?: { invalidate(): Promise<void> }; michiLocalActions?: { invalidate(): Promise<void> }; michiGitHubAchievements?: { invalidate(): Promise<void> } }
const gatewayKey: Record<ConnectionKind, keyof ConnectionWindow> = { fileBridge: 'michiFileBridge', localActions: 'michiLocalActions', github: 'michiGitHubAchievements' }
const host = (): ConnectionWindow | null => typeof window === 'undefined' ? null : window as unknown as ConnectionWindow & FileBridgeWindow & LocalActionWindow & { michiGitHubAchievements?: GitHubAchievementsGateway }

/** Permission reduction is allowed without a new human approval. */
export async function invalidateExternalConnection(): Promise<void> {
  const current = host()
  if (!current) return
  const results = await Promise.allSettled((['fileBridge', 'localActions', 'github'] as const).map(kind => Promise.resolve().then(() => current[gatewayKey[kind]]?.invalidate())))
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, '外部接続の取消中にエラーが発生しました。接続状態を確認してください')
}
/** Stops one connection only: no policy epoch bump, so the other connections and the AI switch stay valid. */
export async function stopConnection(kind: ConnectionKind, current: ConnectionWindow | null = host()): Promise<'stopped' | 'not_available'> {
  if (!Object.hasOwn(gatewayKey, kind)) throw new Error('停止する接続を確認してください')
  const gateway = current?.[gatewayKey[kind]]
  if (!gateway) return 'not_available'
  await gateway.invalidate()
  return 'stopped'
}
