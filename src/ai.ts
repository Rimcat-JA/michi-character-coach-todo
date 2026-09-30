import type { CharacterProfile, Goal, GoalCheckIn, Task } from './domain'
import { currentCheckInContext } from './goals'
import type { AIUsageLimits, AIUsageSnapshot } from './AIUsageView'
import type { DetectionRequest, DetectionChange } from './detection-contract'

export type AIStatus = { secureStorage: boolean; configured: boolean }
export type AIRequest = { model: string; message: string; selectedTask: string | null; character?: CharacterProfile }

declare global {
  interface Window {
    michiDesktop?: { openTopOfMind: () => Promise<boolean>; showMain: () => Promise<boolean>; notify: (payload: { title: string; body: string }) => Promise<boolean> }
    michiAI?: {
      status: () => Promise<AIStatus>
      saveKey: (value: string) => Promise<boolean>
      deleteKey: () => Promise<boolean>
      chat: (request: AIRequest) => Promise<string>
      summarize: (request: { model: string; kind: 'day-note' | 'goal-checkin' | 'review' | 'source'; text: string }) => Promise<string>
      assistTask: (request: { model: string; text: string }) => Promise<string>
      assessScore: (request: { model: string; text: string }) => Promise<string>
      proposeTaskChange: (request: { model: string; message: string; task: { id: string; title: string; notes: string; scheduledDate: string | null; dueDate: string | null; revision: number } }) => Promise<string>
      detectObligations: (input: { model: string; request: DetectionRequest }) => Promise<string>
      verifyObligations: (input: { model: string; request: DetectionRequest; change: DetectionChange }) => Promise<string>
      usage: () => Promise<AIUsageSnapshot>
      setUsageLimits: (limits: AIUsageLimits) => Promise<AIUsageSnapshot>
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
