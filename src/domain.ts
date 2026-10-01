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
  project: string; containerId?: string | null; planBucketId?: string | null; labels: string[]; scheduledDate: string | null; dueDate: string | null
  /** Clock deadline (UTC) and its IANA zone. When set, dueDate is its local date there (due_kind=datetime). */
  dueAt?: string | null; dueTimezone?: string | null
  targetDate: string | null; reviewDate: string | null; availableFrom: string | null; deferredUntil?: string | null; firstScheduledDate?: string | null; snoozedUntil?: string | null
  importance: number; frog?: number | null; weight?: number | null; energyNeed?: number | null; focusNeed?: number | null; positiveFeeling?: number | null; dayHalf?: 'morning' | 'afternoon' | null; customSection?: string | null; spotlightOrder?: number | null; pinned?: boolean; backburner?: boolean; orbit?: boolean; score: ScoreInput; effectivePoints: number | null
  assessmentId: string; status: 'open' | 'completed'; revision: number
  createdAt: string; updatedAt: string; deletedAt: string | null
}
export type Container = { id: string; parentId: string | null; kind: 'category' | 'project'; name: string; ownerId: string; revision: number; createdAt: string; updatedAt: string; deletedAt: string | null }
export type ChecklistItem = { id: string; taskId: string; text: string; done: boolean; convertedTaskId: string | null; createdAt: string; updatedAt: string }
export type LabelGroup = { id: string; ownerId: string; name: string; selectionMode: 'single' | 'multi'; createdAt: string }
export type LabelDefinition = { id: string; groupId: string | null; ownerId: string; name: string; createdAt: string }
export type TemplateTask = { title: string; notes: string; labels: string[]; importance: number; energyNeed?: number | null; focusNeed?: number | null; positiveFeeling?: number | null; score: ScoreInput; checklistTexts: string[]; containerKey: string | null }
export type TemplateContainer = { key: string; parentKey: string | null; kind: Container['kind']; name: string }
export type SavedTemplate = { id: string; familyId: string; ownerId: string; name: string; version: number; kind: 'task' | 'project'; containers: TemplateContainer[]; tasks: TemplateTask[]; createdAt: string }
export type TaskNote = { id: string; taskId: string; ownerId: string; kind: 'self' | 'source'; body: string; createdAt: string }
/** authorKind/authorLabel mark a comment returned by a share recipient (I06); absent means the owner wrote it. */
export type TaskComment = { id: string; taskId: string; ownerId: string; body: string; createdAt: string; authorKind?: 'share_recipient'; authorLabel?: string }
export type TaskAttachment = { id: string; taskId: string; ownerId: string; name: string; mediaType: string; size: number; sha256: string; blob: Blob; createdAt: string }
export type TaskDependency = { id: string; taskId: string; dependsOnId: string; createdAt: string }
export type PlanningBucket = { id: string; ownerId: string; kind: 'week' | 'month' | 'quarter'; startDate: string; endDate: string; parentId: string | null; revision: number; createdAt: string }
export type TimeBlock = { id: string; ownerId: string; kind: 'activity' | 'work_session'; category: string; projectId: string | null; date: string; startMinute: number; endMinute: number; timezone: string; taskIds: string[]; linkedSessionId: string | null; closed: boolean; revision: number; createdAt: string; updatedAt: string }
export type CalendarEvent = { id: string; ownerId: string; kind: 'meeting' | 'class' | 'other'; title: string; startAt: string; endAt: string; timezone: string; linkedTaskId: string | null; createdAt: string }
export type RolloverEntry = { id: string; taskId: string; fromDate: string; toDate: string; at: string }
export type ThemeRule = { id: string; ownerId: string; category: string; weekdays: number[]; startDate: string | null; endDate: string | null; strength: number; createdAt: string }
export type SmartListField = 'status' | 'title' | 'project' | 'labels' | 'scheduledDate' | 'dueDate' | 'importance' | 'effectivePoints' | 'minutes' | 'energyNeed' | 'focusNeed'
export type SmartListAst = { type: 'all' | 'any'; children: SmartListAst[] } | { type: 'not'; child: SmartListAst } | { type: 'condition'; field: SmartListField; operator: 'eq' | 'neq' | 'lte' | 'gte' | 'contains' | 'is_unknown'; value?: string | number }
export type SmartList = { id: string; ownerId: string; name: string; ast: SmartListAst; revision: number; createdAt: string; updatedAt: string }
export type FocusProjectSelection = { id: string; ownerId: string; date: string; projects: string[]; source: 'user' | 'coach'; revision: number; updatedAt: string }
export type AssessmentInstruction = { id: string; digest: string; ownerId: string; datasetId: string; actorId: string; actorKind: 'coach' | 'external-agent'; model: string | null; taskRevision: number; approvedBy: string }
export type Assessment = { id: string; taskId: string; score: ScoreInput; result: ScoreResult; createdAt: string; ruleVersion: 'v1' } & (
  { origin: 'human' | 'routine'; instruction?: never } |
  { origin: 'user_instruction_via_agent'; instruction: AssessmentInstruction }
)
export type Completion = { id: string; taskId: string; originalAt: string; currentAt: string | null; localDate?: string; timezone?: string; originalPoints: number | null; netPoints: number | null; lastConfirmedPoints?: number | null; allocationAssessmentId?: string; reconfirmedAssessmentId?: string; scoreState: 'pending' | 'confirmed'; title: string; project: string }
export type LedgerEntry = { id: string; completionId: string; taskId: string; kind: 'award' | 'adjust' | 'reverse' | 'restore'; delta: number; at: string; reason: string; assessmentId?: string }
export type Routine = { id: string; title: string; cadence: 'daily' | 'weekly' | 'monthly' | 'after_completion'; interval: number; weekdays: number[]; monthDay: number; startDate: string; endDate: string | null; excludedDates?: string[]; afterTaskId: string | null; score: ScoreInput; project: string; active: boolean; revision: number; createdAt: string }
export type WorkSession = { id: string; taskId: string; startedAt: string; endedAt: string; minutes: number; revision?: number; corrections?: { startedAt: string; endedAt: string; minutes: number; reason: string; at: string }[] }
export type PomodoroCycle = { id: string; taskId: string; startedAt: string; finishedAt: string; targetMinutes: number; elapsedMinutes: number }
export type WallTile = { taskId: string; x: number; y: number; group: string }
export type WorkflowConfig = { navDesktop: string[]; navMobile: string[]; hiddenFeatures: string[]; daySectionMode: 'halfday' | 'category' | 'timeblock' | 'custom'; taskListLimit: number | null; dailyMinutes: number; dailyPoints: number }
export type WorkflowPreset = { id: string; name: string; version: number; config: WorkflowConfig; createdAt: string; updatedAt: string }
export type Appearance = { theme: 'light' | 'soft' | 'high-contrast'; accent: 'violet' | 'blue' | 'green' | 'rose'; fontScale: 90 | 100 | 110 | 120; iconStyle: 'outline' | 'bold' }
export type ReminderRule = { id: string; kind: 'once' | 'smart-daily' | 'bug-me' | 'review'; targetId: string; nextAt: string; timeOfDay: string | null; reviewDate?: string | null; intervalMinutes: number; maxCount: number; sentCount: number; endDate: string | null; channels: ('in-app' | 'os')[]; enabled: boolean; createdAt: string; updatedAt: string }
export type ReminderEvent = { id: string; ruleId: string; targetId: string; kind: ReminderRule['kind']; title: string; reviewDate?: string; reviewRevision?: number; at: string; channels: ('in-app' | 'os')[]; readAt: string | null }
export type ReminderState = { quietStart: string; quietEnd: string; dailyCap: number; rules: ReminderRule[]; events: ReminderEvent[] }
export type Keybindings = { newTask: string; quickJump: string; settings: string }
export type CharacterProfile = { pronoun: '私' | '僕' | 'わたし'; tone: 'gentle' | 'direct' | 'playful'; detail: 'brief' | 'standard' | 'thorough'; coachingStyle: 'encouraging' | 'practical' | 'reflective'; avoidPhrases: string[] }
export type DashboardWidgetId = 'today' | 'capacity' | 'points' | 'completed' | 'sync'
export type CustomScreen = { leftListId: string | null; rightListId: string | null; topListId: string | null }
export type TimeTarget = { id: string; containerId: string; startDate: string; endDate: string; targetMinutes: number }
export type DayProgressBaseline = { date: string; capturedAt: string; entries: { taskId: string; minutes: number | null; points: number | null }[] }
export type Habit = { id: string; ownerId: string; title: string; direction: 'increase' | 'decrease'; unit: string; targetAmount: number; cadence: 'daily' | 'weekly' | 'monthly'; weekdays: number[]; timezone: string; routineId: string | null; active: boolean; createdAt: string; updatedAt: string }
export type HabitLog = { id: string; habitId: string; date: string; amount: number; source: 'manual' | 'task'; taskId: string | null; revision: number; updatedAt: string; history: { amount: number; at: string; reason: string }[] }
export type Goal = { id: string; ownerId: string; title: string; description: string; parentId: string | null; dueDate: string | null; containerId: string | null; taskIds: string[]; habitIds: string[]; manualPercent: number | null; checkInCadence: 'weekly' | 'monthly' | null; checkInQuestion: string; revision: number; createdAt: string; updatedAt: string; deletedAt: string | null }
export type GoalCheckIn = { id: string; goalId: string; date: string; answer: string; summary: string | null; summaryOrigin: 'ai' | 'human' | null; summaryRevision: number; history: { summary: string | null; at: string }[]; createdAt: string; updatedAt: string; deletedAt: string | null }
export type TrackerDefinition = { id: string; ownerId: string; name: string; unit: string; min: number; max: number; private: true; createdAt: string; updatedAt: string }
export type TrackerEntry = { id: string; trackerId: string; value: number | null; recordedAt: string; source: 'user' | 'device'; note: string }
export type DayNote = { id: string; ownerId: string; date: string; timezone: string; humanText: string; aiSummary: string | null; summaryOrigin: 'ai' | 'human' | null; humanRevision: number; summaryRevision: number; summaryOfHumanRevision: number | null; history: { kind: 'human' | 'summary'; text: string | null; at: string; revision: number }[]; createdAt: string; updatedAt: string; deletedAt: string | null }
export type CommandReceipt = { key: string; hash: string; resultId: string; at: string }
export type Audit = { id: string; taskId: string | null; operation: string; at: string; detail: string }
export type NetworkPolicy = 'offline_only' | 'explicit_online'
/** contracts/runtime-profile.schema.json v1. This build only runs standalone: authority local, no server URL. */
export type RuntimeProfile = { schema_version: '1'; kind: 'standalone'; dataset_id: string; authority: 'local'; network_policy: NetworkPolicy; server_url: null }
export type RoutineCatchupSummary = { at: string; previousRunAt: string | null; days: number; created: number; unexpanded: number; truncatedRoutineIds: string[]; acknowledgedAt: string | null }
/** checkpoints: routine id -> last local date already expanded (expandedThrough). */
export type RoutineCatchupState = { checkpoints: Record<string, string>; lastRunAt: string | null; summary: RoutineCatchupSummary | null }
/** Loopback-only embedding service for hybrid search; off (null/absent) by default. */
export type EmbeddingSettings = { provider: 'loopback-openai-compatible'; endpoint: string; model: string }
export type Settings = { id: 'main'; profileId: string; datasetId: string; createdAt: string; coachName: string; dailyMinutes: number; dailyPoints: number; notifications: boolean; aiEnabled: boolean; aiModel?: string; aiVerifierModel?: string | null; embedding?: EmbeddingSettings | null; changePolicy?: ChangePolicy; notificationState?: CoachNotificationState; daySectionMode?: 'halfday' | 'category' | 'timeblock' | 'custom'; taskListLimit?: number | null; automation: 'A0' | 'A1' | 'A2' | 'A3' | 'custom'; lastBackupAt: string | null; timeTargets?: TimeTarget[]; dayProgressBaseline?: DayProgressBaseline; wallTiles?: WallTile[]; navDesktop?: string[]; navMobile?: string[]; hiddenFeatures?: string[]; workflowPresets?: WorkflowPreset[]; appearance?: Appearance; reminderState?: ReminderState; keybindings?: Keybindings; characterProfile?: CharacterProfile; dashboardWidgets?: DashboardWidgetId[]; customScreen?: CustomScreen; runtimeProfile?: RuntimeProfile; routineCatchup?: RoutineCatchupState; datasetMode?: 'active' | 'frozen' | 'read_only'; lineage?: DatasetLineage }
/** I05: a fork keeps its ancestors (newest first) so earlier provenance stays valid; moveId marks a received or completed move. */
export type DatasetLineage = { parentDatasetId: string | null; ancestorDatasetIds: string[]; forkedAt: string | null; moveId: string | null }

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
  const base = (s.minutes ?? 0) + (s.travelMinutes ?? 0)
  const low = 2 * Math.ceil(base / 15) + 4 * (s.difficulty ?? 0) + 3 * (s.uncertainty ?? 0) + 3 * (s.coordination ?? 0) + 2 * (s.physical ?? 0) + (s.outing ? 10 : 0)
  const high = s.minutes === null || s.travelMinutes === null ? null : 2 * Math.ceil((s.minutes + s.travelMinutes) / 15) + 4 * (s.difficulty ?? 4) + 3 * (s.uncertainty ?? 3) + 3 * (s.coordination ?? 3) + 2 * (s.physical ?? 3) + (s.outing === false ? 0 : 10)
  const lower = Math.max(s.outing === true ? 20 : 1, low)
  const upper = high === null ? null : Math.max(s.outing === false ? 1 : 20, high)
  const complete = s.minutes !== null && s.travelMinutes !== null && s.difficulty !== null && s.uncertainty !== null && s.coordination !== null && s.physical !== null && s.outing !== null
  return { effective: complete ? lower : null, lower, upper, label: complete ? '自動' : '推定範囲' }
}
export function validateTaskInput(input: Pick<Task, 'title' | 'notes' | 'importance' | 'score'> & Partial<Pick<Task, 'frog' | 'weight' | 'energyNeed' | 'focusNeed' | 'positiveFeeling'>>) {
  const title = input.title.trim()
  if (!title || title.length > 300) throw new Error('タイトルは1〜300文字で入力してください')
  if (input.notes.length > 50000) throw new Error('メモは50,000文字以内で入力してください')
  integer(input.importance, 0, 3, '重要度')
  for (const [name, value] of [['frog', input.frog], ['weight', input.weight], ['energyNeed', input.energyNeed], ['focusNeed', input.focusNeed], ['positiveFeeling', input.positiveFeeling]] as const) if (value !== undefined && value !== null) integer(value, 0, 4, name)
  validateScore(input.score)
}
export function validateDate(date: string | null, label: string) {
  if (date === null) return
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || today(new Date(`${date}T12:00:00`)) !== date) throw new Error(`${label}は有効な日付にしてください`)
}
export type TaskDueKind = 'none' | 'date' | 'datetime'
export const taskDueKind = (task: Pick<Task, 'dueDate' | 'dueAt'>): TaskDueKind => task.dueAt ? 'datetime' : task.dueDate ? 'date' : 'none'
/** dueAt and a different dueDate can never coexist: a clock deadline's dueDate is always its local date. */
export function validateTaskDue(task: Pick<Task, 'dueDate' | 'dueAt' | 'dueTimezone'>) {
  const at = task.dueAt ?? null, zone = task.dueTimezone ?? null
  if (at === null) { if (zone !== null) throw new Error('時刻のない締め切りにタイムゾーンは付けません'); return }
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) throw new Error('締め切り時刻はUTCのISO形式で指定してください')
  if (!isTimeZone(zone)) throw new Error('締め切り時刻のタイムゾーンを指定してください')
  if (task.dueDate !== localDateAt(at, zone)) throw new Error('締め切り日と締め切り時刻の現地日付が一致しません')
}
/** The owner's local deadline. A clock skipped or repeated by a DST change is refused with an explanation instead of guessed. */
export function taskDueAt(date: string, time: string, timezone: string): string {
  if (!isTimeZone(timezone)) throw new Error('締め切りのタイムゾーンが不正です')
  const resolved = resolveZonedLocalTime(date, time, timezone)
  if (resolved.kind === 'nonexistent') throw new Error(`${date} ${time}は${timezone}では夏時間の切替で存在しない時刻です。別の時刻を指定してください`)
  if (resolved.kind === 'ambiguous') throw new Error(`${date} ${time}は${timezone}では夏時間の切替で二度ある時刻です。別の時刻を指定してください`)
  return resolved.at!
}
export const taskDueTime = (task: Pick<Task, 'dueAt' | 'dueTimezone'>) => task.dueAt && task.dueTimezone ? localTimeAt(task.dueAt, task.dueTimezone) : null
export function dueText(task: Pick<Task, 'dueDate' | 'dueAt' | 'dueTimezone'>, deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const time = taskDueTime(task)
  return task.dueDate ? `${task.dueDate}${time ? ` ${time}${task.dueTimezone !== deviceZone ? `（${task.dueTimezone}）` : ''}` : ''}` : ''
}
export function scoreText(task: Pick<Task, 'score' | 'effectivePoints'>) {
  if (task.effectivePoints !== null) return `${task.effectivePoints}pt · ${task.score.mode === 'manual' ? '手動' : task.score.mode === 'allocated' ? '配分' : '自動'}`
  if (task.score.mode === 'formula') { const r = calculateScore(task.score); return r.upper === null ? `${r.lower}pt〜 · 上限不明` : `${r.lower}–${r.upper}pt · 推定` }
  return '未設定'
}
import { isTimeZone, localDateAt, localTimeAt, resolveZonedLocalTime } from './zoned-time'
import type { ChangePolicy } from './change-set'
import type { CoachNotificationState } from './coach-notifications'
