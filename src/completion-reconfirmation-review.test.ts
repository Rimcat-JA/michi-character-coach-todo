import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, correctCompletion, createTask, newTaskInput, undoCompletion, updateTask } from './commands'
import { emptyScore } from './domain'
import { addChecklistItem, convertChecklistItem } from './checklist'
import { applyBreakdownProposal, suggestBreakdown } from './breakdown'
import { captureSnapshot, restoreBackup } from './backup'
import { applyTripBundle } from './trip-bundle-save'
import { prepareTripBundle } from './trip-bundles'
import { approveCompletionReconfirmationFromUI, cancelCompletionReconfirmation, clearCompletionReconfirmationAuthority,
  prepareCompletionReconfirmationFromUI, reconfirmationTables } from './completion-reconfirmation'
import { applyCompletionReconfirmationFromUI } from './completion-reconfirmation-save'

beforeEach(async () => { clearCompletionReconfirmationAuthority(); await db.delete(); await db.open(); await ensureSettings() })
afterEach(() => { clearCompletionReconfirmationAuthority(); vi.restoreAllMocks(); vi.useRealTimers() })
const click = () => { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
const task = async (id: string) => (await db.tasks.get(id))!
const completion = async (id: string) => (await db.completions.where('taskId').equals(id).first())!
const finish = async (id: string) => completeTask(id, (await task(id)).revision)
const undo = async (id: string) => undoCompletion(id, (await task(id)).revision)
async function storage() {
  return { tasks: await db.tasks.toArray(), assessments: await db.assessments.toArray(), completions: await db.completions.toArray(),
    ledger: await db.ledger.toArray(), links: await db.checklistItems.toArray(), trips: await db.tripBundles.toArray(),
    commands: await db.commands.toArray(), audits: await db.audits.toArray(), settings: await db.settings.toArray() }
}
async function cancelledTask() {
  const id = await createTask({ ...newTaskInput(), title: '取消実績の独立検証', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
  await finish(id); await undo(id)
  const current = await task(id)
  await updateTask(id, current.revision, { ...current, score: { ...current.score, manualPoints: 9 } })
  return id
}
async function prepare(id: string, points = 3) {
  return prepareCompletionReconfirmationFromUI({ taskId: id, expectedRevision: (await task(id)).revision,
    completionId: (await completion(id)).id, points, reason: '本人が原記録と現在の配分を確認' }, click())
}
async function approved(id: string, points = 3) {
  const prepared = await prepare(id, points)
  return { prepared, approval: await approveCompletionReconfirmationFromUI(prepared, prepared.digest, click(), { points: true, impact: true }) }
}
function digestBarrier() {
  let entered!: () => void, release!: () => void
  const arrival = new Promise<void>(resolve => { entered = resolve }), hold = new Promise<void>(resolve => { release = resolve })
  const original = crypto.subtle.digest.bind(crypto.subtle)
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { entered(); await hold; return original(...args) })
  return { arrival, release }
}
async function trip(ids: string[]) {
  const tasks = await db.tasks.toArray()
  const proposal = await prepareTripBundle(tasks, { title: '合成外出の再確認', travelMinutes: 30, members: ids.map(taskId => ({ taskId,
    attributes: { minutes: 15, difficulty: 0, uncertainty: 0, coordination: 0, physical: 0 } })) })
  return applyTripBundle(proposal, proposal.manualConfirmationIds)
}

describe('取消実績の本人再確認・独立回帰', () => {
  it.each(['breakdown', 'checklist'] as const)('時刻順を復元できない%s親のfuture unsetを保ち、本人3→訂正2を再完了へ引き継ぐ', async kind => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
    const id = await cancelledTask()
    if (kind === 'breakdown') await applyBreakdownProposal(suggestBreakdown(await task(id), 'large'))
    else await convertChecklistItem(await addChecklistItem(id, '合成配分項目'), (await task(id)).revision, 4)
    const saved = await completion(id); delete saved.allocationAssessmentId
    await db.completions.put({ ...saved, lastConfirmedPoints: 40 })
    const current = await task(id)
    await updateTask(id, current.revision, { ...current, score: emptyScore() })
    const before = await storage(), future = await task(id)
    await expect(finish(id)).rejects.toThrow('残額が未確定')
    const { prepared, approval } = await approved(id)
    expect(prepared.preview.cancellation.status).toBe('unknown')
    expect(prepared.preview.allocation.hasChildren).toBe(true)
    expect(prepared.preview.requiresImpactAcknowledgement).toBe(true)
    const result = await applyCompletionReconfirmationFromUI(prepared, approval, click())
    expect(await task(id)).toMatchObject({ score: future.score, effectivePoints: null, assessmentId: future.assessmentId, status: 'completed' })
    expect(await completion(id)).toMatchObject({ id: saved.id, originalAt: saved.originalAt, originalPoints: 40, title: saved.title, project: saved.project,
      netPoints: 3, reconfirmedAssessmentId: result.assessmentId })
    const added = (await db.ledger.toArray()).filter(row => !before.ledger.some(old => old.id === row.id))
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ kind: 'restore', delta: 3, assessmentId: result.assessmentId })
    expect(await db.assessments.get(result.assessmentId)).toMatchObject({ taskId: id, origin: 'human', score: { mode: 'manual', manualPoints: 3 } })
    await correctCompletion(id, 2, '本人が後日に2ptへ訂正'); await undo(id); await finish(id)
    expect(await completion(id)).toMatchObject({ id: saved.id, netPoints: 2, originalPoints: 40, lastConfirmedPoints: 2, reconfirmedAssessmentId: result.assessmentId })
    expect(await db.assessments.get(result.assessmentId)).toMatchObject({ score: { manualPoints: 3 } })
    for (const old of before.ledger) expect(await db.ledger.get(old.id)).toEqual(old)
    expect((await db.ledger.toArray()).filter(row => row.taskId === id).reduce((sum, row) => sum + row.delta, 0)).toBe(2)
  })

  it.each(['task', 'completion', 'assessment', 'ledger', 'child', 'link', 'origin', 'receipt'] as const)('同revisionの%s実値変更を最終保存で検出し、本人評価も台帳も増やさない', async kind => {
    const id = await cancelledTask(), children = await applyBreakdownProposal(suggestBreakdown(await task(id), 'large'))
    const { prepared, approval } = await approved(id)
    if (kind === 'task') await db.tasks.update(id, { notes: '別画面で同revision実値変更' })
    if (kind === 'completion') await db.completions.update(prepared.input.completionId, { title: '同revision実績名変更' })
    if (kind === 'assessment') await db.assessments.update((await task(id)).assessmentId, { createdAt: '2026-09-30T00:00:00.000Z' })
    if (kind === 'ledger') await db.ledger.update((await db.ledger.toArray())[0].id, { reason: '同revision履歴変更' })
    if (kind === 'child') await db.tasks.update(children[0], { notes: '子の実値変更' })
    if (kind === 'link') await db.checklistItems.update((await db.checklistItems.where('taskId').equals(id).first())!.id, { text: '子の参照項目の実値変更' })
    if (kind === 'origin') await db.audits.update((await db.audits.where('taskId').equals(id).first())!.id, { detail: '原本根拠実値変更' })
    if (kind === 'receipt') {
      const receipt = (await db.commands.toArray()).find(row => row.key.startsWith('breakdown:'))!
      await db.commands.update(receipt.key, { at: '2026-09-30T00:00:00.000Z' })
    }
    const changed = await storage()
    await expect(applyCompletionReconfirmationFromUI(prepared, approval, click())).rejects.toThrow('確認後')
    expect(await storage()).toEqual(changed)
  })

  it.each(['prepare', 'approve', 'apply'] as const)('%s digest待機中の全失効は再登録・承認・書込を復活させない', async phase => {
    const id = await cancelledTask(), before = await storage()
    const prepared = phase === 'prepare' ? null : await prepare(id)
    const approval = phase === 'apply' ? await approveCompletionReconfirmationFromUI(prepared!, prepared!.digest, click(), { points: true, impact: true }) : null
    const barrier = digestBarrier()
    const pending = phase === 'prepare' ? prepare(id) : phase === 'approve'
      ? approveCompletionReconfirmationFromUI(prepared!, prepared!.digest, click(), { points: true, impact: true })
      : applyCompletionReconfirmationFromUI(prepared!, approval!, click())
    const outcome = pending.then(value => ({ value, error: null }), error => ({ value: null, error }))
    await barrier.arrival; clearCompletionReconfirmationAuthority(); barrier.release()
    expect((await outcome).error).toBeInstanceOf(Error)
    expect(await storage()).toEqual(before)
    if (prepared) await expect(approveCompletionReconfirmationFromUI(prepared, prepared.digest, click(), { points: true, impact: true })).rejects.toThrow()
  })

  it.each(['approve', 'apply'] as const)('%s digest待機中に同一案だけを取消すると完了書込を拒否する', async phase => {
    const id = await cancelledTask(), { prepared, approval } = await approved(id), before = await storage(), barrier = digestBarrier()
    const pending = phase === 'approve' ? approveCompletionReconfirmationFromUI(prepared, prepared.digest, click(), { points: true, impact: true })
      : applyCompletionReconfirmationFromUI(prepared, approval, click())
    const outcome = pending.then(value => ({ value, error: null }), error => ({ value: null, error }))
    await barrier.arrival; cancelCompletionReconfirmation(prepared); barrier.release()
    expect((await outcome).error).toBeInstanceOf(Error)
    expect(await storage()).toEqual(before)
  })

  it('外側transactionの末尾失敗は新評価・台帳・receiptを全て戻し、元のnative承認で一度だけ再試行できる', async () => {
    const id = await cancelledTask(), { prepared, approval } = await approved(id), before = await storage()
    await expect(db.transaction('rw', reconfirmationTables(), async () => {
      await applyCompletionReconfirmationFromUI(prepared, approval, click())
      throw new Error('外側保存の最後で失敗')
    })).rejects.toThrow('外側保存の最後で失敗')
    expect(await storage()).toEqual(before)
    const result = await applyCompletionReconfirmationFromUI(prepared, approval, click())
    expect(result.points).toBe(3)
    expect(await db.assessments.count()).toBe(before.assessments.length + 1)
    expect(await db.ledger.count()).toBe(before.ledger.length + 1)
  })

  it('同一snapshotを実復元しても古い案と承認は失効し、新しいnative再確認だけ保存する', async () => {
    const id = await cancelledTask(), { prepared, approval } = await approved(id), snapshot = await captureSnapshot()
    await restoreBackup(snapshot)
    const restored = await storage()
    await expect(applyCompletionReconfirmationFromUI(prepared, approval, click())).rejects.toThrow()
    expect(await storage()).toEqual(restored)
    const fresh = await approved(id)
    await applyCompletionReconfirmationFromUI(fresh.prepared, fresh.approval, click())
    expect((await completion(id)).netPoints).toBe(3)
  })

  it.each([false, true])('外出の既存frozen=%sを守り、本人実績7ptは将来配分10ptと別に保存する', async frozen => {
    const first = await cancelledTask(), second = await createTask({ ...newTaskInput(), title: '合成外出の未実行作業', score: { ...emptyScore(), mode: 'manual', manualPoints: 5 } })
    const tripId = await trip([first, second])
    if (frozen) { await finish(first); await undo(first) }
    const bundle = (await db.tripBundles.get(tripId))!, future = await task(first), sibling = await task(second), historical = await db.ledger.toArray()
    const { prepared, approval } = await approved(first, 7)
    await applyCompletionReconfirmationFromUI(prepared, approval, click())
    const final = (await db.tripBundles.get(tripId))!
    expect(final.members).toEqual(bundle.members)
    expect(final.totalPoints).toBe(bundle.totalPoints)
    expect(final.travelMinutes).toBe(bundle.travelMinutes)
    if (frozen) expect(final).toEqual(bundle)
    else expect(final).toMatchObject({ revision: bundle.revision + 1, frozenAt: (await completion(first)).currentAt })
    expect(await task(first)).toMatchObject({ score: future.score, effectivePoints: 10, assessmentId: future.assessmentId })
    expect(await task(second)).toEqual(sibling)
    expect((await completion(first)).netPoints).toBe(7)
    for (const old of historical) expect(await db.ledger.get(old.id)).toEqual(old)
  })

  it('最後のreceipt失敗では外出freezeもロールバックし新しい本人評価を残さない', async () => {
    const id = await cancelledTask(), tripId = await trip([id]), { prepared, approval } = await approved(id), before = await storage()
    const add = db.commands.add.bind(db.commands)
    vi.spyOn(db.commands, 'add').mockImplementationOnce((...args) => add(...args)).mockRejectedValueOnce(new Error('最後のreceipt保存失敗'))
    await expect(applyCompletionReconfirmationFromUI(prepared, approval, click())).rejects.toThrow('最後のreceipt保存失敗')
    expect(await storage()).toEqual(before)
    expect((await db.tripBundles.get(tripId))!.frozenAt).toBeNull()
  })

  it.each(['cancel', 'clear'] as const)('receiptを書き始めた後の%sもcommit直前に拒否し全資源を戻す', async invalidation => {
    const id = await cancelledTask(), { prepared, approval } = await approved(id), before = await storage(), add = db.commands.add.bind(db.commands)
    vi.spyOn(db.commands, 'add').mockImplementationOnce((...args) => add(...args).then(result => {
      if (invalidation === 'cancel') cancelCompletionReconfirmation(prepared)
      else clearCompletionReconfirmationAuthority()
      return result
    }))
    await expect(applyCompletionReconfirmationFromUI(prepared, approval, click())).rejects.toThrow()
    expect(await storage()).toEqual(before)
  })

  it.each([null, -1, 0.5, 100001])('新しい本人再確認markerの不正保存値 %s を通常再完了にも新規確認にも流用しない', async invalid => {
    const id = await cancelledTask(), { prepared, approval } = await approved(id)
    await applyCompletionReconfirmationFromUI(prepared, approval, click()); await undo(id)
    await db.completions.update((await completion(id)).id, { lastConfirmedPoints: invalid })
    const malformed = await storage()
    await expect(finish(id)).rejects.toThrow()
    await expect(prepare(id)).rejects.toThrow()
    expect(await storage()).toEqual(malformed)
  })
})
