import { db } from './db'
import { assertTrustedOwnerEvent, clearChangeSetAuthority } from './change-set'
import { clearCommandAuthority } from './command-bus'
import { clearExternalInstructionAuthority } from './external-instructions'
import { clearTaskSplitAuthority } from './task-split-change'
import { externalAIFor, validateExternalAI } from './external-authority'
import { stopConnection } from './external-connection'
import type { FileBridgeGateway } from './file-bridge-types'

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
  clearExternalInstructionAuthority()
  clearTaskSplitAuthority({ externalOnly: true })
  await stopConnection('fileBridge')
}
/** Local diagnostics describe only local evidence. They never promote a real-host shipping state. */
export async function runExternalSelftest(gateway: FileBridgeGateway, clientId: string, mode: 'read'|'revoke') {
  if (!gateway.selftest) throw new Error('自己診断を利用できません')
  const initial=await db.settings.get('main')
  if(!initial)throw new Error('本人の設定がありません')
  const before=externalAIFor(initial),target=before.clients.find(value=>value.registration.client.id===clientId)
  if(!target || mode==='read' && (!before.enabled || target.status!=='active') || mode==='revoke' && target.status!=='revoked')throw new Error('自己診断の対象が変わりました')
  const result = await gateway.selftest({clientId,mode})
  if (Object.keys(result).length!==3 || result.clientId!==clientId || result.check.surface!=='local_selftest' || result.check.auth!=='not_tested' || result.check.write!=='not_tested' || mode==='read' && result.check.revoke!=='not_tested' || mode==='revoke' && result.check.read!=='not_tested' || result.code!==null && !/^[A-Z_]{1,60}$/.test(result.code)) throw new Error('自己診断の結果を確認できません')
  await db.transaction('rw',db.settings,async()=>{
    const current=await db.settings.get('main')
    if(!current)throw new Error('本人の設定がありません')
    const previous=externalAIFor(current),client=previous.clients.find(value=>value.registration.client.id===clientId)
    if(!client || current.profileId!==initial.profileId || current.datasetId!==initial.datasetId || previous.epoch!==before.epoch || JSON.stringify(client.registration)!==JSON.stringify(target.registration) || mode==='read' && client.status!=='active' || mode==='revoke' && client.status!=='revoked')throw new Error('自己診断の対象が変わりました')
    const next={...previous,clients:previous.clients.map(value=>value===client?{...value,capabilityChecks:[...value.capabilityChecks.slice(-89),structuredClone(result.check)]}:value)}
    validateExternalAI(next)
    await db.settings.put({...current,externalAI:next})
  })
  return result
}
