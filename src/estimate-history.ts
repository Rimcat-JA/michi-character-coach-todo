import type { Assessment, Task } from './domain'

export type EstimateHistoryEntry = { id: string; at: string; workMinutes: number | null; travelMinutes: number | null; totalMinutes: number | null; knownMinutes: number; current: boolean; origin: Assessment['origin'] }
/** Saved immutable assessments are already written with the task transaction and carried by backups. */
export function estimateHistory(task: Pick<Task, 'id' | 'assessmentId'>, assessments: Assessment[]): EstimateHistoryEntry[] {
  return assessments.filter(row => row.taskId === task.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).map(row => ({
    id: row.id, at: row.createdAt, workMinutes: row.score.minutes, travelMinutes: row.score.travelMinutes,
    totalMinutes: row.score.minutes === null || row.score.travelMinutes === null ? null : row.score.minutes + row.score.travelMinutes,
    knownMinutes: (row.score.minutes ?? 0) + (row.score.travelMinutes ?? 0), current: row.id === task.assessmentId, origin: row.origin,
  }))
}
