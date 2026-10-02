import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './db'
import { completeTask } from './commands'
import { applyChangeSet, approveChangeSetFromUI } from './change-set'
import { adoptDetectedTask, enableSyntheticAI, secretQuote } from './source-quote-fixtures'
import { ensureShareIdentity, exportShareCard, importShareCard, pinShareOwner, verifyShareContact } from './share-identity'
import { changeShareRole, createShareGrant, issueShareBundle, revokeShareGrant } from './share-grants'
import { importShareBundle, listSharedInbound } from './share-inbox'
import { buildShareReply, importShareReply, prepareShareProposal } from './share-replies'
import { resolveSharedSourceLink, SHARE_MASKED_SOURCE } from './share-projection'
import type { ShareRole } from './share-types'
import { counts, humanClick, manualTask, resetDevices, switchDevice } from './device-test-fixtures'

beforeEach(() => { resetDevices(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T03:00:00.000Z')) })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

/** A = owner, B = recipient, C = someone else: three separate emulated profiles on one machine, not real people or accounts. */
async function setup(role: ShareRole = 'viewer') {
  const cards: Record<string, string> = {}
  for (const name of ['B', 'C']) { await switchDevice(name); await ensureShareIdentity(`相手${name}`, humanClick()); cards[name] = await exportShareCard() }
  await switchDevice('A')
  await ensureShareIdentity('所有者A', humanClick())
  await enableSyntheticAI()
  const { taskId, sourceId } = await adoptDetectedTask()
  const ownCard = await exportShareCard(), contact = await importShareCard(cards.B)
  await expect(createShareGrant({ taskId, recipientId: contact.id, role, sharedFields: ['title', 'scheduled_date', 'due_date'], shareNote: '' }, humanClick())).rejects.toThrow('指紋を確認')
  await verifyShareContact(contact.id, humanClick())
  const grant = await createShareGrant({ taskId, recipientId: contact.id, role, sharedFields: ['title', 'scheduled_date', 'due_date'], shareNote: '確認をお願いします' }, humanClick())
  const bundle = await issueShareBundle(grant.id, humanClick())
  return { taskId, sourceId, grant, bundle, ownCard, cards }
}
async function receive(bundle: string, ownerCard: string) {
  const first = await importShareBundle(bundle)
  expect(first.status).toBe('needs_owner_confirmation')
  if (first.status === 'needs_owner_confirmation') await pinShareOwner(first.card, humanClick())
  expect(JSON.parse(ownerCard).fingerprint).toBeTruthy()
  return importShareBundle(bundle)
}

describe('I06 ファイルでの共有スナップショット（閲覧）', () => {
  it('Bにはタイトルと日付だけが届き、出典リンクは常に「共有されていない出典です」。Bの端末に資料・引用は無い', async () => {
    const { bundle, ownCard, sourceId, taskId } = await setup()
    const before = await counts()
    await switchDevice('B')
    const result = await receive(bundle, ownCard)
    expect(result.status).toBe('stored')
    const [item] = await listSharedInbound()
    expect(Object.keys(item.projection!).sort()).toEqual(['due_date', 'scheduled_date', 'share_task_id', 'title'])
    expect(item.shareNote).toBe('確認をお願いします'); expect(item.ownerLabel).toBe('所有者A')
    expect(resolveSharedSourceLink(`michi://source/${sourceId}`)).toBe(SHARE_MASKED_SOURCE)
    expect(resolveSharedSourceLink(`michi://source/${sourceId}`)).toBe(resolveSharedSourceLink('michi://source/does-not-exist'))
    expect(await db.contextSources.count()).toBe(0); expect(await db.contextSnapshots.count()).toBe(0); expect(await db.taskSourceEvidence.count()).toBe(0)
    const everything = JSON.stringify(await Promise.all(db.tables.map(table => table.toArray())))
    expect(everything).not.toContain(secretQuote.slice(0, 12)); expect(everything).not.toContain(sourceId); expect(everything).not.toContain(taskId)
    // Shared items never become own tasks, ledger rows or today's work.
    expect(await counts()).toEqual({ tasks: 0, completions: 0, ledger: 0, assessments: 0 })
    await switchDevice('A')
    expect(await counts()).toEqual(before)
  })

  it('C（別の第三者）はBあての共有ファイルを開けない', async () => {
    const { bundle } = await setup()
    await switchDevice('C')
    await expect(importShareBundle(bundle)).rejects.toThrow('宛て')
    expect(await db.sharedInbound.count()).toBe(0)
  })

  it('取り消しで受け手の投影が消え、古い付与ファイルの再取込（epochの巻き戻し）と同じファイルの再生は拒否する', async () => {
    const { bundle, ownCard, grant, taskId } = await setup()
    await switchDevice('B'); await receive(bundle, ownCard)
    await expect(importShareBundle(bundle)).rejects.toThrow('取り込み済み')
    await switchDevice('A')
    await completeTask(taskId, (await db.tasks.get(taskId))!.revision)
    const refreshed = await issueShareBundle(grant.id, humanClick())
    const revoke = await revokeShareGrant(grant.id, humanClick())
    expect((await db.resourceGrants.get(grant.id))!).toMatchObject({ authorizationEpoch: 2, revokedAt: expect.any(String) })
    await switchDevice('B')
    expect((await importShareBundle(refreshed)).status).toBe('stored')
    expect((await importShareBundle(revoke)).status).toBe('revoked')
    expect(await listSharedInbound()).toEqual([])
    expect((await db.sharedInbound.get(grant.id))!.projection).toBeNull()
    await expect(importShareBundle(refreshed)).rejects.toThrow('古い共有')
    await expect(importShareBundle(bundle)).rejects.toThrow('古い共有')
  })
})

describe('I06 コメント・編集提案の返信ファイル', () => {
  it('確認済みの相手の名刺が別名で再取込されたら指紋確認は外れる', async () => {
    await switchDevice('B')
    await ensureShareIdentity('相手B', humanClick())
    const card = await exportShareCard()
    await switchDevice('A')
    await ensureShareIdentity('所有者A', humanClick())
    const contact = await importShareCard(card)
    await verifyShareContact(contact.id, humanClick())
    expect((await db.shareContacts.get(contact.id))!.verifiedAt).not.toBeNull()
    const relabeled = JSON.stringify({ ...JSON.parse(card), display_name: '偽の相手B' })
    const again = await importShareCard(relabeled)
    expect(again.displayName).toBe('偽の相手B')
    expect((await db.shareContacts.get(contact.id))!.verifiedAt).toBeNull()
  })
  it('Bのコメントは一度だけ、Bのラベルつきで追加される。取り消し後と古い権限の返信は拒否する', async () => {
    const { bundle, ownCard, grant, taskId } = await setup('commenter')
    await switchDevice('B'); await receive(bundle, ownCard)
    const reply = await buildShareReply(grant.id, { comments: ['金曜までに見ます'] }, humanClick())
    await expect(buildShareReply(grant.id, { proposal: { title: '変更' } }, humanClick())).rejects.toThrow('編集の提案')
    await switchDevice('A')
    expect(await importShareReply(reply)).toEqual({ added: 1, duplicates: 0, proposalId: null })
    expect(await importShareReply(reply)).toEqual({ added: 0, duplicates: 1, proposalId: null })
    const comments = await db.taskComments.where('taskId').equals(taskId).toArray()
    expect(comments).toHaveLength(1); expect(comments[0]).toMatchObject({ body: '金曜までに見ます', authorKind: 'share_recipient', authorLabel: '相手B' })
    await changeShareRole(grant.id, 'commenter', humanClick())
    await expect(importShareReply(reply)).rejects.toThrow('古い返信')
    await revokeShareGrant(grant.id, humanClick())
    await switchDevice('B')
    const late = await buildShareReply(grant.id, { comments: ['取り消し後のコメント'] }, humanClick())
    await switchDevice('A')
    await expect(importShareReply(late)).rejects.toThrow('取り消し')
    expect(await db.taskComments.where('taskId').equals(taskId).count()).toBe(1)
  })

  it('編集の提案は承認するまで何も変えず、手動ポイント・締め切りは提案できない', async () => {
    const { bundle, ownCard, grant } = await setup('editor')
    await switchDevice('A')
    const manual = await manualTask('手動25', 25)
    const manualGrant = await createShareGrant({ taskId: manual, recipientId: grant.recipientId, role: 'editor', sharedFields: ['title'], shareNote: '' }, humanClick())
    const manualBundle = await issueShareBundle(manualGrant.id, humanClick())
    await switchDevice('B'); await receive(bundle, ownCard); await importShareBundle(manualBundle)
    await expect(buildShareReply(manualGrant.id, { proposal: { manualPoints: '40' } }, humanClick())).rejects.toThrow('手動ポイント')
    await expect(buildShareReply(manualGrant.id, { proposal: { due_date: '2026-10-09' } }, humanClick())).rejects.toThrow('締め切り')
    const reply = await buildShareReply(manualGrant.id, { proposal: { title: 'Bの提案タイトル', scheduled_date: '2026-10-08' } }, humanClick())
    await switchDevice('A')
    const before = (await db.tasks.get(manual))!
    const { proposalId } = await importShareReply(reply)
    expect(await db.tasks.get(manual)).toEqual(before)
    await expect(prepareShareProposal(proposalId!, new Event('click'))).rejects.toThrow('本人確認')
    const { prepared, context } = await prepareShareProposal(proposalId!, humanClick())
    expect([...prepared.changes[0].fields].sort()).toEqual(['scheduledDate', 'title'])
    await expect(applyChangeSet(prepared, null, context, 'no-approval')).rejects.toMatchObject({ code: expect.stringMatching(/APPROVAL|HUMAN/) })
    expect(await db.tasks.get(manual)).toEqual(before)
    await applyChangeSet(prepared, await approveChangeSetFromUI(prepared, context, humanClick()), context, 'owner-approved')
    expect(await db.tasks.get(manual)).toMatchObject({ title: 'Bの提案タイトル', scheduledDate: '2026-10-08', score: { mode: 'manual', manualPoints: 25 }, effectivePoints: 25 })
  })

  it('役割を下げた後に残った編集提案の確認は拒否する', async () => {
    const { bundle, ownCard, grant } = await setup('editor')
    await switchDevice('A')
    const manual = await manualTask('手動25', 25)
    const manualGrant = await createShareGrant({ taskId: manual, recipientId: grant.recipientId, role: 'editor', sharedFields: ['title'], shareNote: '' }, humanClick())
    const manualBundle = await issueShareBundle(manualGrant.id, humanClick())
    await switchDevice('B'); await receive(bundle, ownCard); await importShareBundle(manualBundle)
    const reply = await buildShareReply(manualGrant.id, { proposal: { title: 'Bの古い提案' } }, humanClick())
    await switchDevice('A')
    const { proposalId } = await importShareReply(reply)
    expect(proposalId).not.toBeNull()
    await changeShareRole(manualGrant.id, 'viewer', humanClick())
    await expect(prepareShareProposal(proposalId!, humanClick())).rejects.toThrow('編集の提案')
  })
})
