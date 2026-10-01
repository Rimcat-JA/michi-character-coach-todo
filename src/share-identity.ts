import { db } from './db'
import { generateShareIdentity, ShareError, validateShareCard } from './share-crypto'
import type { ShareCard, ShareContact, ShareIdentity } from './share-types'

export function trustedShareClick(event: Event) {
  const getter = Object.getOwnPropertyDescriptor(Event.prototype, 'type')?.get
  if (!(event instanceof Event) || !event.isTrusted || !getter || !['click', 'submit'].includes(getter.call(event))) throw new ShareError('本人確認ボタンから操作してください')
}
export async function loadShareIdentity(): Promise<ShareIdentity | undefined> { return db.shareIdentity.get('main') }
/** One identity per device, generated here and never exported; a new device gets a new card. */
export async function ensureShareIdentity(displayName: string, event: Event): Promise<ShareIdentity> {
  trustedShareClick(event)
  const current = await db.shareIdentity.get('main')
  if (current) return current
  const identity = await generateShareIdentity(displayName)
  return db.transaction('rw', db.shareIdentity, async () => { const raced = await db.shareIdentity.get('main'); if (raced) return raced; await db.shareIdentity.add(identity); return identity })
}
export async function exportShareCard(): Promise<string> {
  const identity = await db.shareIdentity.get('main')
  if (!identity) throw new ShareError('先に共有用の名刺を作成してください')
  return JSON.stringify(identity.card, null, 2)
}
function parse(raw: string): unknown { if (raw.length > 64 * 1024) throw new ShareError('共有カードが大きすぎます'); try { return JSON.parse(raw) } catch { throw new ShareError('共有カードの形式が不正です') } }
/** Imports a card as unverified. Sharing needs the fingerprint confirmed out of band first. */
export async function importShareCard(raw: string, relation: ShareContact['relation'] = 'recipient'): Promise<ShareContact> {
  const card = await validateShareCard(parse(raw)), own = await db.shareIdentity.get('main')
  if (own?.card.fingerprint === card.fingerprint) throw new ShareError('自分の共有カードです')
  return db.transaction('rw', db.shareContacts, async () => {
    const prior = await db.shareContacts.get(card.fingerprint)
    const contact: ShareContact = { id: card.fingerprint, displayName: card.display_name, card, relation: prior?.relation ?? relation, verifiedAt: prior?.verifiedAt ?? null, createdAt: prior?.createdAt ?? new Date().toISOString() }
    await db.shareContacts.put(contact)
    return contact
  })
}
/** The owner confirms the fingerprint read over another channel with a native click. */
export async function verifyShareContact(id: string, event: Event): Promise<void> {
  trustedShareClick(event)
  const contact = await db.shareContacts.get(id)
  if (!contact) throw new ShareError('相手のカードがありません')
  await db.shareContacts.update(id, { verifiedAt: new Date().toISOString() })
}
/** Recipient side: pin the sender of a share file on first use, after comparing its fingerprint. */
export async function pinShareOwner(card: ShareCard, event: Event): Promise<ShareContact> {
  trustedShareClick(event)
  const valid = await validateShareCard(card)
  return db.transaction('rw', db.shareContacts, async () => {
    const prior = await db.shareContacts.get(valid.fingerprint)
    const contact: ShareContact = { id: valid.fingerprint, displayName: valid.display_name, card: valid, relation: prior?.relation ?? 'owner', verifiedAt: new Date().toISOString(), createdAt: prior?.createdAt ?? new Date().toISOString() }
    await db.shareContacts.put(contact)
    return contact
  })
}
