import Dexie, { type EntityTable } from 'dexie'
import type { Assessment, Audit, CalendarEvent, ChecklistItem, CommandReceipt, Completion, Container, FocusProjectSelection, Habit, HabitLog, LabelDefinition, LabelGroup, LedgerEntry, PlanningBucket, RolloverEntry, Routine, SavedTemplate, Settings, SmartList, Task, TaskAttachment, TaskComment, TaskDependency, TaskNote, ThemeRule, TimeBlock, WorkSession } from './domain'

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

export async function ensureSettings() {
  const current = await db.settings.get('main')
  if (current) return current
  const settings: Settings = { id: 'main', profileId: crypto.randomUUID(), datasetId: crypto.randomUUID(), createdAt: new Date().toISOString(), coachName: 'コーチ', dailyMinutes: 180, dailyPoints: 80, notifications: false, aiEnabled: false, automation: 'A1', lastBackupAt: null }
  try { await db.settings.add(settings) } catch { return (await db.settings.get('main'))! }
  return settings
}
