import type { Goal, GoalCheckIn, Task } from './domain'
import { currentCheckInContext } from './goals'

export type AIStatus = { secureStorage: boolean; configured: boolean }
export type AIRequest = { model: string; message: string; selectedTask: string | null }

declare global {
  interface Window {
    michiAI?: {
      status: () => Promise<AIStatus>
      saveKey: (value: string) => Promise<boolean>
      deleteKey: () => Promise<boolean>
      chat: (request: AIRequest) => Promise<string>
      summarize: (request: { model: string; kind: 'day-note' | 'goal-checkin'; text: string }) => Promise<string>
    }
  }
}

export function selectedTaskContext(task: Task | undefined): string | null {
  if (!task) return null
  return [
    `タイトル: ${task.title}`,
    task.notes ? `メモ: ${task.notes.slice(0, 3000)}` : null,
    task.scheduledDate ? `予定日: ${task.scheduledDate}` : null,
    task.dueDate ? `締め切り: ${task.dueDate}` : null,
    task.effectivePoints === null ? '必要ポイント: 未設定' : `必要ポイント: ${task.effectivePoints}pt`
  ].filter(Boolean).join('\n').slice(0, 5000)
}

export function selectedGoalContext(goal: Goal | undefined, checkIns: GoalCheckIn[]): string | null {
  if (!goal || goal.deletedAt) return null
  const context = currentCheckInContext(checkIns, goal.id).slice(0, 3)
  return [`目標: ${goal.title}`, ...context.map(item => `${item.date} 本人回答: ${item.answer}\n現行要約: ${item.summary ?? 'なし'}`)].join('\n').slice(0, 5000)
}
