import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './db'
import { exportShareCard, ensureShareIdentity, importShareCard, pinShareOwner, verifyShareContact } from './share-identity'
import { changeShareRole, createShareGrant, issueShareBundle, previewSharePayload, revokeShareGrant } from './share-grants'
import { importShareBundle, listSharedInbound } from './share-inbox'
import { applyShareProposalFromUI, buildShareReply, importShareReply, prepareShareProposal } from './share-replies'
import { shareExpiry, validateShareExpiry } from './share-lifetime'
import { sealShareEnvelope } from './share-crypto'
import { humanClick, manualTask, resetDevices, switchDevice } from './device-test-fixtures'

beforeEach(() => resetDevices())
afterEach(() => vi.restoreAllMocks())

async function pair(role: 'viewer' | 'commenter' | 'editor' = 'editor') {
  await switchDevice('B')
  await ensureShareIdentity('相手B', humanClick())
  const cardB = await exportShareCard()
  await switchDevice('A')
  await ensureShareIdentity('所有者A', humanClick())
  const contact = await importShareCard(cardB)
  await verifyShareContact(contact.id, humanClick())
  const cardA = await exportShareCard(), taskId = await manualTask('共有25pt', 25)
  const grant = await createShareGrant({ taskId, recipientId: contact.id, role, sharedFields: ['title'], shareNote: '期限付きの共有', expiresAt: shareExpiry(1) }, humanClick())
  const bundle = await issueShareBundle(grant.id, humanClick())
  return { grant, bundle, cardA, taskId }
}
async function receive(bundle: string, cardA: string) {
  await switchDevice('B')
  const contact = await importShareCard(cardA)
  await pinShareOwner(contact.card, humanClick())
  return importShareBundle(bundle)
}

describe('I06 有効期限付きの暗号化共有', () => {
  it('期限直前は表示・返信可能、期限到達で内容を消し、所有者も返信・再発行・提案を拒否する', async () => {
    const { grant, bundle, cardA, taskId } = await pair()
    await receive(bundle, cardA)
    expect((await listSharedInbound())[0].expiresAt).toBe(grant.expiresAt)
    const reply = await buildShareReply(grant.id, { comments: ['期限前のコメント'], proposal: { title: '期限前の提案' } }, humanClick())
    await switchDevice('A')
    const result = await importShareReply(reply)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(grant.expiresAt!))
    await expect(issueShareBundle(grant.id, humanClick())).rejects.toThrow('有効期限')
    await expect(importShareReply(reply)).rejects.toThrow('有効期限')
    await expect(prepareShareProposal(result.proposalId!, humanClick())).rejects.toThrow('有効期限')
    expect((await db.tasks.get(taskId))!.title).toBe('共有25pt')
    expect(await db.ledger.count()).toBe(0)
    await switchDevice('B')
    expect(await listSharedInbound()).toEqual([])
    const tombstone = (await db.sharedInbound.get(grant.id))!
    expect(tombstone).toMatchObject({ projection: null, shareNote: '', sharedFields: [], sequence: 1, epoch: 1 })
    await expect(buildShareReply(grant.id, { comments: ['期限後'] }, humanClick())).rejects.toThrow('有効期限')
    await expect(importShareBundle(bundle)).rejects.toThrow('取り込み済み')
    clock.mockRestore()
    expect(await listSharedInbound()).toEqual([]) // Clearing content is not undone by a clock rollback.
  })

  it('初回取込時に期限切れのファイルは内容を保存せずtombstoneだけ残す', async () => {
    const { grant, bundle, cardA } = await pair()
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(grant.expiresAt!))
    const result = await receive(bundle, cardA)
    expect(result.status).toBe('expired')
    expect((await db.sharedInbound.get(grant.id))!.projection).toBeNull()
    expect(await db.tasks.count()).toBe(0)
    expect(await listSharedInbound()).toEqual([])
  })

  it('不正な日時・過去・365日超・新規の無期限共有を拒否する', async () => {
    for (const value of ['2026-02-30T00:00:00.000Z', 'bad', 1, '2026-10-03']) expect(() => validateShareExpiry(value)).toThrow()
    expect(() => shareExpiry(0)).toThrow(); expect(() => shareExpiry(366)).toThrow()
    const { grant, taskId } = await pair()
    for (const expiresAt of [new Date(Date.now() - 1).toISOString(), new Date(Date.now() + 366 * 86400000).toISOString(), null]) {
      await expect(createShareGrant({ taskId, recipientId: grant.recipientId, role: 'viewer', sharedFields: ['title'], shareNote: '', expiresAt: expiresAt as string }, humanClick())).rejects.toThrow()
    }
  })
})

describe('I06 暗号化中の権限変更・返信の再生・古い提案', () => {
  it('送る内容のpreview後に値が変わったら、新規grantと初回発行は再確認を要求する', async () => {
    const { grant, taskId } = await pair()
    const input = { taskId, recipientId: grant.recipientId, role: 'viewer' as const, sharedFields: ['title'] as const, shareNote: '', expiresAt: shareExpiry(7) }
    const editable = { ...input, sharedFields: [...input.sharedFields] }, preview = await previewSharePayload(editable)
    const fresh = await createShareGrant(editable, humanClick(), preview)
    await db.tasks.update(taskId, { title: 'preview後の別の内容' })
    await expect(createShareGrant(editable, humanClick(), preview)).rejects.toThrow('確認した送る内容')
    await expect(issueShareBundle(fresh.id, humanClick(), preview)).rejects.toThrow('確認した送る内容')
    expect((await db.resourceGrants.get(fresh.id))!.sequence).toBe(0)
  })

  it('署名中に役割が変わったら古いgrantを保存・返却せず、現在のepochを保つ', async () => {
    const { grant } = await pair()
    const original = crypto.subtle.sign.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'sign').mockImplementationOnce(async (...args) => {
      const result = await original(...args)
      await changeShareRole(grant.id, 'viewer', humanClick())
      return result
    })
    await expect(issueShareBundle(grant.id, humanClick())).rejects.toThrow('処理中に共有')
    expect(await db.resourceGrants.get(grant.id)).toMatchObject({ role: 'viewer', authorizationEpoch: 2, sequence: 0 })
  })

  it('署名中に取り消しファイルを受け取ったら返信を返さず、取り消しtombstoneを保つ', async () => {
    const { grant, bundle, cardA } = await pair()
    const revoke = await revokeShareGrant(grant.id, humanClick())
    await receive(bundle, cardA)
    const original = crypto.subtle.sign.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'sign').mockImplementationOnce(async (...args) => {
      const result = await original(...args)
      await importShareBundle(revoke)
      return result
    })
    await expect(buildShareReply(grant.id, { comments: ['競合した返信'] }, humanClick())).rejects.toThrow('処理中に共有')
    expect(await db.sharedInbound.get(grant.id)).toMatchObject({ epoch: 2, projection: null, replySequence: 0 })
  })

  it('同じsequenceで違う内容を追加せず、同じコメントIDの改変も拒否する', async () => {
    const { grant, bundle, cardA, taskId } = await pair('commenter')
    await receive(bundle, cardA)
    const sender = (await db.shareIdentity.get('main'))!, owner = (await db.shareContacts.get(JSON.parse(cardA).fingerprint))!
    const payload = { grant_id: grant.id, epoch: 1, comments: [{ id: 'comment-0001', share_task_id: grant.id, body: '原文' }], proposal: null }
    const encode = (value: unknown) => sealShareEnvelope({ kind: 'reply', shareId: grant.id, epoch: 1, sequence: 1, payload: value, sender, recipient: owner.card })
    const original = await encode(payload)
    const changed = await encode({ ...payload, comments: [{ ...payload.comments[0], body: '改変' }] })
    const reusedSequence = await encode({ ...payload, comments: [{ ...payload.comments[0], id: 'comment-0002' }] })
    await switchDevice('A')
    expect(await importShareReply(original)).toMatchObject({ added: 1 })
    expect(await importShareReply(original)).toMatchObject({ added: 0, duplicates: 1 })
    await expect(importShareReply(changed)).rejects.toThrow('同じコメントID')
    await expect(importShareReply(reusedSequence)).rejects.toThrow('古い返信')
    expect(await db.taskComments.where('taskId').equals(taskId).count()).toBe(1)
  })

  it('editor→viewer→editorに戻しても以前のepochの提案は復活しない', async () => {
    const { grant, bundle, cardA } = await pair()
    await receive(bundle, cardA)
    const reply = await buildShareReply(grant.id, { proposal: { title: '古い提案' } }, humanClick())
    await switchDevice('A')
    const { proposalId } = await importShareReply(reply)
    await changeShareRole(grant.id, 'viewer', humanClick())
    await changeShareRole(grant.id, 'editor', humanClick())
    await expect(prepareShareProposal(proposalId!, humanClick())).rejects.toThrow('古い権限版')
    expect(await db.ledger.count()).toBe(0)
  })

  it('通常のChangeSet承認を使い、承認直前の取消・期限切れは業務更新も提案状態も変えない', async () => {
    const { grant, bundle, cardA, taskId } = await pair()
    await receive(bundle, cardA)
    const reply = await buildShareReply(grant.id, { proposal: { title: '本人が採用する提案' } }, humanClick())
    await switchDevice('A')
    const { proposalId } = await importShareReply(reply)
    const review = await prepareShareProposal(proposalId!, humanClick())
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(grant.expiresAt!))
    await expect(applyShareProposalFromUI(proposalId!, review.prepared, review.context, humanClick(), ['title'])).rejects.toThrow()
    clock.mockRestore()
    expect((await db.tasks.get(taskId))!.title).toBe('共有25pt')
    expect((await db.shareProposals.get(proposalId!))!.state).toBe('pending')
    const receipt = await applyShareProposalFromUI(proposalId!, review.prepared, review.context, humanClick(), ['title'])
    expect(receipt.taskIds).toEqual([taskId])
    expect((await db.tasks.get(taskId))!.title).toBe('本人が採用する提案')
    expect((await db.shareProposals.get(proposalId!))!.state).toBe('applied')
    expect(await db.ledger.count()).toBe(0)
  })

  it('確認画面を開いた後に権限を取り消したら適用を拒否する', async () => {
    const { grant, bundle, cardA, taskId } = await pair()
    await receive(bundle, cardA)
    const reply = await buildShareReply(grant.id, { proposal: { title: '古い確認画面' } }, humanClick())
    await switchDevice('A')
    const { proposalId } = await importShareReply(reply)
    const review = await prepareShareProposal(proposalId!, humanClick())
    await revokeShareGrant(grant.id, humanClick())
    await expect(applyShareProposalFromUI(proposalId!, review.prepared, review.context, humanClick(), ['title'])).rejects.toThrow('確認後に共有')
    expect((await db.tasks.get(taskId))!.title).toBe('共有25pt')
    expect((await db.shareProposals.get(proposalId!))!.state).toBe('pending')
  })
})
