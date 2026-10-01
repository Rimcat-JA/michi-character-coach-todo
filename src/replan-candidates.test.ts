import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput, updateTask } from './commands'
import { emptyScore, type Task, type TaskDependency, type TimeBlock } from './domain'
import { applyChangeSet, approveChangeSetFromUI, type ChangeContext } from './change-set'
import { prepareReplanChangeSet, replanCandidates, replanReason } from './replan-candidates'

const today = '2026-10-01'
let serial = 0
function task(patch: Partial<Task> & { minutes?: number | null; points?: number | null } = {}): Task {
  const { minutes = 60, points = 10, ...rest } = patch, id = rest.id ?? `t${++serial}`
  return { ...newTaskInput(), id, generationKey: id, routineId: null, title: id, score: { ...emptyScore(), mode: 'manual', manualPoints: points, minutes }, effectivePoints: points, assessmentId: `a-${id}`, status: 'open', revision: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', deletedAt: null, ...rest }
}
const settings = { dailyMinutes: 240, dailyPoints: 40 }
const input = (tasks: Task[], extra: { dependencies?: TaskDependency[]; blocks?: TimeBlock[]; selfReport?: boolean } = {}) => ({ tasks, dependencies: extra.dependencies ?? [], blocks: extra.blocks ?? [], settings, today, selfReport: extra.selfReport })
function humanClick() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }

describe('K05 状況に応じた再計画候補（予定日だけ）', () => {
  it('予定日を過ぎた未完了だけを候補にし、予定日だけを提案して期限・手動25pt・状態を触らない', () => {
    const slipped = task({ id: 'slipped', scheduledDate: '2026-09-29', dueDate: '2026-10-09', points: 25 })
    const others = [task({ id: 'done', scheduledDate: '2026-09-28', status: 'completed' }), task({ id: 'deleted', scheduledDate: '2026-09-28', deletedAt: '2026-09-30T00:00:00.000Z' }), task({ id: 'back', scheduledDate: '2026-09-28', backburner: true }), task({ id: 'future', scheduledDate: '2026-10-05' })]
    const summary = replanCandidates(input([slipped, ...others]))
    expect(summary.slipped).toBe(1)
    expect(summary.candidates).toEqual([{ taskId: 'slipped', title: 'slipped', revision: 1, situations: ['slipped'], from: '2026-09-29', to: '2026-10-02', dueDate: '2026-10-09', reason: null }])
    expect(Object.keys(summary.candidates[0])).not.toContain('points')
    expect(slipped).toMatchObject({ dueDate: '2026-10-09', effectivePoints: 25, status: 'open', scheduledDate: '2026-09-29' })
  })
  it('時間とポイントの容量・開始可能日を守り、前提未完了は動かさず、期限前に空きがなければ理由だけ示す', () => {
    const full = [task({ id: 'busy-a', scheduledDate: '2026-10-02', minutes: 240, points: 5 }), task({ id: 'busy-b', scheduledDate: '2026-10-03', minutes: 30, points: 40 })]
    const capacity = task({ id: 'capacity', scheduledDate: '2026-09-30', dueDate: '2026-10-10' })
    const available = task({ id: 'available', scheduledDate: '2026-09-30', availableFrom: '2026-10-06', minutes: 10, points: 1 })
    const prerequisite = task({ id: 'pre', scheduledDate: '2026-10-08' }), blocked = task({ id: 'blocked', scheduledDate: '2026-09-30' })
    const tooLate = task({ id: 'late', scheduledDate: '2026-09-30', dueDate: '2026-10-03', minutes: 100, points: 10 })
    const summary = replanCandidates(input([...full, capacity, available, prerequisite, blocked, tooLate], { dependencies: [{ id: 'd', taskId: 'blocked', dependsOnId: 'pre', createdAt: today }] }))
    const by = (id: string) => summary.candidates.find(item => item.taskId === id)!
    expect(by('capacity').to).toBe('2026-10-04')
    expect(by('available').to).toBe('2026-10-06')
    expect(by('blocked')).toMatchObject({ to: null, reason: '前提タスクが未完了' })
    expect(by('late')).toMatchObject({ to: null, reason: '期限前に空きなし' })
    // A completed prerequisite no longer blocks.
    const done = replanCandidates(input([{ ...prerequisite, status: 'completed' }, blocked], { dependencies: [{ id: 'd', taskId: 'blocked', dependsOnId: 'pre', createdAt: today }] }))
    expect(done.candidates[0]).toMatchObject({ taskId: 'blocked', to: '2026-10-02', reason: null })
  })
  it('今日の容量超過は優先度の低い順に候補化し、候補順は期限→重要度→IDで決定的', () => {
    const tasks = [task({ id: 'b', scheduledDate: today, minutes: 120, importance: 3 }), task({ id: 'a', scheduledDate: today, minutes: 120, importance: 1, dueDate: '2026-10-02' }), task({ id: 'c', scheduledDate: today, minutes: 120, importance: 1 }), task({ id: 'z', scheduledDate: '2026-09-30', minutes: 10 }), task({ id: 'y', scheduledDate: '2026-09-30', minutes: 10 })]
    const first = replanCandidates(input(tasks)), second = replanCandidates(input([...tasks].reverse()))
    expect(first.overloaded).toBe(true)
    expect(first.candidates.map(item => [item.taskId, item.situations.join()])).toEqual([['c', 'overload'], ['y', 'slipped'], ['z', 'slipped']])
    expect(second.candidates).toEqual(first.candidates)
  })
  it('本人申告では今日の予定を選択肢として出すだけで、新しいタスクを作らない', () => {
    const tasks = [task({ id: 'today-a', scheduledDate: today, minutes: 30 }), task({ id: 'today-b', scheduledDate: today, minutes: 30 }), task({ id: 'today-c', scheduledDate: today, minutes: 30 })]
    const summary = replanCandidates(input(tasks, { selfReport: true }))
    expect(summary.candidates.map(item => item.situations)).toEqual([['selfReport'], ['selfReport'], ['selfReport']])
    expect(summary.candidates.map(item => item.to)).toEqual(['2026-10-02', '2026-10-02', '2026-10-02'])
    expect(tasks.map(item => item.scheduledDate)).toEqual([today, today, today])
    expect(replanCandidates(input(tasks)).candidates).toEqual([])
  })
})

describe('K05 再計画のChangeSet（本人選択・一括適用）', () => {
  let owner: ChangeContext, ids: string[]
  beforeEach(async () => {
    await db.delete(); await db.open()
    const settings = await ensureSettings()
    owner = { principal: { id: settings.profileId, kind: 'human' }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: ['scheduledDate'], sourceRevisions: [] }
    ids = []
    for (const title of ['今日A', '今日B', '今日C']) ids.push(await createTask({ ...newTaskInput(), title, scheduledDate: '2026-09-30', dueDate: '2026-10-20', score: { ...emptyScore(), mode: 'manual', manualPoints: 25, minutes: 30 } }))
  })
  async function candidates() { return replanCandidates({ tasks: await db.tasks.toArray(), dependencies: [], blocks: [], settings: { dailyMinutes: 480, dailyPoints: 100 }, today }).candidates }
  it('何も選ばないと差分を作らず、選んだ2件だけ予定日を変え、期限・25pt・台帳は変わらない', async () => {
    const list = await candidates(), settings = (await db.settings.get('main'))!
    await expect(prepareReplanChangeSet(list, [], settings)).rejects.toThrow('選んでください')
    const prepared = await prepareReplanChangeSet(list, [ids[0], ids[1]], settings)
    expect(prepared.reason).toBe(replanReason)
    expect(prepared.changes.map(change => change.fields)).toEqual([['scheduledDate'], ['scheduledDate']])
    const receipt = await applyChangeSet(prepared, await approveChangeSetFromUI(prepared, owner, humanClick()), owner, 'replan')
    expect([...receipt.taskIds].sort()).toEqual([ids[0], ids[1]].sort())
    const after = await db.tasks.bulkGet(ids)
    expect(after.map(item => item!.scheduledDate)).toEqual(['2026-10-02', '2026-10-02', '2026-09-30'])
    expect(after.every(item => item!.dueDate === '2026-10-20' && item!.effectivePoints === 25 && item!.score.mode === 'manual')).toBe(true)
    expect(await db.ledger.count()).toBe(0)
  })
  it('合成クリックは承認にならず、1件でも版が変わると何も適用しない（原子的）', async () => {
    const list = await candidates(), prepared = await prepareReplanChangeSet(list, [ids[0], ids[1]], (await db.settings.get('main'))!)
    await expect(approveChangeSetFromUI(prepared, owner, new Event('click'))).rejects.toMatchObject({ code: 'HUMAN_APPROVAL_REQUIRED' })
    const approval = await approveChangeSetFromUI(prepared, owner, humanClick())
    const second = (await db.tasks.get(ids[1]))!
    await updateTask(ids[1], second.revision, { ...second, notes: '本人の別編集' })
    await expect(applyChangeSet(prepared, approval, owner, 'replan-conflict')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await db.tasks.bulkGet(ids)).map(item => item!.scheduledDate)).toEqual(['2026-09-30', '2026-09-30', '2026-09-30'])
  })
  it('完了済み・移動先なしの候補は選べない', async () => {
    await completeTask(ids[2], 1)
    const list = await candidates()
    expect(list.map(item => item.taskId)).not.toContain(ids[2])
    await expect(prepareReplanChangeSet(list, [ids[2]], (await db.settings.get('main'))!)).rejects.toThrow('移動先のない候補は選べません')
  })
})
