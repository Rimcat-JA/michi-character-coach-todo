import { db } from './db'
import { changePolicyFor, clearChangeSetAuthority, validateChangePolicy } from './change-set'
import { clearDetectionAuthority } from './detection-run'
import { clearCoachTurnAuthority } from './chat-history'
import { clearCalendarRulesAuthority } from './calendar-rules-save'
import { clearRoutineAssistanceAuthority } from './routine-assist-save'
import { clearCompletionReconfirmationAuthority } from './completion-reconfirmation'
import { clearCalendarCSVImportAuthority } from './calendar-csv-import-save'
import { clearCommandAuthority } from './command-bus'
import { clearTaskSplitAuthority } from './task-split-change'
import { validateEmbeddingSettings } from './embedding-settings'
import type { EmbeddingSettings, Settings } from './domain'

/** Every in-memory proposal/approval authority. ChangeSets may be kept so their epoch check reports POLICY_CHANGED. */
export function clearVolatileAuthorities(options: { keepChangeSets?: boolean } = {}) {
  if (!options.keepChangeSets) { clearChangeSetAuthority(); clearCommandAuthority(); clearTaskSplitAuthority() }
  clearDetectionAuthority()
  clearCoachTurnAuthority()
  clearCalendarRulesAuthority()
  clearRoutineAssistanceAuthority()
  clearCompletionReconfirmationAuthority()
  clearCalendarCSVImportAuthority()
}

export async function updateAIConnection(enabled: boolean, model?: string) { await writeAIConnection(() => enabled, model) }
/** Saves the model and keeps the stored on/off state; turning AI back on goes through the S20 resume preview. */
export async function saveAIModel(model: string) { await writeAIConnection(current => current, model) }
async function writeAIConnection(enabled: (current: boolean) => boolean, model?: string) {
  if (model !== undefined && !/^[\w~./:-]{3,120}$/.test(model)) throw new Error('モデルIDを確認してください')
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('本人の設定がありません')
    const aiConnectionEpoch = (settings.aiConnectionEpoch ?? 0) + 1
    if (!Number.isSafeInteger(aiConnectionEpoch)) throw new Error('AI接続の版が上限に達しています')
    await db.settings.put({ ...settings, aiEnabled: enabled(settings.aiEnabled), aiConnectionEpoch, ...(model === undefined ? {} : { aiModel: model }) })
  })
  // BYOK settings do not change the shared policy epoch or external client authority.
  clearChangeSetAuthority({ coachOnly: true })
  clearCommandAuthority({ coachOnly: true })
  clearTaskSplitAuthority({ coachOnly: true })
  clearDetectionAuthority()
  clearCoachTurnAuthority()
  clearRoutineAssistanceAuthority({ coachOnly: true })
  clearCompletionReconfirmationAuthority()
  clearCalendarCSVImportAuthority()
}

/** Optional second model for detection verification. Changing it moves the policy epoch, so prepared runs and candidates expire. */
export async function saveAIVerifierModel(model: string | null) {
  if (model !== null && !/^[\w~./:-]{3,120}$/.test(model)) throw new Error('検証用のモデルIDを確認してください')
  await writeSettings(settings => ({ ...settings, aiVerifierModel: model }))
}
/** Loopback embedding service for hybrid search; null turns it off (the default). */
export async function saveEmbeddingSettings(value: EmbeddingSettings | null) {
  if (value !== null) validateEmbeddingSettings(value)
  await writeSettings(settings => ({ ...settings, embedding: value }))
}
async function writeSettings(change: (settings: Settings) => Settings) {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('本人の設定がありません')
    const previous = changePolicyFor(settings), policy = { ...previous, epoch: previous.epoch + 1 }
    validateChangePolicy(policy)
    await db.settings.put({ ...change(settings), changePolicy: policy })
  })
  clearVolatileAuthorities()
}
