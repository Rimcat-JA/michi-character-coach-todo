import type { ScoreInput } from './domain'

export function estimatedDuration(score: ScoreInput): { work: number | null; travel: number | null; total: number | null } {
  return { work: score.minutes, travel: score.travelMinutes, total: score.minutes === null || score.travelMinutes === null ? null : score.minutes + score.travelMinutes }
}
