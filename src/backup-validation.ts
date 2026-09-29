import { calculateScore, validateTaskInput, validateDate, type Assessment, type Audit, type CalendarEvent, type ChecklistItem, type CommandReceipt, type Completion, type Container, type DayNote, type FocusProjectSelection, type Goal, type GoalCheckIn, type Habit, type HabitLog, type LabelDefinition, type LabelGroup, type LedgerEntry, type PlanningBucket, type PomodoroCycle, type RolloverEntry, type Routine, type SavedTemplate, type Settings, type SmartList, type Task, type TaskAttachment, type TaskComment, type TaskDependency, type TaskNote, type ThemeRule, type TimeBlock, type TrackerDefinition, type TrackerEntry, type WorkSession } from './domain'
import { validateLabelSelection } from './labels'
import { validateDependencyGraph } from './dependencies'
import { validatePlanningBuckets } from './period-planning'
import { validateThemeRule } from './themes'
import { validateSmartListAst } from './smart-lists'
import { NAV_FEATURE_IDS } from './navigation'
import { OPTIONAL_FEATURE_IDS } from './features'
import { validateWorkflowPreset } from './workflows'
import { validateAppearance } from './appearance'
import { validateKeybindings } from './shortcuts'
import { validateCharacterProfile } from './character'
import { validateCustomScreen, validateDashboardWidgets } from './dashboard'

export type Snapshot = {
  format: 'coachbundle'; version: 1; exportedAt: string
  tasks: Task[]; assessments: Assessment[]; completions: Completion[]; ledger: LedgerEntry[]
  routines: Routine[]; sessions: WorkSession[]; commands: CommandReceipt[]; audits: Audit[]; settings: Settings[]
  containers?: Container[]
  checklistItems?: ChecklistItem[]
  labelGroups?: LabelGroup[]
  labelDefinitions?: LabelDefinition[]
  savedTemplates?: SavedTemplate[]
  taskNotes?: TaskNote[]
  taskComments?: TaskComment[]
  taskAttachments?: (Omit<TaskAttachment, 'blob'> & { contentBase64: string })[]
  taskDependencies?: TaskDependency[]
  planningBuckets?: PlanningBucket[]
  timeBlocks?: TimeBlock[]
  calendarEvents?: CalendarEvent[]
  rollovers?: RolloverEntry[]
  themeRules?: ThemeRule[]
  smartLists?: SmartList[]
  focusSelections?: FocusProjectSelection[]
  habits?: Habit[]
  habitLogs?: HabitLog[]
  goals?: Goal[]
  goalCheckIns?: GoalCheckIn[]
  trackerDefinitions?: TrackerDefinition[]
  trackerEntries?: TrackerEntry[]
  dayNotes?: DayNote[]
  pomodoroCycles?: PomodoroCycle[]
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
  if (input.containers !== undefined && !Array.isArray(input.containers)) throw new Error('containersが不正です')
  const containers = (input.containers ?? []) as unknown[]
  const containerIds = unique(containers, 'containers', 'id')
  const byContainerId = new Map(containers.map(raw => [((raw as Container).id), raw as Container]))
  for (const raw of containers) {
    const container = raw as Container
    if (!filled(container.name) || container.name.length > 100 || !['category', 'project'].includes(container.kind) || !nullableString(container.parentId) || !filled(container.ownerId) || !Number.isInteger(container.revision) || container.revision < 1 || !timestamp(container.createdAt) || !timestamp(container.updatedAt) || !nullableString(container.deletedAt) || (container.deletedAt !== null && !timestamp(container.deletedAt))) throw new Error('カテゴリ・プロジェクトが不正です')
    const seen = new Set<string>(), ownerId = container.ownerId
    let cursor: Container | undefined = container
    while (cursor) {
      if (seen.has(cursor.id) || seen.size >= 12 || cursor.ownerId !== ownerId) throw new Error('カテゴリ・プロジェクトの階層が不正です')
      seen.add(cursor.id)
      if (cursor.parentId === null) break
      const parent: Container | undefined = byContainerId.get(cursor.parentId)
      if (!parent || parent.deletedAt || (cursor.kind === 'category' && parent.kind === 'project')) throw new Error('カテゴリ・プロジェクトの親が不正です')
      cursor = parent
    }
  }
  const taskIds = unique(tables.tasks, 'tasks', 'id')
  if (input.themeRules !== undefined && !Array.isArray(input.themeRules)) throw new Error('themeRulesが不正です')
  const themeRules = (input.themeRules ?? []) as ThemeRule[]
  unique(themeRules, 'themeRules', 'id')
  if (input.smartLists !== undefined && !Array.isArray(input.smartLists)) throw new Error('smartListsが不正です')
  const smartLists = (input.smartLists ?? []) as SmartList[]
  unique(smartLists, 'smartLists', 'id')
  if (input.focusSelections !== undefined && !Array.isArray(input.focusSelections)) throw new Error('focusSelectionsが不正です')
  const focusSelections = (input.focusSelections ?? []) as FocusProjectSelection[]
  unique(focusSelections, 'focusSelections', 'id')
  if (input.rollovers !== undefined && !Array.isArray(input.rollovers)) throw new Error('rolloversが不正です')
  const rollovers = (input.rollovers ?? []) as RolloverEntry[]
  unique(rollovers, 'rollovers', 'id')
  for (const entry of rollovers) { if (!taskIds.has(entry.taskId) || !timestamp(entry.at) || entry.fromDate >= entry.toDate) throw new Error('繰越履歴が不正です'); validateDate(entry.fromDate, '繰越元'); validateDate(entry.toDate, '繰越先') }
  if (input.taskDependencies !== undefined && !Array.isArray(input.taskDependencies)) throw new Error('taskDependenciesが不正です')
  const dependencies = (input.taskDependencies ?? []) as TaskDependency[]
  unique(dependencies, 'taskDependencies', 'id')
  for (const edge of dependencies) if (!timestamp(edge.createdAt)) throw new Error('依存関係が不正です')
  validateDependencyGraph(dependencies, taskIds)
  if (input.planningBuckets !== undefined && !Array.isArray(input.planningBuckets)) throw new Error('planningBucketsが不正です')
  const planningBuckets = (input.planningBuckets ?? []) as PlanningBucket[]
  const planningBucketIds = unique(planningBuckets, 'planningBuckets', 'id')
  validatePlanningBuckets(planningBuckets)
  for (const bucket of planningBuckets) if (!timestamp(bucket.createdAt)) throw new Error('計画枠の作成日時が不正です')
  if (input.checklistItems !== undefined && !Array.isArray(input.checklistItems)) throw new Error('checklistItemsが不正です')
  const checklistItems = (input.checklistItems ?? []) as unknown[]
  unique(checklistItems, 'checklistItems', 'id')
  const convertedIds = new Set<string>()
  for (const raw of checklistItems) {
    const item = raw as ChecklistItem
    if (!taskIds.has(item.taskId) || !filled(item.text) || item.text.length > 300 || typeof item.done !== 'boolean' || !nullableString(item.convertedTaskId) || (item.convertedTaskId !== null && !taskIds.has(item.convertedTaskId)) || !timestamp(item.createdAt) || !timestamp(item.updatedAt)) throw new Error('チェック項目が不正です')
    if (item.convertedTaskId) { if (convertedIds.has(item.convertedTaskId)) throw new Error('子タスク参照が重複しています'); convertedIds.add(item.convertedTaskId) }
  }
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
    for (const flag of ['pinned', 'backburner', 'orbit'] as const) if (task[flag] !== undefined && typeof task[flag] !== 'boolean') throw new Error('タスクの分類が不正です')
    if (task.dayHalf !== undefined && task.dayHalf !== null && !['morning', 'afternoon'].includes(task.dayHalf)) throw new Error('午前午後の区分が不正です')
    if (task.customSection !== undefined && task.customSection !== null && (typeof task.customSection !== 'string' || !task.customSection.trim() || task.customSection.length > 60)) throw new Error('カスタム区分が不正です')
    if (task.spotlightOrder !== undefined && task.spotlightOrder !== null && (!Number.isInteger(task.spotlightOrder) || task.spotlightOrder < 1)) throw new Error('Spotlightの順序が不正です')
    if (!nullableString(task.routineId) || (task.routineId !== null && !routineIds.has(task.routineId)) || (task.containerId !== undefined && (!nullableString(task.containerId) || (task.containerId !== null && !containerIds.has(task.containerId)))) || (task.planBucketId !== undefined && (!nullableString(task.planBucketId) || (task.planBucketId !== null && !planningBucketIds.has(task.planBucketId)))) || !nullableString(task.deletedAt) || !timestamp(task.createdAt) || !timestamp(task.updatedAt) || (task.deletedAt !== null && !timestamp(task.deletedAt))) throw new Error('タスクの履歴が不正です')
    for (const [name, value] of [['予定日', task.scheduledDate], ['締め切り', task.dueDate], ['目標日', task.targetDate], ['見直し日', task.reviewDate], ['開始可能日', task.availableFrom], ['延期終了日', task.deferredUntil ?? null], ['初回予定日', task.firstScheduledDate ?? null]] as const) dateOrNull(value, name)
    if (task.snoozedUntil !== undefined && task.snoozedUntil !== null && !timestamp(task.snoozedUntil)) throw new Error('スヌーズ時刻が不正です')
    validateTaskInput(task)
    if (calculateScore(task.score).effective !== task.effectivePoints) throw new Error('タスクのポイントが評価と一致しません')
    const assessment = assessmentById.get(task.assessmentId)
    if (!assessment || assessment.taskId !== task.id) throw new Error('タスクの評価参照が不正です')
  }
  const spotlight = (tables.tasks as Task[]).filter(task => !task.deletedAt && task.status === 'open' && task.spotlightOrder != null)
  if (spotlight.length > 3 || new Set(spotlight.map(task => task.spotlightOrder)).size !== spotlight.length) throw new Error('Spotlightの件数・順序が不正です')

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
    if (completion.localDate !== undefined) validateDate(completion.localDate, '完了日')
    if (completion.timezone !== undefined) { try { new Intl.DateTimeFormat('ja-JP', { timeZone: completion.timezone }) } catch { throw new Error('完了timezoneが不正です') } }
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
    if (session.revision !== undefined && (!Number.isInteger(session.revision) || session.revision < 1)) throw new Error('作業区間の版が不正です')
    if (session.corrections !== undefined && (!Array.isArray(session.corrections) || session.corrections.length > 1000 || session.corrections.some(item => !timestamp(item.startedAt) || !timestamp(item.endedAt) || item.endedAt < item.startedAt || !Number.isInteger(item.minutes) || item.minutes !== Math.round((Date.parse(item.endedAt) - Date.parse(item.startedAt)) / 60000) || !filled(item.reason) || item.reason.length > 300 || !timestamp(item.at)))) throw new Error('作業区間の訂正履歴が不正です')
  }
  if (input.pomodoroCycles !== undefined && !Array.isArray(input.pomodoroCycles)) throw new Error('ポモドーロ記録が不正です')
  const cycles = (input.pomodoroCycles ?? []) as PomodoroCycle[]
  unique(cycles, 'ポモドーロ', 'id')
  for (const cycle of cycles) if (!taskIds.has(cycle.taskId) || !timestamp(cycle.startedAt) || !timestamp(cycle.finishedAt) || cycle.finishedAt < cycle.startedAt || !Number.isInteger(cycle.targetMinutes) || cycle.targetMinutes < 1 || cycle.targetMinutes > 120 || !Number.isInteger(cycle.elapsedMinutes) || cycle.elapsedMinutes < cycle.targetMinutes || cycle.elapsedMinutes > 1440) throw new Error('ポモドーロ記録が不正です')
  for (const raw of tables.commands) {
    const command = raw as CommandReceipt
    if (typeof command.hash !== 'string' || typeof command.resultId !== 'string' || !timestamp(command.at)) throw new Error('コマンド履歴が不正です')
  }
  for (const raw of tables.audits) {
    const audit = raw as Audit
    if ((audit.taskId !== null && !taskIds.has(audit.taskId)) || !filled(audit.operation) || !timestamp(audit.at) || typeof audit.detail !== 'string') throw new Error('監査履歴が不正です')
  }
  const settings = tables.settings[0] as Settings
  if (input.timeBlocks !== undefined && !Array.isArray(input.timeBlocks)) throw new Error('timeBlocksが不正です')
  if (input.calendarEvents !== undefined && !Array.isArray(input.calendarEvents)) throw new Error('calendarEventsが不正です')
  const blocks = (input.timeBlocks ?? []) as TimeBlock[], events = (input.calendarEvents ?? []) as CalendarEvent[]
  unique(blocks, 'timeBlocks', 'id'); unique(events, 'calendarEvents', 'id')
  const sessionIds = new Set(tables.sessions.map(item => (item as WorkSession).id))
  for (const block of blocks) {
    if (block.ownerId !== settings.profileId || !['activity', 'work_session'].includes(block.kind) || !filled(block.category) || block.category.length > 100 || !nullableString(block.projectId) || (block.kind === 'work_session' && (!block.projectId || !containerIds.has(block.projectId))) || (block.kind === 'activity' && block.projectId !== null) || !Number.isInteger(block.startMinute) || !Number.isInteger(block.endMinute) || block.startMinute < 0 || block.endMinute > 1440 || block.startMinute >= block.endMinute || !filled(block.timezone) || !Array.isArray(block.taskIds) || new Set(block.taskIds).size !== block.taskIds.length || block.taskIds.some(id => !taskIds.has(id)) || !nullableString(block.linkedSessionId) || (block.linkedSessionId !== null && !sessionIds.has(block.linkedSessionId)) || typeof block.closed !== 'boolean' || !Number.isInteger(block.revision) || block.revision < 1 || !timestamp(block.createdAt) || !timestamp(block.updatedAt)) throw new Error('時間枠が不正です')
    validateDate(block.date, '時間枠の日付')
  }
  for (const event of events) if (event.ownerId !== settings.profileId || !['meeting', 'class', 'other'].includes(event.kind) || !filled(event.title) || event.title.length > 300 || !filled(event.timezone) || !timestamp(event.createdAt) || !nullableString(event.linkedTaskId) || (event.linkedTaskId !== null && !taskIds.has(event.linkedTaskId)) || !filled(event.startAt) || !filled(event.endAt) || !Number.isFinite(Date.parse(event.startAt)) || !Number.isFinite(Date.parse(event.endAt)) || Date.parse(event.endAt) <= Date.parse(event.startAt)) throw new Error('予定が不正です')
  if (planningBuckets.some(bucket => bucket.ownerId !== settings.profileId)) throw new Error('計画枠の所有者が不正です')
  if (input.labelGroups !== undefined && !Array.isArray(input.labelGroups)) throw new Error('labelGroupsが不正です')
  if (input.labelDefinitions !== undefined && !Array.isArray(input.labelDefinitions)) throw new Error('labelDefinitionsが不正です')
  const groups = (input.labelGroups ?? []) as LabelGroup[], definitions = (input.labelDefinitions ?? []) as LabelDefinition[]
  const groupIds = unique(groups, 'labelGroups', 'id')
  unique(definitions, 'labelDefinitions', 'id')
  const names = new Set<string>(), groupNames = new Set<string>()
  for (const group of groups) {
    const key = group.name?.trim().normalize('NFKC').toLocaleLowerCase('ja-JP')
    if (!key || key.length > 100 || groupNames.has(key) || !['single', 'multi'].includes(group.selectionMode) || group.ownerId !== settings.profileId || !timestamp(group.createdAt)) throw new Error('ラベルグループが不正です')
    groupNames.add(key)
  }
  for (const label of definitions) {
    const key = label.name?.trim().normalize('NFKC').toLocaleLowerCase('ja-JP')
    if (!key || key.length > 100 || names.has(key) || !nullableString(label.groupId) || (label.groupId !== null && !groupIds.has(label.groupId)) || label.ownerId !== settings.profileId || !timestamp(label.createdAt)) throw new Error('ラベル定義が不正です')
    names.add(key)
  }
  for (const task of tables.tasks as Task[]) validateLabelSelection(task.labels, groups, definitions)
  if (input.savedTemplates !== undefined && !Array.isArray(input.savedTemplates)) throw new Error('savedTemplatesが不正です')
  const templates = (input.savedTemplates ?? []) as SavedTemplate[]
  unique(templates, 'savedTemplates', 'id')
  const familyVersions = new Set<string>()
  for (const template of templates) {
    if (!filled(template.familyId) || !filled(template.name) || template.name.length > 100 || template.ownerId !== settings.profileId || !Number.isInteger(template.version) || template.version < 1 || !['task', 'project'].includes(template.kind) || !timestamp(template.createdAt) || !Array.isArray(template.containers) || !Array.isArray(template.tasks) || template.containers.length > 100 || template.tasks.length > 200) throw new Error('テンプレートが不正です')
    const versionKey = `${template.familyId}:${template.version}`
    if (familyVersions.has(versionKey)) throw new Error('テンプレートの版が重複しています')
    familyVersions.add(versionKey)
    if (template.kind === 'task' && (template.containers.length !== 0 || template.tasks.length !== 1)) throw new Error('タスクテンプレートが不正です')
    if (template.kind === 'project' && (!template.containers.length || template.containers[0].parentKey !== null || template.containers[0].kind !== 'project')) throw new Error('プロジェクトテンプレートが不正です')
    const known = new Set<string>()
    for (const [index, item] of template.containers.entries()) {
      if (!filled(item.key) || known.has(item.key) || !filled(item.name) || item.name.length > 100 || !['category', 'project'].includes(item.kind) || (index > 0 && (!filled(item.parentKey) || !known.has(item.parentKey)))) throw new Error('テンプレートの階層が不正です')
      known.add(item.key)
    }
    for (const task of template.tasks) {
      if (!filled(task.title) || task.title.length > 300 || typeof task.notes !== 'string' || !Number.isInteger(task.importance) || task.importance < 0 || task.importance > 3 || !record(task.score) || !Array.isArray(task.checklistTexts) || task.checklistTexts.length > 100 || task.checklistTexts.some(value => !filled(value) || value.length > 300) || !nullableString(task.containerKey) || (task.containerKey !== null && !known.has(task.containerKey))) throw new Error('テンプレートのタスクが不正です')
      validateTaskInput(task)
      calculateScore(task.score)
      validateLabelSelection(task.labels, groups, definitions)
    }
  }
  for (const field of ['taskNotes', 'taskComments', 'taskAttachments'] as const) if (input[field] !== undefined && !Array.isArray(input[field])) throw new Error(`${field}が不正です`)
  const notes = (input.taskNotes ?? []) as TaskNote[], comments = (input.taskComments ?? []) as TaskComment[], attachments = (input.taskAttachments ?? []) as NonNullable<Snapshot['taskAttachments']>
  unique(notes, 'taskNotes', 'id'); unique(comments, 'taskComments', 'id'); unique(attachments, 'taskAttachments', 'id')
  for (const note of notes) if (!taskIds.has(note.taskId) || note.ownerId !== settings.profileId || !['self', 'source'].includes(note.kind) || !filled(note.body) || note.body.length > 50000 || !timestamp(note.createdAt)) throw new Error('ノートが不正です')
  for (const comment of comments) if (!taskIds.has(comment.taskId) || comment.ownerId !== settings.profileId || !filled(comment.body) || comment.body.length > 10000 || !timestamp(comment.createdAt)) throw new Error('コメントが不正です')
  for (const attachment of attachments) {
    if (!taskIds.has(attachment.taskId) || attachment.ownerId !== settings.profileId || !filled(attachment.name) || attachment.name.length > 200 || [...attachment.name].some(char => char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char)) || typeof attachment.mediaType !== 'string' || attachment.mediaType.length > 120 || !Number.isInteger(attachment.size) || attachment.size < 1 || attachment.size > 5 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(attachment.sha256) || !timestamp(attachment.createdAt) || typeof attachment.contentBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.contentBase64) || attachment.contentBase64.length > Math.ceil(attachment.size / 3) * 4) throw new Error('添付が不正です')
  }
  if (containers.some(raw => (raw as Container).ownerId !== settings.profileId)) throw new Error('カテゴリ・プロジェクトの所有者が不正です')
  const allowedSettings = new Set(['id', 'profileId', 'datasetId', 'createdAt', 'coachName', 'dailyMinutes', 'dailyPoints', 'notifications', 'aiEnabled', 'aiModel', 'daySectionMode', 'taskListLimit', 'automation', 'lastBackupAt', 'timeTargets', 'dayProgressBaseline', 'wallTiles', 'navDesktop', 'navMobile', 'hiddenFeatures', 'workflowPresets', 'appearance', 'reminderState', 'keybindings', 'characterProfile', 'dashboardWidgets', 'customScreen'])
  if (Object.keys(settings).some(key => !allowedSettings.has(key))) throw new Error('設定に未対応の項目があります')
  if (!filled(settings.profileId) || !filled(settings.datasetId) || !timestamp(settings.createdAt) || typeof settings.coachName !== 'string' || !Number.isInteger(settings.dailyMinutes) || settings.dailyMinutes < 0 || !Number.isInteger(settings.dailyPoints) || settings.dailyPoints < 0 || typeof settings.aiEnabled !== 'boolean' || typeof settings.notifications !== 'boolean' || !['A0', 'A1', 'A2'].includes(settings.automation) || !nullableString(settings.lastBackupAt) || (settings.lastBackupAt !== null && !timestamp(settings.lastBackupAt))) throw new Error('設定が不正です')
  for (const rule of themeRules) { if (rule.ownerId !== settings.profileId || !timestamp(rule.createdAt)) throw new Error('重点テーマが不正です'); validateThemeRule(rule) }
  for (const list of smartLists) { if (list.ownerId !== settings.profileId || !filled(list.name) || list.name.length > 100 || !Number.isInteger(list.revision) || list.revision < 1 || !timestamp(list.createdAt) || !timestamp(list.updatedAt)) throw new Error('Smart Listが不正です'); validateSmartListAst(list.ast) }
  for (const focus of focusSelections) { validateDate(focus.date, '重点日'); if (focus.id !== `${settings.profileId}:${focus.date}` || focus.ownerId !== settings.profileId || !Array.isArray(focus.projects) || focus.projects.length > 5 || new Set(focus.projects).size !== focus.projects.length || focus.projects.some(name => !filled(name) || name.length > 300) || !['user', 'coach'].includes(focus.source) || !Number.isInteger(focus.revision) || focus.revision < 1 || !timestamp(focus.updatedAt)) throw new Error('重点プロジェクトが不正です') }
  if (settings.aiModel !== undefined && (typeof settings.aiModel !== 'string' || settings.aiModel.length > 120)) throw new Error('AIモデルIDが不正です')
  if (settings.daySectionMode !== undefined && !['halfday', 'category', 'timeblock', 'custom'].includes(settings.daySectionMode)) throw new Error('今日の表示区分が不正です')
  if (settings.taskListLimit !== undefined && settings.taskListLimit !== null && ![5, 10, 20, 50].includes(settings.taskListLimit)) throw new Error('一覧の表示件数が不正です')
  if (input.habits !== undefined && !Array.isArray(input.habits)) throw new Error('習慣が不正です')
  if (input.habitLogs !== undefined && !Array.isArray(input.habitLogs)) throw new Error('習慣ログが不正です')
  const habits = (input.habits ?? []) as Habit[], habitLogs = (input.habitLogs ?? []) as HabitLog[]
  const habitIds = unique(habits, '習慣', 'id')
  for (const habit of habits) {
    if (habit.ownerId !== settings.profileId || !filled(habit.title) || habit.title.length > 100 || !filled(habit.unit) || habit.unit.length > 30 || !['increase', 'decrease'].includes(habit.direction) || !['daily', 'weekly', 'monthly'].includes(habit.cadence) || !Number.isFinite(habit.targetAmount) || habit.targetAmount < 0 || habit.targetAmount > 1000000 || !Array.isArray(habit.weekdays) || new Set(habit.weekdays).size !== habit.weekdays.length || habit.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6) || !nullableString(habit.routineId) || (habit.routineId !== null && !routineIds.has(habit.routineId)) || typeof habit.active !== 'boolean' || !timestamp(habit.createdAt) || !timestamp(habit.updatedAt)) throw new Error('習慣が不正です')
    try { new Intl.DateTimeFormat('ja-JP', { timeZone: habit.timezone }) } catch { throw new Error('習慣のtimezoneが不正です') }
  }
  unique(habitLogs, '習慣ログ', 'id')
  for (const log of habitLogs) {
    validateDate(log.date, '習慣ログ日')
    if (!habitIds.has(log.habitId) || log.id !== `${log.habitId}:${log.date}` || !Number.isFinite(log.amount) || log.amount < 0 || log.amount > 1000000 || !['manual', 'task'].includes(log.source) || !nullableString(log.taskId) || (log.taskId !== null && !taskIds.has(log.taskId)) || !Number.isInteger(log.revision) || log.revision < 1 || !timestamp(log.updatedAt) || !Array.isArray(log.history) || log.history.length > 1000 || log.history.some(entry => !Number.isFinite(entry.amount) || entry.amount < 0 || entry.amount > 1000000 || !timestamp(entry.at) || !filled(entry.reason) || entry.reason.length > 300)) throw new Error('習慣ログが不正です')
  }
  if (input.goals !== undefined && !Array.isArray(input.goals)) throw new Error('目標が不正です')
  if (input.goalCheckIns !== undefined && !Array.isArray(input.goalCheckIns)) throw new Error('チェックインが不正です')
  const goals = (input.goals ?? []) as Goal[], checkIns = (input.goalCheckIns ?? []) as GoalCheckIn[]
  const goalIds = unique(goals, '目標', 'id'), byGoal = new Map(goals.map(goal => [goal.id, goal]))
  for (const goal of goals) {
    if (goal.ownerId !== settings.profileId || !filled(goal.title) || goal.title.length > 200 || typeof goal.description !== 'string' || goal.description.length > 10000 || !nullableString(goal.parentId) || !nullableString(goal.dueDate) || !nullableString(goal.containerId) || (goal.containerId !== null && !containerIds.has(goal.containerId)) || !Array.isArray(goal.taskIds) || goal.taskIds.length > 200 || new Set(goal.taskIds).size !== goal.taskIds.length || goal.taskIds.some(id => !taskIds.has(id)) || !Array.isArray(goal.habitIds) || goal.habitIds.length > 100 || new Set(goal.habitIds).size !== goal.habitIds.length || goal.habitIds.some(id => !habitIds.has(id)) || goal.manualPercent !== null && (!Number.isInteger(goal.manualPercent) || goal.manualPercent < 0 || goal.manualPercent > 100) || goal.checkInCadence !== null && !['weekly', 'monthly'].includes(goal.checkInCadence) || typeof goal.checkInQuestion !== 'string' || goal.checkInQuestion.length > 500 || !Number.isInteger(goal.revision) || goal.revision < 1 || !timestamp(goal.createdAt) || !timestamp(goal.updatedAt) || !nullableString(goal.deletedAt) || (goal.deletedAt !== null && !timestamp(goal.deletedAt))) throw new Error('目標が不正です')
    validateDate(goal.dueDate, '目標日')
    const seen = new Set<string>(); let cursor: Goal | undefined = goal
    while (cursor) { if (seen.has(cursor.id) || seen.size > 12) throw new Error('目標の階層が不正です'); seen.add(cursor.id); cursor = cursor.parentId ? byGoal.get(cursor.parentId) : undefined; if (cursor?.parentId && !goalIds.has(cursor.parentId)) throw new Error('目標の親がありません') }
    if (goal.parentId && !goalIds.has(goal.parentId)) throw new Error('目標の親がありません')
  }
  unique(checkIns, 'チェックイン', 'id')
  for (const checkIn of checkIns) {
    validateDate(checkIn.date, 'チェックイン日')
    if (!goalIds.has(checkIn.goalId) || !filled(checkIn.answer) || checkIn.answer.length > 10000 || !nullableString(checkIn.summary) || (checkIn.summary !== null && checkIn.summary.length > 10000) || ![null, 'ai', 'human'].includes(checkIn.summaryOrigin) || !Number.isInteger(checkIn.summaryRevision) || checkIn.summaryRevision < 1 || !Array.isArray(checkIn.history) || checkIn.history.length > 1000 || checkIn.history.some(item => !nullableString(item.summary) || !timestamp(item.at)) || !timestamp(checkIn.createdAt) || !timestamp(checkIn.updatedAt) || !nullableString(checkIn.deletedAt) || (checkIn.deletedAt !== null && !timestamp(checkIn.deletedAt))) throw new Error('チェックインが不正です')
  }
  if (input.trackerDefinitions !== undefined && !Array.isArray(input.trackerDefinitions)) throw new Error('記録項目が不正です')
  if (input.trackerEntries !== undefined && !Array.isArray(input.trackerEntries)) throw new Error('記録値が不正です')
  if (input.dayNotes !== undefined && !Array.isArray(input.dayNotes)) throw new Error('日記が不正です')
  const trackers = (input.trackerDefinitions ?? []) as TrackerDefinition[], trackerEntries = (input.trackerEntries ?? []) as TrackerEntry[], dayNotes = (input.dayNotes ?? []) as DayNote[]
  const trackerIds = unique(trackers, '記録項目', 'id')
  const byTracker = new Map(trackers.map(tracker => [tracker.id, tracker]))
  for (const tracker of trackers) if (tracker.ownerId !== settings.profileId || !filled(tracker.name) || tracker.name.length > 100 || !filled(tracker.unit) || tracker.unit.length > 30 || !Number.isFinite(tracker.min) || !Number.isFinite(tracker.max) || tracker.min >= tracker.max || tracker.min < -1000000 || tracker.max > 1000000 || tracker.private !== true || !timestamp(tracker.createdAt) || !timestamp(tracker.updatedAt)) throw new Error('記録項目が不正です')
  unique(trackerEntries, '記録値', 'id')
  for (const entry of trackerEntries) { const tracker = byTracker.get(entry.trackerId); if (!trackerIds.has(entry.trackerId) || !tracker || entry.value !== null && (!Number.isFinite(entry.value) || entry.value < tracker.min || entry.value > tracker.max) || !timestamp(entry.recordedAt) || !['user', 'device'].includes(entry.source) || typeof entry.note !== 'string' || entry.note.length > 1000) throw new Error('記録値が不正です') }
  unique(dayNotes, '日記', 'id')
  for (const note of dayNotes) {
    validateDate(note.date, '日記の日付')
    try { new Intl.DateTimeFormat('ja-JP', { timeZone: note.timezone }) } catch { throw new Error('日記のtimezoneが不正です') }
    if (note.ownerId !== settings.profileId || note.id !== `${note.ownerId}:${note.date}:${note.timezone}` || typeof note.humanText !== 'string' || note.humanText.length > 50000 || !nullableString(note.aiSummary) || (note.aiSummary !== null && note.aiSummary.length > 10000) || ![null, 'ai', 'human'].includes(note.summaryOrigin) || !Number.isInteger(note.humanRevision) || note.humanRevision < 1 || !Number.isInteger(note.summaryRevision) || note.summaryRevision < 0 || note.summaryOfHumanRevision !== null && (!Number.isInteger(note.summaryOfHumanRevision) || note.summaryOfHumanRevision < 1 || note.summaryOfHumanRevision > note.humanRevision) || !Array.isArray(note.history) || note.history.length > 1000 || note.history.some(item => !['human', 'summary'].includes(item.kind) || !nullableString(item.text) || !timestamp(item.at) || !Number.isInteger(item.revision) || item.revision < 0) || !timestamp(note.createdAt) || !timestamp(note.updatedAt) || !nullableString(note.deletedAt) || (note.deletedAt !== null && !timestamp(note.deletedAt))) throw new Error('日記が不正です')
  }
  if (settings.timeTargets !== undefined) {
    if (!Array.isArray(settings.timeTargets) || settings.timeTargets.length > 100 || new Set(settings.timeTargets.map(target => target.id)).size !== settings.timeTargets.length) throw new Error('時間目標が不正です')
    for (const target of settings.timeTargets) {
      if (!filled(target.id) || !containerIds.has(target.containerId) || !Number.isInteger(target.targetMinutes) || target.targetMinutes < 1 || target.targetMinutes > 100000) throw new Error('時間目標が不正です')
      validateDate(target.startDate, '時間目標開始日'); validateDate(target.endDate, '時間目標終了日')
      if (target.startDate > target.endDate) throw new Error('時間目標の期間が不正です')
    }
  }
  if (settings.dayProgressBaseline !== undefined) {
    const baseline = settings.dayProgressBaseline
    validateDate(baseline.date, '今日の進捗日'); if (!timestamp(baseline.capturedAt) || !Array.isArray(baseline.entries) || baseline.entries.length > 100000 || new Set(baseline.entries.map(entry => entry.taskId)).size !== baseline.entries.length) throw new Error('今日の進捗基準が不正です')
    for (const entry of baseline.entries) if (!taskIds.has(entry.taskId) || entry.minutes !== null && (!Number.isInteger(entry.minutes) || entry.minutes < 0 || entry.minutes > 10080) || !points(entry.points)) throw new Error('今日の進捗基準が不正です')
  }
  if (settings.wallTiles !== undefined) {
    if (!Array.isArray(settings.wallTiles) || settings.wallTiles.length > 50 || new Set(settings.wallTiles.map(tile => tile.taskId)).size !== settings.wallTiles.length || new Set(settings.wallTiles.map(tile => `${tile.x}:${tile.y}`)).size !== settings.wallTiles.length) throw new Error('Wallの配置が不正です')
    for (const tile of settings.wallTiles) if (!taskIds.has(tile.taskId) || !Number.isInteger(tile.x) || tile.x < 0 || tile.x > 4 || !Number.isInteger(tile.y) || tile.y < 0 || tile.y > 9 || typeof tile.group !== 'string' || tile.group.length > 100) throw new Error('Wallの付箋が不正です')
  }
  for (const key of ['navDesktop', 'navMobile'] as const) if (settings[key] !== undefined && (!Array.isArray(settings[key]) || settings[key].length > NAV_FEATURE_IDS.length || new Set(settings[key]).size !== settings[key].length || settings[key].some(id => !NAV_FEATURE_IDS.includes(id as typeof NAV_FEATURE_IDS[number])))) throw new Error('ナビゲーション設定が不正です')
  if (settings.hiddenFeatures !== undefined && (!Array.isArray(settings.hiddenFeatures) || settings.hiddenFeatures.length > OPTIONAL_FEATURE_IDS.length || new Set(settings.hiddenFeatures).size !== settings.hiddenFeatures.length || settings.hiddenFeatures.some(id => !OPTIONAL_FEATURE_IDS.includes(id as typeof OPTIONAL_FEATURE_IDS[number])))) throw new Error('機能の表示設定が不正です')
  if (settings.workflowPresets !== undefined) {
    if (!Array.isArray(settings.workflowPresets) || settings.workflowPresets.length > 100 || new Set(settings.workflowPresets.map(preset => preset.id)).size !== settings.workflowPresets.length) throw new Error('ワークフロープリセットが不正です')
    for (const preset of settings.workflowPresets) validateWorkflowPreset(preset)
  }
  if (settings.appearance !== undefined) validateAppearance(settings.appearance)
  if (settings.keybindings !== undefined) validateKeybindings(settings.keybindings)
  if (settings.characterProfile !== undefined) validateCharacterProfile(settings.characterProfile)
  if (settings.dashboardWidgets !== undefined) validateDashboardWidgets(settings.dashboardWidgets)
  if (settings.customScreen !== undefined) validateCustomScreen(settings.customScreen, smartLists, settings.profileId)
  if (settings.reminderState !== undefined) {
    const reminders = settings.reminderState
    const clock = (value: unknown) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
    const channels = (value: unknown) => Array.isArray(value) && value.length > 0 && value.length <= 2 && new Set(value).size === value.length && value.every(channel => channel === 'in-app' || channel === 'os')
    if (!record(reminders) || Object.keys(reminders).some(key => !['quietStart', 'quietEnd', 'dailyCap', 'rules', 'events'].includes(key)) || !clock(reminders.quietStart) || !clock(reminders.quietEnd) || !Number.isInteger(reminders.dailyCap) || reminders.dailyCap < 0 || reminders.dailyCap > 50 || !Array.isArray(reminders.rules) || reminders.rules.length > 500 || !Array.isArray(reminders.events) || reminders.events.length > 1000) throw new Error('通知設定が不正です')
    const ruleIds = unique(reminders.rules, '通知予約', 'id')
    for (const rule of reminders.rules) {
      if (!['once', 'smart-daily', 'bug-me'].includes(rule.kind) || !filled(rule.targetId) || (rule.kind === 'smart-daily' ? rule.enabled && !smartLists.some(list => list.id === rule.targetId) : !taskIds.has(rule.targetId)) || !timestamp(rule.nextAt) || !nullableString(rule.timeOfDay) || (rule.kind === 'smart-daily' ? !clock(rule.timeOfDay) : rule.timeOfDay !== null) || !Number.isInteger(rule.intervalMinutes) || (rule.kind === 'bug-me' ? rule.intervalMinutes !== 30 : rule.intervalMinutes !== 0) || !Number.isInteger(rule.maxCount) || rule.maxCount !== (rule.kind === 'smart-daily' ? 0 : rule.kind === 'bug-me' ? 3 : 1) || !Number.isInteger(rule.sentCount) || rule.sentCount < 0 || (rule.maxCount > 0 && rule.sentCount > rule.maxCount) || !nullableString(rule.endDate) || !channels(rule.channels) || typeof rule.enabled !== 'boolean' || !timestamp(rule.createdAt) || !timestamp(rule.updatedAt) || Object.keys(rule).some(key => !['id', 'kind', 'targetId', 'nextAt', 'timeOfDay', 'intervalMinutes', 'maxCount', 'sentCount', 'endDate', 'channels', 'enabled', 'createdAt', 'updatedAt'].includes(key))) throw new Error('通知予約が不正です')
      if (rule.endDate !== null) validateDate(rule.endDate, '通知終了日')
      if ((rule.kind === 'bug-me') !== (rule.endDate !== null)) throw new Error('催促終了日が不正です')
    }
    unique(reminders.events, '通知履歴', 'id')
    for (const event of reminders.events) if (!ruleIds.has(event.ruleId) || !filled(event.targetId) || !['once', 'smart-daily', 'bug-me'].includes(event.kind) || typeof event.title !== 'string' || event.title.length > 300 || !timestamp(event.at) || !channels(event.channels) || !nullableString(event.readAt) || (event.readAt !== null && !timestamp(event.readAt)) || Object.keys(event).some(key => !['id', 'ruleId', 'targetId', 'kind', 'title', 'at', 'channels', 'readAt'].includes(key))) throw new Error('通知履歴が不正です')
  }
}
