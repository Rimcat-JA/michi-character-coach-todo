import { db } from './db'
import { addDays, today, uid, type ReminderEvent, type ReminderRule, type ReminderState, type Settings } from './domain'
import { querySmartList } from './smart-lists'

export const defaultReminderState = (): ReminderState => ({ quietStart: '22:00', quietEnd: '08:00', dailyCap: 6, rules: [], events: [] })

function state(settings: Settings) { return settings.reminderState ?? defaultReminderState() }
function localTime(date: Date) { return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` }
function atLocal(date: string, time: string) { return new Date(`${date}T${time}:00`).toISOString() }
function withinQuietHours(time: string, start: string, end: string) {
  if (start === end) return false
  return start < end ? time >= start && time < end : time >= start || time < end
}
function nextDaily(now: Date, time: string) { return atLocal(addDays(today(now), 1), time) }
function assertTime(time: string) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('時刻を確認してください') }

export async function setReminderPolicy(patch: Partial<Pick<ReminderState, 'quietStart' | 'quietEnd' | 'dailyCap'>>) {
  if (patch.quietStart !== undefined) assertTime(patch.quietStart)
  if (patch.quietEnd !== undefined) assertTime(patch.quietEnd)
  if (patch.dailyCap !== undefined && (!Number.isInteger(patch.dailyCap) || patch.dailyCap < 0 || patch.dailyCap > 50)) throw new Error('通知の1日上限は0〜50件で指定してください')
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main'); if (!settings) throw new Error('設定がありません')
    await db.settings.update('main', { reminderState: { ...state(settings), ...patch } })
  })
}

export async function createReminder(kind: ReminderRule['kind'], targetId: string, schedule: string, channels: ReminderRule['channels'] = ['in-app'], now = new Date()) {
  if (!['once', 'smart-daily', 'bug-me'].includes(kind) || !targetId) throw new Error('通知の対象が不正です')
  if (!Array.isArray(channels) || !channels.length || new Set(channels).size !== channels.length || channels.some(channel => !['in-app', 'os'].includes(channel))) throw new Error('通知先が不正です')
  let nextAt: string, timeOfDay: string | null = null
  if (kind === 'smart-daily') {
    assertTime(schedule); timeOfDay = schedule
    nextAt = atLocal(today(now), schedule)
    if (nextAt <= now.toISOString()) nextAt = nextDaily(now, schedule)
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
    if (kind === 'smart-daily') {
      const list = await db.smartLists.get(targetId)
      if (!list || list.ownerId !== settings.profileId) throw new Error('Smart Listがありません')
    } else {
      const task = await db.tasks.get(targetId)
      if (!task || task.deletedAt || task.status !== 'open') throw new Error('未完了タスクを選んでください')
    }
    const current = state(settings)
    if (current.rules.length >= 500) throw new Error('通知予約は500件までです')
    const rule: ReminderRule = { id: uid(), kind, targetId, nextAt, timeOfDay, intervalMinutes: kind === 'bug-me' ? 30 : 0, maxCount: kind === 'bug-me' ? 3 : kind === 'once' ? 1 : 0, sentCount: 0, endDate: kind === 'bug-me' ? today(now) : null, channels, enabled: true, createdAt: at, updatedAt: at }
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
    await db.settings.update('main', { reminderState: { ...current, rules: current.rules.map(rule => rule.id === id ? { ...rule, enabled: false, updatedAt: at } : rule) } })
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
    const events = [...current.events], emitted: ReminderEvent[] = []
    const rules = current.rules.map(rule => ({ ...rule }))
    for (const rule of rules) {
      if (!rule.enabled || rule.nextAt > stamp) continue
      const task = rule.kind === 'smart-daily' ? null : tasks.find(item => item.id === rule.targetId)
      const list = rule.kind === 'smart-daily' ? lists.find(item => item.id === rule.targetId && item.ownerId === settings.profileId) : null
      if (rule.kind === 'smart-daily' ? !list : !task || task.deletedAt || task.status !== 'open') { rule.enabled = false; rule.updatedAt = stamp; continue }
      if (rule.endDate && day > rule.endDate) { rule.enabled = false; rule.updatedAt = stamp; continue }
      if (rule.kind === 'smart-daily' && list && !querySmartList(list, tasks, settings.profileId).some(item => item.status === 'open')) { rule.nextAt = nextDaily(now, rule.timeOfDay!); rule.updatedAt = stamp; continue }
      if (withinQuietHours(localTime(now), current.quietStart, current.quietEnd)) continue
      if (events.filter(event => today(new Date(event.at)) === day).length >= current.dailyCap) continue
      const lastForTarget = [...events].reverse().find(event => event.targetId === rule.targetId)
      if (lastForTarget && now.getTime() - Date.parse(lastForTarget.at) < (rule.kind === 'bug-me' ? rule.intervalMinutes : 60) * 60000) continue
      const title = task?.title ?? list?.name ?? ''
      const channels = rule.channels.filter(channel => channel === 'in-app' || settings.notifications)
      if (!channels.length) continue
      const event: ReminderEvent = { id: uid(), ruleId: rule.id, targetId: rule.targetId, kind: rule.kind, title, at: stamp, channels, readAt: null }
      events.push(event); emitted.push(event); rule.sentCount++; rule.updatedAt = stamp
      if (rule.kind === 'smart-daily') rule.nextAt = nextDaily(now, rule.timeOfDay!)
      else if (rule.sentCount >= rule.maxCount) rule.enabled = false
      else rule.nextAt = new Date(now.getTime() + rule.intervalMinutes * 60000).toISOString()
    }
    if (emitted.length || rules.some((rule, index) => rule.updatedAt !== current.rules[index].updatedAt)) await db.settings.update('main', { reminderState: { ...current, rules, events: events.slice(-1000) } })
    return emitted
  })
}

export async function pendingOSReminder(event: ReminderEvent, now = new Date()): Promise<{ title: string; body: string } | null> {
  if (!event.channels.includes('os')) return null
  const settings = await db.settings.get('main')
  if (!settings?.notifications) return null
  const current = state(settings), rule = current.rules.find(item => item.id === event.ruleId)
  if (!rule || rule.updatedAt !== event.at || !current.events.some(item => item.id === event.id) || withinQuietHours(localTime(now), current.quietStart, current.quietEnd)) return null
  if (current.events.filter(item => today(new Date(item.at)) === today(now)).length > current.dailyCap) return null
  if (event.kind === 'smart-daily') {
    const list = await db.smartLists.get(event.targetId)
    if (!list || list.ownerId !== settings.profileId || !querySmartList(list, await db.tasks.toArray(), settings.profileId).some(item => item.status === 'open')) return null
    return { title: 'michi リマインダー', body: list.name }
  }
  const task = await db.tasks.get(event.targetId)
  return task && !task.deletedAt && task.status === 'open' ? { title: 'michi リマインダー', body: task.title } : null
}
