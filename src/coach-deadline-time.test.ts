import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput, updateTask } from './commands'
import { emptyScore, taskDueAt, type Settings, type Task } from './domain'
import { createReminder, deadlineReminderAt, dispatchDueReminders } from './reminders'
import { coachNotificationStateFor, prepareCoachNotificationDelivery, setCoachNotificationPolicy, setCoachNotificationTriggers } from './coach-notification-save'
import { defaultCoachTriggers, type CoachTriggerSettings } from './coach-notifications'
import { deadlineNearRequests, runCoachTriggers } from './coach-triggers'
import { deadlineFactual, deadlineFacts, deadlineLabel, factsDigest } from './coach-facts'
import { validateNotificationText } from './notification-text'
import { applyChangeSet, approveChangeSetFromUI, clearChangeSetAuthority, prepareTaskChanges, prepareUndoFromAudits, type ChangeContext, type PreparedChangeSet } from './change-set'
import { latestCoachChange } from './change-history'
import { COACH_MEDIATED_REASONS } from './automation-policy'
import { prepareReplanChangeSet, replanCandidates } from './replan-candidates'
import { scheduleOnlyPatch } from './coach-task-change'
import { confirmTaskInstructionFromUI } from './task-user-instruction'
import { applyCoachSplitFromUI, buildCoachSplitProposal, consultationKind } from './coach-split'
import { groundedRoutinePattern } from './routine-assist'
import RoutineAssistView from './RoutineAssistView'
import { calendarFixture } from './calendar-test-fixtures'
import fixtures from './notification-fact-fixtures.json'

const zone = 'Asia/Tokyo'
const clock17 = taskDueAt('2026-10-02', '17:00', zone)
const deadline = (patch: Partial<CoachTriggerSettings['deadlineNear']> = {}) => ({ enabled: true, leadDays: 1, time: '09:00', os: true, ...patch })
function humanClick() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
async function timedTask(title = '申請書の提出', dueAt = clock17, dueDate = '2026-10-02', dueTimezone = zone) {
  return createTask({ ...newTaskInput(), title, scheduledDate: '2026-10-01', dueDate, dueAt, dueTimezone, score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } })
}
const intents = async () => coachNotificationStateFor((await db.settings.get('main'))!).intents
let owner: ChangeContext
beforeEach(async () => {
  clearChangeSetAuthority(); await db.delete(); await db.open()
  const settings = await ensureSettings()
  await db.settings.update('main', { notifications: true }); await setCoachNotificationPolicy({ timezone: zone })
  owner = { principal: { id: settings.profileId, kind: 'human' }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: ['title', 'notes', 'scheduledDate', 'dueDate', 'dueAt', 'manualPoints'], sourceRevisions: [] }
})
afterEach(() => { vi.unstubAllGlobals() })
const approveAndApply = async (prepared: PreparedChangeSet, key: string, fields: string[] = []) => applyChangeSet(prepared, await approveChangeSetFromUI(prepared, owner, humanClick(), fields as never), owner, key)

describe('N05×N07 時刻付き締め切り（dueAt）の deadline_near と事実', () => {
  it('事実文は締め切り時刻を含み、予約の有効期限は dueAt。dueAt を過ぎたら通知しない', async () => {
    const id = await timedTask(); await setCoachNotificationTriggers({ deadlineNear: deadline() })
    const [intent] = await runCoachTriggers({}, '2026-10-01T00:30:00.000Z')
    expect(intent).toMatchObject({ purpose: 'deadline_near', target: { id }, ruleWindow: '2026-10-02', expiresAt: '2026-10-02T08:00:00.000Z', text: { factual: '期限が近いタスク: 申請書の提出（期限 2026-10-02 17:00）' } })
    const task = (await db.tasks.get(id))!, triggers = { ...defaultCoachTriggers(), deadlineNear: deadline() }, settings = { notifications: true }
    expect(deadlineNearRequests([task], triggers, settings, '2026-10-02T07:59:00.000Z', zone)).toHaveLength(1)
    expect(deadlineNearRequests([task], triggers, settings, '2026-10-02T08:00:00.000Z', zone)).toEqual([])
    // A date-only deadline of the same day still runs to local midnight.
    expect(deadlineNearRequests([{ ...task, dueAt: null, dueTimezone: null }], triggers, settings, '2026-10-02T08:00:00.000Z', zone)[0]).toMatchObject({ expiresAt: '2026-10-02T15:00:00.000Z', text: { factual: '期限が近いタスク: 申請書の提出（期限 2026-10-02）' } })
  })
  it('通知時刻が締め切り時刻より後なら1時間前へ寄せ、別のタイムゾーンの締め切りはゾーン名を添える', async () => {
    const at10 = taskDueAt('2026-10-01', '10:00', zone), triggers = { ...defaultCoachTriggers(), deadlineNear: deadline({ leadDays: 0, time: '11:00' }) }
    const task = { ...newTaskInput(), id: 't', generationKey: 'g', routineId: null, title: '朝の提出', dueDate: '2026-10-01', dueAt: at10, dueTimezone: zone, effectivePoints: null, assessmentId: 'a', status: 'open', revision: 1, createdAt: '', updatedAt: '', deletedAt: null } as Task
    const [request] = deadlineNearRequests([task], triggers, { notifications: true }, '2026-10-01T00:10:00.000Z', zone)
    expect(request).toMatchObject({ notBefore: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-01T01:00:00.000Z' })
    const abroad = { ...task, dueDate: '2026-10-01', dueAt: taskDueAt('2026-10-01', '17:00', 'America/New_York'), dueTimezone: 'America/New_York' }
    expect(deadlineLabel(abroad, zone)).toBe('2026-10-01 17:00（America/New_York）')
    expect(deadlineLabel(abroad, 'America/New_York')).toBe('2026-10-01 17:00')
  })
  it('AIに渡す事実は時刻を含み（日付だけの締め切りは従来どおり）、検査は締め切り時刻だけを数字として許す', async () => {
    const task = (await db.tasks.get(await timedTask('週次報告書')))!, facts = deadlineFacts(task)
    expect(facts).toEqual({ purpose: 'deadline_near', title: '週次報告書', dueDate: '2026-10-02', scheduledDate: '2026-10-01', dueTime: '17:00' })
    expect(deadlineFacts({ ...task, dueAt: null, dueTimezone: null })).not.toHaveProperty('dueTime')
    expect(await factsDigest(facts)).not.toBe(await factsDigest(deadlineFacts({ ...task, dueAt: null, dueTimezone: null })))
    for (const text of ['週次報告書の期限は10月2日17:00です。', '週次報告書は10月2日の17時までです。', '週次報告書は2026-10-02 17時00分が期限です。']) expect(validateNotificationText(text, facts)).toBe(text)
    for (const text of ['週次報告書は10月2日18時までです。', '週次報告書は10月2日17時30分までです。']) expect(() => validateNotificationText(text, facts)).toThrow('事実にない数字')
    expect(() => validateNotificationText('週次報告書は10月2日17:00までです。', { ...facts, dueTime: undefined })).toThrow('事実にない数字')
  })
  it('時刻付き締め切りの事実文・digest は main と共有する fixture に一致する', async () => {
    for (const item of fixtures.timedDeadline) {
      expect(deadlineFactual(item.title, deadlineLabel(item, item.timezone))).toBe(item.factual)
      expect(deadlineFacts(item).dueTime).toBe(item.dueTime)
      expect(await factsDigest(deadlineFacts(item))).toBe(item.digest)
    }
  })
})

describe('N05×N07 「締め切り時刻の30分前」リマインダーとコーチ通知は二重にしない', () => {
  it('本人の30分前リマインダーがある締め切りにはコーチの deadline_near を出さず、リマインダーだけが1回届く', async () => {
    const id = await timedTask(); await setCoachNotificationTriggers({ deadlineNear: deadline({ leadDays: 0 }) })
    const task = (await db.tasks.get(id))!
    expect(deadlineReminderAt(task, 30)).toBe('2026-10-02T07:30:00.000Z')
    await createReminder('once', id, deadlineReminderAt(task, 30), ['in-app'], new Date('2026-10-02T00:00:00.000Z'))
    expect(await runCoachTriggers({}, '2026-10-02T00:30:00.000Z')).toEqual([])
    expect(await dispatchDueReminders(new Date('2026-10-02T07:31:00.000Z'))).toHaveLength(1)
    expect(await runCoachTriggers({}, '2026-10-02T07:40:00.000Z')).toEqual([])
    expect((await intents()).map(intent => intent.purpose)).toEqual(['reminder'])
  })
  it('コーチ通知の予約後に本人が30分前リマインダーを作ると、待機中のコーチ通知は送らない', async () => {
    const id = await timedTask(); await setCoachNotificationTriggers({ deadlineNear: deadline({ leadDays: 0 }) })
    const [intent] = await runCoachTriggers({}, '2026-10-02T00:30:00.000Z')
    expect(intent.destinationIds).toContain('os')
    await createReminder('once', id, deadlineReminderAt((await db.tasks.get(id))!, 30), ['in-app'], new Date('2026-10-02T00:31:00.000Z'))
    expect(await prepareCoachNotificationDelivery(intent.id, 'os', '2026-10-02T00:32:00.000Z')).toBeNull()
  })
  it('本人が停止した（未送信の）リマインダーは覆いにならず、コーチの通知は通常どおり', async () => {
    const id = await timedTask(); await setCoachNotificationTriggers({ deadlineNear: deadline({ leadDays: 0 }) })
    const rule = await createReminder('once', id, deadlineReminderAt((await db.tasks.get(id))!, 30), ['in-app'], new Date('2026-10-02T00:00:00.000Z'))
    const settings = (await db.settings.get('main'))!
    await db.settings.update('main', { reminderState: { ...settings.reminderState!, rules: settings.reminderState!.rules.map(item => item.id === rule.id ? { ...item, enabled: false } : item) } })
    expect(await runCoachTriggers({}, '2026-10-02T00:30:00.000Z')).toHaveLength(1)
  })
})

describe('K05/N08×N05 コーチの再計画・移動・取り消しは dueAt を暗黙に変えない', () => {
  it('再計画候補は締め切り時刻を表示し、予定日だけを動かす。取り消しても dueAt はそのまま', async () => {
    const id = await timedTask('報告書', taskDueAt('2026-10-09', '17:00', zone), '2026-10-09')
    await updateTask(id, 1, { ...(await db.tasks.get(id))!, scheduledDate: '2026-09-29' })
    const settings = (await db.settings.get('main'))! as Settings, tasks = await db.tasks.toArray()
    const summary = replanCandidates({ tasks, dependencies: [], blocks: [], settings, today: '2026-10-01' })
    expect(summary.candidates[0]).toMatchObject({ taskId: id, dueDate: '2026-10-09', dueTime: '17:00', to: '2026-10-02' })
    const prepared = await prepareReplanChangeSet(summary.candidates, [id], settings)
    expect(prepared.changes.map(change => change.fields)).toEqual([['scheduledDate']])
    await approveAndApply(prepared, 'replan')
    expect(await db.tasks.get(id)).toMatchObject({ scheduledDate: '2026-10-02', dueDate: '2026-10-09', dueAt: '2026-10-09T08:00:00.000Z', dueTimezone: zone })
    const undo = await prepareUndoFromAudits(latestCoachChange(await db.audits.toArray()).map(fact => fact.auditId), owner)
    if (undo.status !== 'prepared') throw new Error(undo.status)
    expect(undo.prepared.changes[0].fields).toEqual(['scheduledDate'])
    await approveAndApply(undo.prepared, 'undo')
    expect(await db.tasks.get(id)).toMatchObject({ scheduledDate: '2026-09-29', dueDate: '2026-10-09', dueAt: '2026-10-09T08:00:00.000Z', dueTimezone: zone })
  })
  it('相談文の「明日に移して」（AIなし）は予定日だけ。締め切り時刻の変更は期限欄での本人指定へ回す', async () => {
    const task = (await db.tasks.get(await timedTask()))!
    expect(scheduleOnlyPatch(task, '明日に移して', '2026-10-01')).toEqual({ scheduledDate: '2026-10-02', notice: expect.stringContaining('締め切りは変えません') })
    expect(scheduleOnlyPatch(task, '締め切りを18時にして', '2026-10-01')).not.toHaveProperty('scheduledDate')
  })
  it('コーチ相談で変えた締め切り時刻（dueAt だけ）の取り消しは新しい本人指示が必要で、指示があれば元の時刻へ戻す', async () => {
    const id = await timedTask(), clock18 = { at: taskDueAt('2026-10-02', '18:00', zone), timezone: zone }
    const requests = [{ taskId: id, expectedRevision: 1, patch: { dueAt: clock18 } }]
    const instruction = await confirmTaskInstructionFromUI({ message: '締め切りを18:00に変更', referenceDate: '2026-10-01', timezone: zone, changes: requests }, owner, humanClick())
    const consult = await prepareTaskChanges(requests, { ...owner, allowedFields: ['dueAt'] }, COACH_MEDIATED_REASONS[1], instruction)
    await approveAndApply(consult, 'consult', ['dueAt'])
    expect(await db.tasks.get(id)).toMatchObject({ dueAt: clock18.at, dueDate: '2026-10-02' })
    const latest = latestCoachChange(await db.audits.toArray())
    expect(latest.map(fact => fact.fields)).toEqual([['dueAt']])
    await expect(prepareUndoFromAudits(latest.map(fact => fact.auditId), owner)).rejects.toMatchObject({ code: 'USER_INSTRUCTION_REQUIRED' })
    const current = (await db.tasks.get(id))!, back = [{ taskId: id, expectedRevision: current.revision, patch: { dueAt: { at: clock17, timezone: zone } } }]
    const again = await confirmTaskInstructionFromUI({ message: '締め切りを17:00に戻して', referenceDate: '2026-10-01', timezone: zone, changes: back }, owner, humanClick())
    const undo = await prepareUndoFromAudits(latest.map(fact => fact.auditId), owner, again)
    if (undo.status !== 'prepared') throw new Error(undo.status)
    expect(undo.prepared.changes[0]).toMatchObject({ fields: ['dueAt'], before: { dueAt: clock18 }, after: { dueAt: { at: clock17, timezone: zone } } })
    await approveAndApply(undo.prepared, 'undo-clock', ['dueAt'])
    expect(await db.tasks.get(id)).toMatchObject({ dueAt: clock17, dueTimezone: zone, dueDate: '2026-10-02' })
  })
  it('コーチの移動の後に本人が締め切り時刻を変えていれば、取り消しは上書きせず再差分を返す', async () => {
    const id = await timedTask()
    const move = await prepareTaskChanges([{ taskId: id, expectedRevision: 1, patch: { scheduledDate: '2026-10-02' } }], { ...owner, allowedFields: ['scheduledDate'] }, COACH_MEDIATED_REASONS[1])
    await approveAndApply(move, 'move')
    const moved = (await db.tasks.get(id))!
    await updateTask(id, moved.revision, { ...moved, dueAt: taskDueAt('2026-10-02', '12:00', zone), dueTimezone: zone })
    const undo = await prepareUndoFromAudits(latestCoachChange(await db.audits.toArray()).map(fact => fact.auditId), owner)
    expect(undo).toMatchObject({ status: 'conflict', taskId: id })
    expect((await db.tasks.get(id))!.dueAt).toBe(taskDueAt('2026-10-02', '12:00', zone))
  })
  it('コーチ経由の分割で作る子タスクは親の締め切り時刻を引き継ぐ', async () => {
    const id = await timedTask('資料作成'), parent = (await db.tasks.get(id))!, settings = (await db.settings.get('main'))!
    const proposal = buildCoachSplitProposal(parent, [{ name: '調査', points: 10 }, { name: '執筆', points: 15 }], '調査10ptと執筆15ptに分けて')
    const children = await applyCoachSplitFromUI(proposal, ['調査', '執筆'], { ownerId: settings.profileId, datasetId: settings.datasetId }, humanClick())
    expect((await db.tasks.bulkGet(children)).map(child => [child!.dueDate, child!.dueAt, child!.dueTimezone])).toEqual([['2026-10-02', clock17, zone], ['2026-10-02', clock17, zone]])
  })
})

describe('N08×N05 コーチ相談の周期は繰り返し規則・完了起点の周期設定へ渡す', () => {
  it.each([
    ['前回の完了から5日後に掃除', 'completion_relative'],
    ['2週間ごとに定例資料を作る', 'rrule'],
    ['第2火曜に会議準備', 'rrule'],
    ['毎月最終平日に経費精算', 'rrule'],
    ['隔月で棚卸し', 'rrule'],
    ['毎年4月の第1月曜に健康診断の予約', 'rrule'],
  ])('%s → routine（%s）', (text, kind) => {
    expect(consultationKind(text)).toBe('routine')
    expect(groundedRoutinePattern(text).kind).toBe(kind)
  })
  it.each(['金曜に移して', '3日後に移して', '明日に移して'])('%s は周期ではなく既存タスクの移動', text => {
    expect(consultationKind(text)).toBe('task')
  })
  it('周期設定の画面は相談文を引き継ぎ、本文からの読み取りと完了起点・繰り返し規則の選択肢を示す', async () => {
    const settings = (await db.settings.get('main'))!
    vi.stubGlobal('window', {})
    const html = renderToStaticMarkup(createElement(RoutineAssistView, { state: calendarFixture(), settings, initialMessage: '前回の完了から5日後に掃除', heading: '周期の設定として確認' }))
    expect(html).toContain('周期の設定として確認'); expect(html).toContain('前回の完了から5日後に掃除'); expect(html).toContain('本文から周期を読み取る')
    expect(html).toContain('前回の完了から数える周期で未完了が残ったとき')
  })
})
