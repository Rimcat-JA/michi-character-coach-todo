import { taskDueTime, type ReminderRule, type Task } from './domain'
import { notificationLocalClock, type CoachNotificationIntent, type CoachTriggerSettings, type NotificationGuard, type NotificationRequest } from './coach-notifications'

/** Fact wording shared with electron/notification-delivery.cjs; src/notification-fact-fixtures.json keeps both sides equal. */
export const deadlineFactual = (title: string, due: string) => `期限が近いタスク: ${title}（期限 ${due}）`
type DueFields = Pick<Task, 'dueDate' | 'dueAt' | 'dueTimezone'>
/** Local clock of a timed deadline in its own zone (null for a date-only deadline). */
export function deadlineClock(task: DueFields): string | null {
  return taskDueTime(task)
}
/** The deadline as the person set it: the date, plus the clock time when dueAt exists; the zone is named only when it differs from the notification zone. */
export function deadlineLabel(task: DueFields, timezone: string): string {
  const time = deadlineClock(task)
  return time ? `${task.dueDate} ${time}${task.dueTimezone !== timezone ? `（${task.dueTimezone}）` : ''}` : task.dueDate!
}
/** A one-time reminder the person set on this task inside the coach's notice window already covers the deadline, so the coach fact notice is not added on top. */
export function deadlineCoveredByReminder(task: Pick<Task, 'id'>, rules: ReminderRule[] | undefined, from: string, end: string): boolean {
  return (rules ?? []).some(rule => rule.kind === 'once' && rule.targetId === task.id && (rule.enabled || rule.sentCount > 0) && rule.nextAt >= from && rule.nextAt <= end)
}
export const calendarFactual = (title: string, from: string | null, to: string | null) => `公式カレンダーの変更で予定日を変更: ${title} ${from ?? '未設定'}→${to ?? '未設定'}`
export const replanFactual = (count: number) => `予定日を過ぎた未完了が${count}件あります`
/** Open, visible tasks whose chosen day already passed. Backburner items are excluded on purpose. */
export function slippedTasks<T extends Pick<Task, 'status' | 'deletedAt' | 'scheduledDate'> & { backburner?: boolean }>(tasks: T[], day: string): T[] {
  return tasks.filter(task => !task.deletedAt && task.status === 'open' && !task.backburner && Boolean(task.scheduledDate) && task.scheduledDate! < day)
}
/** Facts an AI may word; nothing else about the person or other tasks is sent. */
export type NotificationFacts = { purpose: 'deadline_near'; title: string; dueDate: string; scheduledDate: string | null; dueTime?: string }
/** dueTime (HH:mm in the deadline's own zone) is present only for a timed deadline; a date-only deadline keeps the original fact shape and digest. */
export const deadlineFacts = (task: Pick<Task, 'title' | 'dueDate' | 'scheduledDate' | 'dueAt' | 'dueTimezone'>): NotificationFacts => { const time = deadlineClock(task); return { purpose: 'deadline_near', title: task.title, dueDate: task.dueDate!, scheduledDate: task.scheduledDate, ...(time ? { dueTime: time } : {}) } }
export const factsText = (facts: NotificationFacts) => JSON.stringify([facts.purpose, facts.title, facts.dueDate, facts.scheduledDate, ...(facts.dueTime ? [facts.dueTime] : [])])
export async function factsDigest(facts: NotificationFacts): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(factsText(facts)))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
export const deadlineRuleRevision = (task: Pick<Task, 'revision' | 'dueDate'>) => `deadline:${task.revision}:${task.dueDate}`
export const calendarRuleRevision = (revision: number, from: string | null, to: string | null) => `calendar:${revision}:${from ?? '-'}:${to ?? '-'}`
export const isDeadlineIntent = (intent: Pick<NotificationRequest, 'purpose' | 'ruleId' | 'target'>) => intent.purpose === 'deadline_near' && intent.target.kind === 'task' && intent.ruleId === `deadline:${intent.target.id}`
export const isCalendarIntent = (intent: Pick<NotificationRequest, 'purpose' | 'ruleId' | 'target'>) => intent.purpose === 'plan_changed' && intent.target.kind === 'task' && intent.ruleId.startsWith('calendar:') && intent.ruleId.endsWith(`:${intent.target.id}`)
export const isReplanIntent = (intent: Pick<NotificationRequest, 'purpose' | 'ruleId' | 'target'>) => intent.purpose === 'plan_changed' && intent.target.kind === 'system' && intent.target.id.startsWith('replan:') && intent.ruleId === intent.target.id
/** Re-derives target and rule state for the app's own fact triggers from current data (null for other producers). */
export function triggerGuardState(intent: CoachNotificationIntent, task: Task | undefined, tasks: Task[], triggers: CoachTriggerSettings, timezone: string, at: string, reminderRules: ReminderRule[] = []): Pick<NotificationGuard, 'target' | 'rule'> | null {
  const open = Boolean(task && !task.deletedAt && task.status === 'open' && task.id === intent.target.id)
  if (isDeadlineIntent(intent)) {
    // A timed deadline is over at dueAt; a reminder the person set in the same window replaces the coach notice.
    const revision = task ? deadlineRuleRevision(task) : '', active = triggers.deadlineNear.enabled && open && task!.dueDate === intent.ruleWindow && intent.text.factual === deadlineFactual(task!.title, deadlineLabel(task!, timezone)) && (!task!.dueAt || Date.parse(at) < Date.parse(task!.dueAt)) && !deadlineCoveredByReminder(task!, reminderRules, intent.notBefore, intent.expiresAt)
    return { target: { ...intent.target, revision: task?.revision ?? -1, active }, rule: { id: intent.ruleId, revision, active, sentCount: 0 } }
  }
  if (isCalendarIntent(intent)) {
    const [, revision, from, to] = intent.ruleRevision.split(':'), dates = (value: string | undefined) => value === '-' ? null : value ?? ''
    const active = triggers.calendarChange.enabled && open && String(task!.revision) === revision && task!.scheduledDate === dates(to) && intent.text.factual === calendarFactual(task!.title, dates(from), dates(to))
    return { target: { ...intent.target, revision: task?.revision ?? -1, active }, rule: { id: intent.ruleId, revision: task ? calendarRuleRevision(task.revision, dates(from), task.scheduledDate) : '', active, sentCount: 0 } }
  }
  if (isReplanIntent(intent)) {
    const day = notificationLocalClock(at, timezone).day, count = slippedTasks(tasks, day).length
    const active = triggers.replanPrompt.enabled && intent.target.id === `replan:${day}` && intent.ruleWindow === day && count > 0 && intent.text.factual === replanFactual(count)
    return { target: { ...intent.target, active }, rule: { id: intent.ruleId, revision: `replan:${count}`, active, sentCount: 0 } }
  }
  return null
}
