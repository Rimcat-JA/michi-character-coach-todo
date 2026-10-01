import { db } from './db'
import { addTask, expandRoutines, legacyRoutineHandedOver, matchesRoutine, newTaskInput } from './commands'
import { addDays, today, uid, validateDate, type Routine, type RoutineCatchupState, type RoutineCatchupSummary } from './domain'

/** 5.4: one series materializes at most 1,000 occurrences per run; the oldest beyond that stay explicitly unexpanded. */
export const CATCHUP_SERIES_CAP = 1000
/** 11.6: one run materializes at most 5,000 occurrences across all series. */
export const CATCHUP_RUN_CAP = 5000
const PAST_DAYS = 30, WINDOW_DAYS = 120
const emptyState = (): RoutineCatchupState => ({ checkpoints: {}, lastRunAt: null, summary: null })
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0

export function validateRoutineCatchupState(value: unknown): asserts value is RoutineCatchupState {
  if (!record(value) || Object.keys(value).length !== 3 || !record(value.checkpoints) || !(value.lastRunAt === null || timestamp(value.lastRunAt))) throw new Error('繰り返しの展開位置が不正です')
  const entries = Object.entries(value.checkpoints)
  if (entries.length > 10000 || entries.some(([id, date]) => !id || id.length > 200 || typeof date !== 'string')) throw new Error('繰り返しの展開位置が不正です')
  for (const [, date] of entries) validateDate(date as string, '展開済みの日付')
  const summary = value.summary
  if (summary === null) return
  if (!record(summary) || Object.keys(summary).length !== 7 || !timestamp(summary.at) || !(summary.previousRunAt === null || timestamp(summary.previousRunAt)) || !count(summary.days) || !count(summary.created) || !count(summary.unexpanded) || !Array.isArray(summary.truncatedRoutineIds) || summary.truncatedRoutineIds.length > 10000 || summary.truncatedRoutineIds.some(id => typeof id !== 'string' || !id || id.length > 200) || !(summary.acknowledgedAt === null || timestamp(summary.acknowledgedAt))) throw new Error('繰り返しの展開結果が不正です')
}

function datesBetween(routine: Routine, from: string, toExclusive: string): string[] {
  const dates: string[] = []
  for (let date = from; date < toExclusive; date = addDays(date, 1)) if (matchesRoutine(routine, date)) dates.push(date)
  return dates
}
async function materialize(routine: Routine, date: string): Promise<boolean> {
  const key = `${routine.id}:${date}`
  return db.transaction('rw', [db.tasks, db.assessments, db.audits, db.containers, db.settings, db.labelGroups, db.labelDefinitions], async () => {
    if (await db.tasks.where('generationKey').equals(key).first()) return false
    await addTask({ ...newTaskInput(), title: routine.title, project: routine.project, scheduledDate: date, score: routine.score }, key, routine.id)
    return true
  })
}

/** Startup/foreground expansion. Calendar series resume from their checkpoint (keep_all) with the same
 * generation keys as expandRoutines, so repeated launches never duplicate. Past occurrences are rows only;
 * no notification is produced here. A series without a checkpoint starts at the usual window, unless it was
 * saved after the last run: then it resumes from the window that existed when it was saved. */
export async function catchUpRoutines(now = new Date()): Promise<RoutineCatchupSummary> {
  const day = today(now), windowStart = addDays(day, -PAST_DAYS), windowEnd = addDays(windowStart, WINDOW_DAYS - 1), at = now.toISOString()
  const settings0 = await db.settings.get('main'), initial = settings0?.routineCatchup ?? emptyState()
  // N09 routine stop: create nothing and keep checkpoints so resume backfills the stopped span (automation-control resume copy).
  if (settings0?.changePolicy?.stops?.routines) return { at, previousRunAt: initial.lastRunAt, days: 0, created: 0, unexpanded: 0, truncatedRoutineIds: [], acknowledgedAt: null }
  // A stored time after now can only come from a clock that has since gone back.
  const clockBack = initial.lastRunAt !== null && initial.lastRunAt > at, clockSeries = new Set<string>(), overwrite = new Set<string>(), truncated = new Set<string>(), checkpoints: Record<string, string> = {}
  const gapPlans: { routine: Routine; date: string }[] = [], windowPlans: { routine: Routine; date: string }[] = []
  let unexpanded = 0, futureRows = 0
  for (const routine of await db.routines.toArray()) {
    // Completion-relative series advance one completion at a time (expandRoutines below), never by bulk past dates.
    if (!routine.active || routine.cadence === 'after_completion' || await legacyRoutineHandedOver(routine.id)) continue
    const existing = new Set((await db.tasks.where('routineId').equals(routine.id).toArray()).flatMap(task => task.generationKey?.startsWith(`${routine.id}:`) ? [task.generationKey.slice(routine.id.length + 1)] : []))
    const stored = initial.checkpoints[routine.id], back = !!stored && stored > windowEnd
    let gapStart: string
    if (back) {
      // Ignore the future checkpoint: resume after the latest occurrence before the window, or from the series start.
      clockSeries.add(routine.id); overwrite.add(routine.id); futureRows += [...existing].filter(date => date > windowEnd).length
      const before = [...existing].filter(date => date < windowStart).sort().at(-1)
      gapStart = before ? addDays(before, 1) : routine.startDate
    } else if (stored) gapStart = addDays(stored, 1)
    // Saved after the last run: resume from its save-time window, not today's.
    else gapStart = initial.lastRunAt !== null && routine.createdAt > initial.lastRunAt ? addDays(today(new Date(routine.createdAt)), -PAST_DAYS) : windowStart
    // Only missing dates count, so a rescanned span never reports existing occurrences as unexpanded.
    const window = datesBetween(routine, windowStart, addDays(windowEnd, 1)).filter(date => !existing.has(date)), room = Math.max(0, CATCHUP_SERIES_CAP - window.length)
    if (gapStart < windowStart) {
      const gap = datesBetween(routine, gapStart, windowStart).filter(date => !existing.has(date)), kept = gap.slice(Math.max(0, gap.length - room))
      if (kept.length < gap.length) { unexpanded += gap.length - kept.length; truncated.add(routine.id) }
      for (const date of kept) gapPlans.push({ routine, date })
    }
    for (const date of window) windowPlans.push({ routine, date })
    checkpoints[routine.id] = windowEnd
  }
  // 11.6 run cap: the window comes first; past gap dates beyond the remaining budget are unexpanded oldest-first, like the series cap
  // (the checkpoint passes them, so no later run fills or recounts them). Window dates are never unexpanded: if the window alone
  // exceeds the cap, its farthest future dates wait for the next run; their series checkpoint stays before them so they are never skipped.
  const byDate = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date)
  gapPlans.sort(byDate); windowPlans.sort(byDate)
  const trimmed = Math.max(0, gapPlans.length - Math.max(0, CATCHUP_RUN_CAP - windowPlans.length)), deferred = Math.max(0, windowPlans.length - CATCHUP_RUN_CAP)
  for (const plan of gapPlans.slice(0, trimmed)) truncated.add(plan.routine.id)
  for (const plan of windowPlans.slice(windowPlans.length - deferred)) { const before = addDays(plan.date, -1); if (before < checkpoints[plan.routine.id]) checkpoints[plan.routine.id] = before; overwrite.add(plan.routine.id) }
  unexpanded += trimmed
  let created = 0
  for (const plan of [...gapPlans.slice(trimmed), ...windowPlans.slice(0, windowPlans.length - deferred)]) if (await materialize(plan.routine, plan.date)) created++
  // Completion-based series only: the calendar windows were materialized above under the run cap.
  created += await expandRoutines(windowStart, 0)
  const previousRunAt = initial.lastRunAt, days = previousRunAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(previousRunAt)) / 86400000)) : 0
  const summary: RoutineCatchupSummary = { at, previousRunAt, days, created, unexpanded, truncatedRoutineIds: [...truncated], acknowledgedAt: null }
  await db.transaction('rw', db.settings, db.audits, async () => {
    const settings = await db.settings.get('main')
    if (!settings) return
    const current = settings.routineCatchup ?? emptyState(), merged = { ...current.checkpoints }
    // Checkpoints only move forward, except where this run deliberately set them (clock gone back, deferred window dates).
    for (const [id, date] of Object.entries(checkpoints)) if (overwrite.has(id) || !merged[id] || merged[id] < date) merged[id] = date
    // A quiet run keeps the unacknowledged report; a shown, unacknowledged report accumulates so a later run never hides an earlier truncation.
    const open = current.summary && !current.summary.acknowledgedAt ? current.summary : null, prev = catchupNotice(open) !== null ? open : null
    const report: RoutineCatchupSummary = open && !created && !unexpanded ? open : !prev ? summary : { ...summary, previousRunAt: prev.previousRunAt, days: prev.previousRunAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(prev.previousRunAt)) / 86400000)) : summary.days, created: Math.min(Number.MAX_SAFE_INTEGER, prev.created + created), unexpanded: Math.min(Number.MAX_SAFE_INTEGER, prev.unexpanded + unexpanded), truncatedRoutineIds: [...new Set([...prev.truncatedRoutineIds, ...truncated])].slice(0, 10000) }
    const back = clockBack || clockSeries.size > 0
    const next: RoutineCatchupState = { checkpoints: merged, lastRunAt: back || !current.lastRunAt || current.lastRunAt < at ? at : current.lastRunAt, summary: report }
    validateRoutineCatchupState(next)
    await db.settings.put({ ...settings, routineCatchup: next })
    // The owner can review rows made while the clock was ahead; nothing is deleted.
    if (back) await db.audits.add({ id: uid(), taskId: null, operation: 'routine.catchup.clock', at, detail: JSON.stringify({ message: `端末の時計が前回記録(${initial.lastRunAt ?? '展開位置'})より過去です`, previousRunAt: initial.lastRunAt, futureOccurrences: futureRows, series: clockSeries.size }) })
    if (deferred) await db.audits.add({ id: uid(), taskId: null, operation: 'routine.catchup.deferred', at, detail: JSON.stringify({ deferred, runCap: CATCHUP_RUN_CAP }) })
  })
  return summary
}
export function catchupNotice(summary: RoutineCatchupSummary | null | undefined): string | null {
  if (!summary || summary.acknowledgedAt || summary.days < 1 || !summary.created && !summary.unexpanded) return null
  return `前回起動から ${summary.days} 日：作成 ${summary.created} 回／未展開 ${summary.unexpanded} 回`
}
export async function acknowledgeCatchupSummary(): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main')
    if (!settings?.routineCatchup?.summary) return
    await db.settings.put({ ...settings, routineCatchup: { ...settings.routineCatchup, summary: { ...settings.routineCatchup.summary, acknowledgedAt: new Date().toISOString() } } })
  })
}
