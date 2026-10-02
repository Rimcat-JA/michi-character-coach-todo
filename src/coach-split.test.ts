import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput, undoCompletion, updateTask } from './commands'
import { emptyScore } from './domain'
import { changePolicyFor } from './change-set'
import { automationRulesFor } from './automation-policy'
import { applyCoachSplitFromUI, buildCoachSplitProposal, consultationKind, parseCoachSplit, validateCoachSplit } from './coach-split'

function humanClick() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
let owner: { ownerId: string; datasetId: string }
beforeEach(async () => { await db.delete(); await db.open(); const settings = await ensureSettings(); owner = { ownerId: settings.profileId, datasetId: settings.datasetId } })
const parent = () => createTask({ ...newTaskInput(), title: 'API連携', scheduledDate: '2026-10-01', dueDate: '2026-10-09', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
const total = async () => (await db.ledger.toArray()).reduce((sum, entry) => sum + entry.delta, 0)
const instruction = '40ptの作業を調査と実装へ分けて'

describe('N08 コーチ相談からの分割（明示した作業名・本人確認の配分）', () => {
  it('作業名と明示ポイントだけを読み取り、「半分にして」は確認に回す', () => {
    expect(parseCoachSplit(instruction)).toEqual({ kind: 'split', parts: [{ name: '調査', points: null }, { name: '実装', points: null }] })
    expect(parseCoachSplit('調査10pt、実装30ptに分割して')).toEqual({ kind: 'split', parts: [{ name: '調査', points: 10 }, { name: '実装', points: 30 }] })
    expect(parseCoachSplit('これ大変だから半分にして')).toMatchObject({ kind: 'clarify' })
    expect(parseCoachSplit('少し減らして')).toMatchObject({ kind: 'clarify' })
    expect(parseCoachSplit('明日に移して')).toBeNull()
    expect(() => parseCoachSplit('調査10ptと実装に分けて')).toThrow('すべて指定')
    expect(() => parseCoachSplit('調査に分けて')).toThrow('2〜10個')
  })
  it('40pt → 既定20/20（未確認フラグ）を本人が10/30へ修正し、合計を強制。承認後は親0pt・子は配分、完了で台帳40', async () => {
    const id = await parent(), task = (await db.tasks.get(id))!, parsed = parseCoachSplit(instruction)
    if (parsed?.kind !== 'split') throw new Error('split expected')
    const proposal = buildCoachSplitProposal(task, parsed.parts, instruction, 'split-1'), names = parsed.parts.map(part => part.name)
    expect(proposal.parts.map(part => [part.title, part.points, part.origin])).toEqual([['API連携：調査', 20, 'app_default'], ['API連携：実装', 20, 'app_default']])
    expect(() => validateCoachSplit(proposal, names)).toThrow('既定値')
    const edited = { ...proposal, parts: [{ ...proposal.parts[0], points: 10, origin: 'human' as const }, { ...proposal.parts[1], points: 25, origin: 'human' as const }] }
    expect(() => validateCoachSplit(edited, names)).toThrow('40pt')
    edited.parts[1].points = 30
    const ids = await applyCoachSplitFromUI(edited, names, owner, humanClick())
    expect(await db.tasks.get(id)).toMatchObject({ effectivePoints: 0, score: { manualPoints: 0 }, status: 'open' })
    const children = await db.tasks.bulkGet(ids)
    expect(children.map(child => [child!.title, child!.effectivePoints, child!.score.mode, child!.scheduledDate, child!.dueDate])).toEqual([['API連携：調査', 10, 'allocated', '2026-10-01', '2026-10-09'], ['API連携：実装', 30, 'allocated', '2026-10-01', '2026-10-09']])
    expect(await total()).toBe(0)
    const audit = (await db.audits.where('taskId').equals(id).toArray()).find(item => item.operation === 'breakdown')!
    expect(audit.detail).toContain('origin=coach_split_from_instruction')
    for (const child of ids) await completeTask(child, 1)
    expect(await total()).toBe(40)
    await undoCompletion(ids[0], 2)
    expect(await total()).toBe(30)
    // Replaying the same approved proposal returns the same children and creates nothing new.
    expect(await applyCoachSplitFromUI(edited, names, owner, humanClick())).toEqual(ids)
    expect(await db.tasks.count()).toBe(3)
  })
  it('AIが作業を追加・改名した案や、合成クリック・古い親の版は拒否し、何も書かない', async () => {
    const id = await parent(), task = (await db.tasks.get(id))!, names = ['調査', '実装']
    const proposal = { ...buildCoachSplitProposal(task, names.map(name => ({ name, points: 20 })), instruction, 'split-2') }
    expect(() => validateCoachSplit({ ...proposal, parts: [...proposal.parts.map(part => ({ ...part, points: 10 })), { name: 'テスト', title: 'API連携：テスト', points: 20, origin: 'human' }] }, names)).toThrow('一致しません')
    expect(() => validateCoachSplit({ ...proposal, parts: [{ ...proposal.parts[0], title: 'API連携：設計' }, proposal.parts[1]] }, names)).toThrow('一致しません')
    await expect(applyCoachSplitFromUI(proposal, names, owner, new Event('click'))).rejects.toThrow('本人確認ボタン')
    await expect(applyCoachSplitFromUI(proposal, names, owner, { isTrusted: true, type: 'click' } as Event)).rejects.toThrow('本人確認ボタン')
    await updateTask(id, task.revision, { ...task, notes: '別の編集' })
    await expect(applyCoachSplitFromUI(proposal, names, owner, humanClick())).rejects.toThrow()
    expect(await db.tasks.count()).toBe(1)
    expect((await db.tasks.get(id))!.effectivePoints).toBe(40)
  })
  it('自動化設定で「タスクの分割」を停止していればコーチからは分割しない', async () => {
    const id = await parent(), task = (await db.tasks.get(id))!, names = ['調査', '実装']
    const settings = (await db.settings.get('main'))!, policy = changePolicyFor(settings)
    await db.settings.put({ ...settings, changePolicy: { ...policy, operations: automationRulesFor(policy).map(rule => rule.operation === 'task.split' ? { ...rule, mode: 'deny' as const } : rule) } })
    const proposal = buildCoachSplitProposal(task, names.map(name => ({ name, points: 20 })), instruction, 'split-deny')
    await expect(applyCoachSplitFromUI(proposal, names, owner, humanClick())).rejects.toThrow('停止しています')
    expect(await db.tasks.count()).toBe(1); expect((await db.tasks.get(id))!.effectivePoints).toBe(40)
  })
  it('推定ポイントしかないタスクは配分しない', async () => {
    const id = await createTask({ ...newTaskInput(), title: '推定だけ', score: { ...emptyScore(), mode: 'formula', minutes: 60 } })
    const estimated = (await db.tasks.get(id))!
    expect(() => buildCoachSplitProposal(estimated, [{ name: 'A', points: null }, { name: 'B', points: null }], 'AとBに分けて')).toThrow('本人が確定')
  })
})
describe('N08 周期の相談は周期設定へ渡し、タスクを変更しない', () => {
  it.each(['毎月末、会社営業日の最終日に勤怠提出', '毎週月曜に週報を出す', '隔週で1on1', '第3営業日に請求書'])('%s → routine', text => {
    expect(consultationKind(text)).toBe('routine')
  })
  it('通常の移動・分割・確認と区別する', () => {
    expect(consultationKind('報告書を明日に移して')).toBe('task')
    expect(consultationKind('調査と実装に分けて')).toBe('split')
    expect(consultationKind('半分にして')).toBe('clarify')
  })
  it.each([
    ['「月末精算」を明日に移して', '月末精算'],
    ['毎日の運動記録を明日に移して', '毎日の運動記録'],
    ['営業日報を明日に移して', '営業日報'],
    ['毎朝のストレッチを明日に移して', '毎朝のストレッチ'],
  ])('タイトル内の周期語では周期設定にしない：%s → task', (text, title) => {
    expect(consultationKind(text, [title, '買い物'])).toBe('task')
  })
  it('タイトル外に周期語があれば、既存タイトルを含んでも周期設定へ', () => {
    expect(consultationKind('第3営業日に請求書', ['請求書'])).toBe('routine')
    expect(consultationKind('週報を毎週月曜に', ['週報'])).toBe('routine')
    expect(consultationKind('「月末精算」を毎月末に', ['月末精算'])).toBe('routine')
  })
})
