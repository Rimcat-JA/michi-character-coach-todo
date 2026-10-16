import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { db, ensureSettings } from './db'
import { captureSnapshot, restoreBackup } from './backup'
import { completeTask, createTask, newTaskInput, updateTask } from './commands'
import { emptyScore } from './domain'
import { EstimateHistoryTable } from './TaskEstimateHistory'
import { estimateHistory } from './estimate-history'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })
describe('E01 保存済み評価からの専用見積履歴', () => {
  it('30+20から45+20への変更を別々に保ち、手動25pt・完了台帳を通常編集で変えない', async () => {
    const input = { ...newTaskInput(), title: '見積履歴', score: { ...emptyScore(), mode: 'manual' as const, manualPoints: 25, minutes: 30, travelMinutes: 20 } }
    const id = await createTask(input)
    await completeTask(id, 1)
    const task = (await db.tasks.get(id))!, ledger = await db.ledger.toArray(), completion = await db.completions.toArray()
    await updateTask(id, task.revision, { ...input, score: { ...input.score, minutes: 45 } })
    const current = (await db.tasks.get(id))!, assessments = await db.assessments.toArray()
    const history = estimateHistory(current, assessments)
    expect(history.map(row => row.totalMinutes).sort()).toEqual([50, 65])
    expect(history.filter(row => row.current)).toHaveLength(1)
    expect(history.find(row => row.current)).toMatchObject({ workMinutes: 45, travelMinutes: 20 })
    expect(current.effectivePoints).toBe(25)
    expect(await db.ledger.toArray()).toEqual(ledger)
    expect(await db.completions.toArray()).toEqual(completion)
    const backup = await captureSnapshot()
    await restoreBackup(backup)
    expect(estimateHistory((await db.tasks.get(id))!, await db.assessments.toArray())).toEqual(history)
  })

  it('0分と未設定を区別し、別タスクの評価は見せず、同時刻の行も失わない', async () => {
    const id = await createTask({ ...newTaskInput(), title: '0と未設定', score: { ...emptyScore(), minutes: 0, travelMinutes: null } })
    await createTask({ ...newTaskInput(), title: '別タスク', score: { ...emptyScore(), minutes: 99 } })
    const task = (await db.tasks.get(id))!, assessments = await db.assessments.toArray()
    expect(estimateHistory(task, assessments)).toHaveLength(1)
    expect(estimateHistory(task, assessments)[0]).toMatchObject({ workMinutes: 0, travelMinutes: null, totalMinutes: null, knownMinutes: 0 })
    const html = renderToStaticMarkup(<EstimateHistoryTable task={task} assessments={assessments} sessions={[]} />)
    expect(html).toContain('0分'); expect(html).toContain('未設定を含む'); expect(html).not.toContain('99分')
  })

  it('作業記録の重なる区間を二重加算せず、見積の合計と分けて表示する', async () => {
    const id = await createTask({ ...newTaskInput(), title: '区間', score: { ...emptyScore(), minutes: 30, travelMinutes: 20 } })
    const task = (await db.tasks.get(id))!, at = '2026-10-03T'
    const sessions = [{ id: 's1', taskId: id, startedAt: `${at}01:00:00.000Z`, endedAt: `${at}01:30:00.000Z`, minutes: 30 }, { id: 's2', taskId: id, startedAt: `${at}01:15:00.000Z`, endedAt: `${at}01:45:00.000Z`, minutes: 30 }]
    const html = renderToStaticMarkup(<EstimateHistoryTable task={task} assessments={await db.assessments.toArray()} sessions={sessions} />)
    expect(html).toContain('実作業時間: 45分')
    expect(html).toContain('>50分<')
    expect(html).not.toContain('実作業時間: 60分')
    expect(await db.ledger.count()).toBe(0)
  })
})
