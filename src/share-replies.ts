import { db } from './db'
import { uid, validateDate } from './domain'
import { prepareTaskChanges, type ChangeContext, type PreparedChangeSet, type TaskChangePatch } from './change-set'
import { openShareEnvelope, sealShareEnvelope, ShareError } from './share-crypto'
import { trustedShareClick } from './share-identity'
import { PROPOSAL_FIELDS, type ProposalField, type ShareProposal } from './share-types'

export type ReplyComment = { id: string; share_task_id: string; body: string }
export type ReplyPayload = { grant_id: string; epoch: number; comments: ReplyComment[]; proposal: { id: string; fields: Partial<Record<ProposalField, string | null>> } | null }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9-]{8,100}$/.test(value)

function validateProposalFields(value: unknown): asserts value is Partial<Record<ProposalField, string | null>> {
  if (!record(value) || !Object.keys(value).length) throw new ShareError('提案する項目がありません')
  // Manual points and the real deadline stay the owner's own decision; a recipient cannot even propose them.
  if (Object.keys(value).some(key => !PROPOSAL_FIELDS.includes(key as ProposalField))) throw new ShareError('提案できるのはタイトルと予定日だけです（手動ポイント・締め切りは提案できません）')
  if ('title' in value && (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 300)) throw new ShareError('提案のタイトルが不正です')
  if ('scheduled_date' in value) { if (value.scheduled_date !== null && typeof value.scheduled_date !== 'string') throw new ShareError('提案の予定日が不正です'); validateDate(value.scheduled_date as string | null, '提案の予定日') }
}
function validateReplyPayload(value: unknown, grantId: string, epoch: number): asserts value is ReplyPayload {
  if (!record(value) || !exact(value, ['grant_id', 'epoch', 'comments', 'proposal']) || value.grant_id !== grantId || value.epoch !== epoch || !Array.isArray(value.comments) || value.comments.length > 50) throw new ShareError('返信ファイルの形式が不正です')
  for (const comment of value.comments) if (!record(comment) || !exact(comment, ['id', 'share_task_id', 'body']) || !id(comment.id) || comment.share_task_id !== grantId || typeof comment.body !== 'string' || !comment.body.trim() || comment.body.length > 10000) throw new ShareError('返信のコメントが不正です')
  if (value.proposal !== null) { if (!record(value.proposal) || !exact(value.proposal, ['id', 'fields']) || !id(value.proposal.id)) throw new ShareError('編集提案の形式が不正です'); validateProposalFields(value.proposal.fields) }
  if (!value.comments.length && value.proposal === null) throw new ShareError('返信の内容がありません')
}
/** Recipient: comments (commenter/editor) and an edit proposal (editor), signed by me and encrypted to the owner. */
export async function buildShareReply(shareId: string, input: { comments?: string[]; proposal?: Partial<Record<string, string | null>> }, event: Event): Promise<string> {
  trustedShareClick(event)
  const [identity, inbound] = await Promise.all([db.shareIdentity.get('main'), db.sharedInbound.get(shareId)])
  if (!identity) throw new ShareError('共有用の名刺がありません')
  if (!inbound?.projection || inbound.revokedAt) throw new ShareError('この共有は取り消されています')
  const owner = await db.shareContacts.get(inbound.ownerFp)
  if (!owner?.verifiedAt) throw new ShareError('共有元のカードが確認されていません')
  const comments = (input.comments ?? []).map(body => body.trim()).filter(Boolean)
  if (comments.length && inbound.role === 'viewer') throw new ShareError('閲覧のみの共有にはコメントできません')
  if (input.proposal && inbound.role !== 'editor') throw new ShareError('編集の提案は「編集の提案」権限の共有だけでできます')
  const payload: ReplyPayload = { grant_id: shareId, epoch: inbound.epoch, comments: comments.map(body => ({ id: uid(), share_task_id: shareId, body })), proposal: input.proposal ? { id: uid(), fields: input.proposal as Partial<Record<ProposalField, string | null>> } : null }
  validateReplyPayload(payload, shareId, inbound.epoch)
  const sequence = inbound.replySequence + 1
  const envelope = await sealShareEnvelope({ kind: 'reply', shareId, epoch: inbound.epoch, sequence, payload, sender: identity, recipient: owner.card })
  await db.sharedInbound.update(shareId, { replySequence: sequence })
  return envelope
}
export type ReplyImportResult = { added: number; duplicates: number; proposalId: string | null }
/** Owner: comments are appended once (idempotent by id) with the sender's label; proposals wait for a ChangeSet approval. Revoked or stale-epoch replies are rejected. */
export async function importShareReply(raw: string): Promise<ReplyImportResult> {
  const identity = await db.shareIdentity.get('main')
  if (!identity) throw new ShareError('共有用の名刺がありません')
  const { header, payload } = await openShareEnvelope(raw, identity)
  if (header.kind !== 'reply') throw new ShareError('共有への返信ファイルではありません')
  const [grant, settings] = await Promise.all([db.resourceGrants.get(header.share_id), db.settings.get('main')])
  if (!grant || !settings || grant.ownerId !== settings.profileId || grant.datasetId !== settings.datasetId) throw new ShareError('この端末の共有への返信ではありません')
  const contact = await db.shareContacts.get(header.from_fp)
  if (header.from_fp !== grant.recipientId || !contact?.verifiedAt) throw new ShareError('共有した相手からの返信ではありません')
  if (grant.revokedAt) throw new ShareError('この共有は取り消し済みのため返信を受け付けません')
  if (header.epoch !== grant.authorizationEpoch) throw new ShareError('権限変更より前の古い返信です')
  validateReplyPayload(payload, grant.id, header.epoch)
  if (payload.comments.length && grant.role === 'viewer') throw new ShareError('閲覧のみの共有にはコメントできません')
  if (payload.proposal && grant.role !== 'editor') throw new ShareError('この共有では編集の提案を受け付けません')
  const taskId = grant.resource.id, at = new Date().toISOString()
  return db.transaction('rw', [db.tasks, db.taskComments, db.shareProposals, db.resourceGrants], async () => {
    const task = await db.tasks.get(taskId)
    if (!task) throw new ShareError('共有したタスクが見つかりません')
    let added = 0, duplicates = 0, proposalId: string | null = null
    for (const comment of payload.comments) {
      const commentId = `share:${grant.id}:${comment.id}`
      if (await db.taskComments.get(commentId)) { duplicates++; continue }
      await db.taskComments.add({ id: commentId, taskId, ownerId: settings.profileId, body: comment.body, createdAt: at, authorKind: 'share_recipient', authorLabel: contact.displayName })
      added++
    }
    if (payload.proposal) {
      proposalId = `${grant.id}:${payload.proposal.id}`
      if (!await db.shareProposals.get(proposalId)) await db.shareProposals.add({ id: proposalId, grantId: grant.id, taskId, contactId: contact.id, authorLabel: contact.displayName, fields: payload.proposal.fields, receivedAt: at, state: 'pending' })
    }
    const current = await db.resourceGrants.get(grant.id)
    if (current && header.sequence > current.replySequence) await db.resourceGrants.update(grant.id, { replySequence: header.sequence })
    return { added, duplicates, proposalId }
  })
}
/** Turns a pending proposal into a normal owner ChangeSet; it changes nothing until the owner approves it with a native click. */
export async function prepareShareProposal(proposalId: string): Promise<{ prepared: PreparedChangeSet; context: ChangeContext; proposal: ShareProposal }> {
  const proposal = await db.shareProposals.get(proposalId), settings = await db.settings.get('main')
  if (!proposal || proposal.state !== 'pending' || !settings) throw new ShareError('確認待ちの提案がありません')
  const grant = await db.resourceGrants.get(proposal.grantId)
  if (!grant || grant.revokedAt) throw new ShareError('この共有は取り消し済みです')
  const task = await db.tasks.get(proposal.taskId)
  if (!task || task.deletedAt) throw new ShareError('共有したタスクが見つかりません')
  const patch: TaskChangePatch = {}
  if ('title' in proposal.fields) patch.title = proposal.fields.title!
  if ('scheduled_date' in proposal.fields) patch.scheduledDate = proposal.fields.scheduled_date ?? null
  const context: ChangeContext = { principal: { id: settings.profileId, kind: 'human' }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: ['title', 'scheduledDate'], sourceRevisions: [] }
  const prepared = await prepareTaskChanges([{ taskId: task.id, expectedRevision: task.revision, patch }], context, `共有相手「${proposal.authorLabel}」からの編集提案`)
  return { prepared, context, proposal }
}
export async function settleShareProposal(proposalId: string, state: 'applied' | 'dismissed', event: Event): Promise<void> {
  trustedShareClick(event)
  const proposal = await db.shareProposals.get(proposalId)
  if (!proposal || proposal.state !== 'pending') throw new ShareError('確認待ちの提案がありません')
  await db.shareProposals.update(proposalId, { state })
}
