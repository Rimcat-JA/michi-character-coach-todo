import { db } from './db'
import { canonicalJSON } from './canonical'
import { assertShareUnexpired, shareExpiry, validateShareExpiry } from './share-lifetime'
import { uid } from './domain'
import { sealShareEnvelope, ShareError } from './share-crypto'
import { trustedShareClick } from './share-identity'
import { projectTask, validateShareFields, validateShareNote, validateShareTitle } from './share-projection'
import { SHARE_ROLES, type ResourceGrant, type ShareField, type ShareProjection, type ShareRole } from './share-types'

export type ShareGrantInput = { taskId: string; recipientId: string; role: ShareRole; sharedFields: ShareField[]; shareNote: string; expiresAt?: string }
export type GrantPayload = { role: ShareRole; shared_fields: ShareField[]; projection: ShareProjection; share_note: string; expires_at: string | null }
function assertPreviewUnchanged(payload: GrantPayload, preview?: GrantPayload) {
  if (!preview) return
  const normalized = { ...payload, projection: { ...payload.projection, share_task_id: preview.projection.share_task_id } }
  if (canonicalJSON(normalized) !== canonicalJSON(preview)) throw new ShareError('確認した送る内容が変わりました。もう一度送る内容を確認してください')
}

async function privateTexts() {
  const [snapshots, evidence, sources] = await Promise.all([db.contextSnapshots.toArray(), db.taskSourceEvidence.toArray(), db.contextSources.toArray()])
  return { texts: [...snapshots.flatMap(row => [row.text, row.originalText, ...row.spans.map(span => span.text)]), ...evidence.map(row => row.quote)], sourceIds: sources.map(row => row.id) }
}
export async function checkShareNote(note: string): Promise<string> { const { texts, sourceIds } = await privateTexts(); return validateShareNote(note, texts, sourceIds) }
/** The exact object that will be encrypted for the recipient, for the preview before sharing. */
export async function previewSharePayload(input: Pick<ShareGrantInput, 'taskId' | 'role' | 'sharedFields' | 'shareNote'> & { expiresAt?: string | null }, shareId = 'preview'): Promise<GrantPayload> {
  if (!SHARE_ROLES.includes(input.role)) throw new ShareError('共有の役割が不正です')
  validateShareFields(input.sharedFields)
  const [task, completion, settings] = await Promise.all([db.tasks.get(input.taskId), db.completions.where('taskId').equals(input.taskId).first(), db.settings.get('main')])
  if (!task || task.deletedAt || !settings) throw new ShareError('共有するタスクが見つかりません')
  const projection = projectTask(task, completion, shareId, input.sharedFields)
  if (input.sharedFields.includes('title') && projection.title !== undefined) {
    const { texts } = await privateTexts()
    validateShareTitle(projection.title, texts)
  }
  const expiresAt = input.expiresAt === undefined ? shareExpiry() : input.expiresAt
  validateShareExpiry(expiresAt, true)
  return { role: input.role, shared_fields: [...input.sharedFields], projection, share_note: await checkShareNote(input.shareNote), expires_at: expiresAt }
}
export async function createShareGrant(input: ShareGrantInput, event: Event, expectedPreview?: GrantPayload): Promise<ResourceGrant> {
  trustedShareClick(event)
  const contact = await db.shareContacts.get(input.recipientId), settings = await db.settings.get('main')
  if (!contact?.verifiedAt) throw new ShareError('指紋を確認した相手にだけ共有できます')
  if (!settings) throw new ShareError('設定がありません')
  const id = uid(), payload = await previewSharePayload(input, id), at = new Date().toISOString()
  if (payload.expires_at === null) throw new ShareError('新しい共有には有効期限を指定してください')
  assertPreviewUnchanged(payload, expectedPreview)
  const grant: ResourceGrant = { id, ownerId: settings.profileId, datasetId: settings.datasetId, resource: { kind: 'task', id: input.taskId }, recipientId: contact.id, role: payload.role, authorizationEpoch: 1, sequence: 0, replySequence: 0, sharedFields: payload.shared_fields, shareNote: payload.share_note, createdAt: at, updatedAt: at, revokedAt: null, expiresAt: payload.expires_at }
  await db.transaction('rw', [db.resourceGrants, db.settings, db.shareContacts], async () => {
    const currentSettings = await db.settings.get('main'), currentContact = await db.shareContacts.get(contact.id)
    if (currentSettings?.datasetId !== settings.datasetId || currentSettings.profileId !== settings.profileId || !currentContact?.verifiedAt || currentContact.verifiedAt !== contact.verifiedAt) throw new ShareError('処理中にデータセット・相手の確認が変わりました')
    assertShareUnexpired(grant)
    await db.resourceGrants.add(grant)
  })
  return grant
}
async function persistIssuedGrant(prior: ResourceGrant, next: ResourceGrant): Promise<void> {
  await db.transaction('rw', [db.resourceGrants, db.settings, db.shareContacts], async () => {
    const [current, settings, contact] = await Promise.all([db.resourceGrants.get(prior.id), db.settings.get('main'), db.shareContacts.get(prior.recipientId)])
    if (!current || canonicalJSON(current) !== canonicalJSON(prior)) throw new ShareError('処理中に共有の権限・版が変わりました。もう一度確認してください')
    if (settings?.datasetId !== prior.datasetId || settings.profileId !== prior.ownerId || !contact?.verifiedAt) throw new ShareError('現在のデータセット・共有相手の確認と一致しません')
    if (!next.revokedAt) assertShareUnexpired(next)
    await db.resourceGrants.put(next)
  })
}
async function sealFor(grant: ResourceGrant, kind: 'grant' | 'revoke', payload: unknown) {
  const [identity, contact] = await Promise.all([db.shareIdentity.get('main'), db.shareContacts.get(grant.recipientId)])
  if (!identity) throw new ShareError('共有用の名刺がありません')
  if (!contact?.verifiedAt) throw new ShareError('相手のカードが確認されていません')
  return sealShareEnvelope({ kind, shareId: grant.id, epoch: grant.authorizationEpoch, sequence: grant.sequence, payload, sender: identity, recipient: contact.card })
}
/** Writes a fresh .michishare for an active grant from the task's current values. */
export async function issueShareBundle(grantId: string, event: Event, expectedPreview?: GrantPayload): Promise<string> {
  trustedShareClick(event)
  const grant = await db.resourceGrants.get(grantId)
  if (!grant || grant.revokedAt) throw new ShareError('有効な共有がありません')
  assertShareUnexpired(grant)
  const settings = await db.settings.get('main')
  if (settings?.datasetId !== grant.datasetId || settings.profileId !== grant.ownerId) throw new ShareError('現在のデータセットの共有ではありません')
  const payload = await previewSharePayload({ taskId: grant.resource.id, role: grant.role, sharedFields: grant.sharedFields, shareNote: grant.shareNote, expiresAt: grant.expiresAt ?? null }, grant.id)
  assertPreviewUnchanged(payload, expectedPreview)
  const next = { ...grant, sequence: grant.sequence + 1, updatedAt: new Date().toISOString() }
  const envelope = await sealFor(next, 'grant', payload)
  await persistIssuedGrant(grant, next)
  return envelope
}
/** A role change raises the authorization epoch; replies made under the old role are then rejected. */
export async function changeShareRole(grantId: string, role: ShareRole, event: Event): Promise<ResourceGrant> {
  trustedShareClick(event)
  if (!SHARE_ROLES.includes(role)) throw new ShareError('共有の役割が不正です')
  return db.transaction('rw', db.resourceGrants, async () => {
    const grant = await db.resourceGrants.get(grantId)
    if (!grant || grant.revokedAt) throw new ShareError('有効な共有がありません')
    assertShareUnexpired(grant)
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
  await persistIssuedGrant(grant, next)
  return envelope
}
