import type { Task } from './domain'

export type AIStatus = { secureStorage: boolean; configured: boolean }
export type AIRequest = { model: string; message: string; selectedTask: string | null }

declare global {
  interface Window {
    michiAI?: {
      status: () => Promise<AIStatus>
      saveKey: (value: string) => Promise<boolean>
      deleteKey: () => Promise<boolean>
      chat: (request: AIRequest) => Promise<string>
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
