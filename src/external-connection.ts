import type { FileBridgeWindow } from './file-bridge-types'
import type { LocalActionWindow } from './local-action-types'

/** Permission reduction is allowed without a new human approval. */
export async function invalidateExternalConnection(): Promise<void> {
  if (typeof window === 'undefined') return
  const results = await Promise.allSettled([
    Promise.resolve().then(() => (window as FileBridgeWindow).michiFileBridge?.invalidate()),
    Promise.resolve().then(() => (window as LocalActionWindow).michiLocalActions?.invalidate()),
  ])
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, '外部接続の取消中にエラーが発生しました。接続状態を確認してください')
}
