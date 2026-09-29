import Dexie, { type EntityTable } from 'dexie'
import type { Assessment, Audit, ChecklistItem, CommandReceipt, Completion, Container, LedgerEntry, Routine, Settings, Task, WorkSession } from './domain'

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

export async function ensureSettings() {
  const current = await db.settings.get('main')
  if (current) return current
  const settings: Settings = { id: 'main', profileId: crypto.randomUUID(), datasetId: crypto.randomUUID(), createdAt: new Date().toISOString(), coachName: 'コーチ', dailyMinutes: 180, dailyPoints: 80, notifications: false, aiEnabled: false, automation: 'A1', lastBackupAt: null }
  try { await db.settings.add(settings) } catch { return (await db.settings.get('main'))! }
  return settings
}
