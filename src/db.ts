import Dexie, { type EntityTable } from 'dexie'
import type { Assessment, Audit, CommandReceipt, Completion, LedgerEntry, Routine, Settings, Task, WorkSession } from './domain'

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
}
db.version(1).stores({
  tasks: 'id, &generationKey, status, scheduledDate, dueDate, project, routineId, deletedAt, updatedAt',
  assessments: 'id, taskId, createdAt', completions: 'id, &taskId, currentAt',
  ledger: 'id, completionId, taskId, at', routines: 'id, active', sessions: 'id, taskId, startedAt',
  commands: 'key', audits: 'id, taskId, at', settings: 'id'
})

export async function ensureSettings() {
  const current = await db.settings.get('main')
  if (current) return current
  const settings: Settings = { id: 'main', profileId: crypto.randomUUID(), datasetId: crypto.randomUUID(), createdAt: new Date().toISOString(), coachName: 'コーチ', dailyMinutes: 180, dailyPoints: 80, notifications: false, aiEnabled: false, automation: 'A1', lastBackupAt: null }
  try { await db.settings.add(settings) } catch { return (await db.settings.get('main'))! }
  return settings
}
