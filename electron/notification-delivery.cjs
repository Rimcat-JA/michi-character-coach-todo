'use strict'

const pending = new Set(['prepared', 'queued', 'sending'])
const counted = new Set([...pending, 'accepted_by_provider', 'delivery_unknown'])
const { activeSmartList } = require('./smart-list-notification.cjs')
function clock(at, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))
  const value = key => parts.find(part => part.type === key).value
  return { day: `${value('year')}-${value('month')}-${value('day')}`, time: `${value('hour')}:${value('minute')}` }
}
const sameTarget = (a, b) => a?.id === b?.id && a?.kind === b?.kind
// N09: the notification stop switch and notification.send=deny are re-checked at the OS boundary.
const notificationsStopped = settings => Boolean(settings?.changePolicy?.stops?.notifications) || Array.isArray(settings?.changePolicy?.operations) && settings.changePolicy.operations.find(rule => rule?.operation === 'notification.send')?.mode !== 'auto_within_bounds'
const { createHash } = require('node:crypto')
// Fact wording mirrors src/coach-facts.ts; src/notification-fact-fixtures.json is checked by both test suites.
const deadlineFactual = (title, due) => `期限が近いタスク: ${title}（期限 ${due}）`
// A timed deadline (dueAt + dueTimezone) is shown at its own clock time; the zone is named only when it differs from the notification zone.
const deadlineTime = task => typeof task.dueAt === 'string' && typeof task.dueTimezone === 'string' && task.dueAt && task.dueTimezone ? clock(task.dueAt, task.dueTimezone).time : null
const deadlineLabel = (task, timezone) => { const time = deadlineTime(task); return time ? `${task.dueDate} ${time}${task.dueTimezone !== timezone ? `（${task.dueTimezone}）` : ''}` : task.dueDate }
// The person's own one-time reminder inside the coach notice window replaces the coach deadline notice (no double notification).
const deadlineCoveredByReminder = (task, rules, from, end) => (Array.isArray(rules) ? rules : []).some(rule => rule && rule.kind === 'once' && rule.targetId === task.id && (rule.enabled || rule.sentCount > 0) && typeof rule.nextAt === 'string' && rule.nextAt >= from && rule.nextAt <= end)
const calendarFactual = (title, from, to) => `公式カレンダーの変更で予定日を変更: ${title} ${from ?? '未設定'}→${to ?? '未設定'}`
const replanFactual = count => `予定日を過ぎた未完了が${count}件あります`
const slippedCount = (tasks, day) => (Array.isArray(tasks) ? tasks : []).filter(task => task && !task.deletedAt && task.status === 'open' && !task.backburner && typeof task.scheduledDate === 'string' && task.scheduledDate && task.scheduledDate < day).length
const factsDigest = task => { const time = deadlineTime(task); return createHash('sha256').update(JSON.stringify(['deadline_near', task.title, task.dueDate, task.scheduledDate ?? null, ...(time ? [time] : [])])).digest('hex') }
const shiftDay = (day, days) => { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10) }
const triggerOff = { deadlineNear: { enabled: false, leadDays: 1 }, calendarChange: { enabled: false }, replanPrompt: { enabled: false }, aiText: false }
const isDeadline = intent => intent.purpose === 'deadline_near' && intent.target?.kind === 'task' && intent.ruleId === `deadline:${intent.target.id}`
const isCalendar = intent => intent.purpose === 'plan_changed' && intent.target?.kind === 'task' && typeof intent.ruleId === 'string' && intent.ruleId.startsWith('calendar:') && intent.ruleId.endsWith(`:${intent.target.id}`)
const isReplan = intent => intent.purpose === 'plan_changed' && intent.target?.kind === 'system' && typeof intent.target.id === 'string' && intent.target.id.startsWith('replan:') && intent.ruleId === intent.target.id
function validateOSNotification(context, payload, now = new Date().toISOString()) {
  try {
    if (!context || !payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['notificationId', 'destinationId', 'attemptId', 'title', 'body', 'provenance'].includes(key)) || payload.destinationId !== 'os' || typeof payload.notificationId !== 'string' || typeof payload.attemptId !== 'string' || !payload.attemptId) return null
    const settings = context.settings, state = settings?.notificationState, policy = state?.policy
    if (!settings?.notifications || notificationsStopped(settings) || !state || state.version !== 1 || state.ownerId !== settings.profileId || state.datasetId !== settings.datasetId || !policy?.enabled || !Number.isInteger(policy.epoch) || !Array.isArray(state.intents)) return null
    const intent = state.intents.find(item => item.id === payload.notificationId), delivery = intent?.deliveries?.find(item => item.destinationId === 'os')
    if (!intent || intent.category !== 'proactive' || !intent.destinationIds?.includes('os') || delivery?.state !== 'sending' || delivery.attemptId !== payload.attemptId || intent.ownerId !== settings.profileId || intent.datasetId !== settings.datasetId || intent.policyEpoch !== policy.epoch || intent.authorityEpoch !== (settings.changePolicy?.epoch ?? 0) || intent.sourcePermissionRevision !== (settings.changePolicy?.sourcePermissionRevision ?? 0)) return null
    if (typeof now !== 'string' || new Date(now).toISOString() !== now || now < intent.notBefore || now >= intent.expiresAt) return null
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(policy.quietStart) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(policy.quietEnd) || !Array.isArray(policy.restDays) || !Array.isArray(policy.mutedTargets)) return null
    const local = clock(now, policy.timezone)
    if (intent.reservedDay !== local.day || policy.mutedTargets?.includes(intent.target.id) || intent.category === 'proactive' && policy.restDays?.includes(local.day) || intent.endDate !== null && intent.endDate !== undefined && local.day > intent.endDate) return null
    if (policy.quietStart !== policy.quietEnd && (policy.quietStart < policy.quietEnd ? local.time >= policy.quietStart && local.time < policy.quietEnd : local.time >= policy.quietStart || local.time < policy.quietEnd)) return null
    const destination = policy.destinations?.find(item => item.id === 'os')
    if (!destination?.approved || destination.channel !== 'os' || destination.shared) return null
    const rule = settings.reminderState?.rules.find(item => item.id === intent.ruleId), triggers = state.triggers ?? triggerOff
    let factual, savedAIFacts = null
    if (intent.target.kind === 'task') {
      const task = context.task
      if (!task || task.id !== intent.target.id || task.revision !== intent.target.revision || task.deletedAt || task.status !== 'open') return null
      if (isDeadline(intent)) {
        // Re-derived from the DB: still open, same revision and real deadline, inside the person's lead window.
        if (!triggers.deadlineNear?.enabled || !Number.isInteger(triggers.deadlineNear.leadDays) || typeof task.dueDate !== 'string' || task.dueDate !== intent.ruleWindow || intent.ruleRevision !== `deadline:${task.revision}:${task.dueDate}` || local.day > task.dueDate || local.day < shiftDay(task.dueDate, -triggers.deadlineNear.leadDays)) return null
        // A timed deadline is over at dueAt; the person's own reminder in the same window is the only notice.
        if (task.dueAt && !(Date.parse(now) < Date.parse(task.dueAt)) || deadlineCoveredByReminder(task, settings.reminderState?.rules, intent.notBefore, intent.expiresAt)) return null
        factual = deadlineFactual(task.title, deadlineLabel(task, policy.timezone)); savedAIFacts = factsDigest(task)
      } else if (isCalendar(intent)) {
        const [, revision, from, to] = String(intent.ruleRevision).split(':'), date = value => value === '-' ? null : value
        if (!triggers.calendarChange?.enabled || String(task.revision) !== revision || (task.scheduledDate ?? null) !== date(to)) return null
        factual = calendarFactual(task.title, date(from), date(to))
      } else if (intent.purpose === 'plan_changed' && intent.ruleId === `snooze:${task.id}`) {
        if (!task.snoozedUntil || task.snoozedUntil !== intent.ruleWindow || task.snoozedUntil > now || intent.ruleRevision !== `snooze:${task.revision}:${task.snoozedUntil}`) return null
        factual = `タスクを再表示: ${task.title}`
      } else {
        if (!validRule(rule, intent)) return null
        if (intent.purpose === 'bug-me' && (intent.intervalMinutes !== rule.intervalMinutes || intent.maxCount !== rule.maxCount || intent.endDate !== rule.endDate || rule.sentCount > rule.maxCount)) return null
        if (intent.purpose === 'review' && (!task.reviewDate || task.reviewDate !== rule.reviewDate || task.reviewDate !== intent.ruleWindow)) return null
        factual = intent.purpose === 'review' ? `見直し: ${task.title}` : task.title
      }
    } else if (intent.target.kind === 'smart-list') {
      if (!context.list || context.list.id !== intent.target.id || context.list.revision !== intent.target.revision || !activeSmartList(context.list, context.tasks, settings.profileId, now) || !validRule(rule, intent)) return null
      factual = context.list.name
    } else if (isReplan(intent)) {
      // Only the count recomputed from current tasks can be shown; any other text is refused.
      const count = slippedCount(context.tasks, local.day)
      if (!triggers.replanPrompt?.enabled || intent.target.id !== `replan:${local.day}` || intent.ruleWindow !== local.day || !count || intent.ruleRevision !== `replan:${count}`) return null
      factual = replanFactual(count)
    } else return null
    for (const ref of intent.sourceRefs ?? []) {
      const source = context.sources?.find(item => item.id === ref.id)
      if (!source || source.ownerId !== settings.profileId || source.deletedAt || !source.permissions?.retain || !source.permissions.notify || source.revision !== ref.revision || source.permissionRevision !== ref.permissionRevision || source.retentionUntil !== null && source.retentionUntil !== undefined && source.retentionUntil <= now) return null
    }
    if (intent.category === 'proactive') {
      const others = state.intents.filter(item => item.id !== intent.id && item.category === 'proactive' && item.deliveries?.some(part => counted.has(part.state)))
      if (!Number.isInteger(policy.dailyCap) || policy.dailyCap < 0 || policy.dailyCap > 50 || others.filter(item => item.reservedDay === local.day).length >= policy.dailyCap) return null
      const interval = intent.intervalMinutes ?? policy.targetIntervalMinutes
      if (!Number.isInteger(interval) || interval < 1 || interval > 1440 || others.some(item => sameTarget(item.target, intent.target) && Date.parse(now) - Date.parse(item.reservedAt) < interval * 60000)) return null
    }
    if (typeof factual !== 'string' || !factual || factual.length > 2000 || intent.text?.factual !== factual || payload.title !== 'michi 通知') return null
    if (payload.provenance === 'saved-ai') {
      // Saved AI wording: AI and AI wording still ON, unchanged facts, same model, exact stored text, never to a shared destination.
      const saved = intent.text.savedAI
      if (!savedAIFacts || !settings.aiEnabled || triggers.aiText !== true || typeof saved !== 'string' || !saved || saved.length > 200 || /[\r\n]/.test(saved) || /https?:|www\./i.test(saved) || intent.text.factsDigest !== savedAIFacts || typeof intent.text.savedAIModel !== 'string' || intent.text.savedAIModel !== settings.aiModel || payload.body !== saved) return null
      return { title: 'michi 通知', body: saved }
    }
    if (payload.provenance !== 'factual-template' || payload.body !== factual) return null
    return { title: 'michi 通知', body: factual }
  } catch { return null }
}
/** Automatic notification wording is sent only while the saved settings still allow it (AI, AI wording, notifications ON, same model, not a rest day). */
function notificationTextAllowed(settings, model, now = new Date().toISOString()) {
  try {
    const state = settings?.notificationState, policy = state?.policy
    if (!settings || settings.aiEnabled !== true || typeof model !== 'string' || settings.aiModel !== model || state?.triggers?.aiText !== true || !policy?.enabled || notificationsStopped(settings)) return false
    return !Array.isArray(policy.restDays) || !policy.restDays.includes(clock(now, policy.timezone).day)
  } catch { return false }
}
function validRule(rule, intent) {
  return Boolean(rule && intent.category === 'proactive' && intent.purpose === (rule.kind === 'once' ? 'reminder' : rule.kind) && ['once', 'review', 'bug-me', 'smart-daily'].includes(rule.kind) && rule.targetId === intent.target.id && rule.updatedAt === intent.ruleRevision && (rule.enabled || (rule.kind === 'once' || rule.kind === 'bug-me') && rule.updatedAt === intent.reservedAt && rule.sentCount >= rule.maxCount))
}
/** Recheck from the current DB view before every call; each accepted attempt is consumed once. */
function createOSNotificationGuard() {
  const consumed = new Set()
  return (context, payload, now) => {
    const key = JSON.stringify([context?.settings?.datasetId, payload?.notificationId, payload?.destinationId, payload?.attemptId])
    if (consumed.has(key)) return null
    const result = validateOSNotification(context, payload, now)
    if (result) consumed.add(key)
    return result
  }
}
module.exports = { validateOSNotification, createOSNotificationGuard, notificationTextAllowed }
