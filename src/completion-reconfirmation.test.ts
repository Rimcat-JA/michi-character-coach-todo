import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, correctCompletion, createTask, newTaskInput, undoCompletion, updateTask } from './commands'
import { addChecklistItem, convertChecklistItem } from './checklist'
import { calculateScore, emptyScore, uid, type Completion, type LedgerEntry } from './domain'
import { approveCompletionReconfirmationFromUI, cancelCompletionReconfirmation, clearCompletionReconfirmationAuthority, prepareCompletionReconfirmationFromUI, type CompletionReconfirmationInput } from './completion-reconfirmation'
import { applyCompletionReconfirmationFromUI } from './completion-reconfirmation-save'

beforeEach(async () => { clearCompletionReconfirmationAuthority(); await db.delete(); await db.open(); await ensureSettings() })
afterEach(() => { clearCompletionReconfirmationAuthority(); vi.restoreAllMocks(); vi.useRealTimers() })
const click = () => { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
const task = async (id: string) => (await db.tasks.get(id))!
const completion = async (id: string) => (await db.completions.where('taskId').equals(id).first())!
const finish = async (id: string) => completeTask(id, (await task(id)).revision)
const undo = async (id: string) => undoCompletion(id, (await task(id)).revision)
const total = async () => (await db.ledger.toArray()).reduce((sum, row) => sum + row.delta, 0)
const time = (second: number) => vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, 0, 0, second)))
async function cancelled(points: number | null = 40) {
  const id = await createTask({ ...newTaskInput(), title: '原タイトル', project: '原案件', score: points === null ? emptyScore() : { ...emptyScore(), mode: 'manual', manualPoints: points } })
  await finish(id); await undo(id); return id
}
async function input(id: string, points = 3, reason = '本人が実績を再確認したため'): Promise<CompletionReconfirmationInput> { return { taskId: id, expectedRevision: (await task(id)).revision, completionId: (await completion(id)).id, points, reason } }
async function prepared(id: string, points = 3, reason?: string) { return prepareCompletionReconfirmationFromUI(await input(id, points, reason), click()) }
async function restore(id: string, points = 3, reason?: string) {
  const proposal = await prepared(id, points, reason), event = click(), approval = await approveCompletionReconfirmationFromUI(proposal, proposal.digest, event, { points: true, impact: true })
  return { proposal, approval, receipt: await applyCompletionReconfirmationFromUI(proposal, approval, event) }
}
const snapshot = async () => ({ tasks: await db.tasks.toArray(), completions: await db.completions.toArray(), assessments: await db.assessments.toArray(), ledger: await db.ledger.toArray(), settings: await db.settings.toArray(), commands: await db.commands.toArray(), audits: await db.audits.toArray(), items: await db.checklistItems.toArray(), trips: await db.tripBundles.toArray() })

describe('本人のポイントと理由による取消実績の再確認', () => {
  it('確認案・承認では保存せず、同じ実績へmanual human評価を参照したrestoreだけを加える', async () => {
    const id = await cancelled(), oldCompletion = await completion(id), oldLedger = await db.ledger.toArray(), oldAssessments = await db.assessments.toArray()
    const before = await task(id), futureScore = { ...before.score, manualPoints: 99 }
    await updateTask(id, before.revision, { ...before, title: '将来のタイトル', project: '将来の案件', score: futureScore })
    const future = await task(id), initial = await snapshot(), proposal = await prepared(id, 42, '  実際の作業量を本人が42ptと確認  ')
    expect(proposal.input.reason).toBe('実際の作業量を本人が42ptと確認'); expect(proposal.preview.task.estimatePoints).toBe(99); expect(await snapshot()).toEqual(initial)
    const approval = await approveCompletionReconfirmationFromUI(proposal, proposal.digest, click(), { points: true, impact: true }); expect(await snapshot()).toEqual(initial)
    const receipt = await applyCompletionReconfirmationFromUI(proposal, approval, click())
    expect(await db.completions.count()).toBe(1)
    expect(await completion(id)).toMatchObject({ id: oldCompletion.id, originalAt: oldCompletion.originalAt, originalPoints: 40, title: '原タイトル', project: '原案件', netPoints: 42, lastConfirmedPoints: 42, scoreState: 'confirmed', reconfirmedAssessmentId: receipt.assessmentId })
    expect(await task(id)).toEqual({ ...future, status: 'completed', revision: future.revision + 1, updatedAt: receipt.appliedAt })
    expect(await db.assessments.get(receipt.assessmentId)).toMatchObject({ taskId: id, origin: 'human', ruleVersion: 'v1', score: { mode: 'manual', manualPoints: 42 }, result: { effective: 42 } })
    const newLedger = (await db.ledger.toArray()).filter(row => !oldLedger.some(old => old.id === row.id))
    expect(newLedger).toHaveLength(1); expect(newLedger[0]).toMatchObject({ completionId: oldCompletion.id, taskId: id, kind: 'restore', delta: 42, reason: proposal.input.reason, assessmentId: receipt.assessmentId })
    for (const row of oldLedger) expect(await db.ledger.get(row.id)).toEqual(row)
    for (const row of oldAssessments) expect(await db.assessments.get(row.id)).toEqual(row)
    expect(await total()).toBe(42)
  })
  it.each([0, 100000])('明示%dptは未設定にせず確定し、原未設定の履歴を維持する', async points => {
    const id = await cancelled(null), previous = await completion(id), result = await restore(id, points)
    expect(await completion(id)).toMatchObject({ id: previous.id, originalPoints: null, netPoints: points, lastConfirmedPoints: points, scoreState: 'confirmed' })
    expect((await db.ledger.toArray())[0]).toMatchObject({ kind: 'restore', delta: points, assessmentId: result.receipt.assessmentId })
    expect((await task(id)).effectivePoints).toBeNull(); expect(await total()).toBe(points)
  })
  it('AI停止・オフラインでも本人の実績再確認は使え、後の2pt訂正と通常再完了を保つ', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); time(0)
    const id = await cancelled(); await db.settings.update('main', { aiEnabled: false })
    const result = await restore(id, 3); await correctCompletion(id, 2, '後から本人が2ptと訂正'); await undo(id); await finish(id)
    expect(await completion(id)).toMatchObject({ originalPoints: 40, netPoints: 2, lastConfirmedPoints: 2, reconfirmedAssessmentId: result.receipt.assessmentId })
    expect((await db.assessments.get(result.receipt.assessmentId))?.result.effective).toBe(3)
    expect((await db.ledger.toArray()).filter(row => row.assessmentId)).toHaveLength(1); expect(await total()).toBe(2)
  })
  it('原40・取消実加点40・配分後保存値20・将来見積20を別欄に示す', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); time(0)
    const id = await createTask({ ...newTaskInput(), title: '40pt親', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } }); time(1); await finish(id); time(2); await undo(id)
    time(3); await convertChecklistItem(await addChecklistItem(id, '20pt子'), (await task(id)).revision, 20)
    const proposal = await prepared(id, 7)
    expect(proposal.preview.completion).toMatchObject({ originalPoints: 40, cachedPoints: 20 })
    expect(proposal.preview.cancellation).toMatchObject({ status: 'known', points: 40, at: new Date(Date.UTC(2026, 9, 1, 0, 0, 2)).toISOString() })
    expect(proposal.preview.allocation).toMatchObject({ hasChildren: true, parentRemainder: 20, combinedEstimatePoints: 40, combinedActivePoints: 0, proposedCombinedActivePoints: 7, proposedCombinedEstimatePoints: 27 })
    expect(proposal.preview.requiresImpactAcknowledgement).toBe(true)
    await expect(approveCompletionReconfirmationFromUI(proposal, proposal.digest, click(), { points: true, impact: false })).rejects.toThrow('影響')
  })
  it('同ミリ秒の旧配分を推測せず本人7ptで解決し、子の明示訂正12ptと削除後実績を総計に残す', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); time(0)
    const id = await cancelled(), child = await convertChecklistItem(await addChecklistItem(id, '子'), (await task(id)).revision, 20)
    const { allocationAssessmentId: _old, ...legacy } = await completion(id); await db.completions.put({ ...legacy, lastConfirmedPoints: 40 })
    await finish(child); await correctCompletion(child, 12, '本人の子実績'); await db.tasks.update(child, { deletedAt: new Date().toISOString() })
    await expect(finish(id)).rejects.toThrow('順序を確定できません')
    const proposal = await prepared(id, 7)
    expect(proposal.preview.cancellation.status).toBe('unknown')
    expect(proposal.preview.allocation).toMatchObject({ combinedActivePoints: 12, proposedCombinedActivePoints: 19, combinedEstimatePoints: 40, proposedCombinedEstimatePoints: 27 })
    expect(proposal.preview.allocation.children[0]).toMatchObject({ deleted: true, relation: 'verified', estimatePoints: 20, activePoints: 12 })
    const childBefore = await task(child), childCompletion = await completion(child), childLedger = await db.ledger.where('taskId').equals(child).toArray()
    const approval = await approveCompletionReconfirmationFromUI(proposal, proposal.digest, click(), { points: true, impact: true }); await applyCompletionReconfirmationFromUI(proposal, approval, click()); await undo(id); await finish(id)
    expect(await total()).toBe(19); expect(await task(child)).toEqual(childBefore); expect(await completion(child)).toEqual(childCompletion); expect(await db.ledger.where('taskId').equals(child).toArray()).toEqual(childLedger)
  })
  it('未確認の子参照は合計不明と表示し、本人の明示値でも子の参照・評価を修復しない', async () => {
    const id = await cancelled(), item = await addChecklistItem(id, '欠落した子')
    await db.checklistItems.update(item, { convertedTaskId: 'missing-child' }); const proposal = await prepared(id, 5)
    expect(proposal.preview.allocation.issues).not.toHaveLength(0); expect(proposal.preview.allocation.proposedCombinedActivePoints).toBeNull(); expect(proposal.preview.allocation.proposedCombinedEstimatePoints).toBeNull()
    await restore(id, 5); expect((await db.checklistItems.get(item))?.convertedTaskId).toBe('missing-child'); expect(await total()).toBe(5)
  })
  it('別親を含む相反するチェック項目由来は未確認とし、完全な親子総額を表示しない', async () => {
    const id = await cancelled(), child = await convertChecklistItem(await addChecklistItem(id, '20pt子'), (await task(id)).revision, 20)
    await db.audits.add({ id: uid(), taskId: child, operation: 'create_from_checklist', at: new Date().toISOString(), detail: '親タスク 別の親 の項目から作成' })
    const proposal = await prepared(id)
    expect(proposal.preview.allocation.children[0].relation).toBe('unresolved'); expect(proposal.preview.allocation.combinedActivePoints).toBeNull()
  })
  it.each(['completed-without-record', 'open-with-active-record'] as const)('%s の子実績を0ptと断定しない', async kind => {
    const id = await cancelled(), child = await convertChecklistItem(await addChecklistItem(id, '20pt子'), (await task(id)).revision, 20)
    if (kind === 'completed-without-record') await db.tasks.update(child, { status: 'completed' })
    else { await finish(child); await db.tasks.update(child, { status: 'open' }) }
    const proposal = await prepared(id)
    expect(proposal.preview.allocation.children[0].relation).toBe('unresolved'); expect(proposal.preview.allocation.combinedActivePoints).toBeNull()
  })
})

describe('再確認の本人権限・再送・不正入力', () => {
  it('同一案の同じキーと別キーの再送は一つのrestoreと同じreceiptを返す', async () => {
    const id = await cancelled(), { proposal, approval, receipt } = await restore(id, 8), before = await snapshot()
    expect(await applyCompletionReconfirmationFromUI(proposal, approval, click())).toEqual(receipt); expect(await snapshot()).toEqual(before)
    expect(await applyCompletionReconfirmationFromUI(proposal, approval, click(), 'alternate-key')).toEqual(receipt)
    expect((await db.ledger.toArray()).filter(row => row.kind === 'restore')).toHaveLength(1); expect(await db.assessments.count()).toBe(before.assessments.length)
  })
  it('後の訂正・取消・通常再完了後も旧receiptは同じimmutable実績参照で返し再加点しない', async () => {
    const id = await cancelled(), { proposal, approval, receipt } = await restore(id, 3)
    await correctCompletion(id, 2, '本人の後日訂正'); await undo(id)
    const cancelledState = await snapshot(); expect(await applyCompletionReconfirmationFromUI(proposal, approval, click())).toEqual(receipt); expect(await snapshot()).toEqual(cancelledState)
    await finish(id); const restoredState = await snapshot(); expect(await applyCompletionReconfirmationFromUI(proposal, approval, click())).toEqual(receipt); expect(await snapshot()).toEqual(restoredState); expect(await total()).toBe(2)
  })
  it.each(['points', 'task', 'missing-restore', 'missing-audit', 'changed-assessment'] as const)('%sに改変されたdurable receiptから成功を捏造したり別キーを追加しない', async kind => {
    const id = await cancelled(), { proposal, approval, receipt } = await restore(id, 8)
    if (kind === 'points' || kind === 'task') {
      for (const command of (await db.commands.toArray()).filter(row => row.key.startsWith('reconfirmation:'))) {
        const forged = { ...receipt, ...(kind === 'points' ? { points: 900 } : { taskId: 'another-task' }) }; await db.commands.put({ ...command, resultId: JSON.stringify(forged) })
      }
    }
    if (kind === 'missing-restore') { const row = (await db.ledger.where('completionId').equals(receipt.completionId).toArray()).find(entry => entry.assessmentId === receipt.assessmentId)!; await db.ledger.delete(row.id) }
    if (kind === 'missing-audit') { const row = (await db.audits.where('taskId').equals(id).toArray()).find(entry => entry.operation === 'completion.reconfirmed')!; await db.audits.delete(row.id) }
    if (kind === 'changed-assessment') { const row = (await db.assessments.get(receipt.assessmentId))!; const score = { ...row.score, manualPoints: 9 }; await db.assessments.put({ ...row, score, result: calculateScore(score) }) }
    const before = await snapshot()
    await expect(applyCompletionReconfirmationFromUI(proposal, approval, click())).rejects.toThrow('根拠が一致')
    await expect(applyCompletionReconfirmationFromUI(proposal, approval, click(), 'forged-alias')).rejects.toThrow('根拠が一致'); expect(await snapshot()).toEqual(before)
  })
  it('取消状態にfake receiptだけ挿入しても有効restoreの根拠がなく成功を返さない', async () => {
    const id = await cancelled(), proposal = await prepared(id), approval = await approveCompletionReconfirmationFromUI(proposal, proposal.digest, click(), { points: true, impact: true })
    await db.commands.add({ key: `reconfirmation:applied:${proposal.id}`, hash: proposal.digest, resultId: JSON.stringify({ taskId: id, completionId: proposal.input.completionId, revision: proposal.input.expectedRevision + 1, points: proposal.input.points, assessmentId: (await task(id)).assessmentId, appliedAt: new Date().toISOString() }), at: new Date().toISOString() })
    const before = await snapshot(); await expect(applyCompletionReconfirmationFromUI(proposal, approval, click(), 'fake-result-alias')).rejects.toThrow('根拠が一致'); expect(await snapshot()).toEqual(before)
  })
  it('同じ実行キーを取消後の別内容へ再利用できず、旧receiptは保存する', async () => {
    const id = await cancelled(), first = await prepared(id, 3), firstGrant = await approveCompletionReconfirmationFromUI(first, first.digest, click(), { points: true, impact: true })
    await applyCompletionReconfirmationFromUI(first, firstGrant, click(), 'fixed-key'); await undo(id)
    const second = await prepared(id, 4), secondGrant = await approveCompletionReconfirmationFromUI(second, second.digest, click(), { points: true, impact: true }), before = await snapshot()
    await expect(applyCompletionReconfirmationFromUI(second, secondGrant, click(), 'fixed-key')).rejects.toThrow('同じ実行キー'); expect(await snapshot()).toEqual(before)
  })
  it('copied JSON案・copied承認・非nativeボタン・digest不一致は変更を残さない', async () => {
    const id = await cancelled(), proposal = await prepared(id), approval = await approveCompletionReconfirmationFromUI(proposal, proposal.digest, click(), { points: true, impact: true }), before = await snapshot()
    await expect(prepareCompletionReconfirmationFromUI(await input(id), new Event('click'))).rejects.toThrow('本人')
    await expect(prepareCompletionReconfirmationFromUI(await input(id), { isTrusted: true, type: 'click' } as Event)).rejects.toThrow('本人')
    await expect(approveCompletionReconfirmationFromUI(proposal, 'different-digest', click(), { points: true, impact: true })).rejects.toThrow('確認')
    await expect(applyCompletionReconfirmationFromUI(structuredClone(proposal), approval, click())).rejects.toThrow('登録済み')
    await expect(applyCompletionReconfirmationFromUI(proposal, structuredClone(approval), click())).rejects.toThrow('本人承認')
    await expect(applyCompletionReconfirmationFromUI(proposal, approval, new Event('click'))).rejects.toThrow('本人'); expect(await snapshot()).toEqual(before)
  })
  it('exact取消は対象案だけを失効し、コピーによる取消は他案を破棄しない', async () => {
    const id = await cancelled(), first = await prepared(id, 3), second = await prepared(id, 4)
    cancelCompletionReconfirmation(structuredClone(second)); cancelCompletionReconfirmation(first)
    await expect(approveCompletionReconfirmationFromUI(first, first.digest, click(), { points: true, impact: true })).rejects.toThrow('登録済み')
    const grant = await approveCompletionReconfirmationFromUI(second, second.digest, click(), { points: true, impact: true }); await applyCompletionReconfirmationFromUI(second, grant, click()); expect(await total()).toBe(4)
  })
  it('期限切れを確認した案は時計を戻しても再登録できない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); time(0)
    const id = await cancelled(), proposal = await prepared(id), before = await snapshot()
    vi.setSystemTime(new Date(Date.parse(proposal.expiresAt)))
    await expect(approveCompletionReconfirmationFromUI(proposal, proposal.digest, click(), { points: true, impact: true })).rejects.toThrow('期限')
    time(0); await expect(approveCompletionReconfirmationFromUI(proposal, proposal.digest, click(), { points: true, impact: true })).rejects.toThrow('登録済み'); expect(await snapshot()).toEqual(before)
  })
  it.each(['owner', 'dataset', 'epoch', 'permission'] as const)('%s変更で本人案が失効してから元値へ戻しても復活しない', async kind => {
    const id = await cancelled(), proposal = await prepared(id), original = (await db.settings.get('main'))!
    const changed = structuredClone(original)
    if (kind === 'owner') changed.profileId = uid()
    if (kind === 'dataset') changed.datasetId = uid()
    if (kind === 'epoch' || kind === 'permission') { const { changePolicyFor } = await import('./change-set'); changed.changePolicy = changePolicyFor(original); if (kind === 'epoch') changed.changePolicy.epoch++; else changed.changePolicy.sourcePermissionRevision++ }
    await db.settings.put(changed); await expect(approveCompletionReconfirmationFromUI(proposal, proposal.digest, click(), { points: true, impact: true })).rejects.toThrow('権限')
    await db.settings.put(original); const before = await snapshot(); await expect(approveCompletionReconfirmationFromUI(proposal, proposal.digest, click(), { points: true, impact: true })).rejects.toThrow('登録済み'); expect(await snapshot()).toEqual(before)
  })
  it.each([-1, 0.5, 100001, Number.NaN, Number.POSITIVE_INFINITY])('不正ポイント%sを保存しない', async points => {
    const id = await cancelled(), before = await snapshot(); await expect(prepared(id, points)).rejects.toThrow('整数ポイント'); expect(await snapshot()).toEqual(before)
  })
  it.each([' ', 'a'.repeat(2001)])('空または長すぎる理由を保存しない', async reason => {
    const id = await cancelled(), before = await snapshot(); await expect(prepared(id, 3, reason)).rejects.toThrow('理由'); expect(await snapshot()).toEqual(before)
  })
  it('取消していない実績・違うcompletion・stale revisionを確認案にしない', async () => {
    const id = await cancelled(), other = await cancelled(), correct = await input(id), before = await snapshot()
    await expect(prepareCompletionReconfirmationFromUI({ ...correct, completionId: (await completion(other)).id }, click())).rejects.toThrow('対象・版')
    await expect(prepareCompletionReconfirmationFromUI({ ...correct, expectedRevision: correct.expectedRevision + 1 }, click())).rejects.toThrow('対象・版')
    await finish(id); await expect(prepared(id)).rejects.toThrow('対象・版'); expect((await snapshot()).ledger.length).toBe(before.ledger.length + 1)
  })
  it.each(['fraction', 'unknown-kind', 'task-mismatch', 'noninteger-cancel-cache', 'projected-result'] as const)('%s の破損実値を再確認によって隠さない', async kind => {
    const id = await cancelled(), entry = (await db.ledger.where('taskId').equals(id).toArray())[0]
    if (kind === 'fraction') { await db.ledger.update(entry.id, { delta: 40.5 }); const reverse = (await db.ledger.where('taskId').equals(id).toArray()).find(row => row.kind === 'reverse')!; await db.ledger.update(reverse.id, { delta: -40.5 }) }
    if (kind === 'unknown-kind') await db.ledger.update(entry.id, { kind: 'unknown' as LedgerEntry['kind'] })
    if (kind === 'task-mismatch') await db.ledger.update(entry.id, { taskId: 'unrelated' })
    if (kind === 'noninteger-cancel-cache') await db.completions.update((await completion(id)).id, { lastConfirmedPoints: 0.5 })
    if (kind === 'projected-result') { const assessment = (await db.assessments.get((await task(id)).assessmentId))!; await db.assessments.put({ ...assessment, result: { ...calculateScore(assessment.score), label: '根拠を差し替えた値' } }) }
    const before = await snapshot(); await expect(prepared(id)).rejects.toThrow(); expect(await snapshot()).toEqual(before)
  })
  it('再確認markerの取消cache欠落・参照破損は通常再完了で将来見積へ代替しない', async () => {
    const id = await cancelled(); await restore(id); await undo(id)
    const cached = await completion(id), { lastConfirmedPoints: _cache, ...missing } = cached
    await db.completions.put(missing as Completion); const before = await snapshot(); await expect(finish(id)).rejects.toThrow('確定ポイントがありません'); expect(await snapshot()).toEqual(before)
    await db.completions.put(cached); await db.assessments.delete(cached.reconfirmedAssessmentId!); const broken = await snapshot(); await expect(finish(id)).rejects.toThrow('評価参照'); expect(await snapshot()).toEqual(broken)
  })
  it.each(['extra-ledger', 'wrong-result-range', 'human-instruction'] as const)('%s の再確認marker根拠を通常再完了もnative新規案も採用しない', async kind => {
    const id = await cancelled(), result = await restore(id, 3); await undo(id)
    if (kind === 'extra-ledger') await db.ledger.add({ id: uid(), completionId: result.receipt.completionId, taskId: id, kind: 'adjust', delta: 1, at: new Date().toISOString(), reason: '整合しない加点' })
    if (kind === 'wrong-result-range') { const row = (await db.assessments.get(result.receipt.assessmentId))!; await db.assessments.put({ ...row, result: { ...row.result, lower: 4 } }) }
    if (kind === 'human-instruction') { const row = (await db.assessments.get(result.receipt.assessmentId))!; await db.assessments.put({ ...row, instruction: { forged: true } } as unknown as typeof row) }
    const before = await snapshot(); await expect(finish(id)).rejects.toThrow(); await expect(prepared(id)).rejects.toThrow(); expect(await snapshot()).toEqual(before)
  })
})
