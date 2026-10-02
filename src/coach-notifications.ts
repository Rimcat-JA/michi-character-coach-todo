export type NotificationPurpose = 'reminder' | 'review' | 'bug-me' | 'smart-daily' | 'deadline_near' | 'plan_changed' | 'grounded_obligation_detected' | 'checkin_due' | 'focus_ended' | 'github_failed' | 'direct_reply'
export type NotificationCategory = 'proactive' | 'timer' | 'reply'
export type NotificationDeliveryStatus = 'prepared' | 'queued' | 'sending' | 'accepted_by_provider' | 'delivery_unknown' | 'failed' | 'suppressed' | 'canceled'
export type NotificationDestination = { id: string; channel: 'in-app' | 'os' | 'messenger'; label: string; approved: boolean; shared: boolean; permissionRevision: number }
export type CoachNotificationPolicy = {
  epoch: number; enabled: boolean; timezone: string; quietStart: string; quietEnd: string; dailyCap: number; targetIntervalMinutes: number
  restDays: string[]; mutedTargets: string[]; destinations: NotificationDestination[]
}
export type NotificationSourceRef = { id: string; revision: number; permissionRevision: number }
export type NotificationTarget = { kind: 'task' | 'smart-list' | 'source' | 'timer' | 'system'; id: string; revision: number }
export type NotificationRequest = {
  id: string; purpose: NotificationPurpose; category: NotificationCategory; target: NotificationTarget; ruleId: string; ruleRevision: string; ruleWindow: string
  notBefore: string; expiresAt: string; destinationIds: string[]; sourceRefs: NotificationSourceRef[]
  /** savedAIModel/factsDigest bind saved AI wording to the model and the exact facts it was written from. */
  text: { factual: string; savedAI: string | null; savedAIModel?: string | null; factsDigest?: string | null }; intervalMinutes: number | null; maxCount: number | null; endDate: string | null
}
export type NotificationDelivery = { destinationId: string; state: NotificationDeliveryStatus; attemptId: string | null; at: string }
export type CoachNotificationIntent = NotificationRequest & {
  ownerId: string; datasetId: string; policyEpoch: number; authorityEpoch: number; sourcePermissionRevision: number; dedupeKey: string; reservedAt: string; reservedDay: string
  deliveries: NotificationDelivery[]; reason: string | null; readAt?: string | null
}
/** Opt-in fact triggers (all OFF by default). Optional so older saved data and backups stay valid. */
export type CoachTriggerSettings = {
  deadlineNear: { enabled: boolean; leadDays: number; time: string; os: boolean }
  calendarChange: { enabled: boolean; os: boolean }
  replanPrompt: { enabled: boolean; time: string; os: boolean }
  aiText: boolean; trayResident: boolean
}
export type CoachNotificationState = { version: 1; ownerId: string; datasetId: string; policy: CoachNotificationPolicy; triggers?: CoachTriggerSettings; intents: CoachNotificationIntent[] }
export type NotificationGuard = {
  ownerId: string; datasetId: string; authorityEpoch: number; sourcePermissionRevision: number; aiEnabled: boolean
  target: NotificationTarget & { active: boolean }; rule: { id: string; revision: string; active: boolean; sentCount: number }
  sources: (NotificationSourceRef & { active: boolean; notify: boolean; disclose: boolean })[]; availableDestinationIds: string[]
  /** N09 notification stop switch or notification.send=deny; the reason is shown, nothing is sent. */
  stopped?: string | null
  /** Digest of the facts recomputed now; saved AI wording is used only while it still matches. */
  factsDigest?: string | null
  /** Model selected now; saved AI wording written by another model falls back to the factual template. */
  aiModel?: string | null
}
export type NotificationDecision = { allowed: true } | { allowed: false; reason: string }
const pendingStates: NotificationDeliveryStatus[] = ['prepared', 'queued', 'sending']
const countedStates: NotificationDeliveryStatus[] = [...pendingStates, 'accepted_by_provider', 'delivery_unknown']
const purposes: NotificationPurpose[] = ['reminder', 'review', 'bug-me', 'smart-daily', 'deadline_near', 'plan_changed', 'grounded_obligation_detected', 'checkin_due', 'focus_ended', 'github_failed', 'direct_reply']
const denied = (reason: string): NotificationDecision => ({ allowed: false, reason })
const timestamp = (value: string) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const integer = (value: unknown, min: number, max: number) => Number.isInteger(value) && Number(value) >= min && Number(value) <= max
const text = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const exact = (value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []) => keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key))
const digestText = (value: unknown) => value === undefined || value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
const validTime = (value: unknown): value is string => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
export function notificationLocalClock(at: string, timezone: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))
  const part = (key: string) => parts.find(value => value.type === key)!.value
  return { day: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` }
}
export function defaultCoachNotificationPolicy(timezone = Intl.DateTimeFormat().resolvedOptions().timeZone): CoachNotificationPolicy {
  return { epoch: 0, enabled: true, timezone, quietStart: '22:00', quietEnd: '08:00', dailyCap: 6, targetIntervalMinutes: 60, restDays: [], mutedTargets: [], destinations: [{ id: 'in-app', channel: 'in-app', label: 'アプリ内', approved: true, shared: false, permissionRevision: 0 }, { id: 'os', channel: 'os', label: '端末の通知', approved: true, shared: false, permissionRevision: 0 }] }
}
export function defaultCoachTriggers(): CoachTriggerSettings {
  return { deadlineNear: { enabled: false, leadDays: 1, time: '09:00', os: false }, calendarChange: { enabled: false, os: false }, replanPrompt: { enabled: false, time: '09:00', os: false }, aiText: false, trayResident: false }
}
export function coachTriggersOf(state: CoachNotificationState): CoachTriggerSettings { return structuredClone(state.triggers ?? defaultCoachTriggers()) }
export function validateCoachTriggers(value: unknown): asserts value is CoachTriggerSettings {
  const flags = (item: unknown, keys: string[]) => record(item) && exact(item, keys) && keys.every(key => key === 'leadDays' ? integer(item[key], 0, 7) : key === 'time' ? validTime(item[key]) : typeof item[key] === 'boolean')
  if (!record(value) || !exact(value, ['deadlineNear', 'calendarChange', 'replanPrompt', 'aiText', 'trayResident']) || !flags(value.deadlineNear, ['enabled', 'leadDays', 'time', 'os']) || !flags(value.calendarChange, ['enabled', 'os']) || !flags(value.replanPrompt, ['enabled', 'time', 'os']) || typeof value.aiText !== 'boolean' || typeof value.trayResident !== 'boolean') throw new Error('通知のきっかけ設定が不正です')
}
export function emptyCoachNotificationState(ownerId: string, datasetId: string, timezone?: string): CoachNotificationState {
  return { version: 1, ownerId, datasetId, policy: defaultCoachNotificationPolicy(timezone), intents: [] }
}
export function validateCoachNotificationPolicy(value: unknown): asserts value is CoachNotificationPolicy {
  if (!record(value) || !exact(value, ['epoch', 'enabled', 'timezone', 'quietStart', 'quietEnd', 'dailyCap', 'targetIntervalMinutes', 'restDays', 'mutedTargets', 'destinations']) || !integer(value.epoch, 0, Number.MAX_SAFE_INTEGER) || typeof value.enabled !== 'boolean' || !text(value.timezone) || !validTime(value.quietStart) || !validTime(value.quietEnd) || !integer(value.dailyCap, 0, 50) || !integer(value.targetIntervalMinutes, 1, 1440)) throw new Error('共通通知の設定が不正です')
  try { notificationLocalClock(new Date().toISOString(), value.timezone) } catch { throw new Error('通知のタイムゾーンが不正です') }
  if (!Array.isArray(value.restDays) || value.restDays.length > 400 || value.restDays.some(day => !validDate(day)) || new Set(value.restDays).size !== value.restDays.length || !Array.isArray(value.mutedTargets) || value.mutedTargets.length > 1000 || value.mutedTargets.some(id => !text(id)) || new Set(value.mutedTargets).size !== value.mutedTargets.length) throw new Error('通知の休み・対象停止が不正です')
  if (!Array.isArray(value.destinations) || !value.destinations.length || value.destinations.length > 20 || new Set(value.destinations.map(item => record(item) ? item.id : null)).size !== value.destinations.length || value.destinations.some(item => !record(item) || !exact(item, ['id', 'channel', 'label', 'approved', 'shared', 'permissionRevision']) || !text(item.id) || !text(item.label) || !['in-app', 'os', 'messenger'].includes(String(item.channel)) || typeof item.approved !== 'boolean' || typeof item.shared !== 'boolean' || !integer(item.permissionRevision, 0, Number.MAX_SAFE_INTEGER))) throw new Error('通知先の設定が不正です')
}
export function validateNotificationRequest(value: unknown): asserts value is NotificationRequest {
  if (!record(value) || !exact(value, ['id', 'purpose', 'category', 'target', 'ruleId', 'ruleRevision', 'ruleWindow', 'notBefore', 'expiresAt', 'destinationIds', 'sourceRefs', 'text', 'intervalMinutes', 'maxCount', 'endDate']) || !text(value.id) || !purposes.includes(value.purpose as NotificationPurpose) || !['proactive', 'timer', 'reply'].includes(String(value.category)) || !text(value.ruleId) || !text(value.ruleRevision) || !text(value.ruleWindow) || !text(value.notBefore) || !timestamp(value.notBefore) || !text(value.expiresAt) || !timestamp(value.expiresAt) || value.expiresAt <= value.notBefore || Date.parse(value.expiresAt) - Date.parse(value.notBefore) > 7 * 86400000) throw new Error('通知の予約が不正です')
  if (value.category !== (value.purpose === 'focus_ended' ? 'timer' : value.purpose === 'direct_reply' ? 'reply' : 'proactive')) throw new Error('通知種別の上限を迂回できません')
  if (!record(value.target) || !exact(value.target, ['kind', 'id', 'revision']) || !['task', 'smart-list', 'source', 'timer', 'system'].includes(String(value.target.kind)) || !text(value.target.id) || !integer(value.target.revision, 0, Number.MAX_SAFE_INTEGER)) throw new Error('通知対象が不正です')
  if (!Array.isArray(value.destinationIds) || !value.destinationIds.length || value.destinationIds.length > 2 || value.destinationIds.some(id => !text(id)) || new Set(value.destinationIds).size !== value.destinationIds.length || !Array.isArray(value.sourceRefs) || value.sourceRefs.length > 50 || new Set(value.sourceRefs.map(ref => record(ref) ? ref.id : null)).size !== value.sourceRefs.length || value.sourceRefs.some(ref => !record(ref) || !exact(ref, ['id', 'revision', 'permissionRevision']) || !text(ref.id) || !integer(ref.revision, 1, Number.MAX_SAFE_INTEGER) || !integer(ref.permissionRevision, 0, Number.MAX_SAFE_INTEGER))) throw new Error('通知先・根拠が不正です')
  if (!record(value.text) || !exact(value.text, ['factual', 'savedAI'], ['savedAIModel', 'factsDigest']) || !text(value.text.factual, 2000) || value.text.savedAI !== null && !text(value.text.savedAI, 2000) || value.text.savedAIModel !== undefined && value.text.savedAIModel !== null && !text(value.text.savedAIModel, 120) || !digestText(value.text.factsDigest) || value.intervalMinutes !== null && !integer(value.intervalMinutes, 1, 1440) || value.maxCount !== null && !integer(value.maxCount, 1, 100) || value.endDate !== null && !validDate(value.endDate)) throw new Error('通知内容・回数が不正です')
  if (value.purpose === 'bug-me' && (value.intervalMinutes === null || value.maxCount === null || value.endDate === null)) throw new Error('Bug Meには間隔・最大回数・期限が必要です')
}
export function notificationDedupeKey(ownerId: string, request: NotificationRequest): string {
  return JSON.stringify([ownerId, request.purpose, request.target.kind, request.target.id, request.ruleWindow])
}
function counted(intent: CoachNotificationIntent) { return intent.deliveries.some(item => countedStates.includes(item.state)) }
function sameTarget(a: NotificationTarget, b: NotificationTarget) { return a.id === b.id && a.kind === b.kind }
function policyDecision(state: CoachNotificationState, request: NotificationRequest, guard: NotificationGuard, at: string, excludeId?: string): NotificationDecision {
  const policy = state.policy, clock = notificationLocalClock(at, policy.timezone)
  if (state.ownerId !== guard.ownerId || state.datasetId !== guard.datasetId) return denied('本人・データセットが変わりました')
  if (!policy.enabled) return denied('共通通知を停止しています')
  if (guard.stopped) return denied(guard.stopped)
  if (policy.mutedTargets.includes(request.target.id)) return denied('この対象の通知を停止しています')
  if (request.category === 'proactive' && policy.restDays.includes(clock.day)) return denied('今日は通知を休みます')
  if (policy.quietStart !== policy.quietEnd && (policy.quietStart < policy.quietEnd ? clock.time >= policy.quietStart && clock.time < policy.quietEnd : clock.time >= policy.quietStart || clock.time < policy.quietEnd)) return denied('静かな時間です')
  if (at < request.notBefore) return denied('予約時刻前です')
  if (at >= request.expiresAt) return denied('通知の有効期限が過ぎました')
  if (request.endDate !== null && clock.day > request.endDate) return denied('催促の期限が過ぎました')
  if (!guard.target.active || !sameTarget(request.target, guard.target) || request.target.revision !== guard.target.revision) return denied('対象が完了・取消・削除・変更されています')
  if (!guard.rule.active || guard.rule.id !== request.ruleId || guard.rule.revision !== request.ruleRevision) return denied('予約ルールを停止・変更しました')
  if (request.maxCount !== null && guard.rule.sentCount >= request.maxCount && !excludeId) return denied('催促の最大回数に達しました')
  for (const ref of request.sourceRefs) {
    const source = guard.sources.find(item => item.id === ref.id)
    if (!source || !source.active || !source.notify || source.revision !== ref.revision || source.permissionRevision !== ref.permissionRevision) return denied('根拠資料の通知許可・版が変わりました')
  }
  const destinations = request.destinationIds.map(id => policy.destinations.find(item => item.id === id))
  if (destinations.some(item => !item || !item.approved || !guard.availableDestinationIds.includes(item.id))) return denied('通知先の許可または接続がありません')
  if (destinations.filter(item => item?.channel !== 'in-app').length > 1) return denied('同じ通知を複数の外部サービスへ同報できません')
  if (destinations.some(item => item?.shared) && request.sourceRefs.some(ref => !guard.sources.find(source => source.id === ref.id)?.disclose)) return denied('共有先への開示が許可されていません')
  if (request.category === 'proactive') {
    const other = state.intents.filter(item => item.id !== excludeId && item.category === 'proactive' && counted(item))
    if (other.filter(item => item.reservedDay === clock.day).length >= policy.dailyCap) return denied('共通の1日上限に達しました')
    // A validated explicitly requested Bug Me interval may be shorter than the default.
    const interval = request.intervalMinutes ?? policy.targetIntervalMinutes
    if (other.some(item => sameTarget(item.target, request.target) && Date.parse(at) - Date.parse(item.reservedAt) < interval * 60000)) return denied('同じ対象への通知間隔内です')
  }
  return { allowed: true }
}
export function reserveCoachNotification(state: CoachNotificationState, request: NotificationRequest, guard: NotificationGuard, at = new Date().toISOString()): { state: CoachNotificationState; intent: CoachNotificationIntent | null; decision: NotificationDecision } {
  validateCoachNotificationPolicy(state.policy); validateNotificationRequest(request)
  if (!timestamp(at)) throw new Error('通知の判定時刻が不正です')
  const key = notificationDedupeKey(state.ownerId, request), prior = state.intents.find(item => item.id === request.id || item.dedupeKey === key)
  if (prior && prior.deliveries.some(item => !['canceled', 'suppressed'].includes(item.state))) return { state, intent: null, decision: denied('同じ論理通知は予約済みです') }
  const decision = policyDecision(state, request, guard, at)
  if (!decision.allowed) return { state, intent: null, decision }
  if (state.intents.length >= 5000) return { state, intent: null, decision: denied('通知履歴の保存上限です。過去の履歴を整理してください') }
  const intent: CoachNotificationIntent = { ...structuredClone(request), id: prior?.id ?? request.id, ownerId: state.ownerId, datasetId: state.datasetId, policyEpoch: state.policy.epoch, authorityEpoch: guard.authorityEpoch, sourcePermissionRevision: guard.sourcePermissionRevision, dedupeKey: key, reservedAt: at, reservedDay: notificationLocalClock(at, state.policy.timezone).day, deliveries: request.destinationIds.map(destinationId => ({ destinationId, state: 'queued', attemptId: null, at })), reason: null }
  return { state: { ...state, intents: [...state.intents.filter(item => item !== prior), intent] }, intent, decision }
}
export function revalidateCoachNotification(state: CoachNotificationState, intent: CoachNotificationIntent, guard: NotificationGuard, at = new Date().toISOString()): NotificationDecision {
  if (intent.ownerId !== state.ownerId || intent.datasetId !== state.datasetId || intent.policyEpoch !== state.policy.epoch || intent.authorityEpoch !== guard.authorityEpoch || intent.sourcePermissionRevision !== guard.sourcePermissionRevision) return denied('通知の許可が更新されました')
  if (intent.reservedDay !== notificationLocalClock(at, state.policy.timezone).day) return denied('予約日が変わりました')
  return policyDecision(state, intent, guard, at, intent.id)
}
function mapIntent(state: CoachNotificationState, id: string, fn: (intent: CoachNotificationIntent) => CoachNotificationIntent): CoachNotificationState {
  return { ...state, intents: state.intents.map(intent => intent.id === id ? fn(structuredClone(intent)) : intent) }
}
export function cancelPendingCoachNotifications(state: CoachNotificationState, reason: string, at: string, matches: (intent: CoachNotificationIntent) => boolean = () => true): CoachNotificationState {
  return { ...state, intents: state.intents.map(intent => !matches(intent) ? intent : { ...intent, reason, deliveries: intent.deliveries.map(delivery => pendingStates.includes(delivery.state) ? { ...delivery, state: 'canceled', at } : delivery) }) }
}
export function changeCoachNotificationPolicy(state: CoachNotificationState, next: Omit<CoachNotificationPolicy, 'epoch'>, at = new Date().toISOString()): CoachNotificationState {
  const policy = { ...structuredClone(next), epoch: state.policy.epoch + 1 }; validateCoachNotificationPolicy(policy)
  return { ...cancelPendingCoachNotifications(state, '共通通知の設定が変わりました', at), policy }
}
export function beginCoachNotificationDelivery(state: CoachNotificationState, intentId: string, destinationId: string, attemptId: string, guard: NotificationGuard, at = new Date().toISOString()): { state: CoachNotificationState; payload: { notificationId: string; destinationId: string; attemptId: string; title: string; body: string; provenance: 'factual-template' | 'saved-ai' } | null; decision: NotificationDecision } {
  const intent = state.intents.find(item => item.id === intentId), delivery = intent?.deliveries.find(item => item.destinationId === destinationId)
  if (!intent || !delivery || !['prepared', 'queued'].includes(delivery.state)) return { state, payload: null, decision: denied('送信済み・送信中・停止済みの通知です') }
  const decision = revalidateCoachNotification(state, intent, guard, at)
  if (!decision.allowed) return { state: cancelPendingCoachNotifications(state, decision.reason, at, item => item.id === intentId), payload: null, decision }
  const destination = state.policy.destinations.find(item => item.id === destinationId)!, saved = savedAIUsable(intent, guard) && !destination.shared
  const payload = { notificationId: intent.id, destinationId, attemptId, title: 'michi 通知', body: destination.shared ? '確認事項があります。michiアプリで確認してください。' : saved ? intent.text.savedAI! : intent.text.factual, provenance: saved ? 'saved-ai' as const : 'factual-template' as const }
  return { state: mapIntent(state, intentId, item => ({ ...item, deliveries: item.deliveries.map(value => value.destinationId === destinationId ? { ...value, state: 'sending', attemptId, at } : value) })), payload, decision }
}
const factualLocalPurposes: NotificationPurpose[] = ['reminder', 'review', 'bug-me', 'smart-daily', 'plan_changed']
/** Saved AI wording needs AI ON, a non-local-template purpose and, when bound, the same facts and model it was written with. */
export function savedAIUsable(intent: CoachNotificationIntent, guard: Pick<NotificationGuard, 'aiEnabled' | 'factsDigest' | 'aiModel'>): boolean {
  // App fact triggers (deadline_near) always bind wording to a facts digest and model; any stored digest/model must still match.
  const bound = intent.purpose === 'deadline_near' || intent.text.factsDigest !== undefined, model = intent.text.savedAIModel
  return guard.aiEnabled && intent.text.savedAI !== null && !factualLocalPurposes.includes(intent.purpose) && (!bound || typeof intent.text.factsDigest === 'string' && intent.text.factsDigest === guard.factsDigest) && (model === undefined && !bound || typeof model === 'string' && model === guard.aiModel)
}
/** In-app display is accepted by the app itself; it is a display record, not proof the person read it. */
export function acceptInAppDelivery(state: CoachNotificationState, id: string, at: string): CoachNotificationState {
  const attemptId = `in-app:${id}`
  const sending = mapIntent(state, id, intent => ({ ...intent, deliveries: intent.deliveries.map(delivery => delivery.destinationId === 'in-app' && ['prepared', 'queued'].includes(delivery.state) ? { ...delivery, state: 'sending', attemptId, at } : delivery) }))
  return settleCoachNotificationDelivery(sending, id, 'in-app', attemptId, 'accepted_by_provider', at)
}
export function markCoachNotificationRead(state: CoachNotificationState, id: string, at: string): CoachNotificationState {
  if (!timestamp(at) || !state.intents.some(intent => intent.id === id)) throw new Error('確認する通知がありません')
  return mapIntent(state, id, intent => ({ ...intent, readAt: intent.readAt ?? at }))
}
export function settleCoachNotificationDelivery(state: CoachNotificationState, intentId: string, destinationId: string, attemptId: string, result: 'accepted_by_provider' | 'delivery_unknown' | 'failed', at = new Date().toISOString()): CoachNotificationState {
  return mapIntent(state, intentId, intent => ({ ...intent, deliveries: intent.deliveries.map(item => item.destinationId === destinationId && item.attemptId === attemptId && item.state === 'sending' ? { ...item, state: result, at } : item) }))
}
/** Restore never restores executable reservations or unconfirmed delivery attempts. */
export function restoreCoachNotificationState(state: CoachNotificationState, ownerId: string, datasetId: string, at = new Date().toISOString()): CoachNotificationState {
  const canceled = cancelPendingCoachNotifications(structuredClone(state), '復元した通知予約は再承認が必要です', at)
  return { ...canceled, ownerId, datasetId, policy: { ...state.policy, epoch: state.policy.epoch + 1 }, intents: canceled.intents.map(intent => ({ ...intent, ownerId, datasetId, dedupeKey: notificationDedupeKey(ownerId, intent) })) }
}
export function validateCoachNotificationState(value: unknown, ownerId?: string, datasetId?: string): asserts value is CoachNotificationState {
  if (!record(value) || !exact(value, ['version', 'ownerId', 'datasetId', 'policy', 'intents'], ['triggers']) || value.version !== 1 || !text(value.ownerId) || !text(value.datasetId) || ownerId !== undefined && value.ownerId !== ownerId || datasetId !== undefined && value.datasetId !== datasetId || !Array.isArray(value.intents) || value.intents.length > 5000) throw new Error('共通通知データが不正です')
  validateCoachNotificationPolicy(value.policy)
  if (value.triggers !== undefined) validateCoachTriggers(value.triggers)
  const ids = new Set<string>(), dedupeKeys = new Set<string>()
  for (const raw of value.intents) {
    if (!record(raw) || !exact(raw, ['id', 'purpose', 'category', 'target', 'ruleId', 'ruleRevision', 'ruleWindow', 'notBefore', 'expiresAt', 'destinationIds', 'sourceRefs', 'text', 'intervalMinutes', 'maxCount', 'endDate', 'ownerId', 'datasetId', 'policyEpoch', 'authorityEpoch', 'sourcePermissionRevision', 'dedupeKey', 'reservedAt', 'reservedDay', 'deliveries', 'reason'], ['readAt'])) throw new Error('通知履歴が不正です')
    const { ownerId: intentOwner, datasetId: intentDataset, policyEpoch, authorityEpoch, sourcePermissionRevision, dedupeKey, reservedAt, reservedDay, deliveries, reason, readAt, ...request } = raw
    if (readAt !== undefined && readAt !== null && (!text(readAt) || !timestamp(readAt))) throw new Error('通知の確認日時が不正です')
    validateNotificationRequest(request)
    if (intentOwner !== value.ownerId || intentDataset !== value.datasetId || !integer(policyEpoch, 0, value.policy.epoch) || !integer(authorityEpoch, 0, Number.MAX_SAFE_INTEGER) || !integer(sourcePermissionRevision, 0, Number.MAX_SAFE_INTEGER) || dedupeKey !== notificationDedupeKey(value.ownerId, request) || !text(reservedAt) || !timestamp(reservedAt) || !validDate(reservedDay) || reason !== null && !text(reason, 2000) || !Array.isArray(deliveries) || deliveries.length !== request.destinationIds.length || new Set(deliveries.map(item => record(item) ? item.destinationId : null)).size !== deliveries.length) throw new Error('通知履歴の本人・版が不正です')
    for (const item of deliveries) if (!record(item) || !exact(item, ['destinationId', 'state', 'attemptId', 'at']) || !request.destinationIds.includes(String(item.destinationId)) || !['prepared', 'queued', 'sending', 'accepted_by_provider', 'delivery_unknown', 'failed', 'suppressed', 'canceled'].includes(String(item.state)) || item.attemptId !== null && !text(item.attemptId) || !text(item.at) || !timestamp(item.at) || ['sending', 'accepted_by_provider', 'delivery_unknown', 'failed'].includes(String(item.state)) && item.attemptId === null) throw new Error('通知配信状態が不正です')
    if (ids.has(request.id) || dedupeKeys.has(String(dedupeKey))) throw new Error('通知履歴が重複しています')
    ids.add(request.id); dedupeKeys.add(String(dedupeKey))
  }
}
