import { db, ensureSettings } from './db'
import { addDays, uid, type Settings, type Task, type TaskDependency, type TimeBlock } from './domain'
import { dayCapacity } from './planning'
import { timeBlockCapacity } from './calendar-planning'

export type DuePlacement = { taskId: string; revision: number; date: string }
export type DueUnplaced = { taskId: string; reason: string }
export function proposeDueSchedule(tasks: Task[], dependencies: TaskDependency[], blocks: TimeBlock[], settings: Settings, from: string, horizonDays = 90) {
  const candidates = tasks.filter(task => !task.deletedAt && task.status === 'open' && task.dueDate && !task.scheduledDate).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || b.importance - a.importance)
  const byId = new Map(tasks.map(task => [task.id, task])), placements: DuePlacement[] = [], unplaced: DueUnplaced[] = []
  const projected = tasks.filter(task => !task.deletedAt)
  const horizonEnd = addDays(from, Math.max(0, Math.min(365, horizonDays) - 1))
  for (const task of candidates) {
    const blocked = dependencies.some(edge => edge.taskId === task.id && (byId.get(edge.dependsOnId)?.status !== 'completed' || byId.get(edge.dependsOnId)?.deletedAt))
    if (blocked) { unplaced.push({ taskId: task.id, reason: '前提タスクが未完了' }); continue }
    if (task.score.minutes === null) { unplaced.push({ taskId: task.id, reason: '作業分数が未設定' }); continue }
    if (task.effectivePoints === null) { unplaced.push({ taskId: task.id, reason: '必要ポイントが未設定' }); continue }
    const available = [from, task.availableFrom, task.deferredUntil].filter((value): value is string => Boolean(value)).sort().at(-1)!
    const last = task.dueDate! < horizonEnd ? task.dueDate! : horizonEnd
    let placed = false
    for (let date = available; date <= last; date = addDays(date, 1)) {
      const load = timeBlockCapacity(date, projected, blocks)
      const points = dayCapacity(projected.filter(item => item.scheduledDate === date && item.status === 'open'), settings.dailyMinutes, settings.dailyPoints).points
      if (load.totalMinutes + task.score.minutes > settings.dailyMinutes || points + task.effectivePoints > settings.dailyPoints) continue
      placements.push({ taskId: task.id, revision: task.revision, date })
      projected.push({ ...task, scheduledDate: date })
      placed = true
      break
    }
    if (!placed) unplaced.push({ taskId: task.id, reason: available > last ? '期限前に配置可能な日がない' : '期限前の時間またはポイント容量が不足' })
  }
  return { placements, unplaced }
}

export async function commitDueSchedule(placements: DuePlacement[], from: string) {
  if (!placements.length) return
  const settings = await ensureSettings()
  await db.transaction('rw', db.tasks, db.audits, db.timeBlocks, db.taskDependencies, async () => {
    const [tasks, dependencies, blocks] = await Promise.all([db.tasks.toArray(), db.taskDependencies.toArray(), db.timeBlocks.toArray()])
    const fresh = proposeDueSchedule(tasks, dependencies, blocks, settings, from)
    const expected = new Map(fresh.placements.map(item => [item.taskId, item]))
    if (new Set(placements.map(item => item.taskId)).size !== placements.length || placements.some(item => { const current = expected.get(item.taskId); return !current || current.revision !== item.revision || current.date !== item.date })) throw new Error('配置案が古くなりました。再計算してください')
    const at = new Date().toISOString()
    for (const item of placements) {
      const task = tasks.find(value => value.id === item.taskId)!
      await db.tasks.put({ ...task, scheduledDate: item.date, revision: task.revision + 1, updatedAt: at })
      await db.audits.add({ id: uid(), taskId: task.id, operation: 'auto_schedule', at, detail: item.date })
    }
  })
}
