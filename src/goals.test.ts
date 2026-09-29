import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput } from './commands'
import { emptyScore } from './domain'
import { allGoalsPoints, createGoal, createGoalCheckIn, currentCheckInContext, deleteGoalCheckIn, goalProgress, reviseGoalCheckIn, setGoalCheckInAiSummary } from './goals'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

const goalInput = (title: string, taskId: string) => ({ title, description: '', parentId: null, dueDate: null, containerId: null, taskIds: [taskId], habitIds: [], manualPercent: null, checkInCadence: 'weekly' as const, checkInQuestion: '進捗は？' })

describe('目標とチェックイン', () => {
  it('一つのタスクを二目標へ関連付けても全体ポイントは一度だけ', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '一つの作業', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
    const first = await createGoal(goalInput('目標A', taskId))
    const second = await createGoal(goalInput('目標B', taskId))
    await completeTask(taskId, 1)
    const [goals, tasks, containers, habits, completions, sessions] = await Promise.all([db.goals.toArray(), db.tasks.toArray(), db.containers.toArray(), db.habits.toArray(), db.completions.toArray(), db.sessions.toArray()])
    expect(goalProgress(goals.find(goal => goal.id === first)!, goals, tasks, containers, habits, completions, sessions).points).toBe(40)
    expect(goalProgress(goals.find(goal => goal.id === second)!, goals, tasks, containers, habits, completions, sessions).points).toBe(40)
    expect(allGoalsPoints(goals, tasks, containers, habits, completions)).toBe(40)
    expect((await db.ledger.toArray()).reduce((sum, item) => sum + item.delta, 0)).toBe(40)
  })

  it('誤った要約を訂正・削除した後、次の文脈へ旧要約を渡さない', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '練習' })
    const goalId = await createGoal(goalInput('学習', taskId))
    const id = await createGoalCheckIn(goalId, '2026-10-01', '30分取り組んだ', '何もしなかった')
    await reviseGoalCheckIn(id, 1, '30分取り組んだ', '30分練習した')
    const context = currentCheckInContext(await db.goalCheckIns.toArray(), goalId)
    expect(context).toEqual([{ date: '2026-10-01', answer: '30分取り組んだ', summary: '30分練習した' }])
    expect(JSON.stringify(context)).not.toContain('何もしなかった')
    expect((await db.goalCheckIns.get(id))?.history[0].summary).toBe('何もしなかった')
    await deleteGoalCheckIn(id, 2)
    expect(currentCheckInContext(await db.goalCheckIns.toArray(), goalId)).toEqual([])
  })

  it('AI要約を別保存し、本人の訂正後は旧要約を次の文脈へ渡さない', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '練習' })
    const goalId = await createGoal(goalInput('学習', taskId))
    const id = await createGoalCheckIn(goalId, '2026-10-01', '30分取り組んだ')
    await setGoalCheckInAiSummary(id, 1, '30分取り組んだ', '何もしなかった')
    expect((await db.goalCheckIns.get(id))?.summaryOrigin).toBe('ai')
    await reviseGoalCheckIn(id, 2, '30分取り組んだ', '30分練習した')
    await expect(setGoalCheckInAiSummary(id, 2, '30分取り組んだ', '古い応答')).rejects.toThrow('別の画面')
    expect(JSON.stringify(currentCheckInContext(await db.goalCheckIns.toArray(), goalId))).not.toContain('何もしなかった')
  })
})
