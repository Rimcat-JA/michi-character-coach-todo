import { describe, expect, it } from 'vitest'
import { canonicalJSON } from './canonical'
import { fingerprintGroups, generateShareIdentity, openShareEnvelope, parseShareEnvelope, sealShareEnvelope, validateShareCard } from './share-crypto'

const people = async () => ({ owner: await generateShareIdentity('所有者A'), recipient: await generateShareIdentity('相手B'), other: await generateShareIdentity('第三者C') })
const seal = (value: Awaited<ReturnType<typeof people>>, payload: unknown = { message: '共有する本文' }) => sealShareEnvelope({ kind: 'grant', shareId: 'share-1', epoch: 1, sequence: 1, payload, sender: value.owner, recipient: value.recipient.card })
function reencode(raw: string, change: (value: Record<string, unknown>) => void) { const value = JSON.parse(raw) as Record<string, unknown>; change(value); return JSON.stringify(value) }
function flip(base64: string) { const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0)); bytes[bytes.length - 1] ^= 1; return btoa(Array.from(bytes, value => String.fromCharCode(value)).join('')) }

describe('I06 共有ファイルの暗号と署名（WebCryptoのみ）', () => {
  it('秘密鍵は取り出せず、カードの指紋は公開鍵から再計算して一致する', async () => {
    const { owner } = await people()
    expect(owner.signKeys.privateKey.extractable).toBe(false); expect(owner.dhKeys.privateKey.extractable).toBe(false)
    expect(await validateShareCard(JSON.parse(JSON.stringify(owner.card)))).toEqual(owner.card)
    expect(fingerprintGroups(owner.card.fingerprint).split(' ')).toHaveLength(16)
    await expect(validateShareCard({ ...owner.card, fingerprint: 'a'.repeat(64) })).rejects.toThrow('指紋')
    await expect(validateShareCard({ ...owner.card, extra: true })).rejects.toThrow('形式')
  })

  it('宛先の本人だけが復号でき、別人（C）は宛先検査でも鍵でも開けない', async () => {
    const value = await people(), raw = await seal(value)
    expect(raw).not.toContain('共有する本文')
    expect((await openShareEnvelope(raw, value.recipient)).payload).toEqual({ message: '共有する本文' })
    await expect(openShareEnvelope(raw, value.other)).rejects.toThrow('宛て')
    // C pretends to be the addressee: the signature check fails first; with its own key the AES-GCM tag would fail as well.
    await expect(openShareEnvelope(reencode(raw, row => { row.to_fp = value.other.card.fingerprint }), value.other)).rejects.toThrow('署名')
  })

  it('ヘッダー・暗号文・署名の改ざんと送信者カードの差し替えを拒否する', async () => {
    const value = await people(), raw = await seal(value)
    await expect(openShareEnvelope(reencode(raw, row => { row.epoch = 2 }), value.recipient)).rejects.toThrow('署名')
    await expect(openShareEnvelope(reencode(raw, row => { row.ciphertext = flip(row.ciphertext as string) }), value.recipient)).rejects.toThrow('署名')
    await expect(openShareEnvelope(reencode(raw, row => { row.signature = flip(row.signature as string) }), value.recipient)).rejects.toThrow('署名')
    await expect(openShareEnvelope(reencode(raw, row => { row.from_card = value.other.card }), value.recipient)).rejects.toThrow('指紋')
    // A third party re-signing with its own card is a different sender, never the pinned owner.
    const forged = await sealShareEnvelope({ kind: 'grant', shareId: 'share-1', epoch: 1, sequence: 1, payload: {}, sender: value.other, recipient: value.recipient.card })
    expect((await openShareEnvelope(forged, value.recipient)).header.from_fp).toBe(value.other.card.fingerprint)
    // Even a correctly re-signed body with a flipped ciphertext bit fails the AES-GCM authentication.
    const tampered = JSON.parse(reencode(raw, row => { row.ciphertext = flip(row.ciphertext as string) })) as Record<string, unknown>
    delete tampered.signature
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, value.owner.signKeys.privateKey, new TextEncoder().encode(canonicalJSON(tampered))))
    await expect(openShareEnvelope(JSON.stringify({ ...tampered, signature: btoa(Array.from(signature, byte => String.fromCharCode(byte)).join('')) }), value.recipient)).rejects.toThrow('復号')
    expect(() => parseShareEnvelope(reencode(raw, row => { row.heads = {} }))).toThrow('形式')
    expect(() => parseShareEnvelope('x'.repeat(5 * 1024 * 1024 + 1))).toThrow('5MB')
  })
})
