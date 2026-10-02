import { db } from './db'
import { changePolicyFor } from './change-set'
import { coachNotificationGuardFor, prepareCoachNotificationDelivery, queueCoachNotification, recordCoachNotificationDelivery } from './coach-notification-save'
import type { Settings } from './domain'
import type { ScheduleRefreshInbox } from './schedule-refresh-types'
export function scheduleRefreshNoticeFacts(rows: ScheduleRefreshInbox[], settings: Settings, at: string) {
  const pending = rows.filter(row => row.ownerId === settings.profileId && row.datasetId === settings.datasetId && row.policyEpoch === changePolicyFor(settings).epoch && row.state === 'pending' && row.fetchedAt <= at && Date.parse(row.fetchedAt) > Date.parse(at) - 86400000)
  if (!pending.length || pending.length > 100) return null
  const latest = pending.map(row => row.fetchedAt).sort().at(-1)!
  return { count: pending.length, revision: `refresh:${pending.length}:${latest}`, factual: `予定資料${pending.length}件に変更があります。差分の確認待ちです` }
}
export async function deliverScheduleRefreshNotice(at = new Date().toISOString()) {
  const settings = await db.settings.get('main')
  if (!settings?.notifications) return
  const facts = scheduleRefreshNoticeFacts(await db.scheduleRefreshInbox.toArray(), settings, at)
  if (!facts) return
  const target = { kind: 'system' as const, id: 'schedule-refresh', revision: 1 }, rule = { id: 'schedule-refresh', revision: facts.revision, active: true, sentCount: 0 }
  const intent = await queueCoachNotification({ id: facts.revision, purpose: 'plan_changed', category: 'proactive', target, ruleId: rule.id, ruleRevision: rule.revision, ruleWindow: at.slice(0, 10), notBefore: at, expiresAt: new Date(Date.parse(at) + 3600000).toISOString(), destinationIds: ['os'], sourceRefs: [], text: { factual: facts.factual, savedAI: null }, intervalMinutes: null, maxCount: null, endDate: null }, coachNotificationGuardFor(settings, { ...target, active: true }, rule), at)
  if (!intent) return
  const payload = await prepareCoachNotificationDelivery(intent.id, 'os', at)
  if (!payload) return
  try { const accepted = await window.michiDesktop?.notify(payload); await recordCoachNotificationDelivery(intent.id, 'os', accepted ? 'accepted_by_provider' : 'failed', payload.attemptId, at) }
  catch { await recordCoachNotificationDelivery(intent.id, 'os', 'delivery_unknown', payload.attemptId, at) }
}
