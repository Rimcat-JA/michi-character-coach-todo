import { addDays, taskDueTime, type Settings, type Task, type TaskDependency, type TimeBlock } from './domain'
import { dayCapacity } from './planning'
import { timeBlockCapacity } from './calendar-planning'
import { slippedTasks } from './coach-facts'
import { changePolicyFor, prepareTaskChanges, type PreparedChangeSet } from './change-set'
import { COACH_MEDIATED_REASONS } from './automation-policy'

export type ReplanSituation = 'slipped' | 'overload' | 'selfReport'
/** Only scheduledDate is ever proposed. dueDate/dueAt, points, status and new tasks are out of reach by construction; dueTime is shown only. */
export type ReplanCandidate = { taskId: string; title: string; revision: number; situations: ReplanSituation[]; from: string | null; to: string | null; dueDate: string | null; dueTime?: string; reason: string | null }
export type ReplanSummary = { today: string; slipped: number; todayCount: number; plannedMinutes: number; plannedPoints: number; minutesLimit: number; pointsLimit: number; overloaded: boolean; candidates: ReplanCandidate[] }
export type ReplanInput = { tasks: Task[]; dependencies: TaskDependency[]; blocks: TimeBlock[]; settings: Pick<Settings, 'dailyMinutes' | 'dailyPoints'>; today: string; selfReport?: boolean; horizonDays?: number }
const order = (a: Task, b: Task) => (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31') || b.importance - a.importance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const live = (task: Task) => !task.deletedAt && task.status === 'open'
/** Deterministic situation-based candidates from 予定 (slipped), 進捗/容量 (overload) and 本人申告 (selfReport). */
export function replanCandidates({ tasks, dependencies, blocks, settings, today, selfReport = false, horizonDays = 60 }: ReplanInput): ReplanSummary {
  const open = tasks.filter(live), byId = new Map(tasks.map(task => [task.id, task]))
  const todays = open.filter(task => task.scheduledDate === today && !task.backburner).sort(order)
  const load = (date: string, projected: Task[]) => ({ minutes: timeBlockCapacity(date, projected.filter(live), blocks).totalMinutes, points: dayCapacity(projected.filter(item => live(item) && item.scheduledDate === date), settings.dailyMinutes, settings.dailyPoints).points })
  const planned = load(today, open), overloaded = planned.minutes > settings.dailyMinutes || planned.points > settings.dailyPoints
  const situations = new Map<string, ReplanSituation[]>(), add = (task: Task, situation: ReplanSituation) => situations.set(task.id, [...(situations.get(task.id) ?? []), situation])
  for (const task of slippedTasks(open, today)) add(task, 'slipped')
  if (overloaded) {
    // Keep today's highest-priority tasks inside capacity; the rest become optional move candidates.
    let minutes = timeBlockCapacity(today, [], blocks).totalMinutes, points = 0
    for (const task of todays) {
      const nextMinutes = minutes + (task.score.minutes ?? 0), nextPoints = points + (task.effectivePoints ?? 0)
      if (nextMinutes > settings.dailyMinutes || nextPoints > settings.dailyPoints) add(task, 'overload')
      else { minutes = nextMinutes; points = nextPoints }
    }
  }
  if (selfReport) for (const task of todays) if (!situations.has(task.id)) add(task, 'selfReport')
  const projected = open.map(task => ({ ...task })), tomorrow = addDays(today, 1), candidates: ReplanCandidate[] = []
  for (const task of open.filter(item => situations.has(item.id)).sort(order)) {
    const base = { taskId: task.id, title: task.title, revision: task.revision, situations: situations.get(task.id)!, from: task.scheduledDate, dueDate: task.dueDate, ...(taskDueTime(task) ? { dueTime: taskDueTime(task)! } : {}) }
    if (dependencies.some(edge => edge.taskId === task.id && (byId.get(edge.dependsOnId)?.status !== 'completed' || byId.get(edge.dependsOnId)?.deletedAt))) { candidates.push({ ...base, to: null, reason: '前提タスクが未完了' }); continue }
    const first = [tomorrow, task.availableFrom, task.deferredUntil ?? null].filter((value): value is string => Boolean(value)).sort().at(-1)!
    const last = task.dueDate ?? addDays(today, horizonDays)
    let to: string | null = null
    for (let date = first; date <= last; date = addDays(date, 1)) {
      const day = load(date, projected)
      if (day.minutes + (task.score.minutes ?? 0) <= settings.dailyMinutes && day.points + (task.effectivePoints ?? 0) <= settings.dailyPoints) { to = date; break }
    }
    if (to) projected.find(item => item.id === task.id)!.scheduledDate = to
    candidates.push({ ...base, to, reason: to ? null : task.dueDate ? '期限前に空きなし' : '先の予定に空きなし' })
  }
  return { today, slipped: slippedTasks(open, today).length, todayCount: todays.length, plannedMinutes: planned.minutes, plannedPoints: planned.points, minutesLimit: settings.dailyMinutes, pointsLimit: settings.dailyPoints, overloaded, candidates }
}
export const replanReason = COACH_MEDIATED_REASONS[0]
/** One owner ChangeSet with scheduledDate only for the rows the person ticked; nothing is pre-selected. */
export async function prepareReplanChangeSet(candidates: ReplanCandidate[], selectedIds: string[], settings: Settings): Promise<PreparedChangeSet> {
  const chosen = candidates.filter(item => selectedIds.includes(item.taskId) && item.to), policy = changePolicyFor(settings)
  if (!chosen.length || chosen.length !== new Set(selectedIds).size) throw new Error('移す候補を選んでください（移動先のない候補は選べません）')
  if (chosen.length > policy.bounds.maxTasks) throw new Error(`一度に移せるのは${policy.bounds.maxTasks}件までです`)
  return prepareTaskChanges(chosen.map(item => ({ taskId: item.taskId, expectedRevision: item.revision, patch: { scheduledDate: item.to } })), { principal: { id: settings.profileId, kind: 'human' }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: ['scheduledDate'], sourceRevisions: [] }, replanReason)
}
