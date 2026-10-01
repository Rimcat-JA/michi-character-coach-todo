import { IDBFactory } from 'fake-indexeddb'
import { vi } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput, updateTask } from './commands'
import { emptyScore, type Task } from './domain'
import { exportBackup, inspectBackup } from './backup'
import type { Snapshot } from './backup-validation'

/**
 * Test-only emulation of separate devices/profiles: each name gets its own fake IndexedDB.
 * This is emulation on one machine, not a second real device or a smartphone.
 */
const factories = new Map<string, IDBFactory>()
export async function useDevice(name: string) {
  db.close()
  const factory = factories.get(name) ?? new IDBFactory()
  factories.set(name, factory)
  ;(db as unknown as { _deps: { indexedDB: IDBFactory } })._deps.indexedDB = factory
  await db.open()
  await ensureSettings()
}
export function resetDevices() { factories.clear() }
// Node-only fixture: production browsers never let page code set isTrusted.
export function humanClick() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
export const PASSWORD = 'device-handoff-password'
/** Runs the real exportBackup (encrypted .coachbundle) and reads the downloaded file back through inspectBackup. */
export async function exportFile(password = PASSWORD): Promise<{ text: string; snapshot: Snapshot }> {
  let downloaded: Blob | undefined
  const anchor = { href: '', download: '', click: vi.fn() }
  vi.stubGlobal('document', { createElement: vi.fn(() => anchor) })
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(content => { downloaded = content as Blob; return 'blob:device-test' })
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  try {
    await exportBackup(password)
    const text = await downloaded!.text()
    return { text, snapshot: await inspectBackup(new File([text], anchor.download), password) }
  } finally { create.mockRestore(); revoke.mockRestore(); vi.unstubAllGlobals() }
}
export async function readBundle(text: string, password = PASSWORD) { return inspectBackup(new File([text], 'bundle.coachbundle'), password) }
export async function manualTask(title: string, points: number) { return createTask({ ...newTaskInput(), title, score: { ...emptyScore(), mode: 'manual', manualPoints: points } }) }
export async function setManualPoints(id: string, points: number) {
  const task = (await db.tasks.get(id))!
  return updateTask(id, task.revision, { ...inputOf(task), score: { ...task.score, mode: 'manual', manualPoints: points } })
}
export function inputOf(task: Task) {
  return { title: task.title, notes: task.notes, project: task.project, containerId: task.containerId ?? null, labels: task.labels, scheduledDate: task.scheduledDate, dueDate: task.dueDate, targetDate: task.targetDate, reviewDate: task.reviewDate, availableFrom: task.availableFrom, deferredUntil: task.deferredUntil ?? null, importance: task.importance, frog: task.frog ?? null, weight: task.weight ?? null, energyNeed: task.energyNeed ?? null, focusNeed: task.focusNeed ?? null, positiveFeeling: task.positiveFeeling ?? null, score: task.score }
}
export async function counts() { return { tasks: await db.tasks.count(), completions: await db.completions.count(), ledger: await db.ledger.count(), assessments: await db.assessments.count() } }
