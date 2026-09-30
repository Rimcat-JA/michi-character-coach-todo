import { describe, expect, it } from 'vitest'
import { calculateScore, emptyScore, type ScoreInput, type Task } from './domain'
import { allocateTripShares, assertTripBundleCanRemove, assertTripTaskScoreChangeAllowed, freezeTripBundle, prepareTripBundle, tripBundleFromProposal, tripMemberScore, validateTripBundleProposal, validateTripBundleRecord, type TripAttributes, type TripBundleInput } from './trip-bundles'

const zero: TripAttributes = { minutes: 0, difficulty: 0, uncertainty: 0, coordination: 0, physical: 0 }
function task(id: string, patch: Partial<ScoreInput> = {}): Task {
  const score = { ...emptyScore(), mode: 'formula' as const, ...zero, travelMinutes: 0, outing: true, ...patch }
  return { id, title: id, notes: '', project: '', labels: [], generationKey: id, routineId: null, scheduledDate: null, dueDate: null, targetDate: null, reviewDate: null, availableFrom: null, importance: 1, score, effectivePoints: calculateScore(score).effective, assessmentId: `${id}:assessment`, status: 'open', revision: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', deletedAt: null }
}
function input(ids: string[], travelMinutes = 0, overrides: Record<string, Partial<TripAttributes>> = {}): TripBundleInput {
  return { title: '共通外出', travelMinutes, members: ids.map(taskId => ({ taskId, attributes: { ...zero, ...overrides[taskId] } })) }
}

describe('共通外出のポイント予算', () => {
  it('共通移動・外出加点・最低20ptを一度だけ計算し、タスクを変更しない', async () => {
    const tasks = [task('a', { minutes: 15 }), task('b', { minutes: 15 })]
    const before = structuredClone(tasks)
    const proposal = await prepareTripBundle(tasks, input(['a', 'b'], 30, { a: { minutes: 15 }, b: { minutes: 15 } }), 'trip')
    expect(proposal).toMatchObject({ totalMinutes: 60, totalPoints: 20 })
    expect(proposal.members.map(member => member.allocatedPoints)).toEqual([10, 10])
    expect(proposal.members.map(member => member.allocatedTravelMinutes)).toEqual([15, 15])
    expect(proposal.members.map(member => member.standalonePoints)).toEqual([20, 20])
    expect(proposal.members.map(member => tripMemberScore(member).travelMinutes).reduce<number>((sum, value) => sum + value!, 0)).toBe(30)
    expect(tasks).toEqual(before)
    expect(await prepareTripBundle([task('a')], input(['a']), 'single')).toMatchObject({ totalPoints: 20 })
  })

  it('作業の負荷だけを重みにし、最大剰余法で整数の合計を保存する', async () => {
    const proposal = await prepareTripBundle([task('a'), task('b')], input(['b', 'a'], 30, { a: { minutes: 15, difficulty: 1 }, b: { minutes: 45, uncertainty: 1 } }), 'trip')
    expect(proposal.totalPoints).toBe(29)
    expect(proposal.members.map(member => [member.taskId, member.allocatedPoints, member.allocatedTravelMinutes])).toEqual([['a', 12, 12], ['b', 17, 18]])
    expect(proposal.members.reduce((sum, member) => sum + calculateScore(tripMemberScore(member)).effective!, 0)).toBe(29)
  })

  it('同じ余りはlocaleに依存しないID順で配分し、入力順を変えても同じ結果にする', () => {
    const rows = [{ taskId: 'c', weight: 1 }, { taskId: 'a', weight: 1 }, { taskId: 'b', weight: 1 }]
    const byId = (shares: ReturnType<typeof allocateTripShares>) => Object.fromEntries(shares.map(row => [row.taskId, row.amount]))
    expect(byId(allocateTripShares(20, rows))).toEqual({ a: 7, b: 7, c: 6 })
    expect(byId(allocateTripShares(20, [...rows].reverse()))).toEqual({ a: 7, b: 7, c: 6 })
    expect(allocateTripShares(0, rows).every(row => row.amount === 0)).toBe(true)
    expect(() => allocateTripShares(20, [{ taskId: 'a', weight: 0 }])).toThrow('重み')
  })

  it('本人指定の0ptを許容し、配分合計の不足・対象の省略を拒否する', async () => {
    const tasks = [task('a'), task('b')]
    const request = { ...input(['a', 'b']), allocationMode: 'manual' as const, allocations: { a: 0, b: 20 } }
    const proposal = await prepareTripBundle(tasks, request, 'manual')
    expect(proposal.members.map(member => calculateScore(tripMemberScore(member)).effective)).toEqual([0, 20])
    await expect(prepareTripBundle(tasks, { ...request, allocations: { a: 0, b: 19 } })).rejects.toThrow('20pt')
    await expect(prepareTripBundle(tasks, { ...request, allocations: { a: 20 } })).rejects.toThrow('全タスク')
  })

  it('手動5ptを本人確認なしで配分へ切り替えず、項目ごとの確認だけを受け付ける', async () => {
    const tasks = [task('a', { mode: 'manual', manualPoints: 5 }), task('b')]
    const proposal = await prepareTripBundle(tasks, input(['a', 'b']), 'trip')
    expect(proposal.manualConfirmationIds).toEqual(['a'])
    expect(tasks[0].effectivePoints).toBe(5)
    await expect(validateTripBundleProposal(proposal, tasks, [], [])).rejects.toThrow('本人が確認')
    await expect(validateTripBundleProposal(proposal, tasks, [], ['a', 'a'])).rejects.toThrow('本人が確認')
    await expect(validateTripBundleProposal(proposal, tasks, [], ['a', 'b'])).rejects.toThrow('本人が確認')
    await expect(validateTripBundleProposal(proposal, tasks, [], ['a'])).resolves.toBeUndefined()
    expect(tripMemberScore(proposal.members[0])).toMatchObject({ mode: 'allocated', manualPoints: 10 })
    expect(tasks[0].score).toMatchObject({ mode: 'manual', manualPoints: 5 })
  })

  it('古いタスク版・配分案の差替え・既存の外出との二重所属を拒否する', async () => {
    const tasks = [task('a'), task('b')]
    const proposal = await prepareTripBundle(tasks, input(['a', 'b']), 'trip')
    await expect(validateTripBundleProposal(proposal, [{ ...tasks[0], revision: 2 }, tasks[1]], [], [])).rejects.toThrow('案を作り直し')
    const tampered = structuredClone(proposal); tampered.members[0].allocatedPoints++
    await expect(validateTripBundleProposal(tampered, tasks, [], [])).rejects.toThrow('案を作り直し')
    const existing = tripBundleFromProposal(await prepareTripBundle([tasks[0]], input(['a']), 'other'), 'owner')
    await expect(validateTripBundleProposal(proposal, tasks, [existing], [])).rejects.toThrow('既に別')
  })

  it('不明属性を0へ変換せず、完了済み・既存配分・重複タスクを拒否する', async () => {
    await expect(prepareTripBundle([task('a')], input(['a'], 0, { a: { difficulty: null } }))).rejects.toThrow('不明')
    await expect(prepareTripBundle([task('a')], input(['a'], 0, { a: { minutes: null } }))).rejects.toThrow('不明')
    await expect(prepareTripBundle([task('a')], input(['a'], NaN))).rejects.toThrow('移動')
    await expect(prepareTripBundle([{ ...task('a'), status: 'completed' }], input(['a']))).rejects.toThrow('未完了')
    await expect(prepareTripBundle([task('a', { mode: 'allocated', manualPoints: 4 })], input(['a']))).rejects.toThrow('既に配分')
    await expect(prepareTripBundle([task('a')], input(['a', 'a']))).rejects.toThrow('重複')
  })

  it('最初の完了で構成と配分を固定し、取消後も固定を解除しない', async () => {
    const tasks = [task('a'), task('b')]
    const bundle = tripBundleFromProposal(await prepareTripBundle(tasks, input(['a', 'b']), 'trip'), 'owner', '2026-10-01T00:00:00.000Z')
    const first = freezeTripBundle(bundle, 'a', '2026-10-01T01:00:00.000Z')
    const second = freezeTripBundle(first, 'b', '2026-10-01T02:00:00.000Z')
    expect(first.members).toEqual(bundle.members)
    expect(first).toMatchObject({ frozenAt: '2026-10-01T01:00:00.000Z', revision: 2, totalPoints: 20 })
    expect(second).toBe(first)
    expect(() => assertTripBundleCanRemove(first, tasks)).toThrow('固定')
    expect(() => assertTripBundleCanRemove(bundle, [{ ...tasks[0], status: 'completed' }, tasks[1]])).toThrow('固定')
    expect(() => assertTripBundleCanRemove(bundle, tasks)).not.toThrow()
    expect(tasks.every(item => item.status === 'open')).toBe(true)
    const allocated = tripMemberScore(first.members[0])
    expect(() => assertTripTaskScoreChangeAllowed('a', allocated, { ...allocated, manualPoints: 999 }, [first])).toThrow('直接変更')
    expect(() => assertTripTaskScoreChangeAllowed('a', allocated, allocated, [first])).not.toThrow()
  })

  it('保存データの合計・移動配分・所有者・派生タスクの一致を検証する', async () => {
    const tasks = [task('a'), task('b')]
    const proposal = await prepareTripBundle(tasks, input(['a', 'b'], 31), 'trip')
    const bundle = tripBundleFromProposal(proposal, 'owner', '2026-10-01T00:00:00.000Z')
    const allocatedTasks = tasks.map(item => ({ ...item, revision: 2, score: tripMemberScore(proposal.members.find(member => member.taskId === item.id)!), effectivePoints: proposal.members.find(member => member.taskId === item.id)!.allocatedPoints }))
    expect(() => validateTripBundleRecord(bundle, allocatedTasks, 'owner')).not.toThrow()
    expect(() => validateTripBundleRecord(bundle, allocatedTasks, 'other')).toThrow('保存データ')
    expect(() => validateTripBundleRecord({ ...bundle, totalPoints: 999 }, allocatedTasks, 'owner')).toThrow('合計')
    const corrupt = structuredClone(bundle); corrupt.members[0].allocatedTravelMinutes++
    expect(() => validateTripBundleRecord(corrupt, allocatedTasks, 'owner')).toThrow('一致')
    expect(() => validateTripBundleRecord(bundle, tasks, 'owner')).toThrow('一致')
    expect(() => validateTripBundleRecord({ ...bundle, approved: true }, allocatedTasks, 'owner')).toThrow('保存データ')
    expect(() => validateTripBundleRecord(bundle, [{ ...allocatedTasks[0], status: 'completed' }, allocatedTasks[1]], 'owner')).toThrow('固定状態')
    expect(() => validateTripBundleRecord(freezeTripBundle(bundle, 'a'), [{ ...allocatedTasks[0], status: 'completed' }, allocatedTasks[1]], 'owner')).not.toThrow()
  })
})
