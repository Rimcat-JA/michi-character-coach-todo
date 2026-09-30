import type { FileBridgeWindow } from './file-bridge-types'
import type { LocalActionWindow } from './local-action-types'

/** Permission reduction is allowed without a new human approval. */
export async function invalidateExternalConnection(): Promise<void> {
  if (typeof window !== 'undefined') await (window as FileBridgeWindow).michiFileBridge?.invalidate()
  if (typeof window !== 'undefined') await (window as LocalActionWindow).michiLocalActions?.invalidate()
}
