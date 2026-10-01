import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { validateOSNotification, createOSNotificationGuard, notificationTextAllowed } = require('./notification-delivery.cjs')
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
test('N09 notification stop switch and notification.send=deny are re-checked at OS show time', () => {
  const allowed = fixture()
  allowed.context.settings.changePolicy = { ...allowed.context.settings.changePolicy, operations: [{ operation: 'notification.send', mode: 'auto_within_bounds' }] }
  assert.deepEqual(validateOSNotification(allowed.context, allowed.payload, now), { title: allowed.payload.title, body: allowed.payload.body })
  for (const mutate of [value => { value.context.settings.changePolicy = { ...value.context.settings.changePolicy, stops: { notifications: true, routines: false } } }, value => { value.context.settings.changePolicy = { ...value.context.settings.changePolicy, operations: [{ operation: 'notification.send', mode: 'deny' }] } }]) {
    const value = fixture(); mutate(value); assert.equal(validateOSNotification(value.context, value.payload, now), null)
  }
})
const { readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const facts = JSON.parse(readFileSync(new URL('../src/notification-fact-fixtures.json', import.meta.url), 'utf8'))
const triggersOn = () => ({ deadlineNear: { enabled: true, leadDays: 1, time: '09:00', os: true }, calendarChange: { enabled: true, os: true }, replanPrompt: { enabled: true, time: '09:00', os: true }, aiText: true, trayResident: false })
function deadlineFixture() {
  const value = fixture(), item = facts.deadline[0]
  Object.assign(value.context.task, { title: item.title, dueDate: item.dueDate, scheduledDate: item.scheduledDate })
  Object.assign(value.intent, { purpose: 'deadline_near', ruleId: 'deadline:task', ruleRevision: `deadline:1:${item.dueDate}`, ruleWindow: item.dueDate, text: { factual: item.factual, savedAI: null } })
  value.context.settings.notificationState.triggers = triggersOn(); value.payload.body = item.factual
  return value
}
test('fact wording and digest are the shared fixtures (renderer and main cannot drift)', () => {
  for (const item of facts.deadline) assert.equal(createHash('sha256').update(JSON.stringify(['deadline_near', item.title, item.dueDate, item.scheduledDate])).digest('hex'), item.digest)
  const value = deadlineFixture(); assert.deepEqual(validateOSNotification(value.context, value.payload, now), { title: 'michi 通知', body: facts.deadline[0].factual })
})
test('deadline_near is re-derived from the DB: arbitrary body, stale revision, wrong window, trigger OFF and outside lead window fail', () => {
  for (const mutate of [value => { value.payload.body = '期限が近いタスク: 別の義務（期限 2026-10-02）'; value.intent.text.factual = value.payload.body }, value => { value.context.task.revision = 2 }, value => { value.intent.ruleWindow = '2026-10-03' }, value => { value.context.task.dueDate = '2026-10-03' }, value => { value.context.settings.notificationState.triggers.deadlineNear.enabled = false }, value => { delete value.context.settings.notificationState.triggers }, value => { value.context.settings.notificationState.triggers.deadlineNear.leadDays = 0 }, value => { value.intent.ruleRevision = 'deadline:0:2026-10-02' }]) {
    const value = deadlineFixture(); mutate(value); assert.equal(validateOSNotification(value.context, value.payload, now), null)
  }
})
test('saved AI wording only with AI and AI wording ON, unchanged facts digest, same model, exact stored text and a private destination', () => {
  const ai = '週次報告書の期限は2026-10-02です。', ready = () => { const value = deadlineFixture(); value.context.settings.aiEnabled = true; value.context.settings.aiModel = 'synthetic/qa'; value.intent.text = { factual: facts.deadline[0].factual, savedAI: ai, savedAIModel: 'synthetic/qa', factsDigest: facts.deadline[0].digest }; value.payload = { ...value.payload, body: ai, provenance: 'saved-ai' }; return value }
  const value = ready(); assert.deepEqual(validateOSNotification(value.context, value.payload, now), { title: 'michi 通知', body: ai })
  for (const mutate of [value => { value.context.settings.aiEnabled = false }, value => { value.context.settings.notificationState.triggers.aiText = false }, value => { value.intent.text.factsDigest = 'f'.repeat(64) }, value => { value.context.task.scheduledDate = '2026-10-02' }, value => { value.payload.body = '別の文面' }, value => { value.policy.destinations[0].shared = true }, value => { value.intent.text.savedAI = 'https://example.com 週次報告書'; value.payload.body = value.intent.text.savedAI }, value => { value.context.settings.aiModel = 'other/model' }, value => { delete value.intent.text.savedAIModel }]) {
    const next = ready(); mutate(next); assert.equal(validateOSNotification(next.context, next.payload, now), null)
  }
  // With AI off the same intent still goes out as the factual template.
  const off = ready(); off.context.settings.aiEnabled = false; off.payload = { ...off.payload, body: facts.deadline[0].factual, provenance: 'factual-template' }
  assert.notEqual(validateOSNotification(off.context, off.payload, now), null)
})
test('official calendar plan_changed needs the same revision and the recorded new date', () => {
  const ready = () => { const value = fixture(), item = facts.calendar[0]; Object.assign(value.context.task, { title: item.title, scheduledDate: item.to }); Object.assign(value.intent, { purpose: 'plan_changed', ruleId: 'calendar:proposal:task', ruleRevision: `calendar:1:${item.from}:${item.to}`, ruleWindow: 'calendar:proposal', text: { factual: item.factual, savedAI: null } }); value.payload.body = item.factual; value.context.settings.notificationState.triggers = triggersOn(); return value }
  const value = ready(); assert.notEqual(validateOSNotification(value.context, value.payload, now), null)
  for (const mutate of [value => { value.context.task.scheduledDate = '2026-10-20' }, value => { value.context.task.revision = 2; value.intent.target.revision = 2 }, value => { value.context.settings.notificationState.triggers.calendarChange.enabled = false }, value => { value.payload.body = '公式カレンダーの変更で予定日を変更: 任意 2026-10-12→2026-10-13'; value.intent.text.factual = value.payload.body }]) {
    const next = ready(); mutate(next); assert.equal(validateOSNotification(next.context, next.payload, now), null)
  }
})
test('system replan target is accepted only with the count recomputed from current tasks', () => {
  const ready = () => { const value = fixture(), item = facts.replan[0]; Object.assign(value.intent, { purpose: 'plan_changed', target: { kind: 'system', id: `replan:${item.day}`, revision: 0 }, ruleId: `replan:${item.day}`, ruleRevision: `replan:${item.count}`, ruleWindow: item.day, text: { factual: item.factual, savedAI: null } }); value.payload.body = item.factual; value.context.tasks = structuredClone(item.tasks); value.context.settings.notificationState.triggers = triggersOn(); return value }
  const value = ready(); assert.deepEqual(validateOSNotification(value.context, value.payload, now), { title: 'michi 通知', body: facts.replan[0].factual })
  for (const mutate of [value => { value.payload.body = '予定日を過ぎた未完了が2件あります。今すぐ全部やりましょう'; value.intent.text.factual = value.payload.body }, value => { value.context.tasks.push({ status: 'open', deletedAt: null, scheduledDate: '2026-09-01' }) }, value => { value.context.tasks = [] }, value => { value.intent.target.id = 'replan:2026-09-30'; value.intent.ruleId = 'replan:2026-09-30' }, value => { value.context.settings.notificationState.triggers.replanPrompt.enabled = false }, value => { value.payload.provenance = 'saved-ai' }]) {
    const next = ready(); mutate(next); assert.equal(validateOSNotification(next.context, next.payload, now), null)
  }
})
test('automatic AI wording IPC is refused unless the saved settings still allow it (checked before the key is read)', () => {
  const ready = () => { const value = fixture(); Object.assign(value.context.settings, { aiEnabled: true, aiModel: 'synthetic/qa' }); value.context.settings.notificationState.triggers = triggersOn(); return value.context.settings }
  assert.equal(notificationTextAllowed(ready(), 'synthetic/qa', now), true)
  for (const mutate of [settings => { settings.aiEnabled = false }, settings => { settings.notificationState.triggers.aiText = false }, settings => { delete settings.notificationState.triggers }, settings => { settings.aiModel = 'other/model' }, settings => { settings.notificationState.policy.enabled = false }, settings => { settings.notificationState.policy.restDays = ['2026-10-01'] }, settings => { settings.changePolicy = { ...settings.changePolicy, stops: { notifications: true, routines: false } } }, settings => { settings.changePolicy = { ...settings.changePolicy, operations: [{ operation: 'notification.send', mode: 'deny' }] } }]) {
    const settings = ready(); mutate(settings); assert.equal(notificationTextAllowed(settings, 'synthetic/qa', now), false)
  }
  assert.equal(notificationTextAllowed(null, 'synthetic/qa', now), false)
})
function timedDeadlineFixture(item = facts.timedDeadline[0]) {
  const value = deadlineFixture()
  Object.assign(value.context.task, { title: item.title, dueDate: item.dueDate, dueAt: item.dueAt, dueTimezone: item.dueTimezone, scheduledDate: item.scheduledDate })
  Object.assign(value.intent, { ruleRevision: `deadline:1:${item.dueDate}`, ruleWindow: item.dueDate, expiresAt: item.dueAt, text: { factual: item.factual, savedAI: null } })
  value.payload.body = item.factual
  return value
}
test('timed deadline (dueAt): the shared fixture wording with the clock time and zone, digest including dueTime, nothing after dueAt', () => {
  for (const item of facts.timedDeadline) {
    assert.equal(createHash('sha256').update(JSON.stringify(['deadline_near', item.title, item.dueDate, item.scheduledDate, item.dueTime])).digest('hex'), item.digest)
    const value = timedDeadlineFixture(item); assert.deepEqual(validateOSNotification(value.context, value.payload, now), { title: 'michi 通知', body: item.factual })
  }
  // The date-only wording is refused for a timed deadline, and the deadline instant ends the notice even if the stored intent says otherwise.
  const dateOnly = timedDeadlineFixture(); dateOnly.payload.body = `期限が近いタスク: ${facts.timedDeadline[0].title}（期限 ${facts.timedDeadline[0].dueDate}）`; dateOnly.intent.text.factual = dateOnly.payload.body
  assert.equal(validateOSNotification(dateOnly.context, dateOnly.payload, now), null)
  const late = timedDeadlineFixture(); late.context.task.dueAt = '2026-10-01T01:59:00.000Z'; late.context.task.dueDate = '2026-10-01'
  assert.equal(validateOSNotification(late.context, late.payload, now), null)
  // Saved AI wording is bound to the digest that includes the deadline time.
  const ai = timedDeadlineFixture(); ai.context.settings.aiEnabled = true; ai.context.settings.aiModel = 'synthetic/qa'; ai.intent.text = { factual: facts.timedDeadline[0].factual, savedAI: '申請書の提出は10月2日17:00までです。', savedAIModel: 'synthetic/qa', factsDigest: facts.timedDeadline[0].digest }; ai.payload = { ...ai.payload, body: ai.intent.text.savedAI, provenance: 'saved-ai' }
  assert.notEqual(validateOSNotification(ai.context, ai.payload, now), null)
  ai.intent.text.factsDigest = facts.deadline[0].digest; assert.equal(validateOSNotification(ai.context, ai.payload, now), null)
})
test('the person\'s own one-time reminder inside the notice window replaces the coach deadline notice at the OS boundary', () => {
  const covered = timedDeadlineFixture(); covered.context.settings.reminderState.rules.push({ id: 'before', kind: 'once', targetId: 'task', nextAt: '2026-10-02T07:30:00.000Z', enabled: true, sentCount: 0, maxCount: 1, updatedAt: now })
  assert.equal(validateOSNotification(covered.context, covered.payload, now), null)
  const stopped = timedDeadlineFixture(); stopped.context.settings.reminderState.rules.push({ id: 'before', kind: 'once', targetId: 'task', nextAt: '2026-10-02T07:30:00.000Z', enabled: false, sentCount: 0, maxCount: 1, updatedAt: now })
  assert.notEqual(validateOSNotification(stopped.context, stopped.payload, now), null)
  const other = timedDeadlineFixture(); other.context.settings.reminderState.rules.push({ id: 'before', kind: 'once', targetId: 'other-task', nextAt: '2026-10-02T07:30:00.000Z', enabled: true, sentCount: 0, maxCount: 1, updatedAt: now })
  assert.notEqual(validateOSNotification(other.context, other.payload, now), null)
})
