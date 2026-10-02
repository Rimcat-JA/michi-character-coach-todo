import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput, updateTask } from './commands'
import { emptyScore } from './domain'
import { validateNotificationText, type NotificationTextRequest } from './notification-text'
import { calendarFactual, deadlineFactual, deadlineFacts, factsDigest, replanFactual, slippedTasks } from './coach-facts'
import { coachNotificationGuardFor, coachNotificationStateFor, currentCoachNotificationGuard, prepareCoachNotificationDelivery, queueCoachNotification, restCoachNotificationsToday, saveCoachNotificationAIText, setCoachNotificationPolicy, setCoachNotificationTriggers } from './coach-notification-save'
import { beginCoachNotificationDelivery, coachTriggersOf, savedAIUsable } from './coach-notifications'
import { deadlineNearRequests, deliverPendingCoachTriggers, runCoachTriggers, type OSNotificationPayload } from './coach-triggers'
import fixtures from './notification-fact-fixtures.json'
import { captureSnapshot, restoreBackup } from './backup'
import { validateSnapshot } from './backup-validation'
import { readCoachNotification } from './coach-notification-save'
import { validateCoachNotificationState } from './coach-notifications'

const facts = { purpose: 'deadline_near' as const, title: '週次報告書', dueDate: '2026-10-02', scheduledDate: '2026-10-01' }
describe('N07 AI通知文の検査（保存前）', () => {
  it('事実のタスク名と日付だけの一文を受け付ける', () => {
    expect(validateNotificationText(' 週次報告書の期限は2026-10-02です。落ち着いて確認しましょう。 ', facts)).toBe('週次報告書の期限は2026-10-02です。落ち着いて確認しましょう。')
    expect(validateNotificationText('週次報告書は10月2日が期限です。', facts)).toBe('週次報告書は10月2日が期限です。')
  })
  it.each([
    ['新しい日付', '週次報告書の期限は2026-10-05です。'],
    ['新しい数字', '週次報告書を3回に分けて進めましょう。'],
    ['別のタスク', '週次報告書の期限です。請求書も確認しましょう。'],
    ['URL', '週次報告書の期限です。https://example.com を確認'],
    ['実行済みの主張', '週次報告書の予定を変更しました。'],
    ['完了の主張', '週次報告書は完了しました。'],
    ['新しい義務', '週次報告書の期限です。ついでに資料も整理しましょう。'],
    ['相対日付', '週次報告書の期限は明日です。'],
    ['改行', '週次報告書の期限です。\n確認しましょう。'],
    ['タスク名なし', '期限が近い作業があります。'],
    ['200字超', `週次報告書${'あ'.repeat(200)}`],
  ])('%sを拒否する', (_label, text) => {
    expect(() => validateNotificationText(text, facts, ['請求書'])).toThrow()
  })
  const due = { ...facts, dueDate: '2026-10-05' }
  it.each([
    ['入れ替えた日付', '週次報告書の期限は2026-05-10です。'],
    ['入れ替えた月日', '週次報告書の期限は5月10日です。'],
    ['事実にない時刻', '週次報告書は10時に確認しましょう。'],
    ['事実にない時刻（コロン）', '週次報告書は10:05に確認しましょう。'],
    ['期限切れの主張', '週次報告書は期限を過ぎています。'],
    ['期限なしの主張', '週次報告書は期限がありません。'],
    ['事実にない残り日数', '週次報告書は残り5日です。'],
  ])('期限 2026-10-05 の事実で%sを拒否する', (_label, text) => {
    expect(() => validateNotificationText(text, due)).toThrow()
  })
  it('期限日そのものの表記（ISO・年月日・月日・M/D、ゼロ埋め有無）とタイトル内の数字は受け付ける', () => {
    for (const text of ['週次報告書の期限は2026-10-05です。', '週次報告書の期限は2026年10月5日です。', '週次報告書は10月05日が期限です。', '週次報告書は10/5が期限です。']) expect(validateNotificationText(text, due)).toBe(text)
    expect(validateNotificationText('第3四半期報告の期限は10月5日です。', { ...due, title: '第3四半期報告' })).toBe('第3四半期報告の期限は10月5日です。')
  })
  it('事実の定型文・digest・件数はOS側（main）と同じfixtureに一致する', async () => {
    for (const item of fixtures.deadline) {
      expect(deadlineFactual(item.title, item.dueDate)).toBe(item.factual)
      expect(await factsDigest({ purpose: 'deadline_near', title: item.title, dueDate: item.dueDate, scheduledDate: item.scheduledDate })).toBe(item.digest)
    }
    for (const item of fixtures.calendar) expect(calendarFactual(item.title, item.from, item.to)).toBe(item.factual)
    for (const item of fixtures.replan) { expect(slippedTasks(item.tasks as never[], item.day)).toHaveLength(item.count); expect(replanFactual(item.count)).toBe(item.factual) }
  })
})

describe('N07 AI通知文の生成・保存・縮退（合成transportのみ）', () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone, at = (hour: number, minute = 0) => new Date(2026, 9, 1, hour, minute).toISOString()
  let id: string
  beforeEach(async () => {
    await db.delete(); await db.open(); await ensureSettings()
    await db.settings.update('main', { notifications: true, aiEnabled: true, aiModel: 'synthetic/qa-model' }); await setCoachNotificationPolicy({ timezone: zone })
    await setCoachNotificationTriggers({ deadlineNear: { enabled: true, leadDays: 1, time: '09:00', os: true }, aiText: true })
    id = await createTask({ ...newTaskInput(), title: '週次報告書', scheduledDate: '2026-10-01', dueDate: '2026-10-02', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } })
    await createTask({ ...newTaskInput(), title: '請求書', score: emptyScore() })
  })
  const intent = async () => coachNotificationStateFor((await db.settings.get('main'))!).intents[0]
  it('予約が通った後にだけ事実セットを送り、検査済みの文面をモデル名・digest付きで保存してOSへ送る', async () => {
    const notificationText = vi.fn(async (request: NotificationTextRequest) => `${request.facts.title}の期限は${request.facts.dueDate}です。`), notify = vi.fn(async (_payload: OSNotificationPayload) => true)
    await runCoachTriggers({ notify, notificationText }, at(9, 30))
    expect(notificationText).toHaveBeenCalledTimes(1)
    expect(notificationText.mock.calls[0][0]).toEqual({ model: 'synthetic/qa-model', facts: { purpose: 'deadline_near', title: '週次報告書', dueDate: '2026-10-02', scheduledDate: '2026-10-01' }, character: expect.any(Object) })
    expect(JSON.stringify(notificationText.mock.calls[0][0])).not.toContain('請求書')
    const saved = await intent(), task = (await db.tasks.get(id))!
    expect(saved.text).toEqual({ factual: '期限が近いタスク: 週次報告書（期限 2026-10-02）', savedAI: '週次報告書の期限は2026-10-02です。', savedAIModel: 'synthetic/qa-model', factsDigest: await factsDigest(deadlineFacts(task)) })
    expect(notify.mock.calls[0][0]).toMatchObject({ body: '週次報告書の期限は2026-10-02です。', provenance: 'saved-ai' })
  })
  it.each(['rest', 'quiet', 'cap', 'stop'] as const)('予約が拒否されるとAIを一度も呼ばない（%s）', async mode => {
    if (mode === 'rest') await restCoachNotificationsToday(at(9))
    if (mode === 'quiet') await setCoachNotificationPolicy({ quietStart: '09:00', quietEnd: '10:00' })
    if (mode === 'cap') await setCoachNotificationPolicy({ dailyCap: 0 })
    if (mode === 'stop') await setCoachNotificationPolicy({ enabled: false })
    const notificationText = vi.fn(async () => '週次報告書の期限は2026-10-02です。')
    await runCoachTriggers({ notificationText }, at(9, 30))
    expect(notificationText).toHaveBeenCalledTimes(0)
  })
  it.each([
    ['予算拒否', async () => { throw new Error('自動AI処理の利用予算は0です') }],
    ['タイムアウト', async () => { throw new Error('OpenRouterへ接続できませんでした') }],
    ['検査不合格', async () => '週次報告書の予定を変更しました。'],
  ])('%sは事実の定型文で送る', async (_label, transport) => {
    const notify = vi.fn(async (_payload: OSNotificationPayload) => true)
    await runCoachTriggers({ notify, notificationText: transport }, at(9, 30))
    expect((await intent()).text.savedAI).toBeNull()
    expect(notify.mock.calls[0][0]).toMatchObject({ body: '期限が近いタスク: 週次報告書（期限 2026-10-02）', provenance: 'factual-template' })
  })
  it('生成後・送信前にAIをOFFにすると事実の定型文へ縮退する', async () => {
    await runCoachTriggers({ notificationText: async () => '週次報告書の期限は2026-10-02です。' }, at(9, 30))
    expect((await intent()).text.savedAI).not.toBeNull()
    await db.settings.update('main', { aiEnabled: false })
    const notify = vi.fn(async (_payload: OSNotificationPayload) => true)
    await deliverPendingCoachTriggers({ notify }, at(9, 31))
    expect(notify.mock.calls[0][0]).toMatchObject({ body: '期限が近いタスク: 週次報告書（期限 2026-10-02）', provenance: 'factual-template' })
  })
  it('生成後・送信前にモデルを切り替えると事実の定型文へ縮退し、保存済み文面は書き換えない', async () => {
    await runCoachTriggers({ notificationText: async () => '週次報告書の期限は2026-10-02です。' }, at(9, 30))
    await db.settings.update('main', { aiModel: 'synthetic/other-model' })
    const notify = vi.fn(async (_payload: OSNotificationPayload) => true)
    await deliverPendingCoachTriggers({ notify }, at(9, 31))
    expect(notify.mock.calls[0][0]).toMatchObject({ body: '期限が近いタスク: 週次報告書（期限 2026-10-02）', provenance: 'factual-template' })
    expect((await intent()).text).toMatchObject({ savedAI: '週次報告書の期限は2026-10-02です。', savedAIModel: 'synthetic/qa-model' })
  })
  it('アプリ内に表示済みの通知はAI文面をOFFにしても保存済み文面を残し、生成後にタイトル・期限が変わった通知は送らない', async () => {
    await runCoachTriggers({ notificationText: async () => '週次報告書の期限は2026-10-02です。' }, at(9, 30))
    const reserved = await intent(), task = (await db.tasks.get(id))!
    await updateTask(id, task.revision, { ...task, title: '月次報告書' })
    expect(savedAIUsable(reserved, { aiEnabled: true, aiModel: 'synthetic/qa-model', factsDigest: (await currentCoachNotificationGuard(reserved.id, at(9, 31)))?.factsDigest ?? null })).toBe(false)
    expect(await prepareCoachNotificationDelivery(reserved.id, 'os', at(9, 31))).toBeNull()
    await setCoachNotificationTriggers({ aiText: false })
    expect((await intent()).text).toEqual(reserved.text)
  })
  it('AI文面をOFFにすると、まだどこにも表示していない予約からだけ保存済み文面を外す', async () => {
    // A worded reservation before any delivery (e.g. the app closed between wording and delivery), built through the public producers.
    const settings = (await db.settings.get('main'))!, task = (await db.tasks.get(id))!, [request] = deadlineNearRequests([task], coachTriggersOf(coachNotificationStateFor(settings)), settings, at(9, 30), zone)
    const reserved = (await queueCoachNotification(request, coachNotificationGuardFor(settings, { ...request.target, active: true }, { id: request.ruleId, revision: request.ruleRevision, active: true, sentCount: 0 }), at(9, 30)))!
    expect(await saveCoachNotificationAIText(reserved.id, '週次報告書の期限は2026-10-02です。', 'synthetic/qa-model', await factsDigest(deadlineFacts(task)), at(9, 30))).toBe(true)
    await setCoachNotificationTriggers({ aiText: false })
    expect((await intent()).text).toEqual({ factual: reserved.text.factual, savedAI: null })
  })
  it('OSとアプリ内の両方へ配信済みなら、AI文面をOFFにしても文面・モデル・digestの記録を書き換えない', async () => {
    const notify = vi.fn(async (_payload: OSNotificationPayload) => true)
    await runCoachTriggers({ notify, notificationText: async () => '週次報告書の期限は2026-10-02です。' }, at(9, 30))
    const delivered = await intent(), task = (await db.tasks.get(id))!
    expect(delivered.deliveries.map(item => item.state)).toEqual(['accepted_by_provider', 'accepted_by_provider'])
    await setCoachNotificationTriggers({ aiText: false })
    expect((await intent()).text).toEqual({ factual: '期限が近いタスク: 週次報告書（期限 2026-10-02）', savedAI: '週次報告書の期限は2026-10-02です。', savedAIModel: 'synthetic/qa-model', factsDigest: await factsDigest(deadlineFacts(task)) })
  })
  it('共有先には保存済みAI文も私的タスク名も送らない', async () => {
    await runCoachTriggers({ notificationText: async () => '週次報告書の期限は2026-10-02です。' }, at(9, 30))
    const settings = (await db.settings.get('main'))!, state = coachNotificationStateFor(settings), reserved = state.intents[0]
    const shared = { ...state, policy: { ...state.policy, destinations: state.policy.destinations.map(item => item.id === 'os' ? { ...item, shared: true } : item) } }
    const guard = (await currentCoachNotificationGuard(reserved.id, at(9, 31)))!
    expect(beginCoachNotificationDelivery(shared, reserved.id, 'os', 'attempt', guard, at(9, 31)).payload).toMatchObject({ body: '確認事項があります。michiアプリで確認してください。', provenance: 'factual-template' })
  })
})

describe('N07 通知データの後方互換とバックアップ', () => {
  const at = new Date(2026, 9, 1, 9, 30).toISOString()
  beforeEach(async () => {
    await db.delete(); await db.open(); await ensureSettings()
    await db.settings.update('main', { notifications: true, aiEnabled: true, aiModel: 'synthetic/qa-model' }); await setCoachNotificationPolicy({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  })
  it('きっかけ設定・既読・保存済みAI文はbackupで検証・復元され、待機中の予約は再実行しない', async () => {
    await setCoachNotificationTriggers({ deadlineNear: { enabled: true, leadDays: 1, time: '09:00', os: true }, aiText: true })
    await createTask({ ...newTaskInput(), title: '週次報告書', scheduledDate: '2026-10-01', dueDate: '2026-10-02', score: emptyScore() })
    const [intent] = await runCoachTriggers({ notificationText: async () => '週次報告書の期限は2026-10-02です。' }, at)
    await readCoachNotification(intent.id, at)
    const snapshot = await captureSnapshot()
    expect(() => validateSnapshot(snapshot)).not.toThrow()
    await restoreBackup(snapshot)
    const restored = coachNotificationStateFor((await db.settings.get('main'))!)
    expect(restored.triggers).toMatchObject({ deadlineNear: { enabled: true }, aiText: true })
    expect(restored.intents[0]).toMatchObject({ readAt: at, text: { savedAI: '週次報告書の期限は2026-10-02です。', savedAIModel: 'synthetic/qa-model' } })
    expect(restored.intents[0].deliveries.find(item => item.destinationId === 'os')?.state).toBe('canceled')
  })
  it('復元は、この端末でOFFにしたAI文面・期限のきっかけを再びONにしない（AI・OS通知は呼ばない）', async () => {
    await setCoachNotificationTriggers({ deadlineNear: { enabled: true, leadDays: 1, time: '09:00', os: true }, aiText: true, trayResident: true })
    await createTask({ ...newTaskInput(), title: '週次報告書', scheduledDate: '2026-10-01', dueDate: '2026-10-02', score: emptyScore() })
    const snapshot = await captureSnapshot()
    await setCoachNotificationTriggers({ deadlineNear: { enabled: false, leadDays: 1, time: '09:00', os: false }, aiText: false, trayResident: false })
    await restoreBackup(snapshot)
    expect(coachNotificationStateFor((await db.settings.get('main'))!).triggers).toMatchObject({ aiText: false, deadlineNear: { enabled: false, os: false }, trayResident: false })
    const notificationText = vi.fn(async () => '週次報告書の期限は2026-10-02です。'), notify = vi.fn(async (_payload: OSNotificationPayload) => true)
    await runCoachTriggers({ notify, notificationText }, at)
    expect(notificationText).toHaveBeenCalledTimes(0)
    expect(notify).toHaveBeenCalledTimes(0)
  })
  it('旧形式（きっかけ・既読なし）を受け付け、不正な任意項目は拒否する', async () => {
    const state = coachNotificationStateFor((await db.settings.get('main'))!)
    expect(() => validateCoachNotificationState(state)).not.toThrow()
    expect(state.triggers).toBeUndefined()
    expect(() => validateCoachNotificationState({ ...state, triggers: { aiText: true } })).toThrow('きっかけ')
    expect(() => validateCoachNotificationState({ ...state, triggers: { deadlineNear: { enabled: true, leadDays: 8, time: '09:00', os: false }, calendarChange: { enabled: false, os: false }, replanPrompt: { enabled: false, time: '09:00', os: false }, aiText: false, trayResident: false } })).toThrow('きっかけ')
    await setCoachNotificationTriggers({ deadlineNear: { enabled: true, leadDays: 1, time: '09:00', os: false } })
    await createTask({ ...newTaskInput(), title: '週次報告書', dueDate: '2026-10-02', score: emptyScore() })
    const [intent] = await runCoachTriggers({}, at), current = coachNotificationStateFor((await db.settings.get('main'))!)
    expect(() => validateCoachNotificationState({ ...current, intents: [{ ...current.intents[0], readAt: 'yesterday' }] })).toThrow('確認日時')
    expect(() => validateCoachNotificationState({ ...current, intents: [{ ...intent, ...current.intents[0], text: { ...current.intents[0].text, factsDigest: 'not-a-digest' } }] })).toThrow()
    expect(() => validateCoachNotificationState({ ...current, intents: [{ ...current.intents[0], text: { ...current.intents[0].text, extra: 1 } }] })).toThrow()
  })
})
