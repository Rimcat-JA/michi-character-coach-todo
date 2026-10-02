/// <reference types="node" />
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, correctCompletion, createTask, newTaskInput, undoCompletion } from './commands'
import { emptyScore } from './domain'
import { addTaskAttachment, addTaskNote } from './materials'
import { achievementDB, approveAchievementFromUI, clearAchievementAuthority, createAchievementEvidenceFromUI, editAchievementPublicEvidenceFromUI, prepareAchievementExport, publishAchievementFromUI, reconcileAchievementExport, reconcileAchievementExports, saveAchievementDraftFromUI, saveAchievementPolicyFromUI } from './achievements-save'
import { achievementDraftFor, achievementTextHash, type AchievementEvidence, type AchievementExport } from './achievements'
import { achievementTestGateway } from './achievements-test-fixtures'
import { restoreAchievementExports, validateAchievementRecords, verifyAchievementDigests } from './achievements-validation'
import type { GitHubAchievementsGateway, GitHubGatewayStatus, GitHubPublishRequest, GitHubPublishResult } from './github-publish-types'
import { changePolicyFor } from './change-set'
import { automationRulesFor, type OperationGroup, type OperationMode } from './automation-policy'
import { captureSnapshot, restoreBackup } from './backup'

function nativeClick() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
function fakeGateway() {
  let status: GitHubGatewayStatus = structuredClone(achievementTestGateway)
  let publishResult: GitHubPublishResult | 'throw' | null = null, reconcileResult: GitHubPublishResult = { status: 'unknown', code: 'still_unknown' }
  const publish = vi.fn(async (request: GitHubPublishRequest): Promise<GitHubPublishResult> => {
    const row = await achievementDB.achievementExports.get(request.exportId)
    expect(row).toMatchObject({ state: 'committing', attemptId: request.attemptId, attemptCount: 1 });if(status.repository?.visibility!==row!.manifest.repository.visibility||status.repository.defaultBranch!==row!.manifest.repository.defaultBranch)return {status:'failed',code:'REPOSITORY_CHANGED'}
    if (publishResult === 'throw') throw new Error('fake disconnected response')
    if (publishResult) return publishResult
    return { status: 'published', receipt: { exportId: request.exportId, attemptId: request.attemptId, approvalDigest: request.approvalDigest, repositoryId: 42, publicId: row!.publicId, commitSha: 'b'.repeat(40), branch: 'main', recordPath: row!.recordPath, publishedAt: new Date().toISOString(), url: 'https://github.com/test-owner/test-achievements/blob/' + 'b'.repeat(40) + '/' + row!.recordPath, contribution: 'pending', pullRequestUrl: null } }
  })
  const recordReceipt = vi.fn(async (request: GitHubPublishRequest) => {
    const receipt = await db.commands.get(`achievement:publish:${request.exportId}:${request.attemptId}`)
    expect(receipt).toMatchObject({ hash: request.approvalDigest, resultId: request.exportId })
  })
  const api: GitHubAchievementsGateway = { status: vi.fn(async () => structuredClone(status)), storedStatus: vi.fn(async () => ({ ...structuredClone(status), state: 'awaiting_connection' as const })), inspectConfiguration: async () => { throw new Error('fake only') }, configure: async () => structuredClone(status), publish, recordReceipt, reconcile: vi.fn(async () => reconcileResult), disconnect: async () => ({ ...status, state: 'integration_not_configured', configurationId: null, repository: null }), invalidate: vi.fn(async () => undefined) }
  return { api, publish, recordReceipt, setStatus(value: GitHubGatewayStatus) { status = value }, setPublish(value: GitHubPublishResult | 'throw') { publishResult = value }, setReconcile(value: GitHubPublishResult) { reconcileResult = value } }
}
async function fixture(points: number | null = 40) {
  const owner = await ensureSettings(), gateway = fakeGateway()
  const policyId = await saveAchievementPolicyFromUI({ threshold: 40, allowedCategoryIds: [], allowedEvidenceKinds: ['artifact_file', 'user_statement', 'code_link'], requireAttachment: true, enabled: true }, nativeClick(), gateway.api)
  const taskId = await createTask({ ...newTaskInput(), title: '秘密の内部タスク名', notes: 'private notes', score: points === null ? emptyScore() : { ...emptyScore(), mode: 'manual', manualPoints: points } })
  const attachmentId = await addTaskAttachment(taskId, new File(['private bytes'], 'private-name.txt', { type: 'text/plain' }))
  await completeTask(taskId, 1)
  const completion = (await db.completions.where('taskId').equals(taskId).first())!
  const evidenceId = await createAchievementEvidenceFromUI({ completionId: completion.id, kind: 'artifact_file', attachmentId, publicText: '本人が選んだ独立した公開証拠説明', publicReviewed: true }, nativeClick())
  const selection = { title: '公開用成果名', body: '公開用に本人が編集した説明', evidenceIds: [evidenceId], includePastCompletion: false, correctionReason: '' }
  return { owner, gateway, policyId, taskId, attachmentId, completion, evidenceId, selection, proposal: () => prepareAchievementExport(completion.id, policyId, selection, gateway.api) }
}
beforeEach(async () => { clearAchievementAuthority(); await db.delete(); await db.open() })
describe('実績の本人承認・保存・送信状態', () => {
  it('PRのreceiptは公開ポイントを確定せず、squash mergeの読取確認後にだけ公開receiptを保存する', async () => {
    const value=await fixture(100),id=await approveAchievementFromUI(await value.proposal(),nativeClick(),value.gateway.api)
    value.gateway.api.publish=async request=>{const row=(await achievementDB.achievementExports.get(id))!;return {status:'pr_pending',receipt:{...request,repositoryId:42,publicId:row.publicId,commitSha:'a'.repeat(40),branch:'michi-achievements/'+row.publicId,recordPath:row.recordPath,publishedAt:new Date().toISOString(),url:'https://github.com/test-owner/test-achievements/commit/'+'a'.repeat(40),contribution:'pr_pending',pullRequestUrl:'https://github.com/test-owner/test-achievements/pull/1'}}}
    const pending=await publishAchievementFromUI(id,nativeClick(),value.gateway.api)
    expect(pending.state).toBe('pr_pending');expect(pending.publishedSummary).toBeNull();expect(value.gateway.recordReceipt).not.toHaveBeenCalled()
    expect(await db.commands.get(`achievement:publish:${id}:${pending.attemptId}`)).toBeUndefined()
    value.gateway.setReconcile({status:'published',receipt:{exportId:id,attemptId:pending.attemptId!,approvalDigest:pending.manifest.approvalDigest,repositoryId:42,publicId:pending.publicId,commitSha:'b'.repeat(40),branch:'main',recordPath:pending.recordPath,publishedAt:new Date().toISOString(),url:'https://github.com/test-owner/test-achievements/commit/'+'b'.repeat(40),contribution:'unverified',pullRequestUrl:'https://github.com/test-owner/test-achievements/pull/1'}})
    const merged=await reconcileAchievementExport(id,value.gateway.api)
    expect(merged).toMatchObject({state:'published',publishedSummary:{points:100},commitSha:'b'.repeat(40)});expect(value.gateway.recordReceipt).toHaveBeenCalledOnce()
  })
  it('未接続でも草稿/原本/公開説明はローカル保存でき、第三者送信しない', async () => {
    await ensureSettings()
    const taskId = await createTask({ ...newTaskInput(), title: 'offline', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
    await completeTask(taskId, 1)
    const completion = (await db.completions.where('taskId').equals(taskId).first())!
    await saveAchievementDraftFromUI(completion.id, 'ローカル草稿', '本人の説明', nativeClick())
    expect(achievementDraftFor(await achievementDB.achievementEvidence.toArray(), completion.id)).toEqual({ title: 'ローカル草稿', body: '本人の説明' })
    expect(await achievementDB.achievementExports.count()).toBe(0)
    expect(await db.ledger.count()).toBe(1)
  })
  it('合成クリックは原本保存/承認/送信に使えない', async () => {
    const value = await fixture(), event = new Event('click'), proposal = await value.proposal()
    await expect(approveAchievementFromUI(proposal, event, value.gateway.api)).rejects.toThrow('本人確認')
    await expect(createAchievementEvidenceFromUI({ completionId: value.completion.id, kind: 'user_statement', originalText: 'self', publicText: 'public', publicReviewed: true }, event)).rejects.toThrow('本人確認')
    const id = await approveAchievementFromUI(proposal, nativeClick(), value.gateway.api)
    await expect(publishAchievementFromUI(id, event, value.gateway.api)).rejects.toThrow('本人確認')
    expect(value.gateway.publish).not.toHaveBeenCalled()
  })
  it('40pt証拠承認後に一record一attemptを保存し、確認済みcommitでも草は反映待ち', async () => {
    const value = await fixture(100), beforeLedger = await db.ledger.toArray(), proposal = await value.proposal()
    expect(await achievementDB.achievementExports.count()).toBe(0)
    const id = await approveAchievementFromUI(proposal, nativeClick(), value.gateway.api)
    expect(value.gateway.publish).not.toHaveBeenCalled();vi.mocked(value.gateway.api.status).mockClear()
    const row = await publishAchievementFromUI(id, nativeClick(), value.gateway.api)
    expect(row).toMatchObject({ state: 'published', contribution: 'pending', attemptCount: 1, publishedSummary: { points: 100 } })
    expect(value.gateway.publish).toHaveBeenCalledOnce(); expect(value.gateway.recordReceipt).toHaveBeenCalledOnce();expect(value.gateway.api.status).not.toHaveBeenCalled()
    expect(await db.ledger.toArray()).toEqual(beforeLedger)
    await expect(publishAchievementFromUI(id, nativeClick(), value.gateway.api)).rejects.toThrow('本人承認')
    expect(await achievementDB.achievementExports.count()).toBe(1)
  })
  it('ポイント未知/証拠欠落は送信案を作れず、本人確定後に進められる', async () => {
    const value = await fixture(null)
    await expect(value.proposal()).rejects.toThrow('確定')
    await correctCompletion(value.taskId, 40, '本人が確認した実績')
    const proposal = await value.proposal()
    expect(proposal.row.summary.scoreMode).toBe('manual')
    await achievementDB.achievementEvidence.delete(value.evidenceId)
    await expect(value.proposal()).rejects.toThrow('証拠')
    expect(value.gateway.publish).not.toHaveBeenCalled()
  })
  it('同じrepo+完了に同時の公開案を承認しても一行だけ保存', async () => {
    const value = await fixture(), a = await value.proposal(), b = await value.proposal()
    const result = await Promise.allSettled([approveAchievementFromUI(a, nativeClick(), value.gateway.api), approveAchievementFromUI(b, nativeClick(), value.gateway.api)])
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(await achievementDB.achievementExports.count()).toBe(1)
  })
  it('登録済み案の本文/hash/選択改変やsource editは承認前に拒否', async () => {
    const value = await fixture(), proposal = await value.proposal(), changed = structuredClone(proposal)
    changed.row.selection.body = 'changed'
    await expect(approveAchievementFromUI(changed, nativeClick(), value.gateway.api)).rejects.toThrow('登録')
    await editAchievementPublicEvidenceFromUI(value.evidenceId, 1, '公開証拠説明を編集', true, nativeClick())
    await expect(approveAchievementFromUI(proposal, nativeClick(), value.gateway.api)).rejects.toThrow()
    expect(await achievementDB.achievementExports.count()).toBe(0)
  })
  it.each(['completion', 'epoch', 'source-permission', 'owner', 'visibility', 'branch', 'evidence', 'bytes'] as const)('承認後の%s変更を送信直前に拒否', async kind => {
    const value = await fixture(), id = await approveAchievementFromUI(await value.proposal(), nativeClick(), value.gateway.api)
    if (kind === 'completion') await correctCompletion(value.taskId, 50, '訂正')
    if (kind === 'epoch') { const settings = (await db.settings.get('main'))!; await db.settings.update('main', { changePolicy: { ...changePolicyFor(settings), epoch: changePolicyFor(settings).epoch + 1 } }) }
    if (kind === 'source-permission') { const settings = (await db.settings.get('main'))!; await db.settings.update('main', { changePolicy: { ...changePolicyFor(settings), sourcePermissionRevision: changePolicyFor(settings).sourcePermissionRevision + 1 } }) }
    if (kind === 'owner') await db.settings.update('main', { profileId: 'another-owner' })
    if (kind === 'visibility') value.gateway.setStatus({ ...achievementTestGateway, repository: { ...achievementTestGateway.repository!, visibility: 'private' } })
    if (kind === 'branch') value.gateway.setStatus({ ...achievementTestGateway, repository: { ...achievementTestGateway.repository!, defaultBranch: 'other' } })
    if (kind === 'evidence') await achievementDB.achievementEvidence.update(value.evidenceId, { revision: 2 })
    if (kind === 'bytes') await db.taskAttachments.update(value.attachmentId, { blob: new Blob(['tamperedbytes']) })
    if(kind==='visibility'||kind==='branch'){const row=await publishAchievementFromUI(id,nativeClick(),value.gateway.api);expect(row.state).toBe('failed');expect(value.gateway.publish).toHaveBeenCalledOnce();expect(row.commitSha).toBeNull()}else {await expect(publishAchievementFromUI(id, nativeClick(), value.gateway.api)).rejects.toThrow();expect(value.gateway.publish).not.toHaveBeenCalled();expect((await achievementDB.achievementExports.get(id))?.attemptCount).toBe(0)}
  })
  it('送信の結果不明は再送せず、読取照合で同じreceiptを保存する', async () => {
    const value = await fixture(), id = await approveAchievementFromUI(await value.proposal(), nativeClick(), value.gateway.api)
    value.gateway.setPublish('throw')
    const unknown = await publishAchievementFromUI(id, nativeClick(), value.gateway.api)
    expect(unknown.state).toBe('unknown')
    await expect(value.proposal()).rejects.toThrow('再送しません')
    await expect(publishAchievementFromUI(id, nativeClick(), value.gateway.api)).rejects.toThrow('承認')
    const receipt = { exportId: id, attemptId: unknown.attemptId!, approvalDigest: unknown.manifest.approvalDigest, repositoryId: 42, publicId: unknown.publicId, commitSha: 'b'.repeat(40), branch: 'main', recordPath: unknown.recordPath, publishedAt: new Date().toISOString(), url: 'https://github.com/test-owner/test-achievements/commit/' + 'b'.repeat(40), contribution: 'unverified' as const, pullRequestUrl: null }
    value.gateway.setReconcile({ status: 'published', receipt })
    expect((await reconcileAchievementExport(id, value.gateway.api)).state).toBe('published')
    expect(value.gateway.publish).toHaveBeenCalledOnce(); expect(value.gateway.recordReceipt).toHaveBeenCalledOnce()
    expect(await db.commands.get(`achievement:publish:${id}:${unknown.attemptId}`)).toMatchObject({ at: receipt.publishedAt })
  })
  it('期限切れや承認済みmanifestの改変はattemptを確保する前に拒否する', async () => {
    const value = await fixture(), id = await approveAchievementFromUI(await value.proposal(), nativeClick(), value.gateway.api), row = (await achievementDB.achievementExports.get(id))!
    row.manifest.files[0].content += 'x'
    await achievementDB.achievementExports.put(row)
    await expect(publishAchievementFromUI(id, nativeClick(), value.gateway.api)).rejects.toThrow('SHA-256')
    expect(value.gateway.publish).not.toHaveBeenCalled(); expect((await achievementDB.achievementExports.get(id))?.attemptCount).toBe(0)
    const fresh = await fixture(), freshId = await approveAchievementFromUI(await fresh.proposal(), nativeClick(), fresh.gateway.api)
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+16*60000)
    try { await expect(publishAchievementFromUI(freshId, nativeClick(), fresh.gateway.api)).rejects.toThrow('期限'); expect(fresh.gateway.publish).not.toHaveBeenCalled() } finally { clock.mockRestore() }
  })
  it('停止/期限切れはpending承認を解除し、既に公開した事実には訂正を推測しない', async () => {
    const value = await fixture(), id = await approveAchievementFromUI(await value.proposal(), nativeClick(), value.gateway.api)
    const owner = (await db.settings.get('main'))!, policy = changePolicyFor(owner)
    await db.settings.update('main', { changePolicy: { ...policy, epoch: policy.epoch + 1 } })
    await reconcileAchievementExports()
    expect(await achievementDB.achievementExports.get(id)).toMatchObject({ state: 'awaiting_review', approvedAt: null, approvedBy: null, attemptCount: 0 })
    const posted = await fixture(), postedId = await approveAchievementFromUI(await posted.proposal(), nativeClick(), posted.gateway.api)
    await publishAchievementFromUI(postedId, nativeClick(), posted.gateway.api)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60000)
    try { await reconcileAchievementExports(); expect((await achievementDB.achievementExports.get(postedId))?.state).toBe('published') } finally { clock.mockRestore() }
    expect(value.gateway.publish).not.toHaveBeenCalled()
  })
  it('不正な結果receiptは結果不明とし、保護branchの実PR無しを公開済みにしない', async () => {
    const value = await fixture(), id = await approveAchievementFromUI(await value.proposal(), nativeClick(), value.gateway.api)
    value.gateway.setPublish({ status: 'published', receipt: { exportId: 'wrong', attemptId: 'wrong', approvalDigest: 'f'.repeat(64), repositoryId: 42, publicId: 'wrong', commitSha: 'b'.repeat(40), branch: 'main', recordPath: 'wrong', publishedAt: new Date().toISOString(), url: 'https://github.com/test-owner/test-achievements/commit/' + 'b'.repeat(40), contribution: 'pending', pullRequestUrl: null } })
    await expect(publishAchievementFromUI(id, nativeClick(), value.gateway.api)).rejects.toThrow('receipt')
    expect((await achievementDB.achievementExports.get(id))?.state).toBe('unknown')
    const second = await fixture(), secondId = await approveAchievementFromUI(await second.proposal(), nativeClick(), second.gateway.api)
    second.gateway.setPublish({ status: 'failed', code: 'PROTECTED_BRANCH_REQUIRES_SEPARATE_PR' })
    const row = await publishAchievementFromUI(secondId, nativeClick(), second.gateway.api)
    expect(row.state).toBe('failed'); expect(row.commitSha).toBeNull(); expect(row.pullRequestUrl).toBeNull()
  })
  it('公開後の点数訂正/完了取消は同じrecordの訂正待ち、台帳や草を自動変更しない', async () => {
    const value = await fixture(100), id = await approveAchievementFromUI(await value.proposal(), nativeClick(), value.gateway.api), initial = await publishAchievementFromUI(id, nativeClick(), value.gateway.api)
    await correctCompletion(value.taskId, 80, '本人の訂正')
    await reconcileAchievementExports()
    expect(await achievementDB.achievementExports.get(id)).toMatchObject({ state: 'correction_pending', publishedSummary: { points: 100 }, commitSha: initial.commitSha })
    const before = await db.ledger.toArray(), corrected = await prepareAchievementExport(value.completion.id, value.policyId, { ...value.selection, correctionReason: '本人の訂正' }, value.gateway.api)
    expect(corrected.row.id).toBe(id); expect(corrected.row.publicId).toBe(initial.publicId); expect(corrected.row.summary.points).toBe(80)
    expect(await db.ledger.toArray()).toEqual(before); expect(value.gateway.publish).toHaveBeenCalledOnce()
    await undoCompletion(value.taskId, 2); await reconcileAchievementExports()
    const canceled = await prepareAchievementExport(value.completion.id, value.policyId, { ...value.selection, correctionReason: '完了取消' }, value.gateway.api)
    expect(canceled.row.summary).toMatchObject({ points: 0, canceled: true })
    expect(canceled.row.manifest.recordDate).toBe(initial.manifest.recordDate)
    expect(value.gateway.publish).toHaveBeenCalledOnce()
  })
  it('添付/自己ノート原本を消したらpending承認とcopied originalTextを破棄', async () => {
    const value = await fixture(), noteId = await addTaskNote(value.taskId, '秘密の自己ノート', 'self'), noteEvidenceId = await createAchievementEvidenceFromUI({ completionId: value.completion.id, kind: 'user_statement', noteId, publicText: '公開用自己説明', publicReviewed: true }, nativeClick())
    const id = await approveAchievementFromUI(await value.proposal(), nativeClick(), value.gateway.api)
    await db.taskNotes.delete(noteId); await db.taskAttachments.delete(value.attachmentId); await reconcileAchievementExports()
    expect(await achievementDB.achievementEvidence.get(noteEvidenceId)).toMatchObject({ status: 'removed', origin: { originalText: null }, publicReviewed: false })
    expect((await achievementDB.achievementEvidence.get(value.evidenceId))?.status).toBe('removed')
    expect((await achievementDB.achievementExports.get(id))?.state).toBe('awaiting_review')
    validateAchievementRecords(await achievementDB.achievementPolicies.toArray(), await achievementDB.achievementEvidence.toArray(), await achievementDB.achievementExports.toArray(), await db.tasks.toArray(), await db.completions.toArray(), await db.taskAttachments.toArray(), await db.taskNotes.toArray(), await db.settings.toArray())
  })
  it('復元時に承認を再実行せず、改変backupはDBを書き換えない', async () => {
    const value = await fixture(), id = await approveAchievementFromUI(await value.proposal(), nativeClick(), value.gateway.api), snapshot = await captureSnapshot() as Awaited<ReturnType<typeof captureSnapshot>> & {achievementEvidence: AchievementEvidence[];achievementExports:AchievementExport[]}
    expect(snapshot.achievementExports).toHaveLength(1)
    const bad = structuredClone(snapshot); bad.achievementExports![0].manifest.files[0].content += 'x'
    await expect(restoreBackup(bad)).rejects.toThrow('SHA-256')
    expect((await achievementDB.achievementExports.get(id))?.state).toBe('approved')
    await restoreBackup(snapshot)
    expect((await achievementDB.achievementExports.get(id))?.state).toBe('awaiting_review')
    expect(value.gateway.publish).not.toHaveBeenCalled()
    await expect(publishAchievementFromUI(id, nativeClick(), value.gateway.api)).rejects.toThrow('承認')
    await verifyAchievementDigests(snapshot.achievementEvidence!, snapshot.achievementExports!)
    expect(restoreAchievementExports(snapshot.achievementExports!)[0].approvedAt).toBeNull()
  })
  it('noteの原本とpublic説明は別hashで、sourceノートを本人証拠と偽らない', async () => {
    const value = await fixture(), sourceId = await addTaskNote(value.taskId, '外部資料', 'source')
    await expect(createAchievementEvidenceFromUI({ completionId: value.completion.id, kind: 'user_statement', noteId: sourceId, publicText: '公開説明', publicReviewed: true }, nativeClick())).rejects.toThrow('自己ノート')
    const noteId = await addTaskNote(value.taskId, '秘密の自己ノート', 'self'), id = await createAchievementEvidenceFromUI({ completionId: value.completion.id, kind: 'user_statement', noteId, publicText: '公開説明', publicReviewed: true }, nativeClick()), row = (await achievementDB.achievementEvidence.get(id))!
    expect(row.origin.sha256).toBe(await achievementTextHash('秘密の自己ノート'))
    expect(row.publicSha256).not.toBe(row.origin.sha256)
  })
})
async function setOperation(operation: OperationGroup, mode: OperationMode) { const current = (await db.settings.get('main'))!, policy = changePolicyFor(current); await db.settings.put({ ...current, changePolicy: { ...policy, operations: automationRulesFor(policy).map(rule => rule.operation === operation ? { ...rule, mode } : rule) } }) }
describe('N09 achievement.publish gate', () => {
  it('achievement.publish=deny prevents preparing or approving a publish while drafts and evidence stay', async () => {
    const value = await fixture(), proposal = await value.proposal()
    await setOperation('achievement.publish', 'deny')
    await expect(value.proposal()).rejects.toThrow('GitHub実績の公開は停止')
    await expect(approveAchievementFromUI(proposal, nativeClick(), value.gateway.api)).rejects.toThrow()
    expect(value.gateway.publish).not.toHaveBeenCalled(); expect(await achievementDB.achievementEvidence.count()).toBe(1); expect(await db.ledger.count()).toBe(1)
  })
})
