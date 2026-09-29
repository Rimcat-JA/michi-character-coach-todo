import { calculateScore, validateTaskInput, validateDate, type Assessment, type Audit, type CommandReceipt, type Completion, type LedgerEntry, type Routine, type Settings, type Task, type WorkSession } from './domain'

export type Snapshot = {
  format: 'coachbundle'; version: 1; exportedAt: string
  tasks: Task[]; assessments: Assessment[]; completions: Completion[]; ledger: LedgerEntry[]
  routines: Routine[]; sessions: WorkSession[]; commands: CommandReceipt[]; audits: Audit[]; settings: Settings[]
}

const tableNames = ['tasks', 'assessments', 'completions', 'ledger', 'routines', 'sessions', 'commands', 'audits', 'settings'] as const
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const filled = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
const points = (value: unknown) => value === null || (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100000)
const timestamp = (value: unknown) => filled(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value

function requireRows(value: Record<string, unknown>, name: typeof tableNames[number]) {
  if (!Array.isArray(value[name])) throw new Error(`バックアップの${name}がありません`)
  return value[name] as unknown[]
}

function unique(rows: unknown[], name: string, key: string) {
  const seen = new Set<string>()
  for (const row of rows) {
    if (!record(row) || !filled(row[key])) throw new Error(`${name}の${key}が不正です`)
    if (seen.has(row[key])) throw new Error(`${name}の${key}が重複しています`)
    seen.add(row[key])
  }
  return seen
}

function dateOrNull(value: unknown, name: string) {
  if (!nullableString(value)) throw new Error(`${name}が不正です`)
  validateDate(value, name)
}

export function validateSnapshot(input: unknown): asserts input is Snapshot {
  if (!record(input) || input.format !== 'coachbundle' || input.version !== 1) throw new Error('対応していないバックアップ形式です')
  if (!timestamp(input.exportedAt)) throw new Error('書き出し日時が不正です')
  const tables = Object.fromEntries(tableNames.map(name => [name, requireRows(input, name)])) as Record<typeof tableNames[number], unknown[]>
  const taskIds = unique(tables.tasks, 'tasks', 'id')
  unique(tables.tasks, 'tasks', 'generationKey')
  const assessmentIds = unique(tables.assessments, 'assessments', 'id')
  const completionIds = unique(tables.completions, 'completions', 'id')
  unique(tables.completions, 'completions', 'taskId')
  unique(tables.ledger, 'ledger', 'id')
  unique(tables.routines, 'routines', 'id')
  const routineIds = new Set(tables.routines.map(row => (row as Routine).id))
  unique(tables.sessions, 'sessions', 'id')
  unique(tables.commands, 'commands', 'key')
  unique(tables.audits, 'audits', 'id')
  if (tables.settings.length !== 1 || !record(tables.settings[0]) || tables.settings[0].id !== 'main') throw new Error('設定が不正です')

  const assessmentById = new Map(tables.assessments.map(row => [((row as Record<string, unknown>).id as string), row as Record<string, unknown>]))
  for (const raw of tables.tasks) {
    const task = raw as Task
    if (!filled(task.title) || typeof task.notes !== 'string' || typeof task.project !== 'string' || !Array.isArray(task.labels) || task.labels.some(label => typeof label !== 'string') || task.labels.length > 30) throw new Error('タスクの内容が不正です')
    if (!record(task.score) || !['unset', 'manual', 'formula', 'allocated'].includes(task.score.mode as string) || !['open', 'completed'].includes(task.status) || !Number.isInteger(task.revision) || task.revision < 1 || !points(task.effectivePoints)) throw new Error('タスクの状態が不正です')
    if (!nullableString(task.routineId) || (task.routineId !== null && !routineIds.has(task.routineId)) || !nullableString(task.deletedAt) || !timestamp(task.createdAt) || !timestamp(task.updatedAt) || (task.deletedAt !== null && !timestamp(task.deletedAt))) throw new Error('タスクの履歴が不正です')
    for (const [name, value] of [['予定日', task.scheduledDate], ['締め切り', task.dueDate], ['目標日', task.targetDate], ['見直し日', task.reviewDate], ['開始可能日', task.availableFrom]] as const) dateOrNull(value, name)
    validateTaskInput(task)
    if (calculateScore(task.score).effective !== task.effectivePoints) throw new Error('タスクのポイントが評価と一致しません')
    const assessment = assessmentById.get(task.assessmentId)
    if (!assessment || assessment.taskId !== task.id) throw new Error('タスクの評価参照が不正です')
  }

  for (const raw of tables.assessments) {
    const assessment = raw as Assessment
    if (!taskIds.has(assessment.taskId) || !timestamp(assessment.createdAt) || !['human', 'routine'].includes(assessment.origin) || assessment.ruleVersion !== 'v1' || !record(assessment.result) || !record(assessment.score) || !['unset', 'manual', 'formula', 'allocated'].includes(assessment.score.mode as string)) throw new Error('評価履歴が不正です')
    const calculated = calculateScore(assessment.score)
    if (calculated.effective !== assessment.result.effective || calculated.lower !== assessment.result.lower || calculated.upper !== assessment.result.upper) throw new Error('評価履歴のポイントが一致しません')
  }
  if (assessmentIds.size < tables.tasks.length) throw new Error('評価履歴が不足しています')

  const completionById = new Map<string, Completion>()
  for (const raw of tables.completions) {
    const completion = raw as Completion
    if (!taskIds.has(completion.taskId) || !timestamp(completion.originalAt) || !nullableString(completion.currentAt) || (completion.currentAt !== null && !timestamp(completion.currentAt)) || !points(completion.originalPoints) || !points(completion.netPoints) || (completion.lastConfirmedPoints !== undefined && !points(completion.lastConfirmedPoints)) || !['pending', 'confirmed'].includes(completion.scoreState) || typeof completion.title !== 'string' || typeof completion.project !== 'string') throw new Error('完了履歴が不正です')
    completionById.set(completion.id, completion)
  }

  const ledgerSum = new Map<string, number>()
  for (const raw of tables.ledger) {
    const entry = raw as LedgerEntry
    const completion = completionById.get(entry.completionId)
    if (!completionIds.has(entry.completionId) || !completion || completion.taskId !== entry.taskId || !['award', 'adjust', 'reverse', 'restore'].includes(entry.kind) || !Number.isInteger(entry.delta) || !timestamp(entry.at) || typeof entry.reason !== 'string') throw new Error('台帳に不正な記録があります')
    ledgerSum.set(entry.completionId, (ledgerSum.get(entry.completionId) ?? 0) + entry.delta)
  }
  for (const completion of completionById.values()) {
    const sum = ledgerSum.get(completion.id) ?? 0
    if (!completion.currentAt && (completion.netPoints !== null || sum !== 0)) throw new Error('取消済み台帳が一致しません')
    if (completion.currentAt && completion.scoreState === 'pending' && (completion.netPoints !== null || sum !== 0)) throw new Error('未確定の台帳が一致しません')
    if (completion.currentAt && completion.scoreState === 'confirmed' && (completion.netPoints === null || sum !== completion.netPoints)) throw new Error('台帳の合計が一致しません')
  }
  const completionByTask = new Map([...completionById.values()].map(completion => [completion.taskId, completion]))
  for (const raw of tables.tasks) {
    const task = raw as Task
    const completion = completionByTask.get(task.id)
    if ((task.status === 'completed') !== Boolean(completion?.currentAt)) throw new Error('タスクと完了記録の状態が一致しません')
  }

  for (const raw of tables.routines) {
    const routine = raw as Routine
    if (!filled(routine.title) || !['daily', 'weekly', 'monthly', 'after_completion'].includes(routine.cadence) || !Number.isInteger(routine.interval) || routine.interval < 1 || routine.interval > 365 || !Array.isArray(routine.weekdays) || routine.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6) || !Number.isInteger(routine.monthDay) || routine.monthDay < 1 || routine.monthDay > 31 || typeof routine.project !== 'string' || typeof routine.active !== 'boolean' || !Number.isInteger(routine.revision) || routine.revision < 1 || !timestamp(routine.createdAt) || !nullableString(routine.afterTaskId) || !filled(routine.startDate)) throw new Error('ルーティンが不正です')
    dateOrNull(routine.startDate, 'ルーティン開始日'); dateOrNull(routine.endDate, 'ルーティン終了日')
    if (routine.excludedDates !== undefined && (!Array.isArray(routine.excludedDates) || routine.excludedDates.length > 366 || new Set(routine.excludedDates).size !== routine.excludedDates.length)) throw new Error('除外日が不正です')
    for (const date of routine.excludedDates ?? []) validateDate(date, '除外日')
    if (routine.afterTaskId && !taskIds.has(routine.afterTaskId)) throw new Error('ルーティンの参照先がありません')
    calculateScore(routine.score)
  }
  for (const raw of tables.sessions) {
    const session = raw as WorkSession
    if (!taskIds.has(session.taskId) || !timestamp(session.startedAt) || !timestamp(session.endedAt) || !Number.isInteger(session.minutes) || session.minutes < 0 || session.minutes > 10080 || session.endedAt < session.startedAt || Math.round((Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 60000) !== session.minutes) throw new Error('作業時間が不正です')
  }
  for (const raw of tables.commands) {
    const command = raw as CommandReceipt
    if (typeof command.hash !== 'string' || typeof command.resultId !== 'string' || !timestamp(command.at)) throw new Error('コマンド履歴が不正です')
  }
  for (const raw of tables.audits) {
    const audit = raw as Audit
    if ((audit.taskId !== null && !taskIds.has(audit.taskId)) || !filled(audit.operation) || !timestamp(audit.at) || typeof audit.detail !== 'string') throw new Error('監査履歴が不正です')
  }
  const settings = tables.settings[0] as Settings
  const allowedSettings = new Set(['id', 'profileId', 'datasetId', 'createdAt', 'coachName', 'dailyMinutes', 'dailyPoints', 'notifications', 'aiEnabled', 'aiModel', 'automation', 'lastBackupAt'])
  if (Object.keys(settings).some(key => !allowedSettings.has(key))) throw new Error('設定に未対応の項目があります')
  if (!filled(settings.profileId) || !filled(settings.datasetId) || !timestamp(settings.createdAt) || typeof settings.coachName !== 'string' || !Number.isInteger(settings.dailyMinutes) || settings.dailyMinutes < 0 || !Number.isInteger(settings.dailyPoints) || settings.dailyPoints < 0 || typeof settings.aiEnabled !== 'boolean' || typeof settings.notifications !== 'boolean' || !['A0', 'A1', 'A2'].includes(settings.automation) || !nullableString(settings.lastBackupAt) || (settings.lastBackupAt !== null && !timestamp(settings.lastBackupAt))) throw new Error('設定が不正です')
  if (settings.aiModel !== undefined && (typeof settings.aiModel !== 'string' || settings.aiModel.length > 120)) throw new Error('AIモデルIDが不正です')
}
