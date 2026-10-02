import { db } from './db'
import { openShareEnvelope, ShareError } from './share-crypto'
import { maskSourceReferences, SHARE_NOTE_MAX, validateProjection, validateShareFields } from './share-projection'
import { SHARE_ROLES, type ShareCard, type SharedInbound, type ShareRole } from './share-types'

export type ShareImportResult = { status: 'needs_owner_confirmation'; card: ShareCard } | { status: 'stored' | 'revoked'; inbound: SharedInbound }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

/**
 * Recipient import of a .michishare. Writes only the separate sharedInbound table: never own tasks, today, points, ledger or source search.
 * Order: addressed to me → sender pinned → signature → decryption → exact payload → no epoch rollback or replay.
 */
export async function importShareBundle(raw: string): Promise<ShareImportResult> {
  const identity = await db.shareIdentity.get('main')
  if (!identity) throw new ShareError('この端末の共有用名刺を作成してから取り込んでください')
  const { header, payload, senderCard } = await openShareEnvelope(raw, identity)
  if (header.kind !== 'grant' && header.kind !== 'revoke') throw new ShareError('共有の受け取りファイルではありません')
  const owner = await db.shareContacts.get(header.from_fp)
  if (!owner?.verifiedAt) return { status: 'needs_owner_confirmation', card: senderCard }
  let next: Omit<SharedInbound, 'receivedAt' | 'replySequence'>
  if (header.kind === 'grant') {
    if (!record(payload) || !exact(payload, ['role', 'shared_fields', 'projection', 'share_note']) || !SHARE_ROLES.includes(payload.role as ShareRole) || typeof payload.share_note !== 'string' || payload.share_note.length > SHARE_NOTE_MAX) throw new ShareError('共有内容の形式が不正です')
    validateShareFields(payload.shared_fields)
    validateProjection(payload.projection, header.share_id, payload.shared_fields)
    next = { id: header.share_id, ownerFp: header.from_fp, ownerLabel: owner.displayName, role: payload.role as ShareRole, epoch: header.epoch, sequence: header.sequence, sharedFields: [...payload.shared_fields], projection: payload.projection, shareNote: maskSourceReferences(payload.share_note), revokedAt: null }
  } else {
    if (!record(payload) || !exact(payload, ['revoked_at']) || typeof payload.revoked_at !== 'string' || Number.isNaN(Date.parse(payload.revoked_at))) throw new ShareError('取り消しファイルの形式が不正です')
    next = { id: header.share_id, ownerFp: header.from_fp, ownerLabel: owner.displayName, role: 'viewer', epoch: header.epoch, sequence: header.sequence, sharedFields: [], projection: null, shareNote: '', revokedAt: payload.revoked_at }
  }
  return db.transaction('rw', db.sharedInbound, async () => {
    const prior = await db.sharedInbound.get(header.share_id)
    if (prior) {
      if (prior.ownerFp !== header.from_fp) throw new ShareError('別の送信者の共有と同じIDです')
      if (header.epoch < prior.epoch) throw new ShareError('取り消し・権限変更より前の古い共有ファイルです')
      if (header.epoch === prior.epoch && header.sequence <= prior.sequence) throw new ShareError('取り込み済み、またはより古い共有ファイルです')
      if (prior.revokedAt && header.kind === 'grant' && header.epoch <= prior.epoch) throw new ShareError('取り消された共有です')
    }
    const inbound: SharedInbound = { ...next, receivedAt: new Date().toISOString(), replySequence: prior && prior.epoch === header.epoch ? prior.replySequence : 0 }
    // A revoke keeps only a tombstone (no projection) so older grant files stay rejected.
    await db.sharedInbound.put(inbound)
    return { status: header.kind === 'grant' ? 'stored' as const : 'revoked' as const, inbound }
  })
}
export async function listSharedInbound(): Promise<SharedInbound[]> { return (await db.sharedInbound.toArray()).filter(row => row.projection && !row.revokedAt) }
