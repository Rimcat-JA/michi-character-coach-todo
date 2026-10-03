import { db } from './db'
import { ShareError } from './share-crypto'

export const DEFAULT_SHARE_DAYS = 7
export function shareExpiry(days = DEFAULT_SHARE_DAYS, now = Date.now()): string {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new ShareError('共有の有効期間は1〜365日で指定してください')
  return new Date(now + days * 86400000).toISOString()
}
export function validateShareExpiry(value: unknown, future = false, now = Date.now()): asserts value is string | null {
  if (value === null) return // Legacy grants did not carry a lifetime.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new ShareError('共有の有効期限が不正です')
  if (future && (Date.parse(value) <= now || Date.parse(value) > now + 365 * 86400000)) throw new ShareError('共有の有効期限は現在より後、365日以内にしてください')
}
export function shareExpired(row: { expiresAt?: string | null }, now = Date.now()): boolean {
  return row.expiresAt != null && (!Number.isFinite(Date.parse(row.expiresAt)) || Date.parse(row.expiresAt) <= now)
}
export function assertShareUnexpired(row: { expiresAt?: string | null }): void {
  if (shareExpired(row)) throw new ShareError('共有の有効期限が切れています。共有元で新しく共有してください')
}
/** Clear expired cached content but retain the epoch/sequence tombstone, preventing replay of an old file. */
export async function purgeExpiredSharedInbound(now = Date.now()): Promise<void> {
  await db.transaction('rw', db.sharedInbound, async () => {
    await db.sharedInbound.filter(row => shareExpired(row, now) && Boolean(row.projection || row.shareNote || row.sharedFields.length)).modify(row => {
      row.projection = null; row.shareNote = ''; row.sharedFields = []
    })
  })
}
