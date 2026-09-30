import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { validateOSNotification, createOSNotificationGuard } = require('./notification-delivery.cjs')
const { activeSmartList, validateAst } = require('./smart-list-notification.cjs')
const now = '2026-10-01T02:00:00.000Z'
function fixture() {
  const payload = { notificationId: 'n', destinationId: 'os', attemptId: 'attempt', title: 'michi 通知', body: '見直し: 対象タスク', provenance: 'factual-template' }
  const intent = { id: 'n', purpose: 'review', category: 'proactive', destinationIds: ['os'], ownerId: 'person', datasetId: 'dataset', policyEpoch: 2, authorityEpoch: 3, sourcePermissionRevision: 4, target: { kind: 'task', id: 'task', revision: 1 }, ruleId: 'rule', ruleRevision: now, ruleWindow: '2026-10-01', notBefore: now, expiresAt: '2026-10-02T02:00:00.000Z', reservedAt: now, reservedDay: '2026-10-01', endDate: null, intervalMinutes: null, sourceRefs: [], text: { factual: payload.body, savedAI: null }, deliveries: [{ destinationId: 'os', state: 'sending', attemptId: payload.attemptId, at: now }] }
  const settings = { profileId: 'person', datasetId: 'dataset', notifications: true, aiEnabled: false, changePolicy: { epoch: 3, sourcePermissionRevision: 4 }, notificationState: { version: 1, ownerId: 'person', datasetId: 'dataset', policy: { epoch: 2, enabled: true, timezone: 'Asia/Tokyo', quietStart: '22:00', quietEnd: '08:00', dailyCap: 6, targetIntervalMinutes: 60, restDays: [], mutedTargets: [], destinations: [{ id: 'os', channel: 'os', approved: true, shared: false }] }, intents: [intent] }, reminderState: { rules: [{ id: 'rule', kind: 'review', targetId: 'task', updatedAt: now, enabled: true, reviewDate: '2026-10-01', sentCount: 1, maxCount: 1 }] } }
  const context = { settings, task: { id: 'task', title: '対象タスク', revision: 1, status: 'open', deletedAt: null, reviewDate: '2026-10-01' }, sources: [] }
  return { context, payload, intent, policy: settings.notificationState.policy, rule: settings.reminderState.rules[0] }
}
test('saved intent supplies exact canonical OS text; arbitrary payload fields and divergent model text fail', () => {
  const { context, payload } = fixture()
  assert.deepEqual(validateOSNotification(context, payload, now), { title: payload.title, body: payload.body })
  for (const patch of [{ body: '新しく勝手に追加した義務' }, { title: '任意の通知' }, { notificationId: 'other' }, { attemptId: 'old' }, { destinationId: 'messenger' }, { provenance: 'saved-ai' }, { invoke: 'show' }]) assert.equal(validateOSNotification(context, { ...payload, ...patch }, now), null)
})
test('matching forged intent text still cannot introduce a new obligation; current task facts determine body', () => {
  const value = fixture(); value.intent.text.factual = '本人が登録していない新しい義務'; value.payload.body = value.intent.text.factual
  assert.equal(validateOSNotification(value.context, value.payload, now), null)
  value.intent.text.factual = '見直し: 対象タスク'; value.payload.body = value.intent.text.factual; value.intent.purpose = 'deadline_near'
  assert.equal(validateOSNotification(value.context, value.payload, now), null)
  value.intent.purpose = 'review'; value.intent.category = 'reply'; assert.equal(validateOSNotification(value.context, value.payload, now), null)
})
test('global stop, day rest, target mute, quiet hours and OS permission are checked at show time', () => {
  for (const mutate of [value => { value.policy.enabled = false }, value => { value.policy.restDays = ['2026-10-01'] }, value => { value.policy.mutedTargets = ['task'] }, value => { value.policy.quietStart = '10:00'; value.policy.quietEnd = '12:00' }, value => { value.context.settings.notifications = false }, value => { value.policy.destinations[0].approved = false }]) {
    const value = fixture(); mutate(value); assert.equal(validateOSNotification(value.context, value.payload, now), null)
  }
})
test('policy epoch, source permission epoch, owner/dataset and expiration invalidate pending work', () => {
  for (const mutate of [value => { value.policy.epoch++ }, value => { value.context.settings.changePolicy.epoch++ }, value => { value.context.settings.changePolicy.sourcePermissionRevision++ }, value => { value.context.settings.profileId = 'other' }, value => { value.context.settings.datasetId = 'restored' }, value => { value.intent.expiresAt = now }, value => { value.intent.reservedDay = '2026-09-30' }]) {
    const value = fixture(); mutate(value); assert.equal(validateOSNotification(value.context, value.payload, now), null)
  }
})
test('completion, task revision, review date change, rule stop/cancel and wrong target suppress', () => {
  for (const mutate of [value => { value.context.task.status = 'completed' }, value => { value.context.task.deletedAt = now }, value => { value.context.task.revision++ }, value => { value.context.task.id = 'other' }, value => { value.context.task.reviewDate = '2026-10-02' }, value => { value.rule.enabled = false }, value => { value.rule.updatedAt = '2026-10-01T01:59:00.000Z' }, value => { value.intent.deliveries[0].state = 'canceled' }]) {
    const value = fixture(); mutate(value); assert.equal(validateOSNotification(value.context, value.payload, now), null)
  }
})
test('changed/deleted/expired source and its notify permission are revalidated independently', () => {
  for (const mutate of [value => { value.context.sources[0].permissions.notify = false }, value => { value.context.sources[0].permissionRevision++ }, value => { value.context.sources[0].revision++ }, value => { value.context.sources[0].deletedAt = now }, value => { value.context.sources[0].retentionUntil = now }, value => { value.context.sources[0].ownerId = 'other' }]) {
    const value = fixture(); value.intent.sourceRefs = [{ id: 'source', revision: 1, permissionRevision: 2 }]; value.context.sources = [{ id: 'source', ownerId: 'person', revision: 1, permissionRevision: 2, deletedAt: null, retentionUntil: null, permissions: { retain: true, notify: true } }]
    assert.notEqual(validateOSNotification(value.context, value.payload, now), null)
    mutate(value); assert.equal(validateOSNotification(value.context, value.payload, now), null)
  }
})
test('another trigger reservation consumes common cap and cooldown, unknown delivery remains counted', () => {
  const value = fixture(); value.policy.dailyCap = 1
  value.context.settings.notificationState.intents.push({ ...structuredClone(value.intent), id: 'different-trigger', purpose: 'checkin_due', target: { kind: 'task', id: 'other', revision: 1 }, deliveries: [{ state: 'delivery_unknown' }] })
  assert.equal(validateOSNotification(value.context, value.payload, now), null)
  value.policy.dailyCap = 6; value.context.settings.notificationState.intents[1].target.id = 'task'
  assert.equal(validateOSNotification(value.context, value.payload, now), null)
})
test('local factual trigger stays factual under AI ON/OFF and rejects saved model text as new notification', () => {
  const value = fixture(); value.intent.text.savedAI = '以前作成した保存済みAI文'
  assert.notEqual(validateOSNotification(value.context, value.payload, now), null)
  value.context.settings.aiEnabled = true
  assert.notEqual(validateOSNotification(value.context, value.payload, now), null)
  assert.equal(validateOSNotification(value.context, { ...value.payload, body: value.intent.text.savedAI, provenance: 'saved-ai' }, now), null)
})
test('each accepted attempt is consumed once; rejected attempt is not consumed', () => {
  const value = fixture(), guard = createOSNotificationGuard()
  assert.equal(guard(value.context, { ...value.payload, body: 'divergent' }, now), null)
  assert.notEqual(guard(value.context, value.payload, now), null)
  assert.equal(guard(value.context, value.payload, now), null)
  value.intent.deliveries[0].attemptId = 'second'; value.payload.attemptId = 'second'
  assert.notEqual(guard(value.context, value.payload, now), null)
})
test('Smart List requires current nonempty authorized owner query and exact list version', () => {
  const value = fixture(); value.intent.target.kind = 'smart-list'; value.intent.purpose = 'smart-daily'; value.rule.kind = 'smart-daily'; value.context.list = { id: 'task', name: '今日の作業', ownerId: 'person', revision: 1, ast: { type: 'condition', field: 'status', operator: 'eq', value: 'open' } }; value.context.tasks = [value.context.task]; value.intent.text.factual = value.context.list.name; value.payload.body = value.context.list.name
  assert.notEqual(validateOSNotification(value.context, value.payload, now), null)
  value.context.list.revision = 2; assert.equal(validateOSNotification(value.context, value.payload, now), null)
  value.context.list.revision = 1; value.context.tasks[0].status = 'completed'; assert.equal(validateOSNotification(value.context, value.payload, now), null)
})
test('snooze uses the current chosen timestamp rather than arbitrary source/model trigger', () => {
  const value = fixture(); value.intent.purpose = 'plan_changed'; value.intent.ruleId = 'snooze:task'; value.intent.ruleWindow = now; value.context.task.snoozedUntil = now; value.intent.ruleRevision = `snooze:1:${now}`; value.intent.text.factual = `タスクを再表示: ${value.context.task.title}`; value.payload.body = value.intent.text.factual
  assert.notEqual(validateOSNotification(value.context, value.payload, now), null)
  value.context.task.snoozedUntil = null; assert.equal(validateOSNotification(value.context, value.payload, now), null)
})
test('Smart List handles unknown points, Japanese-insensitive labels and date comparisons like app query', () => {
  const task = { status: 'open', deletedAt: null, title: 'Alphaの準備', project: 'PROJECT', labels: ['Study'], effectivePoints: null, scheduledDate: '2026-10-01', score: { minutes: null } }
  const list = ast => ({ id: 'list', ownerId: 'person', revision: 1, ast })
  for (const ast of [{ type: 'condition', field: 'minutes', operator: 'is_unknown' }, { type: 'condition', field: 'effectivePoints', operator: 'is_unknown' }, { type: 'condition', field: 'labels', operator: 'contains', value: 'study' }, { type: 'condition', field: 'scheduledDate', operator: 'lte', value: '2026-10-02' }, { type: 'not', child: { type: 'condition', field: 'project', operator: 'eq', value: 'Other' } }]) assert.equal(activeSmartList(list(ast), [task], 'person', now), true)
  for (const ast of [{ type: 'condition', field: 'effectivePoints', operator: 'neq', value: 20 }, { type: 'condition', field: 'labels', operator: 'eq', value: 'study' }, { type: 'condition', field: 'scheduledDate', operator: 'gte', value: '2026-10-02' }]) assert.equal(activeSmartList(list(ast), [task], 'person', now), false)
  assert.equal(activeSmartList(list({ type: 'condition', field: 'status', operator: 'eq', value: 'open' }), [task], 'other', now), false)
})
test('Smart List malformed AST/property/prototype operators/deep trees fail closed; completed/deleted never active', () => {
  const valid = { type: 'condition', field: 'status', operator: 'eq', value: 'open' }
  for (const ast of [{ ...valid, field: '__proto__' }, { ...valid, operator: 'eval' }, { ...valid, code: 'return true' }, { type: 'condition', field: 'scheduledDate', operator: 'lte', value: '2026-02-30' }, { type: 'any', children: [] }, { type: 'condition', field: 'minutes', operator: 'is_unknown', value: 0 }]) assert.equal(validateAst(ast), false)
  let deep = valid; for (let index = 0; index < 6; index++) deep = { type: 'not', child: deep }; assert.equal(validateAst(deep), false)
  const list = { id: 'list', ownerId: 'person', revision: 1, ast: valid }
  assert.equal(activeSmartList(list, [{ status: 'completed', deletedAt: null }, { status: 'open', deletedAt: now }], 'person', now), false)
})
