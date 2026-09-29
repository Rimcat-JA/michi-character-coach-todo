export type ScoreMode = 'unset' | 'manual' | 'formula' | 'allocated'
export type ScoreInput = {
  mode: ScoreMode
  manualPoints: number | null
  minutes: number | null
  travelMinutes: number | null
  difficulty: number | null
  uncertainty: number | null
  coordination: number | null
  physical: number | null
  outing: boolean | null
}
export type ScoreResult = { effective: number | null; lower: number | null; upper: number | null; label: string }
export type Task = {
  id: string; generationKey: string; routineId: string | null; title: string; notes: string
  project: string; labels: string[]; scheduledDate: string | null; dueDate: string | null
  targetDate: string | null; reviewDate: string | null; availableFrom: string | null
  importance: number; score: ScoreInput; effectivePoints: number | null
  assessmentId: string; status: 'open' | 'completed'; revision: number
  createdAt: string; updatedAt: string; deletedAt: string | null
}
export type Assessment = { id: string; taskId: string; score: ScoreInput; result: ScoreResult; createdAt: string; origin: 'human' | 'routine'; ruleVersion: 'v1' }
export type Completion = { id: string; taskId: string; originalAt: string; currentAt: string | null; originalPoints: number | null; netPoints: number | null; lastConfirmedPoints?: number | null; scoreState: 'pending' | 'confirmed'; title: string; project: string }
export type LedgerEntry = { id: string; completionId: string; taskId: string; kind: 'award' | 'adjust' | 'reverse' | 'restore'; delta: number; at: string; reason: string }
export type Routine = { id: string; title: string; cadence: 'daily' | 'weekly' | 'monthly' | 'after_completion'; interval: number; weekdays: number[]; monthDay: number; startDate: string; endDate: string | null; excludedDates?: string[]; afterTaskId: string | null; score: ScoreInput; project: string; active: boolean; revision: number; createdAt: string }
export type WorkSession = { id: string; taskId: string; startedAt: string; endedAt: string; minutes: number }
export type CommandReceipt = { key: string; hash: string; resultId: string; at: string }
export type Audit = { id: string; taskId: string | null; operation: string; at: string; detail: string }
export type Settings = { id: 'main'; profileId: string; datasetId: string; createdAt: string; coachName: string; dailyMinutes: number; dailyPoints: number; notifications: boolean; aiEnabled: boolean; aiModel?: string; automation: 'A0' | 'A1' | 'A2'; lastBackupAt: string | null }

export const emptyScore = (): ScoreInput => ({ mode: 'unset', manualPoints: null, minutes: null, travelMinutes: null, difficulty: null, uncertainty: null, coordination: null, physical: null, outing: null })
export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const addDays = (date: string, days: number) => { const d = new Date(`${date}T12:00:00`); d.setDate(d.getDate() + days); return today(d) }
export const uid = () => crypto.randomUUID()

function integer(value: unknown, min: number, max: number, name: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${name}は${min}〜${max}の整数で指定してください`)
}
export function validateScore(s: ScoreInput) {
  if (s.mode === 'manual' || s.mode === 'allocated') integer(s.manualPoints, 0, 100000, 'ポイント')
  for (const [key, max] of [['minutes', 10080], ['travelMinutes', 10080], ['difficulty', 4], ['uncertainty', 3], ['coordination', 3], ['physical', 3]] as const) {
    if (s[key] !== null) integer(s[key], 0, max, key)
  }
  if (s.outing !== null && typeof s.outing !== 'boolean') throw new Error('外出の値が不正です')
}
export function calculateScore(s: ScoreInput): ScoreResult {
  validateScore(s)
  if (s.mode === 'unset') return { effective: null, lower: null, upper: null, label: '未設定' }
  if (s.mode === 'manual' || s.mode === 'allocated') return { effective: s.manualPoints, lower: s.manualPoints, upper: s.manualPoints, label: s.mode === 'manual' ? '手動' : '配分' }
  const base = (s.minutes === null ? 0 : s.minutes + (s.travelMinutes ?? 0))
  const low = 2 * Math.ceil(base / 15) + 4 * (s.difficulty ?? 0) + 3 * (s.uncertainty ?? 0) + 3 * (s.coordination ?? 0) + 2 * (s.physical ?? 0) + (s.outing ? 10 : 0)
  const high = s.minutes === null || s.travelMinutes === null ? null : 2 * Math.ceil((s.minutes + s.travelMinutes) / 15) + 4 * (s.difficulty ?? 4) + 3 * (s.uncertainty ?? 3) + 3 * (s.coordination ?? 3) + 2 * (s.physical ?? 3) + (s.outing === false ? 0 : 10)
  const lower = Math.max(s.outing === true ? 20 : 1, low)
  const upper = high === null ? null : Math.max(s.outing === false ? 1 : 20, high)
  const complete = s.minutes !== null && s.travelMinutes !== null && s.difficulty !== null && s.uncertainty !== null && s.coordination !== null && s.physical !== null && s.outing !== null
  return { effective: complete ? lower : null, lower, upper, label: complete ? '自動' : '推定範囲' }
}
export function validateTaskInput(input: Pick<Task, 'title' | 'notes' | 'importance' | 'score'>) {
  const title = input.title.trim()
  if (!title || title.length > 300) throw new Error('タイトルは1〜300文字で入力してください')
  if (input.notes.length > 50000) throw new Error('メモは50,000文字以内で入力してください')
  integer(input.importance, 0, 3, '重要度')
  validateScore(input.score)
}
export function validateDate(date: string | null, label: string) {
  if (date === null) return
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || today(new Date(`${date}T12:00:00`)) !== date) throw new Error(`${label}は有効な日付にしてください`)
}
export function scoreText(task: Pick<Task, 'score' | 'effectivePoints'>) {
  if (task.effectivePoints !== null) return `${task.effectivePoints}pt · ${task.score.mode === 'manual' ? '手動' : task.score.mode === 'allocated' ? '配分' : '自動'}`
  if (task.score.mode === 'formula') { const r = calculateScore(task.score); return r.upper === null ? `${r.lower}pt〜 · 上限不明` : `${r.lower}–${r.upper}pt · 推定` }
  return '未設定'
}
