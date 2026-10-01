import { canonicalJSON } from './canonical'
import { calculateScore, type Assessment, type LedgerEntry } from './domain'

export function validCompletionLedgerEntry(row: LedgerEntry, taskId: string, completionId: string) {
  return row.taskId === taskId && row.completionId === completionId && ['award', 'adjust', 'reverse', 'restore'].includes(row.kind) && Number.isInteger(row.delta) && Math.abs(row.delta) <= 100000 && Number.isFinite(Date.parse(row.at)) && typeof row.reason === 'string' && Boolean(row.reason.trim()) && (!['award', 'restore'].includes(row.kind) || row.delta >= 0) && (row.kind !== 'reverse' || row.delta <= 0)
}

export function validReconfirmationAssessment(assessment: Assessment | undefined, taskId: string): assessment is Assessment {
  if (!assessment || assessment.taskId !== taskId || assessment.origin !== 'human' || Object.hasOwn(assessment, 'instruction') || assessment.ruleVersion !== 'v1' || assessment.score.mode !== 'manual') return false
  try { return canonicalJSON(calculateScore(assessment.score)) === canonicalJSON(assessment.result) } catch { return false }
}

export function validReconfirmedPoints(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100000 }
