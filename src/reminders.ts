import { db } from './db'
import { addDays, today, uid, validateDate, type ReminderEvent, type ReminderRule, type ReminderState, type Settings } from './domain'
import { querySmartList } from './smart-lists'
import { coachNotificationGuardFor, coachNotificationStateFor, prepareCoachNotificationDelivery, setCoachNotificationPolicy } from './coach-notification-save'
import { cancelPendingCoachNotifications, notificationDedupeKey, notificationLocalClock, reserveCoachNotification, settleCoachNotificationDelivery, type CoachNotificationState, type NotificationRequest } from './coach-notifications'

export const defaultReminderState = (): ReminderState => ({ quietStart: '22:00', quietEnd: '08:00', dailyCap: 6, rules: [], events: [] })

function state(settings: Settings) { return settings.reminderState ?? defaultReminderState() }
function atLocal(date: string, time: string) { return new Date(`${date}T${time}:00`).toISOString() }
function nextDaily(now: Date, time: string) { return atLocal(addDays(today(now), 1), time) }
function assertTime(time: string) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('時刻を確認してください') }

export async function setReminderPolicy(patch: Partial<Pick<ReminderState, 'quietStart' | 'quietEnd' | 'dailyCap'>>) {
  if (patch.quietStart !== undefined) assertTime(patch.quietStart)
  if (patch.quietEnd !== undefined) assertTime(patch.quietEnd)
  if (patch.dailyCap !== undefined && (!Number.isInteger(patch.dailyCap) || patch.dailyCap < 0 || patch.dailyCap > 50)) throw new Error('通知の1日上限は0〜50件で指定してください')
  await setCoachNotificationPolicy(patch)
}

export async function createReminder(kind: ReminderRule['kind'], targetId: string, schedule: string, channels: ReminderRule['channels'] = ['in-app'], now = new Date()) {
  if (!['once', 'smart-daily', 'bug-me', 'review'].includes(kind) || !targetId) throw new Error('通知の対象が不正です')
  if (!Array.isArray(channels) || !channels.length || new Set(channels).size !== channels.length || channels.some(channel => !['in-app', 'os'].includes(channel))) throw new Error('通知先が不正です')
  let nextAt: string, timeOfDay: string | null = null
  if (kind === 'smart-daily' || kind === 'review') {
    assertTime(schedule); timeOfDay = schedule
    nextAt = atLocal(today(now), schedule)
    if (kind === 'smart-daily' && nextAt <= now.toISOString()) nextAt = nextDaily(now, schedule)
  } else if (kind === 'bug-me') {
    nextAt = new Date(now.getTime() + 30 * 60000).toISOString()
  } else {
    const parsed = new Date(schedule)
    if (Number.isNaN(parsed.getTime()) || parsed <= now) throw new Error('通知時刻は未来を指定してください')
    nextAt = parsed.toISOString()
  }
  const at = now.toISOString()
  return db.transaction('rw', db.settings, db.tasks, db.smartLists, async () => {
    const settings = await db.settings.get('main'); if (!settings) throw new Error('設定がありません')
    let reviewDate: string | null = null
    if (kind === 'smart-daily') {
      const list = await db.smartLists.get(targetId)
      if (!list || list.ownerId !== settings.profileId) throw new Error('Smart Listがありません')
    } else {
      const task = await db.tasks.get(targetId)
      if (!task || task.deletedAt || task.status !== 'open') throw new Error('未完了タスクを選んでください')
      if (kind === 'review') {
        if (!task.reviewDate) throw new Error('タスクに見直し日を設定してください')
        validateDate(task.reviewDate, '見直し日')
        reviewDate = task.reviewDate
        nextAt = atLocal(reviewDate, timeOfDay!)
      }
    }
    const current = state(settings)
    if (kind === 'review' && current.rules.some(rule => rule.kind === 'review' && rule.targetId === targetId && rule.enabled)) throw new Error('このタスクの見直し通知は予約済みです')
    if (current.rules.length >= 500) throw new Error('通知予約は500件までです')
    const rule: ReminderRule = { id: uid(), kind, targetId, nextAt, timeOfDay, ...(kind === 'review' ? { reviewDate } : {}), intervalMinutes: kind === 'bug-me' ? 30 : 0, maxCount: kind === 'bug-me' ? 3 : kind === 'once' || kind === 'review' ? 1 : 0, sentCount: 0, endDate: kind === 'bug-me' ? today(now) : null, channels, enabled: true, createdAt: at, updatedAt: at }
    await db.settings.update('main', { reminderState: { ...current, rules: [...current.rules, rule] } })
    return rule
  })
}

export async function stopReminder(id: string) {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main'); if (!settings) throw new Error('設定がありません')
    const current = state(settings)
    if (!current.rules.some(rule => rule.id === id)) throw new Error('通知予約がありません')
    const at = new Date().toISOString()
    await db.settings.update('main', { reminderState: { ...current, rules: current.rules.map(rule => rule.id === id ? { ...rule, enabled: false, updatedAt: at } : rule) }, notificationState: cancelPendingCoachNotifications(coachNotificationStateFor(settings), '予約を停止しました', at, intent => intent.ruleId === id) })
  })
}

export async function markReminderRead(id: string) {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main'); if (!settings) throw new Error('設定がありません')
    const current = state(settings)
    await db.settings.update('main', { reminderState: { ...current, events: current.events.map(event => event.id === id ? { ...event, readAt: new Date().toISOString() } : event) } })
  })
}

export async function dispatchDueReminders(now = new Date()): Promise<ReminderEvent[]> {
  const stamp = now.toISOString(), day = today(now)
  return db.transaction('rw', db.settings, db.tasks, db.smartLists, async () => {
    const settings = await db.settings.get('main'); if (!settings) return []
    const current = state(settings), tasks = await db.tasks.toArray(), lists = await db.smartLists.toArray()
    let notifications = coachNotificationStateFor(settings)
    // Existing accepted events participate in the shared cap after upgrading.
    for (const event of current.events) {
      if (notifications.intents.some(intent => intent.id === event.id)) continue
      const rule = current.rules.find(item => item.id === event.ruleId)
      if (!rule) continue
      const request: NotificationRequest = { id: event.id, purpose: event.kind === 'once' ? 'reminder' : event.kind, category: 'proactive', target: { kind: event.kind === 'smart-daily' ? 'smart-list' : 'task', id: event.targetId, revision: event.reviewRevision ?? (event.kind === 'smart-daily' ? lists.find(item => item.id === event.targetId)?.revision : tasks.find(item => item.id === event.targetId)?.revision) ?? 0 }, ruleId: event.ruleId, ruleRevision: event.at, ruleWindow: event.kind === 'review' ? event.reviewDate ?? event.at : event.at, notBefore: event.at, expiresAt: new Date(Date.parse(event.at) + 86400000).toISOString(), destinationIds: [...event.channels], sourceRefs: [], text: { factual: event.kind === 'review' ? `見直し: ${event.title}` : event.title, savedAI: null }, intervalMinutes: event.kind === 'bug-me' ? rule.intervalMinutes : null, maxCount: event.kind === 'bug-me' ? rule.maxCount : null, endDate: event.kind === 'bug-me' ? rule.endDate : null }
      notifications.intents.push({ ...request, ownerId: settings.profileId, datasetId: settings.datasetId, policyEpoch: notifications.policy.epoch, authorityEpoch: coachNotificationGuardFor(settings, { ...request.target, active: true }, { id: rule.id, revision: event.at, active: true, sentCount: rule.sentCount }).authorityEpoch, sourcePermissionRevision: settings.changePolicy?.sourcePermissionRevision ?? 0, dedupeKey: notificationDedupeKey(settings.profileId, request), reservedAt: event.at, reservedDay: notificationLocalClock(event.at, notifications.policy.timezone).day, deliveries: event.channels.map(destinationId => ({ destinationId, state: destinationId === 'in-app' ? 'accepted_by_provider' : 'canceled', attemptId: `legacy:${event.id}`, at: event.at })), reason: '以前の通知履歴' })
    }
    const previousNotificationCount = settings.notificationState?.intents.length ?? 0
    const events = [...current.events], emitted: ReminderEvent[] = []
    const rules = current.rules.map(rule => ({ ...rule }))
    for (const rule of rules) {
      if (!rule.enabled) continue
      const task = rule.kind === 'smart-daily' ? null : tasks.find(item => item.id === rule.targetId)
      const list = rule.kind === 'smart-daily' ? lists.find(item => item.id === rule.targetId && item.ownerId === settings.profileId) : null
      if (rule.kind === 'review') {
        if (!task || task.deletedAt || task.status !== 'open') { rule.enabled = false; rule.updatedAt = stamp; continue }
        if (rule.reviewDate !== task.reviewDate) {
          rule.reviewDate = task.reviewDate; rule.sentCount = 0; rule.updatedAt = stamp
        }
        if (task.reviewDate) {
          const nextAt = atLocal(task.reviewDate, rule.timeOfDay!)
          if (rule.nextAt !== nextAt) { rule.nextAt = nextAt; rule.updatedAt = stamp }
        }
        if (!rule.reviewDate || rule.sentCount >= rule.maxCount) continue
      }
      if (rule.nextAt > stamp) continue
      if (rule.kind === 'smart-daily' ? !list : !task || task.deletedAt || task.status !== 'open') { rule.enabled = false; rule.updatedAt = stamp; notifications = cancelPendingCoachNotifications(notifications, '対象が完了・削除されました', stamp, intent => intent.ruleId === rule.id); continue }
      if (rule.endDate && day > rule.endDate) { rule.enabled = false; rule.updatedAt = stamp; continue }
      if (rule.kind === 'smart-daily' && list && !querySmartList(list, tasks, settings.profileId).some(item => item.status === 'open')) { rule.nextAt = nextDaily(now, rule.timeOfDay!); rule.updatedAt = stamp; continue }
      const title = task?.title ?? list?.name ?? ''
      const channels = rule.channels.filter(channel => channel === 'in-app' || settings.notifications)
      if (!channels.length) continue
      const event: ReminderEvent = { id: uid(), ruleId: rule.id, targetId: rule.targetId, kind: rule.kind, title, ...(rule.kind === 'review' && task ? { reviewDate: task.reviewDate!, reviewRevision: task.revision } : {}), at: stamp, channels, readAt: null }
      const request: NotificationRequest = { id: event.id, purpose: rule.kind === 'once' ? 'reminder' : rule.kind, category: 'proactive', target: { kind: list ? 'smart-list' : 'task', id: rule.targetId, revision: task?.revision ?? list!.revision }, ruleId: rule.id, ruleRevision: stamp, ruleWindow: rule.kind === 'review' ? rule.reviewDate! : rule.nextAt, notBefore: stamp, expiresAt: new Date(now.getTime() + 86400000).toISOString(), destinationIds: channels, sourceRefs: [], text: { factual: rule.kind === 'review' ? `見直し: ${title}` : title, savedAI: null }, intervalMinutes: rule.kind === 'bug-me' ? rule.intervalMinutes : null, maxCount: rule.kind === 'bug-me' ? rule.maxCount : null, endDate: rule.endDate }
      const reservation = reserveCoachNotification(notifications, request, coachNotificationGuardFor(settings, { ...request.target, active: true }, { id: rule.id, revision: stamp, active: true, sentCount: rule.sentCount }), stamp)
      if (!reservation.intent) continue
      notifications = reservation.state
      if (channels.includes('in-app')) notifications = acceptInApp(notifications, event.id, stamp)
      events.push(event); emitted.push(event); rule.sentCount++; rule.updatedAt = stamp
      if (rule.kind === 'smart-daily') rule.nextAt = nextDaily(now, rule.timeOfDay!)
      else if (rule.kind === 'review') continue
      else if (rule.sentCount >= rule.maxCount) rule.enabled = false
      else rule.nextAt = new Date(now.getTime() + rule.intervalMinutes * 60000).toISOString()
    }
    if (emitted.length || notifications.intents.length !== previousNotificationCount || rules.some((rule, index) => rule.updatedAt !== current.rules[index].updatedAt || rule.reviewDate !== current.rules[index].reviewDate || rule.nextAt !== current.rules[index].nextAt || rule.enabled !== current.rules[index].enabled || rule.sentCount !== current.rules[index].sentCount)) await db.settings.update('main', { reminderState: { ...current, rules, events: events.slice(-1000) }, notificationState: notifications })
    return emitted
  })
}

export async function pendingOSReminder(event: ReminderEvent, now = new Date()) {
  if (!event.channels.includes('os')) return null
  const settings = await db.settings.get('main')
  if (!settings?.notifications) return null
  const current = state(settings), rule = current.rules.find(item => item.id === event.ruleId)
  if (!rule || rule.updatedAt !== event.at || !current.events.some(item => item.id === event.id)) return null
  if (event.kind === 'smart-daily') {
    const list = await db.smartLists.get(event.targetId)
    if (!list || list.ownerId !== settings.profileId || !querySmartList(list, await db.tasks.toArray(), settings.profileId).some(item => item.status === 'open')) return null
    const payload = await prepareCoachNotificationDelivery(event.id, 'os', now.toISOString())
    return payload
  }
  const task = await db.tasks.get(event.targetId)
  if (event.kind === 'review') {
    if (!rule.enabled || rule.kind !== 'review' || rule.targetId !== event.targetId || !task || task.deletedAt || task.status !== 'open' || task.reviewDate !== event.reviewDate || rule.reviewDate !== event.reviewDate || task.revision !== event.reviewRevision) return null
    const payload = await prepareCoachNotificationDelivery(event.id, 'os', now.toISOString())
    return payload
  }
  if (!task || task.deletedAt || task.status !== 'open') return null
  const payload = await prepareCoachNotificationDelivery(event.id, 'os', now.toISOString())
  return payload
}

function acceptInApp(state: CoachNotificationState, id: string, at: string): CoachNotificationState {
  const intent = state.intents.find(item => item.id === id)!, attemptId = `in-app:${id}`
  const sending: CoachNotificationState = { ...state, intents: state.intents.map(item => item.id === id ? { ...intent, deliveries: item.deliveries.map(delivery => delivery.destinationId === 'in-app' ? { ...delivery, state: 'sending', attemptId, at } : delivery) } : item) }
  return settleCoachNotificationDelivery(sending, id, 'in-app', attemptId, 'accepted_by_provider', at)
}
