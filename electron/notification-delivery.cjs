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
function validateOSNotification(context, payload, now = new Date().toISOString()) {
  try {
    if (!context || !payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['notificationId', 'destinationId', 'attemptId', 'title', 'body', 'provenance'].includes(key)) || payload.destinationId !== 'os' || typeof payload.notificationId !== 'string' || typeof payload.attemptId !== 'string' || !payload.attemptId) return null
    const settings = context.settings, state = settings?.notificationState, policy = state?.policy
    if (!settings?.notifications || !state || state.version !== 1 || state.ownerId !== settings.profileId || state.datasetId !== settings.datasetId || !policy?.enabled || !Number.isInteger(policy.epoch) || !Array.isArray(state.intents)) return null
    const intent = state.intents.find(item => item.id === payload.notificationId), delivery = intent?.deliveries?.find(item => item.destinationId === 'os')
    if (!intent || intent.category !== 'proactive' || !intent.destinationIds?.includes('os') || delivery?.state !== 'sending' || delivery.attemptId !== payload.attemptId || intent.ownerId !== settings.profileId || intent.datasetId !== settings.datasetId || intent.policyEpoch !== policy.epoch || intent.authorityEpoch !== (settings.changePolicy?.epoch ?? 0) || intent.sourcePermissionRevision !== (settings.changePolicy?.sourcePermissionRevision ?? 0)) return null
    if (typeof now !== 'string' || new Date(now).toISOString() !== now || now < intent.notBefore || now >= intent.expiresAt) return null
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(policy.quietStart) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(policy.quietEnd) || !Array.isArray(policy.restDays) || !Array.isArray(policy.mutedTargets)) return null
    const local = clock(now, policy.timezone)
    if (intent.reservedDay !== local.day || policy.mutedTargets?.includes(intent.target.id) || intent.category === 'proactive' && policy.restDays?.includes(local.day) || intent.endDate !== null && intent.endDate !== undefined && local.day > intent.endDate) return null
    if (policy.quietStart !== policy.quietEnd && (policy.quietStart < policy.quietEnd ? local.time >= policy.quietStart && local.time < policy.quietEnd : local.time >= policy.quietStart || local.time < policy.quietEnd)) return null
    const destination = policy.destinations?.find(item => item.id === 'os')
    if (!destination?.approved || destination.channel !== 'os' || destination.shared) return null
    const rule = settings.reminderState?.rules.find(item => item.id === intent.ruleId)
    let factual
    if (intent.target.kind === 'task') {
      const task = context.task
      if (!task || task.id !== intent.target.id || task.revision !== intent.target.revision || task.deletedAt || task.status !== 'open') return null
      if (intent.purpose === 'plan_changed' && intent.ruleId === `snooze:${task.id}`) {
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
    if (typeof factual !== 'string' || !factual || factual.length > 2000 || intent.text?.factual !== factual || payload.provenance !== 'factual-template' || payload.title !== 'michi 通知' || payload.body !== factual) return null
    return { title: 'michi 通知', body: factual }
  } catch { return null }
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
module.exports = { validateOSNotification, createOSNotificationGuard }
