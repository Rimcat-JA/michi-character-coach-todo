import { db } from './db'
import { changePolicyFor, clearChangeSetAuthority, validateChangePolicy } from './change-set'
import { clearDetectionAuthority } from './detection-run'
import { clearCoachTurnAuthority } from './chat-history'
import { clearCalendarRulesAuthority } from './calendar-rules-save'
import { invalidateExternalConnection } from './external-connection'

export async function updateAIConnection(enabled: boolean, model?: string) {
  if (model !== undefined && !/^[\w~./:-]{3,120}$/.test(model)) throw new Error('モデルIDを確認してください')
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('本人の設定がありません')
    const previous = changePolicyFor(settings)
    const policy = { ...previous, epoch: previous.epoch + 1 }
    validateChangePolicy(policy)
    await db.settings.put({ ...settings, aiEnabled: enabled, ...(model === undefined ? {} : { aiModel: model }), changePolicy: policy })
  })
  clearChangeSetAuthority()
  clearDetectionAuthority()
  clearCoachTurnAuthority()
  clearCalendarRulesAuthority()
  await invalidateExternalConnection()
}
