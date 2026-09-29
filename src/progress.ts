import { db } from './db'
import { addDays, today, uid, validateDate, type Completion, type Container, type DayProgressBaseline, type Task, type TimeTarget, type WorkSession } from './domain'
import { unionSessionMinutes } from './time-tracking'

export async function createTimeTarget(containerId: string, startDate: string, endDate: string, targetMinutes: number): Promise<string> {
  validateDate(startDate, '開始日'); validateDate(endDate, '終了日')
  if (startDate > endDate || endDate > addDays(startDate, 366)) throw new Error('期間は開始日から366日以内にしてください')
  if (!Number.isInteger(targetMinutes) || targetMinutes < 1 || targetMinutes > 100000) throw new Error('目標時間は1〜100000分で指定してください')
  return db.transaction('rw', [db.settings, db.containers], async () => {
    const settings = await db.settings.get('main'), container = await db.containers.get(containerId)
    if (!settings || !container || container.deletedAt || container.ownerId !== settings.profileId) throw new Error('対象のカテゴリ・プロジェクトがありません')
    if ((settings.timeTargets?.length ?? 0) >= 100) throw new Error('時間目標は100件までです')
    const id = uid()
    await db.settings.put({ ...settings, timeTargets: [...(settings.timeTargets ?? []), { id, containerId, startDate, endDate, targetMinutes }] })
    return id
  })
}

export async function removeTimeTarget(id: string): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('設定がありません')
    await db.settings.put({ ...settings, timeTargets: (settings.timeTargets ?? []).filter(target => target.id !== id) })
  })
}

function insideContainer(task: Task, targetId: string, containers: Container[]): boolean {
  let cursor = task.containerId ?? null
  const byId = new Map(containers.map(container => [container.id, container]))
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    if (cursor === targetId) return true
    seen.add(cursor)
    cursor = byId.get(cursor)?.parentId ?? null
  }
  return false
}

export function timeTargetProgress(target: TimeTarget, tasks: Task[], containers: Container[], sessions: WorkSession[]): { minutes: number; targetMinutes: number; percent: number } {
  const taskIds = new Set(tasks.filter(task => insideContainer(task, target.containerId, containers)).map(task => task.id))
  const start = new Date(`${target.startDate}T00:00:00`).getTime()
  const end = new Date(`${addDays(target.endDate, 1)}T00:00:00`).getTime()
  const clipped = sessions.filter(session => taskIds.has(session.taskId)).flatMap(session => {
    const from = Math.max(start, Date.parse(session.startedAt)), to = Math.min(end, Date.parse(session.endedAt))
    return to > from ? [{ startedAt: new Date(from).toISOString(), endedAt: new Date(to).toISOString() }] : []
  })
  const minutes = unionSessionMinutes(clipped)
  return { minutes, targetMinutes: target.targetMinutes, percent: Math.min(100, Math.round(minutes / target.targetMinutes * 100)) }
}

export async function captureDayProgressBaseline(date: string = today()): Promise<DayProgressBaseline> {
  validateDate(date, '対象日')
  return db.transaction('rw', [db.settings, db.tasks, db.completions], async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('設定がありません')
    if (settings.dayProgressBaseline?.date === date) return settings.dayProgressBaseline
    const [tasks, completions] = await Promise.all([db.tasks.toArray(), db.completions.toArray()])
    const completedToday = new Set(completions.filter(item => item.currentAt && today(new Date(item.currentAt)) === date).map(item => item.taskId))
    const entries = tasks.filter(task => !task.deletedAt && ((task.status === 'open' && (task.scheduledDate === date || !!task.dueDate && task.dueDate < date)) || completedToday.has(task.id))).map(task => ({ taskId: task.id, minutes: task.score.minutes, points: task.effectivePoints }))
    const baseline = { date, capturedAt: new Date().toISOString(), entries }
    await db.settings.put({ ...settings, dayProgressBaseline: baseline })
    return baseline
  })
}

export function dayProgress(baseline: DayProgressBaseline | undefined, date: string, tasks: Task[], completions: Completion[]) {
  const entries = baseline?.date === date ? baseline.entries : []
  const baselineIds = new Set(entries.map(entry => entry.taskId))
  const completedIds = new Set(completions.filter(item => item.currentAt && today(new Date(item.currentAt)) === date).map(item => item.taskId))
  const added = tasks.filter(task => !task.deletedAt && !baselineIds.has(task.id) && ((task.status === 'open' && (task.scheduledDate === date || !!task.dueDate && task.dueDate < date)) || completedIds.has(task.id)))
  const baselineDone = entries.filter(entry => completedIds.has(entry.taskId)).length
  return {
    baselineTotal: entries.length, baselineDone, baselinePercent: entries.length ? Math.round(baselineDone / entries.length * 100) : 0,
    baselineMinutes: entries.reduce((sum, entry) => sum + (entry.minutes ?? 0), 0), baselineUnknownMinutes: entries.filter(entry => entry.minutes === null).length,
    baselinePoints: entries.reduce((sum, entry) => sum + (entry.points ?? 0), 0), baselineUnknownPoints: entries.filter(entry => entry.points === null).length,
    addedTotal: added.length, addedDone: added.filter(task => completedIds.has(task.id)).length,
    addedMinutes: added.reduce((sum, task) => sum + (task.score.minutes ?? 0), 0), addedPoints: added.reduce((sum, task) => sum + (task.effectivePoints ?? 0), 0),
  }
}
