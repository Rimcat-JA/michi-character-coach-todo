import { describe, expect, it } from 'vitest'
import { beginCoachNotificationDelivery, cancelPendingCoachNotifications, changeCoachNotificationPolicy, emptyCoachNotificationState, notificationLocalClock, reserveCoachNotification, restoreCoachNotificationState, revalidateCoachNotification, settleCoachNotificationDelivery, validateCoachNotificationState, validateNotificationRequest, type CoachNotificationState, type NotificationGuard, type NotificationRequest } from './coach-notifications'

const at = '2026-10-01T02:00:00.000Z'
const later = (minutes: number) => new Date(Date.parse(at) + minutes * 60000).toISOString()
const state = () => emptyCoachNotificationState('owner', 'dataset', 'Asia/Tokyo')
function request(patch: Partial<NotificationRequest> = {}): NotificationRequest {
  return { id: 'notification', purpose: 'reminder', category: 'proactive', target: { kind: 'task', id: 'task', revision: 1 }, ruleId: 'rule', ruleRevision: 'rule-1', ruleWindow: at, notBefore: at, expiresAt: later(1440), destinationIds: ['in-app', 'os'], sourceRefs: [], text: { factual: '登録済みタスクの見直し', savedAI: null }, intervalMinutes: null, maxCount: null, endDate: null, ...patch }
}
function guard(next = request()): NotificationGuard {
  return { ownerId: 'owner', datasetId: 'dataset', authorityEpoch: 4, sourcePermissionRevision: 2, aiEnabled: true, target: { ...next.target, active: true }, rule: { id: next.ruleId, revision: next.ruleRevision, active: true, sentCount: 0 }, sources: [], availableDestinationIds: ['in-app', 'os'] }
}
function reserved(next = request(), initial = state()) { return reserveCoachNotification(initial, next, guard(next), at).state }
function policyPatch(initial: CoachNotificationState, patch: Partial<CoachNotificationState['policy']>) {
  const { epoch: _epoch, ...policy } = initial.policy
  return changeCoachNotificationPolicy(initial, { ...policy, ...patch }, at)
}
describe('K05/N07 共通通知ポリシー', () => {
  it('AT-K05: 今日休むと別のきっかけ・タスク・送信先の催促も抑止する', () => {
    const resting = policyPatch(state(), { restDays: ['2026-10-01'] })
    for (const purpose of ['deadline_near', 'plan_changed', 'checkin_due'] as const) {
      const next = request({ id: purpose, purpose, target: { kind: 'task', id: purpose, revision: 1 }, destinationIds: purpose === 'checkin_due' ? ['in-app'] : ['os'] })
      expect(reserveCoachNotification(resting, next, guard(next), at).decision).toEqual({ allowed: false, reason: '今日は通知を休みます' })
    }
    const nextDay = request({ notBefore: later(1440), expiresAt: later(2880) })
    expect(reserveCoachNotification(resting, nextDay, guard(nextDay), later(1440)).decision.allowed).toBe(true)
  })
  it('未送信の予約も共通上限を占有し、別トリガー・別宛先で迂回しない', () => {
    let initial = policyPatch(state(), { dailyCap: 2 })
    for (let index = 0; index < 2; index++) {
      const next = request({ id: `n${index}`, target: { kind: 'task', id: `t${index}`, revision: 1 }, purpose: index ? 'deadline_near' : 'reminder' })
      initial = reserveCoachNotification(initial, next, guard(next), at).state
    }
    const next = request({ id: 'overflow', target: { kind: 'task', id: 'other', revision: 1 }, purpose: 'checkin_due', destinationIds: ['os'] })
    expect(reserveCoachNotification(initial, next, guard(next), at).decision).toMatchObject({ allowed: false, reason: expect.stringContaining('1日上限') })
    expect(initial.intents).toHaveLength(2)
  })
  it('同じ論理通知をアプリ内・OSの1件で数え、別IDでも重複を作らない', () => {
    const first = reserved(), otherId = request({ id: 'new-id', destinationIds: ['os'] })
    expect(reserveCoachNotification(first, otherId, guard(otherId), later(60)).intent).toBeNull()
    expect(first.intents).toHaveLength(1); expect(first.intents[0].deliveries).toHaveLength(2)
  })
  it('静かな時間の跨日境界と本人のタイムゾーンを使い、緊急扱いでも解除しない', () => {
    const start = '2026-10-01T12:59:00.000Z', midnight = '2026-10-01T13:00:00.000Z', end = '2026-10-01T23:00:00.000Z'
    for (const [clock, allowed] of [[start, true], [midnight, false], [end, true]] as const) {
      const next = request({ purpose: 'github_failed', notBefore: start, expiresAt: '2026-10-02T03:00:00.000Z' })
      expect(reserveCoachNotification(state(), next, guard(next), clock).decision.allowed).toBe(allowed)
    }
    expect(notificationLocalClock('2026-11-01T06:30:00.000Z', 'America/New_York')).toEqual({ day: '2026-11-01', time: '01:30' })
  })
  it('同じ対象の別目的も60分抑止し、本人が開始したBug Meの30分と最大回数・期限を守る', () => {
    const initial = reserved(), next = request({ id: 'deadline', purpose: 'deadline_near', ruleWindow: 'window2' })
    expect(reserveCoachNotification(initial, next, guard(next), later(59)).intent).toBeNull()
    expect(reserveCoachNotification(initial, next, guard(next), later(60)).intent).not.toBeNull()
    const bug = request({ id: 'bug', purpose: 'bug-me', ruleWindow: 'bug-window', intervalMinutes: 30, maxCount: 3, endDate: '2026-10-01' })
    expect(reserveCoachNotification(initial, bug, guard(bug), later(29)).intent).toBeNull()
    expect(reserveCoachNotification(initial, bug, guard(bug), later(30)).intent).not.toBeNull()
    expect(reserveCoachNotification(state(), bug, { ...guard(bug), rule: { ...guard(bug).rule, sentCount: 3 } }, at).intent).toBeNull()
    const tomorrowBug = { ...bug, expiresAt: later(2880) }
    expect(reserveCoachNotification(state(), tomorrowBug, guard(tomorrowBug), later(1440)).decision).toMatchObject({ allowed: false, reason: expect.stringContaining('期限') })
  })
  it('本文生成中のepoch・本人・dataset・資料許可変更を送信直前に拒否する', () => {
    const initial = reserved(), intent = initial.intents[0]
    for (const patch of [{ authorityEpoch: 5 }, { sourcePermissionRevision: 3 }, { ownerId: 'other' }, { datasetId: 'restored' }]) expect(revalidateCoachNotification(initial, intent, { ...guard(), ...patch }, at).allowed).toBe(false)
    expect(revalidateCoachNotification(policyPatch(initial, { dailyCap: 1 }), intent, guard(), at).allowed).toBe(false)
  })
  it('完了・取消・変更・ルール停止で送信待ちの全チャンネルを取り消す', () => {
    for (const nextGuard of [{ ...guard(), target: { ...guard().target, active: false } }, { ...guard(), target: { ...guard().target, revision: 2 } }, { ...guard(), rule: { ...guard().rule, active: false } }]) {
      const result = beginCoachNotificationDelivery(reserved(), 'notification', 'os', 'attempt', nextGuard, at)
      expect(result.payload).toBeNull(); expect(result.state.intents[0].deliveries.every(item => item.state === 'canceled')).toBe(true)
    }
  })
  it('宛先の許可・接続と根拠の通知/開示許可を個別に再検査する', () => {
    const req = request({ sourceRefs: [{ id: 'source', revision: 2, permissionRevision: 1 }] }), source = { id: 'source', revision: 2, permissionRevision: 1, active: true, notify: true, disclose: false }
    expect(reserveCoachNotification(state(), req, { ...guard(req), availableDestinationIds: ['in-app'], sources: [source] }, at).intent).toBeNull()
    expect(reserveCoachNotification(state(), req, { ...guard(req), sources: [{ ...source, notify: false }] }, at).intent).toBeNull()
    const shared = policyPatch(state(), { destinations: [...state().policy.destinations, { id: 'team', channel: 'messenger', label: '共同チャンネル', approved: true, shared: true, permissionRevision: 1 }] })
    const team = { ...req, destinationIds: ['team'] }, teamGuard = { ...guard(team), availableDestinationIds: ['team'], sources: [source] }
    expect(reserveCoachNotification(shared, team, teamGuard, at).intent).toBeNull()
    const accepted = reserveCoachNotification(shared, team, { ...teamGuard, sources: [{ ...source, disclose: true }] }, at)
    expect(accepted.intent).not.toBeNull()
    expect(revalidateCoachNotification(accepted.state, accepted.intent!, { ...teamGuard, sources: [{ ...source, disclose: true, permissionRevision: 2 }] }, at).allowed).toBe(false)
  })
  it('外部サービスへの同報と未許可fallbackを拒否する', () => {
    const initial = policyPatch(state(), { destinations: [...state().policy.destinations, { id: 'messenger', channel: 'messenger', label: '本人宛', approved: true, shared: false, permissionRevision: 0 }] })
    const req = request({ destinationIds: ['os', 'messenger'] })
    expect(reserveCoachNotification(initial, req, { ...guard(req), availableDestinationIds: ['os', 'messenger'] }, at).decision).toMatchObject({ allowed: false, reason: expect.stringContaining('同報') })
    const blocked = request({ destinationIds: ['unapproved'] })
    expect(reserveCoachNotification(initial, blocked, { ...guard(blocked), availableDestinationIds: ['unapproved'] }, at).intent).toBeNull()
  })
  it('送信権は1回だけ確保し、不明な結果を再送・到着済みとしない', () => {
    const initial = reserved(), begin = beginCoachNotificationDelivery(initial, 'notification', 'os', 'attempt1', guard(), at)
    expect(begin.payload?.notificationId).toBe('notification')
    expect(beginCoachNotificationDelivery(begin.state, 'notification', 'os', 'attempt2', guard(), at).payload).toBeNull()
    const unknown = settleCoachNotificationDelivery(begin.state, 'notification', 'os', 'attempt1', 'delivery_unknown', at)
    expect(unknown.intents[0].deliveries.find(item => item.destinationId === 'os')?.state).toBe('delivery_unknown')
    expect(beginCoachNotificationDelivery(unknown, 'notification', 'os', 'attempt3', guard(), at).payload).toBeNull()
    expect(settleCoachNotificationDelivery(begin.state, 'notification', 'os', 'stale-attempt', 'accepted_by_provider', at)).toEqual(begin.state)
  })
  it('AI停止時は同じ事実の定型文を使い、保存済みAI文と区別する', () => {
    const digest = 'a'.repeat(64), req = request({ purpose: 'deadline_near', text: { factual: '登録済みの期限を確認してください', savedAI: '以前AIで生成した文面', savedAIModel: 'model/a', factsDigest: digest } }), initial = reserved(req)
    expect(beginCoachNotificationDelivery(initial, req.id, 'os', 'ai', { ...guard(req), factsDigest: digest, aiModel: 'model/a' }, at).payload).toMatchObject({ body: req.text.savedAI, provenance: 'saved-ai' })
    expect(beginCoachNotificationDelivery(initial, req.id, 'os', 'off', { ...guard(req), aiEnabled: false, factsDigest: digest, aiModel: 'model/a' }, at).payload).toMatchObject({ body: req.text.factual, provenance: 'factual-template' })
    // The owner switched models after the wording was saved: the saved text is kept but not used.
    expect(beginCoachNotificationDelivery(initial, req.id, 'os', 'switched', { ...guard(req), factsDigest: digest, aiModel: 'model/b' }, at).payload).toMatchObject({ body: req.text.factual, provenance: 'factual-template' })
    expect(beginCoachNotificationDelivery(initial, req.id, 'os', 'nomodel', { ...guard(req), factsDigest: digest, aiModel: null }, at).payload).toMatchObject({ body: req.text.factual, provenance: 'factual-template' })
    // Facts changed after the wording was saved (or no digest recomputed): the factual template is used.
    expect(beginCoachNotificationDelivery(initial, req.id, 'os', 'changed', { ...guard(req), factsDigest: 'b'.repeat(64) }, at).payload).toMatchObject({ body: req.text.factual, provenance: 'factual-template' })
    const unbound = request({ id: 'unbound', purpose: 'deadline_near', target: { kind: 'task', id: 'other', revision: 1 }, text: { factual: '登録済みの期限', savedAI: '束縛のないAI文' } })
    expect(beginCoachNotificationDelivery(reserved(unbound), unbound.id, 'os', 'x', { ...guard(unbound), factsDigest: digest }, at).payload).toMatchObject({ provenance: 'factual-template' })
  })
  it('共有先では私的タスク名・保存済みAI文を送らない', () => {
    const initial = policyPatch(state(), { destinations: [{ id: 'shared', channel: 'messenger', label: '共有', approved: true, shared: true, permissionRevision: 0 }] })
    const req = request({ destinationIds: ['shared'], text: { factual: '秘密のタスク名', savedAI: '秘密の会話' } }), checked = { ...guard(req), availableDestinationIds: ['shared'] }
    const reservation = reserveCoachNotification(initial, req, checked, at)
    expect(beginCoachNotificationDelivery(reservation.state, req.id, 'shared', 'send', checked, at).payload).toMatchObject({ body: '確認事項があります。michiアプリで確認してください。', provenance: 'factual-template' })
  })
  it('タイマー・本人への返信は能動通知cap/休みから独立するがmuteを尊重する', () => {
    const initial = policyPatch(state(), { dailyCap: 0, restDays: ['2026-10-01'] })
    for (const [purpose, category] of [['focus_ended', 'timer'], ['direct_reply', 'reply']] as const) {
      const req = request({ purpose, category })
      expect(reserveCoachNotification(initial, req, guard(req), at).intent).not.toBeNull()
      expect(reserveCoachNotification(policyPatch(initial, { enabled: false }), req, guard(req), at).intent).toBeNull()
      expect(reserveCoachNotification(policyPatch(initial, { mutedTargets: ['task'] }), req, guard(req), at).intent).toBeNull()
    }
    expect(() => validateNotificationRequest(request({ purpose: 'deadline_near', category: 'reply' }))).toThrow('迂回')
  })
  it('停止したqueued/sendingは取消し、受付済み・結果不明の事実は残す', () => {
    const begun = beginCoachNotificationDelivery(reserved(), 'notification', 'os', 'attempt', guard(), at).state
    const stopped = cancelPendingCoachNotifications(begun, '停止', at)
    expect(stopped.intents[0].deliveries.every(item => item.state === 'canceled')).toBe(true)
    const accepted = settleCoachNotificationDelivery(begun, 'notification', 'os', 'attempt', 'accepted_by_provider', at)
    expect(cancelPendingCoachNotifications(accepted, '停止', at).intents[0].deliveries.find(item => item.destinationId === 'os')?.state).toBe('accepted_by_provider')
    expect(reserveCoachNotification(stopped, request(), guard(), at).intent?.id).toBe('notification')
  })
  it('復元データの予約と旧許可を実行せず、厳密なバックアップ検証を行う', () => {
    const initial = reserved(), restored = restoreCoachNotificationState(initial, 'new-owner', 'new-dataset', at)
    expect(restored.intents[0].deliveries.every(item => item.state === 'canceled')).toBe(true)
    expect(() => validateCoachNotificationState(restored, 'new-owner', 'new-dataset')).not.toThrow()
    expect(() => validateCoachNotificationState({ ...initial, grant: true })).toThrow()
    expect(() => validateCoachNotificationState({ ...initial, intents: [...initial.intents, initial.intents[0]] })).toThrow('重複')
    expect(() => validateCoachNotificationState({ ...initial, policy: { ...initial.policy, dailyCap: 100 } })).toThrow()
    expect(() => validateCoachNotificationState(initial, 'other-owner')).toThrow()
  })
})
