import { db } from './db'
import { assertTrustedOwnerEvent, clearChangeSetAuthority } from './change-set'
import { clearCommandAuthority } from './command-bus'
import { clearTaskSplitAuthority } from './task-split-change'
import { externalAIFor } from './external-authority'
import { stopConnection } from './external-connection'

/** Enabling is owner consent; disabling reduces authority without changing BYOK or reminders. */
export async function setExternalAIEnabled(enabled: boolean, event?: Event) {
  if (typeof enabled !== 'boolean') throw new Error('外部AIの利用許可が不正です')
  await db.transaction('rw', db.settings, async () => {
    const current = await db.settings.get('main')
    if (!current) throw new Error('本人の設定がありません')
    if (enabled) {
      if (!event) throw new Error('本人の確認が必要です')
      assertTrustedOwnerEvent({ ownerId: current.profileId, datasetId: current.datasetId, principal: { id: current.profileId, kind: 'human' }, allowedFields: [], sourceRevisions: [] }, event)
    }
    const previous = externalAIFor(current)
    if (!Number.isSafeInteger(previous.epoch + 1)) throw new Error('外部AIの許可版が上限に達しています')
    await db.settings.put({ ...current, externalAI: { ...previous, enabled, epoch: previous.epoch + 1, clients: previous.clients.map(client => ({ ...client, status: 'revoked' })) } })
  })
  clearChangeSetAuthority({ externalOnly: true })
  clearCommandAuthority({ externalOnly: true })
  clearTaskSplitAuthority({ externalOnly: true })
  await stopConnection('fileBridge')
}
