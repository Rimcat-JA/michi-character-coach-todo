import Dexie, { type EntityTable } from 'dexie'
import type { ReviewRecord } from './review-coach'
import type { TripBundle } from './trip-bundles'
import type { CoachMemory, MemoryTombstone } from './coach-memory'
import type { ContextSource, ContextSnapshot, SourceSummary, SourceArtifact } from './source-library'
import type { CalendarRulesState } from './calendar-resolver'
import type { CoachConversation, CoachMessage } from './chat-history'
import type { AchievementPolicy, AchievementEvidence, AchievementExport } from './achievements'
import type { Assessment, Audit, CalendarEvent, ChecklistItem, CommandReceipt, Completion, Container, DayNote, FocusProjectSelection, Goal, GoalCheckIn, Habit, HabitLog, LabelDefinition, LabelGroup, LedgerEntry, PlanningBucket, PomodoroCycle, RolloverEntry, Routine, SavedTemplate, Settings, SmartList, Task, TaskAttachment, TaskComment, TaskDependency, TaskNote, ThemeRule, TimeBlock, TrackerDefinition, TrackerEntry, WorkSession } from './domain'

export const db = new Dexie('character-coach-v1') as Dexie & {
  tasks: EntityTable<Task, 'id'>
  assessments: EntityTable<Assessment, 'id'>
  completions: EntityTable<Completion, 'id'>
  ledger: EntityTable<LedgerEntry, 'id'>
  routines: EntityTable<Routine, 'id'>
  sessions: EntityTable<WorkSession, 'id'>
  commands: EntityTable<CommandReceipt, 'key'>
  audits: EntityTable<Audit, 'id'>
  settings: EntityTable<Settings, 'id'>
  containers: EntityTable<Container, 'id'>
  checklistItems: EntityTable<ChecklistItem, 'id'>
  labelGroups: EntityTable<LabelGroup, 'id'>
  labelDefinitions: EntityTable<LabelDefinition, 'id'>
  savedTemplates: EntityTable<SavedTemplate, 'id'>
  taskNotes: EntityTable<TaskNote, 'id'>
  taskComments: EntityTable<TaskComment, 'id'>
  taskAttachments: EntityTable<TaskAttachment, 'id'>
  taskDependencies: EntityTable<TaskDependency, 'id'>
  planningBuckets: EntityTable<PlanningBucket, 'id'>
  timeBlocks: EntityTable<TimeBlock, 'id'>
  calendarEvents: EntityTable<CalendarEvent, 'id'>
  rollovers: EntityTable<RolloverEntry, 'id'>
  themeRules: EntityTable<ThemeRule, 'id'>
  smartLists: EntityTable<SmartList, 'id'>
  focusSelections: EntityTable<FocusProjectSelection, 'id'>
  habits: EntityTable<Habit, 'id'>
  habitLogs: EntityTable<HabitLog, 'id'>
  goals: EntityTable<Goal, 'id'>
  goalCheckIns: EntityTable<GoalCheckIn, 'id'>
  trackerDefinitions: EntityTable<TrackerDefinition, 'id'>
  trackerEntries: EntityTable<TrackerEntry, 'id'>
  dayNotes: EntityTable<DayNote, 'id'>
  pomodoroCycles: EntityTable<PomodoroCycle, 'id'>
  reviewRecords: EntityTable<ReviewRecord, 'id'>
  tripBundles: EntityTable<TripBundle, 'id'>
  coachMemories: EntityTable<CoachMemory, 'id'>
  memoryTombstones: EntityTable<MemoryTombstone, 'id'>
  contextSources: EntityTable<ContextSource, 'id'>
  contextSnapshots: EntityTable<ContextSnapshot, 'id'>
  sourceSummaries: EntityTable<SourceSummary, 'id'>
  sourceArtifacts: EntityTable<SourceArtifact, 'id'>
  calendarRules: EntityTable<CalendarRulesState, 'id'>
  coachConversations: EntityTable<CoachConversation, 'id'>
  coachMessages: EntityTable<CoachMessage, 'id'>
  achievementPolicies: EntityTable<AchievementPolicy, 'id'>
  achievementEvidence: EntityTable<AchievementEvidence, 'id'>
  achievementExports: EntityTable<AchievementExport, 'id'>
}
db.version(1).stores({
  tasks: 'id, &generationKey, status, scheduledDate, dueDate, project, routineId, deletedAt, updatedAt',
  assessments: 'id, taskId, createdAt', completions: 'id, &taskId, currentAt',
  ledger: 'id, completionId, taskId, at', routines: 'id, active', sessions: 'id, taskId, startedAt',
  commands: 'key', audits: 'id, taskId, at', settings: 'id'
})
db.version(2).stores({
  tasks: 'id, &generationKey, status, scheduledDate, dueDate, project, containerId, routineId, deletedAt, updatedAt',
  assessments: 'id, taskId, createdAt', completions: 'id, &taskId, currentAt',
  ledger: 'id, completionId, taskId, at', routines: 'id, active', sessions: 'id, taskId, startedAt',
  commands: 'key', audits: 'id, taskId, at', settings: 'id',
  containers: 'id, parentId, kind, ownerId, deletedAt', checklistItems: 'id, taskId, convertedTaskId'
}).upgrade(async transaction => {
  const tasks = await transaction.table('tasks').toArray() as Task[]
  const settings = await transaction.table('settings').get('main') as Settings | undefined
  const ownerId = settings?.profileId ?? 'local'
  const names = [...new Set(tasks.map(task => task.project.trim()).filter(Boolean))]
  const at = new Date().toISOString()
  const containers: Container[] = names.map(name => ({ id: crypto.randomUUID(), parentId: null, kind: 'project', name, ownerId, revision: 1, createdAt: at, updatedAt: at, deletedAt: null }))
  const byName = new Map(containers.map(container => [container.name, container.id]))
  if (containers.length) await transaction.table('containers').bulkAdd(containers)
  for (const task of tasks) if (task.project.trim()) await transaction.table('tasks').update(task.id, { containerId: byName.get(task.project.trim()) })
})
db.version(3).stores({
  tasks: 'id, &generationKey, status, scheduledDate, dueDate, project, containerId, routineId, deletedAt, updatedAt',
  assessments: 'id, taskId, createdAt', completions: 'id, &taskId, currentAt',
  ledger: 'id, completionId, taskId, at', routines: 'id, active', sessions: 'id, taskId, startedAt',
  commands: 'key', audits: 'id, taskId, at', settings: 'id',
  containers: 'id, parentId, kind, ownerId, deletedAt', checklistItems: 'id, taskId, convertedTaskId',
  labelGroups: 'id, ownerId', labelDefinitions: 'id, groupId, ownerId, name'
})
db.version(4).stores({
  tasks: 'id, &generationKey, status, scheduledDate, dueDate, project, containerId, routineId, deletedAt, updatedAt',
  assessments: 'id, taskId, createdAt', completions: 'id, &taskId, currentAt',
  ledger: 'id, completionId, taskId, at', routines: 'id, active', sessions: 'id, taskId, startedAt',
  commands: 'key', audits: 'id, taskId, at', settings: 'id',
  containers: 'id, parentId, kind, ownerId, deletedAt', checklistItems: 'id, taskId, convertedTaskId',
  labelGroups: 'id, ownerId', labelDefinitions: 'id, groupId, ownerId, name',
  savedTemplates: 'id, familyId, ownerId, kind, name, version'
})
db.version(5).stores({
  tasks: 'id, &generationKey, status, scheduledDate, dueDate, project, containerId, routineId, deletedAt, updatedAt',
  assessments: 'id, taskId, createdAt', completions: 'id, &taskId, currentAt',
  ledger: 'id, completionId, taskId, at', routines: 'id, active', sessions: 'id, taskId, startedAt',
  commands: 'key', audits: 'id, taskId, at', settings: 'id',
  containers: 'id, parentId, kind, ownerId, deletedAt', checklistItems: 'id, taskId, convertedTaskId',
  labelGroups: 'id, ownerId', labelDefinitions: 'id, groupId, ownerId, name', savedTemplates: 'id, familyId, ownerId, kind, name, version',
  taskNotes: 'id, taskId, ownerId', taskComments: 'id, taskId, ownerId', taskAttachments: 'id, taskId, ownerId'
})
db.version(6).stores({
  tasks: 'id, &generationKey, status, scheduledDate, dueDate, project, containerId, routineId, deletedAt, updatedAt',
  assessments: 'id, taskId, createdAt', completions: 'id, &taskId, currentAt',
  ledger: 'id, completionId, taskId, at', routines: 'id, active', sessions: 'id, taskId, startedAt',
  commands: 'key', audits: 'id, taskId, at', settings: 'id',
  containers: 'id, parentId, kind, ownerId, deletedAt', checklistItems: 'id, taskId, convertedTaskId',
  labelGroups: 'id, ownerId', labelDefinitions: 'id, groupId, ownerId, name', savedTemplates: 'id, familyId, ownerId, kind, name, version',
  taskNotes: 'id, taskId, ownerId', taskComments: 'id, taskId, ownerId', taskAttachments: 'id, taskId, ownerId',
  taskDependencies: 'id, taskId, dependsOnId'
})
db.version(7).stores({
  tasks: 'id, &generationKey, status, scheduledDate, dueDate, project, containerId, planBucketId, routineId, deletedAt, updatedAt',
  assessments: 'id, taskId, createdAt', completions: 'id, &taskId, currentAt',
  ledger: 'id, completionId, taskId, at', routines: 'id, active', sessions: 'id, taskId, startedAt',
  commands: 'key', audits: 'id, taskId, at', settings: 'id',
  containers: 'id, parentId, kind, ownerId, deletedAt', checklistItems: 'id, taskId, convertedTaskId',
  labelGroups: 'id, ownerId', labelDefinitions: 'id, groupId, ownerId, name', savedTemplates: 'id, familyId, ownerId, kind, name, version',
  taskNotes: 'id, taskId, ownerId', taskComments: 'id, taskId, ownerId', taskAttachments: 'id, taskId, ownerId', taskDependencies: 'id, taskId, dependsOnId',
  planningBuckets: 'id, ownerId, kind, startDate, parentId'
})
db.version(8).stores({
  tasks: 'id, &generationKey, status, scheduledDate, dueDate, project, containerId, planBucketId, routineId, deletedAt, updatedAt',
  assessments: 'id, taskId, createdAt', completions: 'id, &taskId, currentAt',
  ledger: 'id, completionId, taskId, at', routines: 'id, active', sessions: 'id, taskId, startedAt',
  commands: 'key', audits: 'id, taskId, at', settings: 'id',
  containers: 'id, parentId, kind, ownerId, deletedAt', checklistItems: 'id, taskId, convertedTaskId',
  labelGroups: 'id, ownerId', labelDefinitions: 'id, groupId, ownerId, name', savedTemplates: 'id, familyId, ownerId, kind, name, version',
  taskNotes: 'id, taskId, ownerId', taskComments: 'id, taskId, ownerId', taskAttachments: 'id, taskId, ownerId', taskDependencies: 'id, taskId, dependsOnId',
  planningBuckets: 'id, ownerId, kind, startDate, parentId', timeBlocks: 'id, ownerId, date, projectId', calendarEvents: 'id, ownerId, startAt'
})
db.version(9).stores({
  tasks: 'id, &generationKey, status, scheduledDate, dueDate, project, containerId, planBucketId, routineId, deletedAt, updatedAt',
  assessments: 'id, taskId, createdAt', completions: 'id, &taskId, currentAt',
  ledger: 'id, completionId, taskId, at', routines: 'id, active', sessions: 'id, taskId, startedAt',
  commands: 'key', audits: 'id, taskId, at', settings: 'id',
  containers: 'id, parentId, kind, ownerId, deletedAt', checklistItems: 'id, taskId, convertedTaskId',
  labelGroups: 'id, ownerId', labelDefinitions: 'id, groupId, ownerId, name', savedTemplates: 'id, familyId, ownerId, kind, name, version',
  taskNotes: 'id, taskId, ownerId', taskComments: 'id, taskId, ownerId', taskAttachments: 'id, taskId, ownerId', taskDependencies: 'id, taskId, dependsOnId',
  planningBuckets: 'id, ownerId, kind, startDate, parentId', timeBlocks: 'id, ownerId, date, projectId', calendarEvents: 'id, ownerId, startAt', rollovers: 'id, taskId, at'
})
db.version(10).stores({
  tasks: 'id, &generationKey, status, scheduledDate, dueDate, project, containerId, planBucketId, routineId, deletedAt, updatedAt',
  assessments: 'id, taskId, createdAt', completions: 'id, &taskId, currentAt',
  ledger: 'id, completionId, taskId, at', routines: 'id, active', sessions: 'id, taskId, startedAt',
  commands: 'key', audits: 'id, taskId, at', settings: 'id',
  containers: 'id, parentId, kind, ownerId, deletedAt', checklistItems: 'id, taskId, convertedTaskId',
  labelGroups: 'id, ownerId', labelDefinitions: 'id, groupId, ownerId, name', savedTemplates: 'id, familyId, ownerId, kind, name, version',
  taskNotes: 'id, taskId, ownerId', taskComments: 'id, taskId, ownerId', taskAttachments: 'id, taskId, ownerId', taskDependencies: 'id, taskId, dependsOnId',
  planningBuckets: 'id, ownerId, kind, startDate, parentId', timeBlocks: 'id, ownerId, date, projectId', calendarEvents: 'id, ownerId, startAt', rollovers: 'id, taskId, at', themeRules: 'id, ownerId, category'
})
db.version(11).stores({
  tasks: 'id, &generationKey, status, scheduledDate, dueDate, project, containerId, planBucketId, routineId, deletedAt, updatedAt',
  assessments: 'id, taskId, createdAt', completions: 'id, &taskId, currentAt',
  ledger: 'id, completionId, taskId, at', routines: 'id, active', sessions: 'id, taskId, startedAt',
  commands: 'key', audits: 'id, taskId, at', settings: 'id',
  containers: 'id, parentId, kind, ownerId, deletedAt', checklistItems: 'id, taskId, convertedTaskId',
  labelGroups: 'id, ownerId', labelDefinitions: 'id, groupId, ownerId, name', savedTemplates: 'id, familyId, ownerId, kind, name, version',
  taskNotes: 'id, taskId, ownerId', taskComments: 'id, taskId, ownerId', taskAttachments: 'id, taskId, ownerId', taskDependencies: 'id, taskId, dependsOnId',
  planningBuckets: 'id, ownerId, kind, startDate, parentId', timeBlocks: 'id, ownerId, date, projectId', calendarEvents: 'id, ownerId, startAt', rollovers: 'id, taskId, at', themeRules: 'id, ownerId, category', smartLists: 'id, ownerId, name'
})
db.version(12).stores({
  tasks: 'id, &generationKey, status, scheduledDate, dueDate, project, containerId, planBucketId, routineId, deletedAt, updatedAt',
  assessments: 'id, taskId, createdAt', completions: 'id, &taskId, currentAt',
  ledger: 'id, completionId, taskId, at', routines: 'id, active', sessions: 'id, taskId, startedAt',
  commands: 'key', audits: 'id, taskId, at', settings: 'id',
  containers: 'id, parentId, kind, ownerId, deletedAt', checklistItems: 'id, taskId, convertedTaskId',
  labelGroups: 'id, ownerId', labelDefinitions: 'id, groupId, ownerId, name', savedTemplates: 'id, familyId, ownerId, kind, name, version',
  taskNotes: 'id, taskId, ownerId', taskComments: 'id, taskId, ownerId', taskAttachments: 'id, taskId, ownerId', taskDependencies: 'id, taskId, dependsOnId',
  planningBuckets: 'id, ownerId, kind, startDate, parentId', timeBlocks: 'id, ownerId, date, projectId', calendarEvents: 'id, ownerId, startAt', rollovers: 'id, taskId, at', themeRules: 'id, ownerId, category', smartLists: 'id, ownerId, name', focusSelections: 'id, ownerId, date'
})
db.version(13).stores({
  habits: 'id, ownerId, active, routineId', habitLogs: 'id, habitId, date, taskId'
})
db.version(14).stores({ goals: 'id, ownerId, parentId, deletedAt', goalCheckIns: 'id, goalId, date, deletedAt' })
db.version(15).stores({ trackerDefinitions: 'id, ownerId, name', trackerEntries: 'id, trackerId, recordedAt', dayNotes: 'id, ownerId, date, deletedAt' })
db.version(16).stores({ pomodoroCycles: 'id, taskId, finishedAt' })
db.version(17).stores({ reviewRecords: 'id, ownerId, date, kind, deletedAt' })
db.version(18).stores({ tripBundles: 'id, ownerId, frozenAt' })
db.version(19).stores({ coachMemories: 'id, ownerId, kind, deletedAt', memoryTombstones: 'id, ownerId, sourceKey' })
db.version(20).stores({ contextSources: 'id, ownerId, provider, latestRevision, deletedAt', contextSnapshots: 'id, sourceId, ownerId, revision', sourceSummaries: 'id, sourceId, ownerId, sourceRevision, permissionRevision', sourceArtifacts: 'id, sourceId, ownerId, kind' })
db.version(21).stores({ coachConversations: 'id, ownerId, deletedAt, updatedAt', coachMessages: 'id, conversationId, ownerId, [conversationId+sequence], replyTo, createdAt' })
db.version(22).stores({ calendarRules: 'id, ownerId, datasetId, revision' })
db.version(23).stores({ achievementPolicies: 'id,&repositoryId,ownerId,datasetId,revision', achievementEvidence: 'id,ownerId,datasetId,taskId,completionId,status', achievementExports: 'id,&[repositoryId+completionId],ownerId,datasetId,completionId,state' })

export async function ensureSettings() {
  const current = await db.settings.get('main')
  if (current) return current
  const settings: Settings = { id: 'main', profileId: crypto.randomUUID(), datasetId: crypto.randomUUID(), createdAt: new Date().toISOString(), coachName: 'コーチ', dailyMinutes: 180, dailyPoints: 80, notifications: false, aiEnabled: false, automation: 'A1', lastBackupAt: null }
  try { await db.settings.add(settings) } catch { return (await db.settings.get('main'))! }
  return settings
}
