import { purgeExpiredDetectionCandidates, purgeExpiredSources } from './source-library'
import { purgeExpiredMemories } from './coach-memory'
import { purgeExpiredConversations } from './chat-history'

let cleanup: Promise<void> | null = null
/** Run from a native effect or user action, never from a Dexie liveQuery. */
export async function purgeExpiredCoachContext(): Promise<void> {
  if (cleanup) return cleanup
  cleanup = (async () => { await purgeExpiredSources(); await purgeExpiredDetectionCandidates(); await purgeExpiredMemories(); await purgeExpiredConversations() })()
  try { await cleanup } finally { cleanup = null }
}
