import { db } from './db'
import { addDays, type Settings, type Task } from './domain'
import { DEFAULT_CHARACTER } from './character'
import { calendarFactual, calendarRuleRevision, deadlineCoveredByReminder, deadlineFactual, deadlineLabel, deadlineFacts, deadlineRuleRevision, factsDigest, isCalendarIntent, isDeadlineIntent, isReplanIntent, replanFactual, slippedTasks } from './coach-facts'
import { coachTriggersOf, notificationLocalClock, type CoachNotificationIntent, type CoachTriggerSettings, type NotificationGuard, type NotificationRequest } from './coach-notifications'
import { acceptCoachNotificationInApp, coachNotificationGuardFor, coachNotificationStateFor, prepareCoachNotificationDelivery, queueCoachNotification, recordCoachNotificationDelivery, saveCoachNotificationAIText } from './coach-notification-save'
import { draftNotificationText, type NotificationTextTransport } from './notification-text'

export type OSNotificationPayload = NonNullable<Awaited<ReturnType<typeof prepareCoachNotificationDelivery>>>
/** Delivery adapters supplied by the shell; tests pass synthetic ones. */
export type CoachTriggerDeps = { notify?: (payload: OSNotificationPayload) => Promise<boolean>; notificationText?: NotificationTextTransport }
export type CalendarMove = { taskId: string; title: string; revision: number; from: string | null; to: string | null }
const dayMs = 86400000
/** UTC instant of a wall-clock time in the notification timezone (DST-safe by re-reading the zone). */
export function zonedInstant(day: string, time: string, timezone: string): string {
  const wanted = Date.parse(`${day}T${time}:00Z`)
  let guess = wanted
  for (let step = 0; step < 3; step++) { const clock = notificationLocalClock(new Date(guess).toISOString(), timezone); guess += wanted - Date.parse(`${clock.day}T${clock.time}:00Z`) }
  return new Date(guess).toISOString()
}
const destinations = (os: boolean, settings: Pick<Settings, 'notifications'>) => ['in-app', ...(os && settings.notifications ? ['os'] : [])]
const hourMs = 3600000
/**
 * Fact trigger for open tasks whose real deadline is within the person's lead window. A timed deadline (dueAt) ends the window at that instant and
 * is never announced after it; when the lead time falls after dueAt the notice moves to one hour before it. A one-time reminder the person set on the
 * task inside the same window (e.g. 「締め切り時刻の30分前」) replaces the coach notice, so the deadline is not announced twice.
 */
export function deadlineNearRequests(tasks: Task[], triggers: CoachTriggerSettings, settings: Pick<Settings, 'notifications'> & Partial<Pick<Settings, 'reminderState'>>, at: string, timezone: string): NotificationRequest[] {
  if (!triggers.deadlineNear.enabled) return []
  return tasks.filter(task => !task.deletedAt && task.status === 'open' && task.dueDate && (!task.snoozedUntil || task.snoozedUntil <= at)).flatMap(task => {
    const timed = Boolean(task.dueAt && task.dueTimezone)
    const expiresAt = timed ? new Date(Date.parse(task.dueAt!)).toISOString() : zonedInstant(addDays(task.dueDate!, 1), '00:00', timezone), lead = zonedInstant(addDays(task.dueDate!, -triggers.deadlineNear.leadDays), triggers.deadlineNear.time, timezone)
    const start = timed ? Math.min(Date.parse(lead), Date.parse(expiresAt) - hourMs) : Date.parse(lead)
    const notBefore = new Date(Math.max(start, Date.parse(expiresAt) - 7 * dayMs + 60000)).toISOString()
    if (at < notBefore || at >= expiresAt) return []
    if (deadlineCoveredByReminder(task, settings.reminderState?.rules, notBefore, expiresAt)) return []
    return [{ id: `deadline:${task.id}:${task.dueDate}`, purpose: 'deadline_near', category: 'proactive', target: { kind: 'task', id: task.id, revision: task.revision }, ruleId: `deadline:${task.id}`, ruleRevision: deadlineRuleRevision(task), ruleWindow: task.dueDate!, notBefore, expiresAt, destinationIds: destinations(triggers.deadlineNear.os, settings), sourceRefs: [], text: { factual: deadlineFactual(task.title, deadlineLabel(task, timezone)), savedAI: null }, intervalMinutes: null, maxCount: null, endDate: null } satisfies NotificationRequest]
  })
}
/** Optional daily prompt: only a count of slipped tasks, never a change. */
export function replanPromptRequest(tasks: Task[], triggers: CoachTriggerSettings, settings: Pick<Settings, 'notifications'>, at: string, timezone: string): NotificationRequest | null {
  if (!triggers.replanPrompt.enabled) return null
  const clock = notificationLocalClock(at, timezone), count = slippedTasks(tasks, clock.day).length
  if (!count || clock.time < triggers.replanPrompt.time) return null
  const id = `replan:${clock.day}`
  return { id, purpose: 'plan_changed', category: 'proactive', target: { kind: 'system', id, revision: 0 }, ruleId: id, ruleRevision: `replan:${count}`, ruleWindow: clock.day, notBefore: zonedInstant(clock.day, triggers.replanPrompt.time, timezone), expiresAt: zonedInstant(addDays(clock.day, 1), '00:00', timezone), destinationIds: destinations(triggers.replanPrompt.os, settings), sourceRefs: [], text: { factual: replanFactual(count), savedAI: null }, intervalMinutes: null, maxCount: null, endDate: null }
}
/** One plan_changed per task moved by an approved official calendar change. */
export function calendarChangeRequests(proposalId: string, moves: CalendarMove[], triggers: CoachTriggerSettings, settings: Pick<Settings, 'notifications'>, at: string): NotificationRequest[] {
  if (!triggers.calendarChange.enabled) return []
  return moves.filter(move => move.from !== move.to).map(move => ({ id: `calendar:${proposalId}:${move.taskId}`, purpose: 'plan_changed', category: 'proactive', target: { kind: 'task', id: move.taskId, revision: move.revision }, ruleId: `calendar:${proposalId}:${move.taskId}`, ruleRevision: calendarRuleRevision(move.revision, move.from, move.to), ruleWindow: `calendar:${proposalId}`, notBefore: at, expiresAt: new Date(Date.parse(at) + dayMs).toISOString(), destinationIds: destinations(triggers.calendarChange.os, settings), sourceRefs: [], text: { factual: calendarFactual(move.title, move.from, move.to), savedAI: null }, intervalMinutes: null, maxCount: null, endDate: null }))
}
/** A deadline taken from a source is bound to that source: revoking its notify permission cancels and anonymizes the notice. */
async function bindEvidenceSources(settings: Settings, request: NotificationRequest, at: string): Promise<{ request: NotificationRequest; sources: NotificationGuard['sources'] }> {
  if (request.target.kind !== 'task') return { request, sources: [] }
  const ids = [...new Set((await db.taskSourceEvidence.where('taskId').equals(request.target.id).toArray()).map(row => row.sourceId))].slice(0, 50), sources: NotificationGuard['sources'] = []
  for (const id of ids) {
    const source = await db.contextSources.get(id)
    if (!source || source.deletedAt || source.revision < 1) continue
    sources.push({ id: source.id, revision: source.revision, permissionRevision: source.permissionRevision, active: source.ownerId === settings.profileId && source.permissions.retain && (source.retentionUntil === null || source.retentionUntil > at), notify: source.permissions.notify, disclose: source.permissions.disclose })
  }
  return { request: { ...request, sourceRefs: sources.map(({ id, revision, permissionRevision }) => ({ id, revision, permissionRevision })) }, sources }
}
/** The common policy (stop, rest day, mute, quiet hours, cap, interval, source permission) runs inside queueCoachNotification first. */
async function reserve(settings: Settings, request: NotificationRequest, at: string) {
  const bound = await bindEvidenceSources(settings, request, at)
  return queueCoachNotification(bound.request, coachNotificationGuardFor(settings, { ...request.target, active: true }, { id: request.ruleId, revision: request.ruleRevision, active: true, sentCount: 0 }, bound.sources), at)
}
/** AI wording is written only after a reservation passed the policy; any failure keeps the factual template. */
async function wordIntent(intent: CoachNotificationIntent, deps: CoachTriggerDeps, at: string) {
  const settings = await db.settings.get('main'), task = await db.tasks.get(intent.target.id)
  const state = settings ? coachNotificationStateFor(settings) : null
  if (!settings || !state || !isDeadlineIntent(intent) || !coachTriggersOf(state).aiText || !settings.aiEnabled || !settings.aiModel || !deps.notificationText || !task?.dueDate) return
  // A deadline set in another zone keeps the factual template: the zone name is not something the AI wording may restate.
  if (task.dueAt && task.dueTimezone !== state.policy.timezone) return
  const facts = deadlineFacts(task), model = settings.aiModel, others = (await db.tasks.toArray()).filter(item => item.id !== task.id && !item.deletedAt && item.status === 'open').map(item => item.title)
  const draft = await draftNotificationText(deps.notificationText, { model, facts, character: settings.characterProfile ?? DEFAULT_CHARACTER }, others)
  if (draft.text) await saveCoachNotificationAIText(intent.id, draft.text, model, await factsDigest(facts), at)
}
async function deliver(intent: CoachNotificationIntent, deps: CoachTriggerDeps, at: string) {
  if (intent.destinationIds.includes('in-app')) await acceptCoachNotificationInApp(intent.id, at)
  if (!intent.destinationIds.includes('os') || !deps.notify) return
  const payload = await prepareCoachNotificationDelivery(intent.id, 'os', at)
  if (!payload) return
  try { await recordCoachNotificationDelivery(intent.id, 'os', await deps.notify(payload) ? 'accepted_by_provider' : 'failed', payload.attemptId, at) }
  catch { await recordCoachNotificationDelivery(intent.id, 'os', 'delivery_unknown', payload.attemptId, at) }
}
/** Runs on the app's 60s tick: reserve due fact triggers, then deliver queued trigger intents of today. */
export async function runCoachTriggers(deps: CoachTriggerDeps = {}, at = new Date().toISOString()): Promise<CoachNotificationIntent[]> {
  const settings = await db.settings.get('main'); if (!settings) return []
  const state = coachNotificationStateFor(settings), triggers = coachTriggersOf(state), tasks = await db.tasks.toArray(), timezone = state.policy.timezone
  const requests = [...deadlineNearRequests(tasks, triggers, settings, at, timezone), replanPromptRequest(tasks, triggers, settings, at, timezone)].filter((item): item is NotificationRequest => Boolean(item))
  const reserved: CoachNotificationIntent[] = []
  for (const request of requests) {
    const intent = await reserve((await db.settings.get('main'))!, request, at)
    if (!intent) continue
    await wordIntent(intent, deps, at)
    reserved.push(intent)
  }
  await deliverPendingCoachTriggers(deps, at)
  return reserved
}
/** Delivers still-queued trigger intents reserved today (also those queued by calendar approval). */
export async function deliverPendingCoachTriggers(deps: CoachTriggerDeps = {}, at = new Date().toISOString()): Promise<void> {
  const settings = await db.settings.get('main'); if (!settings) return
  const state = coachNotificationStateFor(settings), day = notificationLocalClock(at, state.policy.timezone).day
  for (const intent of state.intents.filter(item => (isDeadlineIntent(item) || isCalendarIntent(item) || isReplanIntent(item)) && item.reservedDay === day && item.deliveries.some(delivery => delivery.state === 'queued'))) await deliver(intent, deps, at)
}
/** Called after an approved calendar generation committed; failures never undo the approved change. */
export async function queueCalendarChangeNotifications(proposalId: string, moves: CalendarMove[], at = new Date().toISOString()): Promise<CoachNotificationIntent[]> {
  const settings = await db.settings.get('main'); if (!settings || !moves.length) return []
  const reserved: CoachNotificationIntent[] = []
  for (const request of calendarChangeRequests(proposalId, moves, coachTriggersOf(coachNotificationStateFor(settings)), settings, at)) {
    const intent = await reserve((await db.settings.get('main'))!, request, at)
    if (intent) { reserved.push(intent); if (intent.destinationIds.includes('in-app')) await acceptCoachNotificationInApp(intent.id, at) }
  }
  return reserved
}
