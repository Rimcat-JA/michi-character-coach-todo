import type { CharacterProfile, Goal, GoalCheckIn, Task } from './domain'
import { currentCheckInContext } from './goals'
import type { AIUsageLimits, AIUsageSnapshot } from './AIUsageView'
import type { DetectionRequest, DetectionChange } from './detection-contract'
import type { RoutineAssistRequest } from './routine-assist'
import type { NotificationTextTransport } from './notification-text'
import type { CoachTargetCandidate } from './coach-target-resolution'

export type AIStatus = { secureStorage: boolean; configured: boolean }
export type AIRequest = { model: string; message: string; selectedTask: string | null; character?: CharacterProfile }

declare global {
  interface Window {
    michiDesktop?: { openTopOfMind: () => Promise<boolean>; showMain: () => Promise<boolean>; notify: (payload: { notificationId: string; destinationId: string; attemptId: string; title: string; body: string; provenance: 'factual-template' | 'saved-ai' }) => Promise<boolean>; setTrayMode?: (enabled: boolean) => Promise<boolean>; onTrayStopNotifications?: (callback: () => void) => () => void }
    michiAI?: {
      status: () => Promise<AIStatus>
      saveKey: (value: string) => Promise<boolean>
      deleteKey: () => Promise<boolean>
      chat: (request: AIRequest) => Promise<string>
      summarize: (request: { model: string; kind: 'day-note' | 'goal-checkin' | 'review' | 'source'; text: string }) => Promise<string>
      assistTask: (request: { model: string; text: string }) => Promise<string>
      assessScore: (request: { model: string; text: string }) => Promise<string>
      proposeTaskChange: (request: { model: string; message: string; task: { id: string; title: string; notes: string; scheduledDate: string | null; dueDate: string | null; revision: number; scoreMode: Task['score']['mode']; manualPoints: number | null } }) => Promise<string>
      proposeTaskSplit?: (request: { model: string; message: string; task: { id: string; title: string; revision: number; scoreMode: Task['score']['mode']; manualPoints: number | null } }) => Promise<string>
      proposeRoutine: (request: RoutineAssistRequest) => Promise<string>
      detectObligations: (input: { model: string; request: DetectionRequest }) => Promise<string>
      verifyObligations: (input: { model: string; request: DetectionRequest; change: DetectionChange }) => Promise<string>
      notificationText?: NotificationTextTransport
      resolveTarget?: (request: { model: string; message: string; candidates: CoachTargetCandidate[] }) => Promise<string>
      usage: () => Promise<AIUsageSnapshot>
      setUsageLimits: (limits: AIUsageLimits) => Promise<AIUsageSnapshot>
    }
  }
}

/** Callers pass notes already filtered by egress-policy; evidence lines are only the quotes the sources allow. */
export function selectedTaskContext(task: Task | undefined, evidence: string[] = []): string | null {
  if (!task) return null
  return [
    `タイトル: ${task.title}`,
    task.notes ? `メモ: ${task.notes.slice(0, 3000)}` : null,
    ...evidence.map(line => line.slice(0, 2100)),
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
