import { db } from './db'
import { retentionDefaults } from './retention-defaults'

const noticeKey = 'michi.retention-defaults-notice.v1'
/** One-time, per-device notice: defaults apply to new data only, so existing unlimited rows are counted, never rewritten. */
export async function unlimitedRetentionNotice(storage: Pick<Storage, 'getItem' | 'setItem'> | null = globalThis.localStorage ?? null): Promise<string | null> {
  try { if (storage?.getItem(noticeKey)) return null } catch { return null }
  const settings = await db.settings.get('main')
  if (!settings) return null
  const sources = (await db.contextSources.where('ownerId').equals(settings.profileId).toArray()).filter(source => !source.deletedAt && source.provider !== 'local' && source.retentionUntil === null).length
  const conversations = (await db.coachConversations.where('ownerId').equals(settings.profileId).toArray()).filter(row => !row.deletedAt && !row.retentionUntil).length
  try { storage?.setItem(noticeKey, new Date().toISOString()) } catch { /* The notice may repeat when storage is unavailable. */ }
  if (!sources && !conversations) return null
  return `保持期限の既定（取込会話${retentionDefaults.importedConversationDays}日・コーチ会話${retentionDefaults.coachConversationDays}日）は新しいデータだけに使います。既存の期限なし：取込会話${sources}件・コーチ会話${conversations}件は変更していません。必要なら資料・会話の画面で期限を設定してください。`
}
