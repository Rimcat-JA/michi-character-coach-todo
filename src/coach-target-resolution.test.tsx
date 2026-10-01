import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput, updateTask } from './commands'
import { emptyScore, type Task } from './domain'
import * as changeSet from './change-set'
import { parseCoachTargetAnswer, resolveCoachTarget } from './coach-target-resolution'
import { requestedDeadlineDate, requestedScheduleDate, scheduleOnlyPatch } from './coach-task-change'
import { createReminder, dispatchDueReminders } from './reminders'
import { coachNotificationStateFor, muteCoachNotificationTarget, restCoachNotificationsToday, setCoachNotificationPolicy } from './coach-notification-save'
import { NotificationActions } from './CoachInboxView'
import SelfReportOptions from './SelfReportOptions'
import { selfReportMessage } from './self-report'

let serial = 0
const task = (title: string, patch: Partial<Task> = {}): Task => ({ ...newTaskInput(), id: `task-${++serial}`, generationKey: `g${serial}`, routineId: null, title, score: emptyScore(), effectivePoints: null, assessmentId: 'a', status: 'open', revision: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', deletedAt: null, ...patch })

describe('N08 相談から対象タスクを特定する（決定的）', () => {
  it('一致するタスクが一つなら一意、似た名前が複数なら曖昧（変更案は作らない）', () => {
    const report = task('報告書'), shopping = task('買い物')
    expect(resolveCoachTarget('報告書を明日に移して', [report, shopping])).toMatchObject({ status: 'unique', task: { id: report.id }, via: 'title' })
    const weekly = task('週次報告書'), monthly = task('月次報告書')
    const prepare = vi.spyOn(changeSet, 'prepareTaskChanges')
    const result = resolveCoachTarget('報告書を明日に移して', [weekly, monthly, shopping])
    expect(result.status).toBe('ambiguous')
    expect(result.status === 'ambiguous' && result.candidates.map(item => item.title).sort()).toEqual(['月次報告書', '週次報告書'])
    expect(prepare).not.toHaveBeenCalled()
  })
  it('「」で囲んだタイトルを最優先し、完了・削除済みは候補にしない', () => {
    const weekly = task('週次報告書'), monthly = task('月次報告書'), done = task('報告書', { status: 'completed' }), deleted = task('報告書の下書き', { deletedAt: '2026-10-01T00:00:00.000Z' })
    expect(resolveCoachTarget('「月次報告書」を明日に移して', [weekly, monthly, done, deleted])).toMatchObject({ status: 'unique', task: { id: monthly.id }, via: 'quoted' })
    const result = resolveCoachTarget('報告書を明日に', [done, deleted, weekly])
    expect(result).toMatchObject({ status: 'unique', task: { id: weekly.id } })
  })
  it('「あれ」は明示した文脈が一つのときだけ解決し、文脈がなければ選択を求める', () => {
    const a = task('請求書'), b = task('会議準備')
    expect(resolveCoachTarget('あれを明日に', [a, b])).toEqual({ status: 'none', candidates: [] })
    expect(resolveCoachTarget('あれを明日に', [a, b], { notificationTaskIds: [a.id] })).toMatchObject({ status: 'unique', task: { id: a.id }, via: 'notification' })
    expect(resolveCoachTarget('それを明日に', [a, b], { lastDiscussedTaskId: b.id })).toMatchObject({ status: 'unique', task: { id: b.id }, via: 'context' })
    expect(resolveCoachTarget('それを明日に', [a, b], { selectedTaskId: a.id, lastDiscussedTaskId: b.id }).status).toBe('ambiguous')
  })
  it('通知への返信は通知のタスクに結び付き、複数タスクの通知（Smart List）は一括変更せず選ばせる', () => {
    const a = task('請求書'), b = task('会議準備'), c = task('報告書')
    expect(resolveCoachTarget('今日は無理、明日に移して', [a, b, c], { notificationTaskIds: [c.id] })).toMatchObject({ status: 'unique', task: { id: c.id }, via: 'notification' })
    const list = resolveCoachTarget('今日は無理、明日に移して', [a, b, c], { notificationTaskIds: [a.id, b.id] })
    expect(list.status).toBe('ambiguous')
    expect(list.status === 'ambiguous' && list.candidates.map(item => item.id).sort()).toEqual([a.id, b.id].sort())
    const chosen = resolveCoachTarget('会議準備を明日に', [a, b, c], { notificationTaskIds: [a.id, b.id] })
    expect(chosen).toMatchObject({ status: 'unique', task: { id: b.id } })
    expect(resolveCoachTarget('明日に移して', [a, b, c], { notificationTaskIds: [task('完了済み', { status: 'completed' }).id] })).toEqual({ status: 'none', candidates: [] })
  })
  it('指示語は文脈がなければ件名推測に進まず、時間語は主語にしない', () => {
    const material = task('資料作成'), shopping = task('買い物')
    // Case 1: さっきの資料 is a pointer; without context the person chooses.
    expect(resolveCoachTarget('さっきの資料を明日に', [material, shopping])).toEqual({ status: 'none', candidates: [] })
    expect(resolveCoachTarget('さっきの資料を明日に', [material, shopping], { lastDiscussedTaskId: material.id })).toMatchObject({ status: 'unique', task: { id: material.id }, via: 'context' })
    // Case 2: 今日 before the particle is a time word, not the subject.
    const report = task('レポート提出'), review = task('今日の振り返り')
    expect(resolveCoachTarget('今日はレポートを明日に移して', [report, review])).toMatchObject({ status: 'unique', task: { id: report.id }, via: 'subject' })
  })
  it('タイトル一致と主語が食い違えば選ばせ、2文字のタイトルが偶然含まれるだけでは決めない', () => {
    // Case 3: 移動 appears as a verb, the subject names 週次報告書の作成.
    const move = task('移動'), weekly = task('週次報告書の作成')
    const result = resolveCoachTarget('報告書を明日に移動して', [move, weekly])
    expect(result.status).toBe('ambiguous')
    expect(result.status === 'ambiguous' && result.candidates.map(item => item.id).sort()).toEqual([move.id, weekly.id].sort())
    // Case 4: an incidental 2-character title alone never auto-selects.
    expect(resolveCoachTarget('移動で疲れたので明日に', [move, task('買い物')]).status).not.toBe('unique')
  })
  it('対象名のない相談は今日・明日の文字の重なりで別のタスクを選ばない（重なりは候補の絞り込みだけ）', () => {
    const meeting = task('明日の会議資料'), cleaning = task('部屋の掃除')
    expect(resolveCoachTarget('今日は無理、明日に移して', [meeting, cleaning])).toEqual({ status: 'none', candidates: [] })
    expect(resolveCoachTarget('今日は無理、明日に移して', [task('今日の振り返り'), cleaning]).status).not.toBe('unique')
    const report = task('報告書')
    expect(resolveCoachTarget('報告書を明日に移して', [report, task('買い物')])).toMatchObject({ status: 'unique', task: { id: report.id }, via: 'title' })
    expect(resolveCoachTarget('会議資料を明日に', [meeting, cleaning])).toMatchObject({ status: 'unique', task: { id: meeting.id }, via: 'subject' })
    expect(resolveCoachTarget('「明日の会議資料」を来週に', [meeting, cleaning])).toMatchObject({ status: 'unique', task: { id: meeting.id }, via: 'quoted' })
    expect(resolveCoachTarget('会議の資料を明日に', [meeting, cleaning]).status).toBe('ambiguous')
  })
  it('AIは決定的な候補一覧からidを一つ返すだけ。候補外・複数・形式違いは選択画面へ戻す', () => {
    const candidates = [task('週次報告書'), task('月次報告書')].map(item => ({ id: item.id, title: item.title, scheduledDate: null, dueDate: null, revision: 1 }))
    expect(parseCoachTargetAnswer(JSON.stringify({ taskId: candidates[1].id }), candidates)).toBe(candidates[1].id)
    for (const answer of [JSON.stringify({ taskId: 'foreign-task' }), JSON.stringify({ taskId: null }), JSON.stringify({ taskId: candidates[0].id, also: candidates[1].id }), JSON.stringify([candidates[0].id]), '週次報告書です']) expect(() => parseCoachTargetAnswer(answer, candidates)).toThrow('候補から選んでください')
  })
})

describe('N08 通知への返信「今日は無理、明日に移して」', () => {
  function humanClick() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
  const at = (hour: number, minute = 0) => new Date(2026, 9, 1, hour, minute)
  beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings(); await db.settings.update('main', { notifications: true }); await setCoachNotificationPolicy({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) })
  it('予定日だけを本人入力として用意し、期限の変更は確認へ回す', () => {
    expect(scheduleOnlyPatch({ scheduledDate: '2026-10-01' }, '今日は無理、明日に移して', '2026-10-01')).toMatchObject({ scheduledDate: '2026-10-02' })
    expect(scheduleOnlyPatch({ scheduledDate: '2026-10-01' }, '期限を明日にして', '2026-10-01')).not.toHaveProperty('scheduledDate')
    expect(scheduleOnlyPatch({ scheduledDate: '2026-10-01' }, '今日か明日に', '2026-10-01')).not.toHaveProperty('scheduledDate')
  })
  it('「今日は無理なので」「今日は疲れたから」の後の日付を読み、読めない相対日付を今日・明日にしない', () => {
    expect(scheduleOnlyPatch({ scheduledDate: '2026-10-01' }, '今日は無理なので明日に移して', '2026-10-01')).toMatchObject({ scheduledDate: '2026-10-02' })
    expect(scheduleOnlyPatch({ scheduledDate: '2026-10-01' }, '今日は疲れたから明日に移して', '2026-10-01')).toMatchObject({ scheduledDate: '2026-10-02' })
    expect(scheduleOnlyPatch({ scheduledDate: '2026-10-01' }, '今日は無理、明日に移して', '2026-10-01')).toMatchObject({ scheduledDate: '2026-10-02' })
    expect(scheduleOnlyPatch({ scheduledDate: '2026-09-30' }, '今日は無理なので明後日に移して', '2026-10-01').scheduledDate).not.toBe('2026-10-01')
    expect(scheduleOnlyPatch({ scheduledDate: '2026-09-30' }, '今日は無理なので明後日に移して', '2026-10-01')).toEqual({ notice: 'この日付の言い方は読み取れません。手動欄で予定日を指定してください' })
    expect(() => requestedScheduleDate('来週に移して', '2026-10-01')).toThrow('読み取れません')
    expect(() => requestedDeadlineDate('期限を3日後にして', '2026-10-01')).toThrow('読み取れません')
  })
  it('通知のタスクの予定日だけを承認後に変え、期限・手動25pt・台帳は維持し、待機中の通知は変更フックで取り消す', async () => {
    const settings = (await db.settings.get('main'))!, id = await createTask({ ...newTaskInput(), title: '報告書', scheduledDate: '2026-10-01', dueDate: '2026-10-09', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } })
    await createReminder('once', id, at(10).toISOString(), ['in-app', 'os'], at(9))
    const [event] = await dispatchDueReminders(at(10))
    const resolution = resolveCoachTarget('今日は無理、明日に移して', await db.tasks.toArray(), { notificationTaskIds: [event.targetId] })
    expect(resolution).toMatchObject({ status: 'unique', task: { id } })
    const current = (await db.tasks.get(id))!, patch = scheduleOnlyPatch(current, '今日は無理、明日に移して', '2026-10-01')
    const owner: changeSet.ChangeContext = { principal: { id: settings.profileId, kind: 'human' }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: [...changeSet.taskChangeFields], sourceRevisions: [] }
    const prepared = await changeSet.prepareTaskChanges([{ taskId: id, expectedRevision: current.revision, patch: { scheduledDate: patch.scheduledDate } }], owner, '通知への返信')
    expect(prepared.changes[0].fields).toEqual(['scheduledDate'])
    await expect(changeSet.approveChangeSetFromUI(prepared, owner, new Event('click'))).rejects.toMatchObject({ code: 'HUMAN_APPROVAL_REQUIRED' })
    const receipt = await changeSet.applyChangeSet(prepared, await changeSet.approveChangeSetFromUI(prepared, owner, humanClick()), owner, 'reply')
    expect(receipt.taskIds).toEqual([id])
    expect(await db.tasks.get(id)).toMatchObject({ scheduledDate: '2026-10-02', dueDate: '2026-10-09', effectivePoints: 25, score: { mode: 'manual', manualPoints: 25 } })
    expect(await db.ledger.count()).toBe(0)
    const intent = coachNotificationStateFor((await db.settings.get('main'))!).intents.find(item => item.id === event.id)!
    expect(intent.deliveries.find(item => item.destinationId === 'os')?.state).toBe('canceled')
  })
  it('通知の後にタスクが更新されたら古い版の差分は作れない（再読込が必要）', async () => {
    const settings = (await db.settings.get('main'))!, id = await createTask({ ...newTaskInput(), title: '報告書', scheduledDate: '2026-10-01', score: emptyScore() })
    const before = (await db.tasks.get(id))!
    await updateTask(id, before.revision, { ...before, notes: '通知の後の編集' })
    const owner: changeSet.ChangeContext = { principal: { id: settings.profileId, kind: 'human' }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: ['scheduledDate'], sourceRevisions: [] }
    await expect(changeSet.prepareTaskChanges([{ taskId: id, expectedRevision: before.revision, patch: { scheduledDate: '2026-10-02' } }], owner)).rejects.toMatchObject({ code: 'CONFLICT' })
    await completeTask(id, before.revision + 1)
    expect(resolveCoachTarget('報告書を明日に', await db.tasks.toArray(), { notificationTaskIds: [id] })).toEqual({ status: 'none', candidates: [] })
  })
  it('通知の固定ボタン（このタスクは通知しない・今日は休む）は待機中の通知を取り消す', async () => {
    const id = await createTask({ ...newTaskInput(), title: '報告書', score: emptyScore() })
    await createReminder('once', id, at(10).toISOString(), ['in-app', 'os'], at(9))
    const [event] = await dispatchDueReminders(at(10))
    await muteCoachNotificationTarget(id, true, at(10, 1).toISOString())
    const muted = coachNotificationStateFor((await db.settings.get('main'))!).intents.find(item => item.id === event.id)!
    expect(muted.deliveries.find(item => item.destinationId === 'os')?.state).toBe('canceled')
    await restCoachNotificationsToday(at(10, 2).toISOString())
    expect(coachNotificationStateFor((await db.settings.get('main'))!).policy.restDays).toContain('2026-10-01')
    const settings = (await db.settings.get('main'))!, html = renderToStaticMarkup(<NotificationActions settings={settings} tasks={await db.tasks.toArray()} run={async () => true} targetId={id} notification={{ id: event.id, title: '報告書', taskIds: [id], revisions: { [id]: 1 } }} />)
    expect(html).toContain('返信して調整'); expect(html).toContain('このタスクは通知しない'); expect(html).toContain('今日は休む')
  })
})

describe('K05 本人申告は選択肢だけを示す', () => {
  it('疲れた等の最新の本人発言にだけ選択肢カードを出し、何も変更しない文言にする', async () => {
    expect(selfReportMessage([{ id: '1', role: 'user', text: '疲れた' }, { id: '2', role: 'assistant', text: '応答' }])?.id).toBe('1')
    expect(selfReportMessage([{ id: '1', role: 'user', text: '疲れた' }, { id: '3', role: 'user', text: '次は何？' }])).toBeNull()
    await db.delete(); await db.open()
    const html = renderToStaticMarkup(<SelfReportOptions settings={await ensureSettings()} />)
    for (const label of ['今日のコーチ通知を休む', '今日の予定から選んで移す', 'このままにする', 'まだ何も変更していません']) expect(html).toContain(label)
    expect(html).not.toContain('checked')
  })
})
