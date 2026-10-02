import { db } from './db'
import { uid } from './domain'
import { sealShareEnvelope, ShareError } from './share-crypto'
import { trustedShareClick } from './share-identity'
import { projectTask, validateShareFields, validateShareNote, validateShareTitle } from './share-projection'
import { SHARE_ROLES, type ResourceGrant, type ShareField, type ShareProjection, type ShareRole } from './share-types'

export type ShareGrantInput = { taskId: string; recipientId: string; role: ShareRole; sharedFields: ShareField[]; shareNote: string }
export type GrantPayload = { role: ShareRole; shared_fields: ShareField[]; projection: ShareProjection; share_note: string }

async function privateTexts() {
  const [snapshots, evidence, sources] = await Promise.all([db.contextSnapshots.toArray(), db.taskSourceEvidence.toArray(), db.contextSources.toArray()])
  return { texts: [...snapshots.flatMap(row => [row.text, row.originalText, ...row.spans.map(span => span.text)]), ...evidence.map(row => row.quote)], sourceIds: sources.map(row => row.id) }
}
export async function checkShareNote(note: string): Promise<string> { const { texts, sourceIds } = await privateTexts(); return validateShareNote(note, texts, sourceIds) }
/** The exact object that will be encrypted for the recipient, for the preview before sharing. */
export async function previewSharePayload(input: Pick<ShareGrantInput, 'taskId' | 'role' | 'sharedFields' | 'shareNote'>, shareId = 'preview'): Promise<GrantPayload> {
  if (!SHARE_ROLES.includes(input.role)) throw new ShareError('共有の役割が不正です')
  validateShareFields(input.sharedFields)
  const [task, completion, settings] = await Promise.all([db.tasks.get(input.taskId), db.completions.where('taskId').equals(input.taskId).first(), db.settings.get('main')])
  if (!task || task.deletedAt || !settings) throw new ShareError('共有するタスクが見つかりません')
  const projection = projectTask(task, completion, shareId, input.sharedFields)
  if (input.sharedFields.includes('title') && projection.title !== undefined) {
    const { texts } = await privateTexts()
    validateShareTitle(projection.title, texts)
  }
  return { role: input.role, shared_fields: [...input.sharedFields], projection, share_note: await checkShareNote(input.shareNote) }
}
export async function createShareGrant(input: ShareGrantInput, event: Event): Promise<ResourceGrant> {
  trustedShareClick(event)
  const contact = await db.shareContacts.get(input.recipientId), settings = await db.settings.get('main')
  if (!contact?.verifiedAt) throw new ShareError('指紋を確認した相手にだけ共有できます')
  if (!settings) throw new ShareError('設定がありません')
  const id = uid(), payload = await previewSharePayload(input, id), at = new Date().toISOString()
  const grant: ResourceGrant = { id, ownerId: settings.profileId, datasetId: settings.datasetId, resource: { kind: 'task', id: input.taskId }, recipientId: contact.id, role: payload.role, authorizationEpoch: 1, sequence: 0, replySequence: 0, sharedFields: payload.shared_fields, shareNote: payload.share_note, createdAt: at, updatedAt: at, revokedAt: null }
  await db.resourceGrants.add(grant)
  return grant
}
async function sealFor(grant: ResourceGrant, kind: 'grant' | 'revoke', payload: unknown) {
  const [identity, contact] = await Promise.all([db.shareIdentity.get('main'), db.shareContacts.get(grant.recipientId)])
  if (!identity) throw new ShareError('共有用の名刺がありません')
  if (!contact?.verifiedAt) throw new ShareError('相手のカードが確認されていません')
  return sealShareEnvelope({ kind, shareId: grant.id, epoch: grant.authorizationEpoch, sequence: grant.sequence, payload, sender: identity, recipient: contact.card })
}
/** Writes a fresh .michishare for an active grant from the task's current values. */
export async function issueShareBundle(grantId: string, event: Event): Promise<string> {
  trustedShareClick(event)
  const grant = await db.resourceGrants.get(grantId)
  if (!grant || grant.revokedAt) throw new ShareError('有効な共有がありません')
  const payload = await previewSharePayload({ taskId: grant.resource.id, role: grant.role, sharedFields: grant.sharedFields, shareNote: grant.shareNote }, grant.id)
  const next = { ...grant, sequence: grant.sequence + 1, updatedAt: new Date().toISOString() }
  const envelope = await sealFor(next, 'grant', payload)
  await db.resourceGrants.put(next)
  return envelope
}
/** A role change raises the authorization epoch; replies made under the old role are then rejected. */
export async function changeShareRole(grantId: string, role: ShareRole, event: Event): Promise<ResourceGrant> {
  trustedShareClick(event)
  if (!SHARE_ROLES.includes(role)) throw new ShareError('共有の役割が不正です')
  return db.transaction('rw', db.resourceGrants, async () => {
    const grant = await db.resourceGrants.get(grantId)
    if (!grant || grant.revokedAt) throw new ShareError('有効な共有がありません')
    const next = { ...grant, role, authorizationEpoch: grant.authorizationEpoch + 1, sequence: 0, replySequence: 0, updatedAt: new Date().toISOString() }
    await db.resourceGrants.put(next)
    return next
  })
}
/** Revoke: epoch + 1 and a signed revoke file. A copy already on the other device cannot be erased remotely. */
export async function revokeShareGrant(grantId: string, event: Event): Promise<string> {
  trustedShareClick(event)
  const grant = await db.resourceGrants.get(grantId)
  if (!grant) throw new ShareError('共有がありません')
  const at = grant.revokedAt ?? new Date().toISOString()
  const next: ResourceGrant = grant.revokedAt ? { ...grant, sequence: grant.sequence + 1 } : { ...grant, revokedAt: at, authorizationEpoch: grant.authorizationEpoch + 1, sequence: 1, updatedAt: at }
  const envelope = await sealFor(next, 'revoke', { revoked_at: at })
  await db.resourceGrants.put(next)
  return envelope
}
