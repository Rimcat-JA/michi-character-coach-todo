import { canonicalJSON } from './canonical'
import type { PublicJwk, ShareCard, ShareIdentity } from './share-types'

/** WebCrypto only: ECDSA P-256 signatures, ECDH P-256 + HKDF-SHA256 key agreement, AES-256-GCM content encryption. */
export type ShareEnvelopeKind = 'grant' | 'revoke' | 'reply'
export type ShareHeader = { format: 'michi-share'; version: 1; kind: ShareEnvelopeKind; share_id: string; from_fp: string; to_fp: string; epoch: number; sequence: number; issued_at: string; from_card: ShareCard; epk: PublicJwk }
export type ShareEnvelope = ShareHeader & { iv: string; ciphertext: string; signature: string }
export const SHARE_MAX_BYTES = 5 * 1024 * 1024
const ENVELOPE_KEYS = ['format', 'version', 'kind', 'share_id', 'from_fp', 'to_fp', 'epoch', 'sequence', 'issued_at', 'from_card', 'epk', 'iv', 'ciphertext', 'signature']
const CARD_KEYS = ['format', 'version', 'display_name', 'ecdsa_public_jwk', 'ecdh_public_jwk', 'fingerprint']
const utf8 = (text: string) => new TextEncoder().encode(text)
const b64 = (bytes: Uint8Array) => btoa(Array.from(bytes, value => String.fromCharCode(value)).join(''))
const fromB64 = (text: string) => Uint8Array.from(atob(text), char => char.charCodeAt(0))
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const text = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && ![...value].some(char => char.charCodeAt(0) < 32)
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('')

export class ShareError extends Error { constructor(message: string) { super(message) } }
function publicJwk(value: unknown): PublicJwk {
  if (!record(value) || value.kty !== 'EC' || value.crv !== 'P-256' || typeof value.x !== 'string' || typeof value.y !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.x) || !/^[A-Za-z0-9_-]{43}$/.test(value.y)) throw new ShareError('公開鍵の形式が不正です')
  return { kty: 'EC', crv: 'P-256', x: value.x, y: value.y }
}
export async function cardFingerprint(ecdsa: PublicJwk, ecdh: PublicJwk): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', utf8(canonicalJSON({ ecdh: publicJwk(ecdh), ecdsa: publicJwk(ecdsa) }))))
}
/** Grouped for reading aloud or comparing over a separate channel. */
export const fingerprintGroups = (fingerprint: string) => fingerprint.toUpperCase().match(/.{1,4}/g)!.join(' ')
export async function validateShareCard(value: unknown): Promise<ShareCard> {
  if (!record(value) || !exact(value, CARD_KEYS) || value.format !== 'michi-share-card' || value.version !== 1 || !text(value.display_name, 100) || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)) throw new ShareError('共有カードの形式が不正です')
  const ecdsa = publicJwk(value.ecdsa_public_jwk), ecdh = publicJwk(value.ecdh_public_jwk)
  if (await cardFingerprint(ecdsa, ecdh) !== value.fingerprint) throw new ShareError('共有カードの指紋が公開鍵と一致しません')
  return { format: 'michi-share-card', version: 1, display_name: value.display_name, ecdsa_public_jwk: ecdsa, ecdh_public_jwk: ecdh, fingerprint: value.fingerprint }
}
export async function generateShareIdentity(displayName: string): Promise<ShareIdentity> {
  if (!text(displayName.trim(), 100)) throw new ShareError('表示名を1〜100文字で入力してください')
  // Private keys are non-extractable; only the public halves are exported into the card.
  const signKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair
  const dhKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair
  const ecdsa = publicJwk(await crypto.subtle.exportKey('jwk', signKeys.publicKey)), ecdh = publicJwk(await crypto.subtle.exportKey('jwk', dhKeys.publicKey))
  const card: ShareCard = { format: 'michi-share-card', version: 1, display_name: displayName.trim(), ecdsa_public_jwk: ecdsa, ecdh_public_jwk: ecdh, fingerprint: await cardFingerprint(ecdsa, ecdh) }
  return { id: 'main', displayName: displayName.trim(), signKeys, dhKeys, card, createdAt: new Date().toISOString() }
}
async function contentKey(privateKey: CryptoKey, publicKey: PublicJwk, header: Pick<ShareHeader, 'kind' | 'share_id' | 'epoch' | 'sequence'>) {
  const peer = await crypto.subtle.importKey('jwk', { ...publicKey, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256)
  const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: utf8('michi-share-v1'), info: utf8(`${header.kind}|${header.share_id}|${header.epoch}|${header.sequence}`) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
const unsignedBody = (envelope: Omit<ShareEnvelope, 'signature'>) => utf8(canonicalJSON(envelope))
const aad = (header: ShareHeader, iv: string) => utf8(canonicalJSON({ ...header, iv }))
export async function sealShareEnvelope(input: { kind: ShareEnvelopeKind; shareId: string; epoch: number; sequence: number; payload: unknown; sender: ShareIdentity; recipient: ShareCard }): Promise<string> {
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const header: ShareHeader = { format: 'michi-share', version: 1, kind: input.kind, share_id: input.shareId, from_fp: input.sender.card.fingerprint, to_fp: input.recipient.fingerprint, epoch: input.epoch, sequence: input.sequence, issued_at: new Date().toISOString(), from_card: input.sender.card, epk: publicJwk(await crypto.subtle.exportKey('jwk', ephemeral.publicKey)) }
  const key = await contentKey(ephemeral.privateKey, input.recipient.ecdh_public_jwk, header), iv = b64(crypto.getRandomValues(new Uint8Array(12)))
  const ciphertext = b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fromB64(iv) as BufferSource, additionalData: aad(header, iv) as BufferSource }, key, utf8(canonicalJSON(input.payload)) as BufferSource)))
  const unsigned = { ...header, iv, ciphertext }
  const signature = b64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, input.sender.signKeys.privateKey, unsignedBody(unsigned) as BufferSource)))
  const envelope = JSON.stringify({ ...unsigned, signature })
  if (envelope.length > SHARE_MAX_BYTES) throw new ShareError('共有ファイルが5MBを超えます')
  return envelope
}
export function parseShareEnvelope(raw: string): ShareEnvelope {
  if (typeof raw !== 'string' || raw.length > SHARE_MAX_BYTES) throw new ShareError('5MBを超える共有ファイルは読み込めません')
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new ShareError('共有ファイルの形式が不正です') }
  if (!record(value) || !exact(value, ENVELOPE_KEYS) || value.format !== 'michi-share' || value.version !== 1 || !['grant', 'revoke', 'reply'].includes(value.kind as string) || !text(value.share_id) || typeof value.from_fp !== 'string' || !/^[a-f0-9]{64}$/.test(value.from_fp) || typeof value.to_fp !== 'string' || !/^[a-f0-9]{64}$/.test(value.to_fp) || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1 || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 || typeof value.issued_at !== 'string' || Number.isNaN(Date.parse(value.issued_at)) || typeof value.iv !== 'string' || typeof value.ciphertext !== 'string' || typeof value.signature !== 'string') throw new ShareError('共有ファイルの形式が不正です')
  publicJwk(value.epk)
  return value as ShareEnvelope
}
/** Verifies recipient, sender card, signature and authenticated decryption, in that order. Any failure rejects the whole file. */
export async function openShareEnvelope(raw: string, identity: ShareIdentity): Promise<{ header: ShareHeader; payload: unknown; senderCard: ShareCard }> {
  const envelope = parseShareEnvelope(raw)
  if (envelope.to_fp !== identity.card.fingerprint) throw new ShareError('この端末宛ての共有ファイルではありません')
  const senderCard = await validateShareCard(envelope.from_card)
  if (senderCard.fingerprint !== envelope.from_fp) throw new ShareError('送信者の指紋が一致しません')
  const { signature, ...unsigned } = envelope
  const verifier = await crypto.subtle.importKey('jwk', { ...senderCard.ecdsa_public_jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  let valid = false
  try { valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, fromB64(signature) as BufferSource, unsignedBody(unsigned) as BufferSource) } catch { valid = false }
  if (!valid) throw new ShareError('共有ファイルの署名が一致しません。改ざんされたか、別の送信者のファイルです')
  const { iv, ciphertext, ...header } = unsigned
  let plain: ArrayBuffer
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) as BufferSource, additionalData: aad(header, iv) as BufferSource }, await contentKey(identity.dhKeys.privateKey, header.epk, header), fromB64(ciphertext) as BufferSource) }
  catch { throw new ShareError('共有ファイルを復号できません') }
  let payload: unknown
  try { payload = JSON.parse(new TextDecoder().decode(plain)) } catch { throw new ShareError('共有ファイルの内容が不正です') }
  return { header, payload, senderCard }
}
