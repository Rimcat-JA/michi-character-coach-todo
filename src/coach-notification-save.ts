import Dexie from 'dexie'
import { db } from './db'
import { changePolicyFor, type ChangePolicy } from './change-set'
import { operationMode } from './automation-policy'
import { uid, type ReminderRule, type Settings } from './domain'
import { querySmartList } from './smart-lists'
import { acceptInAppDelivery, beginCoachNotificationDelivery, cancelPendingCoachNotifications, changeCoachNotificationPolicy, coachTriggersOf, emptyCoachNotificationState, markCoachNotificationRead, notificationLocalClock, reserveCoachNotification, revalidateCoachNotification, settleCoachNotificationDelivery, validateCoachNotificationState, validateCoachTriggers, type CoachNotificationIntent, type CoachNotificationPolicy, type CoachNotificationState, type CoachTriggerSettings, type NotificationGuard, type NotificationRequest } from './coach-notifications'
import { deadlineFacts, factsDigest, isCalendarIntent, isDeadlineIntent, isReplanIntent, triggerGuardState } from './coach-facts'

export function coachNotificationStateFor(settings: Settings): CoachNotificationState {
  if (settings.notificationState) { validateCoachNotificationState(settings.notificationState, settings.profileId, settings.datasetId); return structuredClone(settings.notificationState) }
  const value = emptyCoachNotificationState(settings.profileId, settings.datasetId)
  if (settings.reminderState) { value.policy.quietStart = settings.reminderState.quietStart; value.policy.quietEnd = settings.reminderState.quietEnd; value.policy.dailyCap = settings.reminderState.dailyCap }
  return value
}
export function notificationStopReason(policy: ChangePolicy): string | null {
  return policy.stops?.notifications ? '通知を停止しています（自動化の停止スイッチ）' : operationMode(policy, 'notification.send') === 'deny' ? '通知の送信は停止しています（自動化設定）' : null
}
export function coachNotificationGuardFor(settings: Settings, target: NotificationGuard['target'], rule: NotificationGuard['rule'], sources: NotificationGuard['sources'] = []): NotificationGuard {
  const policy = changePolicyFor(settings)
  // Only registered local channels have delivery adapters in this build.
  return { ownerId: settings.profileId, datasetId: settings.datasetId, authorityEpoch: policy.epoch, sourcePermissionRevision: policy.sourcePermissionRevision, aiEnabled: settings.aiEnabled, target, rule, sources, availableDestinationIds: ['in-app', ...(settings.notifications ? ['os'] : [])], stopped: notificationStopReason(policy), aiModel: settings.aiModel ?? null }
}
export async function setCoachNotificationPolicy(patch: Partial<Omit<CoachNotificationPolicy, 'epoch'>>, at = new Date().toISOString()): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main'); if (!settings) throw new Error('本人の設定がありません')
    const current = coachNotificationStateFor(settings), { epoch: _epoch, ...previous } = current.policy
    const next = changeCoachNotificationPolicy(current, { ...previous, ...structuredClone(patch) }, at)
    // Legacy controls and the common evaluator show the same limits.
    await db.settings.put({ ...settings, notificationState: next, reminderState: { ...(settings.reminderState ?? { rules: [], events: [] }), quietStart: next.policy.quietStart, quietEnd: next.policy.quietEnd, dailyCap: next.policy.dailyCap } })
  })
}
export async function restCoachNotificationsToday(at = new Date().toISOString()): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main'); if (!settings) throw new Error('本人の設定がありません')
    const state = coachNotificationStateFor(settings), day = notificationLocalClock(at, state.policy.timezone).day
    const { epoch: _epoch, ...policy } = state.policy
    const restDays = [...new Set([...policy.restDays.filter(value => value >= day), day])]
    await db.settings.put({ ...settings, notificationState: changeCoachNotificationPolicy(state, { ...policy, restDays }, at) })
  })
}
export async function muteCoachNotificationTarget(targetId: string, muted = true, at = new Date().toISOString()): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main'); if (!settings) throw new Error('本人の設定がありません')
    const state = coachNotificationStateFor(settings), { epoch: _epoch, ...policy } = state.policy
    const mutedTargets = [...new Set([...policy.mutedTargets.filter(value => value !== targetId), ...(muted ? [targetId] : [])])]
    await db.settings.put({ ...settings, notificationState: changeCoachNotificationPolicy(state, { ...policy, mutedTargets }, at) })
  })
}
function activeReminderRule(rule: ReminderRule | undefined, intent: CoachNotificationIntent) {
  return Boolean(rule && rule.targetId === intent.target.id && rule.updatedAt === intent.ruleRevision && (rule.enabled || (rule.kind === 'once' || rule.kind === 'bug-me') && rule.updatedAt === intent.reservedAt && rule.sentCount >= rule.maxCount))
}
async function currentGuard(settings: Settings, intent: CoachNotificationIntent, at: string): Promise<NotificationGuard> {
  const rule = settings.reminderState?.rules.find(item => item.id === intent.ruleId)
  let ruleState = { id: rule?.id ?? intent.ruleId, revision: rule?.updatedAt ?? '', active: activeReminderRule(rule, intent), sentCount: rule?.sentCount ?? 0 }
  let target: NotificationGuard['target'] = { ...intent.target, active: false }
  if (intent.target.kind === 'task') {
    const task = await db.tasks.get(intent.target.id)
    target = { ...intent.target, revision: task?.revision ?? -1, active: Boolean(task && !task.deletedAt && task.status === 'open') }
    if (intent.purpose === 'review') target.active = target.active && Boolean(task?.reviewDate && rule?.reviewDate === task.reviewDate && intent.ruleWindow === task.reviewDate)
    if (intent.purpose === 'plan_changed' && intent.ruleId === `snooze:${intent.target.id}`) ruleState = { id: intent.ruleId, revision: `snooze:${task?.revision}:${task?.snoozedUntil}`, active: target.active && Boolean(task?.snoozedUntil && task.snoozedUntil === intent.ruleWindow && task.snoozedUntil <= at), sentCount: 0 }
  } else if (intent.target.kind === 'smart-list') {
    const list = await db.smartLists.get(intent.target.id)
    target = { ...intent.target, revision: list?.revision ?? -1, active: Boolean(list && list.ownerId === settings.profileId && querySmartList(list, await db.tasks.toArray(), settings.profileId).some(task => task.status === 'open')) }
  }
  let facts: string | null = null
  if (isDeadlineIntent(intent) || isCalendarIntent(intent) || isReplanIntent(intent)) {
    const state = coachNotificationStateFor(settings), task = intent.target.kind === 'task' ? await db.tasks.get(intent.target.id) : undefined
    const derived = triggerGuardState(intent, task, isReplanIntent(intent) ? await db.tasks.toArray() : [], coachTriggersOf(state), state.policy.timezone, at, settings.reminderState?.rules)!
    target = derived.target; ruleState = derived.rule
    if (task?.dueDate && isDeadlineIntent(intent)) facts = await Dexie.waitFor(factsDigest(deadlineFacts(task)))
  }
  const sources: NotificationGuard['sources'] = []
  for (const ref of intent.sourceRefs) {
    const source = await db.contextSources.get(ref.id)
    if (source) sources.push({ id: source.id, revision: source.revision, permissionRevision: source.permissionRevision, active: source.ownerId === settings.profileId && !source.deletedAt && source.permissions.retain && (source.retentionUntil === null || source.retentionUntil > at), notify: source.permissions.notify, disclose: source.permissions.disclose })
  }
  return { ...coachNotificationGuardFor(settings, target, ruleState, sources), factsDigest: facts }
}
/** The snooze selected by the person supplies the factual trigger and stable window. */
export async function queueSnoozeNotification(taskId: string, at = new Date().toISOString()): Promise<CoachNotificationIntent | null> {
  return db.transaction('rw', db.settings, db.tasks, async () => {
    const settings = await db.settings.get('main'), task = await db.tasks.get(taskId)
    if (!settings || !settings.notifications || !task || task.deletedAt || task.status !== 'open' || !task.snoozedUntil || task.snoozedUntil > at) return null
    const request: NotificationRequest = { id: `snooze:${task.id}:${task.snoozedUntil}`, purpose: 'plan_changed', category: 'proactive', target: { kind: 'task', id: task.id, revision: task.revision }, ruleId: `snooze:${task.id}`, ruleRevision: `snooze:${task.revision}:${task.snoozedUntil}`, ruleWindow: task.snoozedUntil, notBefore: task.snoozedUntil, expiresAt: new Date(Date.parse(task.snoozedUntil) + 86400000).toISOString(), destinationIds: ['os'], sourceRefs: [], text: { factual: `タスクを再表示: ${task.title}`, savedAI: null }, intervalMinutes: null, maxCount: null, endDate: null }
    const guard = coachNotificationGuardFor(settings, { ...request.target, active: true }, { id: request.ruleId, revision: request.ruleRevision, active: true, sentCount: 0 })
    const result = reserveCoachNotification(coachNotificationStateFor(settings), request, guard, at)
    if (result.intent) await db.settings.put({ ...settings, notificationState: result.state })
    return result.intent
  })
}
/** Used by registered, factual trigger adapters. Arbitrary model output is never a trigger. */
export async function queueCoachNotification(request: NotificationRequest, guard: NotificationGuard, at = new Date().toISOString()): Promise<CoachNotificationIntent | null> {
  return db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main'); if (!settings) throw new Error('本人の設定がありません')
    const policy = changePolicyFor(settings)
    if (guard.ownerId !== settings.profileId || guard.datasetId !== settings.datasetId || guard.authorityEpoch !== policy.epoch || guard.sourcePermissionRevision !== policy.sourcePermissionRevision) throw new Error('通知の本人・許可が変わりました')
    const result = reserveCoachNotification(coachNotificationStateFor(settings), request, { ...guard, stopped: notificationStopReason(policy) }, at)
    if (result.intent) await db.settings.put({ ...settings, notificationState: result.state })
    return result.intent
  })
}
export async function prepareCoachNotificationDelivery(intentId: string, destinationId: string, at = new Date().toISOString()) {
  return db.transaction('rw', db.settings, db.tasks, db.smartLists, db.contextSources, async () => {
    const settings = await db.settings.get('main'); if (!settings) return null
    const state = coachNotificationStateFor(settings), intent = state.intents.find(item => item.id === intentId); if (!intent) return null
    const result = beginCoachNotificationDelivery(state, intentId, destinationId, uid(), await currentGuard(settings, intent, at), at)
    if (result.state !== state) await db.settings.put({ ...settings, notificationState: result.state })
    return result.payload
  })
}
export async function recordCoachNotificationDelivery(intentId: string, destinationId: string, result: 'accepted_by_provider' | 'delivery_unknown' | 'failed', attemptId: string, at = new Date().toISOString()): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main'); if (!settings) return
    const state = coachNotificationStateFor(settings), delivery = state.intents.find(item => item.id === intentId)?.deliveries.find(item => item.destinationId === destinationId)
    if (!delivery?.attemptId || delivery.attemptId !== attemptId) return
    await db.settings.put({ ...settings, notificationState: settleCoachNotificationDelivery(state, intentId, destinationId, attemptId, result, at) })
  })
}
export async function cancelCoachNotificationRule(ruleId: string, at = new Date().toISOString()): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main'); if (!settings) return
    await db.settings.put({ ...settings, notificationState: cancelPendingCoachNotifications(coachNotificationStateFor(settings), '予約を停止しました', at, intent => intent.ruleId === ruleId) })
  })
}
/** Completion/revocation hooks can cancel without waiting for the next send attempt. */
export async function cancelCoachNotificationTarget(targetId: string, at = new Date().toISOString()): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main'); if (!settings) return
    await db.settings.put({ ...settings, notificationState: cancelPendingCoachNotifications(coachNotificationStateFor(settings), '対象が完了・取消・変更されました', at, intent => intent.target.id === targetId || intent.sourceRefs.some(ref => ref.id === targetId)) })
  })
}
/** Source purge removes derived notification text, including previously accepted records. */
export async function purgeCoachNotificationSource(sourceId: string, at = new Date().toISOString()): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main'); if (!settings) return
    const matches = (intent: CoachNotificationIntent) => intent.target.kind === 'source' && intent.target.id === sourceId || intent.sourceRefs.some(ref => ref.id === sourceId)
    const state = cancelPendingCoachNotifications(coachNotificationStateFor(settings), '資料の削除・権限変更で取り消しました', at, matches)
    await db.settings.put({ ...settings, notificationState: { ...state, intents: state.intents.map(intent => matches(intent) ? { ...intent, text: { factual: '削除・権限変更した資料の通知', savedAI: null } } : intent) } })
  })
}
/** Turning a trigger OFF cancels its pending reservations; other producers are untouched. */
export async function setCoachNotificationTriggers(patch: Partial<CoachTriggerSettings>, at = new Date().toISOString()): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main'); if (!settings) throw new Error('本人の設定がありません')
    const state = coachNotificationStateFor(settings), previous = coachTriggersOf(state), next = { ...previous, ...structuredClone(patch) }
    validateCoachTriggers(next)
    const changed = (key: 'deadlineNear' | 'calendarChange' | 'replanPrompt') => JSON.stringify(previous[key]) !== JSON.stringify(next[key])
    let updated = cancelPendingCoachNotifications(state, '通知のきっかけ設定が変わりました', at, intent => changed('deadlineNear') && isDeadlineIntent(intent) || changed('calendarChange') && isCalendarIntent(intent) || changed('replanPrompt') && isReplanIntent(intent))
    // Saved AI wording is dropped only where no delivery can have shown it; shown wording stays as the record of what was sent.
    const shown = (intent: CoachNotificationIntent) => intent.deliveries.some(delivery => ['sending', 'accepted_by_provider', 'delivery_unknown'].includes(delivery.state))
    if (previous.aiText && !next.aiText) updated = { ...updated, intents: updated.intents.map(intent => intent.text.savedAI === null || shown(intent) ? intent : { ...intent, text: { factual: intent.text.factual, savedAI: null } }) }
    await db.settings.put({ ...settings, notificationState: { ...updated, triggers: next } })
  })
}
export async function acceptCoachNotificationInApp(intentId: string, at = new Date().toISOString()): Promise<boolean> {
  return db.transaction('rw', db.settings, db.tasks, db.smartLists, db.contextSources, async () => {
    const settings = await db.settings.get('main'); if (!settings) return false
    const state = coachNotificationStateFor(settings), intent = state.intents.find(item => item.id === intentId)
    if (!intent || !intent.deliveries.some(item => item.destinationId === 'in-app' && ['prepared', 'queued'].includes(item.state))) return false
    const decision = revalidateCoachNotification(state, intent, await currentGuard(settings, intent, at), at)
    if (!decision.allowed) { await db.settings.put({ ...settings, notificationState: cancelPendingCoachNotifications(state, decision.reason, at, item => item.id === intentId) }); return false }
    await db.settings.put({ ...settings, notificationState: acceptInAppDelivery(state, intentId, at) })
    return true
  })
}
export async function readCoachNotification(intentId: string, at = new Date().toISOString()): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main'); if (!settings) throw new Error('本人の設定がありません')
    await db.settings.put({ ...settings, notificationState: markCoachNotificationRead(coachNotificationStateFor(settings), intentId, at) })
  })
}
/** Persists validated AI wording only if the reservation still passes every check and the facts are unchanged. */
export async function saveCoachNotificationAIText(intentId: string, text: string, model: string, digest: string, at = new Date().toISOString()): Promise<boolean> {
  return db.transaction('rw', db.settings, db.tasks, db.smartLists, db.contextSources, async () => {
    const settings = await db.settings.get('main'); if (!settings || !settings.aiEnabled || settings.aiModel !== model) return false
    const state = coachNotificationStateFor(settings), intent = state.intents.find(item => item.id === intentId)
    if (!intent || !coachTriggersOf(state).aiText || !intent.deliveries.some(item => ['prepared', 'queued'].includes(item.state))) return false
    const guard = await currentGuard(settings, intent, at)
    if (guard.factsDigest !== digest || !revalidateCoachNotification(state, intent, guard, at).allowed) return false
    await db.settings.put({ ...settings, notificationState: { ...state, intents: state.intents.map(item => item.id === intentId ? { ...item, text: { factual: item.text.factual, savedAI: text, savedAIModel: model, factsDigest: digest } } : item) } })
    return true
  })
}
/** Current recomputed facts digest for display decisions (in-app inbox). */
export async function currentCoachNotificationGuard(intentId: string, at = new Date().toISOString()): Promise<NotificationGuard | null> {
  return db.transaction('r', db.settings, db.tasks, db.smartLists, db.contextSources, async () => {
    const settings = await db.settings.get('main'), intent = settings ? coachNotificationStateFor(settings).intents.find(item => item.id === intentId) : undefined
    return settings && intent ? currentGuard(settings, intent, at) : null
  })
}
