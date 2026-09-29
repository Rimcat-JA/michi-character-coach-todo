import type { WorkSession } from './domain'
import { db } from './db'
import { uid } from './domain'
import { ConflictError } from './commands'

export function unionSessionMinutes(sessions: Pick<WorkSession, 'startedAt' | 'endedAt'>[]): number {
  const intervals = sessions.map(session => [Date.parse(session.startedAt), Date.parse(session.endedAt)] as const)
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start)
    .sort((a, b) => a[0] - b[0])
  let total = 0, start = -1, end = -1
  for (const [nextStart, nextEnd] of intervals) {
    if (nextStart > end) {
      if (start >= 0) total += end - start
      start = nextStart; end = nextEnd
    } else end = Math.max(end, nextEnd)
  }
  if (start >= 0) total += end - start
  return Math.round(total / 60000)
}

export async function correctWorkSession(id: string, expectedRevision: number, startedAt: string, endedAt: string, reason: string): Promise<void> {
  const start = Date.parse(startedAt), end = Date.parse(endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 10080 * 60000 || new Date(start).toISOString() !== startedAt || new Date(end).toISOString() !== endedAt) throw new Error('作業区間の時刻が不正です')
  if (!reason.trim() || reason.length > 300) throw new Error('訂正理由を入力してください')
  await db.transaction('rw', [db.sessions, db.audits], async () => {
    const current = await db.sessions.get(id)
    if (!current) throw new Error('作業区間がありません')
    if ((current.revision ?? 1) !== expectedRevision) throw new ConflictError()
    const at = new Date().toISOString(), minutes = Math.round((end - start) / 60000)
    await db.sessions.put({ ...current, startedAt, endedAt, minutes, revision: expectedRevision + 1, corrections: [...(current.corrections ?? []), { startedAt: current.startedAt, endedAt: current.endedAt, minutes: current.minutes, reason: reason.trim(), at }] })
    await db.audits.add({ id: uid(), taskId: current.taskId, operation: 'correct_work_session', at, detail: `${current.id}: ${reason.trim()}` })
  })
}
