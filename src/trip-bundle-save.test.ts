import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { completeTask, createTask, newTaskInput, undoCompletion, updateTask } from './commands'
import { db, ensureSettings } from './db'
import { emptyScore, uid, type ScoreInput } from './domain'
import { applyTripBundle, removeTripBundle } from './trip-bundle-save'
import { prepareTripBundle, validateTripBundleRecord, type TripBundleProposal } from './trip-bundles'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })
afterEach(() => vi.restoreAllMocks())

async function create(title: string, patch: Partial<ScoreInput> = {}) {
  return createTask({ ...newTaskInput(), title, score: { ...emptyScore(), mode: 'formula', minutes: 15, travelMinutes: 0, difficulty: 0, uncertainty: 0, coordination: 0, physical: 0, outing: true, ...patch } })
}
async function prepare(ids: string[], travelMinutes = 30): Promise<TripBundleProposal> {
  const tasks = await db.tasks.toArray()
  return prepareTripBundle(tasks, { title: '図書館と買い物', travelMinutes, members: ids.map(taskId => {
    const score = tasks.find(task => task.id === taskId)!.score
    return { taskId, attributes: { minutes: score.minutes, difficulty: score.difficulty, uncertainty: score.uncertainty, coordination: score.coordination, physical: score.physical } }
  }) })
}
async function storage() {
  return { tasks: await db.tasks.toArray(), assessments: await db.assessments.toArray(), completions: await db.completions.toArray(), ledger: await db.ledger.toArray(), trips: await db.tripBundles.toArray(), commands: await db.commands.toArray(), audits: await db.audits.toArray() }
}

describe('共通外出の保存と完了台帳', () => {
  it('既存IDへポイントと共通移動を一度だけ配分し、同じ要求の再送で増やさない', async () => {
    const ids = [await create('図書館'), await create('買い物')], proposal = await prepare(ids)
    const id = await applyTripBundle(proposal, [])
    const saved = await storage(), bundle = saved.trips[0]
    expect(bundle).toMatchObject({ id, ownerId: (await db.settings.get('main'))!.profileId, totalPoints: 20, totalMinutes: 60, revision: 1, frozenAt: null })
    expect(saved.tasks.map(task => task.id).sort()).toEqual([...ids].sort())
    expect(saved.tasks.every(task => task.status === 'open' && task.score.mode === 'allocated' && task.revision === 2 && task.effectivePoints === 10)).toBe(true)
    expect(saved.tasks.reduce((sum, task) => sum + task.score.travelMinutes!, 0)).toBe(30)
    expect(saved.assessments).toHaveLength(4)
    expect(saved.ledger).toEqual([])
    expect(await applyTripBundle(proposal, [])).toBe(id)
    expect(await storage()).toEqual(saved)
    expect(() => validateTripBundleRecord(bundle, saved.tasks, bundle.ownerId)).not.toThrow()
  })

  it('手動値の確認なしでは書き込まず、保存末尾の失敗も全資源を戻す', async () => {
    const first = await create('手動の作業', { mode: 'manual', manualPoints: 5 }), second = await create('別の作業')
    await completeTask(first, 1); await undoCompletion(first, 2)
    const proposal = await prepare([first, second]), before = await storage()
    await expect(applyTripBundle(proposal, [])).rejects.toThrow('本人が確認')
    expect(await storage()).toEqual(before)
    vi.spyOn(db.tripBundles, 'add').mockRejectedValueOnce(new Error('保存失敗'))
    await expect(applyTripBundle(proposal, [first])).rejects.toThrow('保存失敗')
    expect(await storage()).toEqual(before)
  })

  it('旧版の案・同じ要求IDの差替え・二重所属を拒否する', async () => {
    const ids = [await create('最初'), await create('次')], stale = await prepare(ids)
    const original = (await db.tasks.get(ids[0]))!
    await updateTask(original.id, original.revision, { ...original, title: '本人の変更' })
    const before = await storage()
    await expect(applyTripBundle(stale, [])).rejects.toThrow('案を作り直し')
    expect(await storage()).toEqual(before)
    const fresh = await prepare(ids), other = await prepare([ids[0]])
    await applyTripBundle(fresh, [])
    const saved = await storage(), altered = structuredClone(fresh)
    altered.input.title = '要求内容を差替え'
    await expect(applyTripBundle(altered, [])).rejects.toThrow('IDEMPOTENCY_MISMATCH')
    await expect(applyTripBundle(other, [])).rejects.toThrow('既に配分')
    expect(await storage()).toEqual(saved)
  })

  it('最初の一件だけを加点し、完了取消後も外出の構成・配分を固定する', async () => {
    const ids = [await create('一件だけ実行'), await create('残りは実行しない')], proposal = await prepare(ids)
    const bundleId = await applyTripBundle(proposal, [])
    await completeTask(ids[0], 2)
    const completed = (await db.tripBundles.get(bundleId))!
    expect(completed.frozenAt).toBeTruthy()
    expect(completed.revision).toBe(2)
    expect(await db.ledger.toArray()).toHaveLength(1)
    expect((await db.ledger.toArray())[0].delta).toBe(10)
    expect((await db.tasks.get(ids[1]))!.status).toBe('open')
    const before = await storage(), task = (await db.tasks.get(ids[1]))!
    await expect(updateTask(task.id, task.revision, { ...task, score: { ...task.score, manualPoints: 99 } })).rejects.toThrow('直接変更')
    expect(await storage()).toEqual(before)
    await undoCompletion(ids[0], 3)
    const undone = (await db.tripBundles.get(bundleId))!
    expect(undone.frozenAt).toBe(completed.frozenAt)
    expect(undone.members).toEqual(completed.members)
    expect((await db.ledger.toArray()).reduce((sum, row) => sum + row.delta, 0)).toBe(0)
    await expect(removeTripBundle(bundleId, undone.revision)).rejects.toThrow('固定')
  })

  it('完了から取消した手動タスクも、共通外出では新しい配分点を使う', async () => {
    const first = await create('以前は5pt', { mode: 'manual', manualPoints: 5 }), second = await create('今回の同じ外出')
    await completeTask(first, 1); await undoCompletion(first, 2)
    const previousLedger = await db.ledger.toArray(), previousCompletion = (await db.completions.where('taskId').equals(first).first())!
    const bundleId = await applyTripBundle(await prepare([first, second]), [first])
    const bundle = (await db.tripBundles.get(bundleId))!, member = bundle.members.find(row => row.taskId === first)!
    expect(member.previousCompletion).toEqual({ completionId: previousCompletion.id, hadLastConfirmedPoints: true, lastConfirmedPoints: 5 })
    expect(await db.ledger.toArray()).toEqual(previousLedger)
    expect((await db.completions.get(previousCompletion.id))!.originalPoints).toBe(5)
    await completeTask(first, 4)
    expect((await db.completions.get(previousCompletion.id))!.netPoints).toBe(10)
    expect((await db.ledger.toArray()).reduce((sum, row) => sum + row.delta, 0)).toBe(10)
    expect((await db.tasks.get(second))!.status).toBe('open')
    expect((await db.tripBundles.get(bundleId))!.frozenAt).toBeTruthy()
  })

  it('完了前にまとめを取り消すと手動値と以前のundefined/nullの完了設定を戻す', async () => {
    const first = await create('手動5pt', { mode: 'manual', manualPoints: 5 }), second = await create('未設定', { mode: 'unset' })
    await completeTask(first, 1); await undoCompletion(first, 2)
    await completeTask(second, 1); await undoCompletion(second, 2)
    const oldFirst = (await db.completions.where('taskId').equals(first).first())!
    delete oldFirst.lastConfirmedPoints; await db.completions.put(oldFirst)
    const beforeLedger = await db.ledger.toArray(), beforeCompletions = await db.completions.toArray()
    const bundleId = await applyTripBundle(await prepare([first, second]), [first])
    const bundle = (await db.tripBundles.get(bundleId))!
    expect(bundle.members.find(row => row.taskId === first)!.previousCompletion!.hadLastConfirmedPoints).toBe(false)
    expect(bundle.members.find(row => row.taskId === second)!.previousCompletion).toMatchObject({ hadLastConfirmedPoints: true, lastConfirmedPoints: null })
    const allocatedTasks = await db.tasks.toArray()
    expect(() => validateTripBundleRecord(bundle, allocatedTasks, bundle.ownerId)).not.toThrow()
    const invalidOverride = structuredClone(bundle), previous = invalidOverride.members.find(row => row.taskId === first)!.previousCompletion!
    previous.lastConfirmedPoints = 5
    expect(() => validateTripBundleRecord(invalidOverride, allocatedTasks, bundle.ownerId)).toThrow('以前の完了設定')
    expect(() => validateTripBundleRecord(bundle, [], bundle.ownerId)).toThrow('一致')
    const edited = (await db.tasks.get(first))!
    await updateTask(first, edited.revision, { ...edited, notes: 'まとめ後の本人メモ', scheduledDate: '2026-10-05' })
    expect(await removeTripBundle(bundleId, bundle.revision)).toBe(bundleId)
    const restored = await storage()
    expect(restored.trips).toEqual([])
    expect((await db.tasks.get(first))!).toMatchObject({ score: { mode: 'manual', manualPoints: 5 }, effectivePoints: 5, notes: 'まとめ後の本人メモ', scheduledDate: '2026-10-05' })
    expect((await db.tasks.get(second))!).toMatchObject({ score: { mode: 'unset' }, effectivePoints: null })
    expect(await db.completions.toArray()).toEqual(beforeCompletions)
    expect(await db.ledger.toArray()).toEqual(beforeLedger)
    expect(await removeTripBundle(bundleId, bundle.revision)).toBe(bundleId)
    expect(await storage()).toEqual(restored)
  })

  it('検証中にデータセットが変わると保存せず、別利用者はまとめを取り消せない', async () => {
    const ids = [await create('対象')], proposal = await prepare(ids), before = await storage()
    const originalRead = db.tasks.toArray.bind(db.tasks)
    vi.spyOn(db.tasks, 'toArray').mockImplementationOnce(() => db.settings.update('main', { datasetId: uid() }).then(() => originalRead()))
    await expect(applyTripBundle(proposal, [])).rejects.toThrow('データセットが変わり')
    expect(await storage()).toEqual(before)
    vi.restoreAllMocks()
    const bundleId = await applyTripBundle(proposal, [])
    await db.settings.update('main', { profileId: uid() })
    await expect(removeTripBundle(bundleId, 1)).rejects.toThrow('共通外出がありません')
    expect(await db.tripBundles.count()).toBe(1)
  })
})
