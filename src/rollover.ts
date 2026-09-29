import { db } from './db'
import { uid, validateDate, type Task } from './domain'

export async function rolloverTask(taskId: string, expectedRevision: number, toDate: string) {
  validateDate(toDate, '繰越先')
  await db.transaction('rw', db.tasks, db.rollovers, db.audits, async () => {
    const task = await db.tasks.get(taskId)
    if (!task || task.deletedAt || task.status !== 'open' || !task.scheduledDate) throw new Error('繰越するタスクがありません')
    if (task.revision !== expectedRevision) throw new Error('別の画面で更新されました')
    if (toDate <= task.scheduledDate) throw new Error('繰越先は現在の予定日より後にしてください')
    const at = new Date().toISOString(), fromDate = task.scheduledDate
    await db.tasks.put({ ...task, scheduledDate: toDate, firstScheduledDate: task.firstScheduledDate ?? fromDate, revision: task.revision + 1, updatedAt: at })
    await db.rollovers.add({ id: uid(), taskId, fromDate, toDate, at })
    await db.audits.add({ id: uid(), taskId, operation: 'rollover', at, detail: `${fromDate} → ${toDate}` })
  })
}

export async function snoozeTask(taskId: string, expectedRevision: number, until: string | null) {
  if (until !== null && (!Number.isFinite(Date.parse(until)) || new Date(until).toISOString() !== until)) throw new Error('再表示時刻が不正です')
  await db.transaction('rw', db.tasks, db.audits, async () => {
    const task = await db.tasks.get(taskId)
    if (!task || task.deletedAt || task.status !== 'open') throw new Error('スヌーズするタスクがありません')
    if (task.revision !== expectedRevision) throw new Error('別の画面で更新されました')
    const at = new Date().toISOString()
    await db.tasks.put({ ...task, snoozedUntil: until, revision: task.revision + 1, updatedAt: at })
    await db.audits.add({ id: uid(), taskId, operation: 'snooze', at, detail: until ?? '解除' })
  })
}

export function dueSnoozes(tasks: Task[], now: string) {
  return tasks.filter(task => !task.deletedAt && task.status === 'open' && task.snoozedUntil && task.snoozedUntil <= now)
}
