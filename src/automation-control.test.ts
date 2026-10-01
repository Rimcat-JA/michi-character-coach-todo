import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createRoutine, createTask, expandRoutines, newTaskInput } from './commands'
import { emptyScore } from './domain'
import { applyChangeSet, approveChangeSetFromUI, changePolicyFor, clearChangeSetAuthority, prepareTaskChanges, type ChangeContext, type TaskChangeField } from './change-set'
import { automationStopsFor, parseCoachAuthorityCommand } from './automation-policy'
import { emergencyStop, previewResume, reduceAuthority, resumeAuthorityFromUI, runCoachAuthorityCommand } from './automation-control'
import { createReminder, dispatchDueReminders, pendingOSReminder } from './reminders'
import { queueSnoozeNotification, setCoachNotificationPolicy } from './coach-notification-save'
import { applyAssistedTasks, draftsFromText, prepareAssistedTasks } from './task-assist'
import { saveAIModel } from './ai-connection'

function humanClick() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
const clock = (hour: number, minute = 0) => new Date(2026, 9, 1, hour, minute)
let owner: ChangeContext, coach: ChangeContext
beforeEach(async () => {
  clearChangeSetAuthority(); await db.delete(); await db.open()
  const settings = await ensureSettings(); await db.settings.update('main', { aiEnabled: true, aiModel: 'synthetic/model', notifications: true })
  await setCoachNotificationPolicy({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  const shared = { ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: ['notes', 'scheduledDate'] as TaskChangeField[], sourceRevisions: [] }
  owner = { ...shared, principal: { id: settings.profileId, kind: 'human' } }; coach = { ...shared, principal: { id: 'app-coach', kind: 'coach', model: 'model/A' } }
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const settings = async () => (await db.settings.get('main'))!
const pending = (states: string[]) => states.filter(state => ['prepared', 'queued', 'sending'].includes(state))

describe('N09 stop switches and emergency stop', () => {
  it('emergency stop invalidates an approved-but-unapplied ChangeSet with POLICY_CHANGED and keeps manual work available', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '承認済み未適用', scheduledDate: '2026-10-01', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } })
    const prepared = await prepareTaskChanges([{ taskId, expectedRevision: 1, patch: { scheduledDate: '2026-10-02' } }], coach), grant = await approveChangeSetFromUI(prepared, owner, humanClick())
    const invalidate = { file: vi.fn(async () => undefined), local: vi.fn(async () => undefined), github: vi.fn(async () => undefined) }
    vi.stubGlobal('window', { michiFileBridge: { invalidate: invalidate.file }, michiLocalActions: { invalidate: invalidate.local }, michiGitHubAchievements: { invalidate: invalidate.github } })
    const before = changePolicyFor(await settings()).epoch, result = await emergencyStop('button')
    expect(result.errors).toEqual([]); expect(result.stops).toEqual({ aiProcessing: true, aiChanges: true, notifications: true, routines: true })
    expect(changePolicyFor(await settings()).epoch).toBe(before + 1)
    expect(invalidate.file).toHaveBeenCalledOnce(); expect(invalidate.local).toHaveBeenCalledOnce(); expect(invalidate.github).toHaveBeenCalledOnce()
    await expect(applyChangeSet(prepared, grant, coach, 'after-emergency')).rejects.toMatchObject({ code: 'POLICY_CHANGED' })
    await expect(prepareTaskChanges([{ taskId, expectedRevision: 1, patch: { notes: '停止中' } }], coach)).rejects.toMatchObject({ code: 'CHANGES_STOPPED' })
    const manual = await createTask({ ...newTaskInput(), title: '手動追加は使える', score: { ...emptyScore(), mode: 'manual', manualPoints: 10 } })
    await completeTask(manual, 1)
    expect((await db.tasks.get(manual))?.status).toBe('completed'); expect(await db.ledger.count()).toBe(1)
    expect((await db.tasks.get(taskId))?.scheduledDate).toBe('2026-10-01')
    expect((await db.audits.toArray()).filter(audit => audit.operation === 'automation.stop').map(audit => JSON.parse(audit.detail).scope)).toEqual(['all'])
  })
  it('routine stop generates 0 occurrences while manual task creation still works', async () => {
    await createRoutine({ title: '毎日の確認', cadence: 'daily', interval: 1, weekdays: [], monthDay: 1, startDate: '2026-10-01', endDate: null, afterTaskId: null, score: emptyScore(), project: '', excludedDates: [], active: true })
    const result = await reduceAuthority('routines', 'button')
    expect(result.stops.routines).toBe(true); expect(changePolicyFor(await settings()).epoch).toBe(0)
    expect(await expandRoutines('2026-10-01', 7)).toBe(0); expect(await db.tasks.count()).toBe(0)
    await createTask({ ...newTaskInput(), title: '手動タスク' }); expect(await db.tasks.count()).toBe(1)
    const preview = await previewResume('routines')
    await expect(resumeAuthorityFromUI(owner, new Event('click'), 'routines', preview.token)).rejects.toMatchObject({ code: 'HUMAN_APPROVAL_REQUIRED' })
    await expect(resumeAuthorityFromUI(owner, humanClick(), 'routines', 'not-a-preview')).rejects.toMatchObject({ code: 'PREVIEW_REQUIRED' })
    await resumeAuthorityFromUI(owner, humanClick(), 'routines', (await previewResume('routines')).token)
    expect(await expandRoutines('2026-10-01', 7)).toBe(7)
  })
  it('emergency stop empties the notification queue and later sends are refused until a native resume', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '通知対象' })
    await createReminder('once', taskId, clock(11).toISOString(), ['in-app', 'os'], clock(10))
    const [event] = await dispatchDueReminders(clock(11))
    expect(pending((await settings()).notificationState!.intents.flatMap(intent => intent.deliveries.map(delivery => delivery.state)))).toEqual(['queued'])
    await emergencyStop('button')
    expect(pending((await settings()).notificationState!.intents.flatMap(intent => intent.deliveries.map(delivery => delivery.state)))).toEqual([])
    expect(await pendingOSReminder(event, clock(11, 1))).toBeNull()
    const other = await createTask({ ...newTaskInput(), title: '次の通知' })
    await createReminder('once', other, clock(12).toISOString(), ['in-app', 'os'], clock(11, 30))
    expect(await dispatchDueReminders(clock(12))).toEqual([])
    expect((await settings()).notifications).toBe(true)
  })
  it("coach command '通知を止めて' stops notifications without a model, but '全部自動にして' changes nothing", async () => {
    const before = await settings()
    expect(await runCoachAuthorityCommand(parseCoachAuthorityCommand('全部自動にして')!)).toContain('設定 > 自動化')
    expect(await settings()).toEqual(before)
    const message = await runCoachAuthorityCommand(parseCoachAuthorityCommand('通知を止めて')!)
    expect(message).toContain('通知を停止しました')
    const after = await settings(), stops = automationStopsFor(after, changePolicyFor(after))
    expect(stops).toEqual({ aiProcessing: false, aiChanges: false, notifications: true, routines: false })
    expect(changePolicyFor(after).epoch).toBe(changePolicyFor(before).epoch)
    const snoozed = await createTask({ ...newTaskInput(), title: 'スヌーズ' }), task = (await db.tasks.get(snoozed))!
    await db.tasks.put({ ...task, snoozedUntil: clock(9).toISOString() })
    expect(await queueSnoozeNotification(snoozed, clock(11).toISOString())).toBeNull()
  })
  it('stopping AI changes bumps the epoch and only stops the agent-change connections; resume needs preview + native click', async () => {
    const invalidate = { file: vi.fn(async () => undefined), local: vi.fn(async () => undefined), github: vi.fn(async () => undefined) }
    vi.stubGlobal('window', { michiFileBridge: { invalidate: invalidate.file }, michiLocalActions: { invalidate: invalidate.local }, michiGitHubAchievements: { invalidate: invalidate.github } })
    await reduceAuthority('aiChanges', 'button')
    expect(changePolicyFor(await settings())).toMatchObject({ aiChangesEnabled: false, epoch: 1 }); expect((await settings()).aiEnabled).toBe(true)
    expect(invalidate.file).toHaveBeenCalledOnce(); expect(invalidate.local).toHaveBeenCalledOnce(); expect(invalidate.github).not.toHaveBeenCalled()
    await expect(resumeAuthorityFromUI(coach, humanClick(), 'aiChanges', (await previewResume('aiChanges')).token)).rejects.toMatchObject({ code: 'HUMAN_APPROVAL_REQUIRED' })
    const preview = await previewResume('aiChanges')
    await reduceAuthority('notifications', 'button')
    await resumeAuthorityFromUI(owner, humanClick(), 'aiChanges', preview.token)
    expect(changePolicyFor(await settings())).toMatchObject({ aiChangesEnabled: true, epoch: 2 })
    expect((await db.audits.toArray()).filter(audit => audit.operation === 'automation.resume')).toHaveLength(1)
  })
  it("the coach '緊急停止して' command stops everything without a model and the local turn is still saved", async () => {
    const { createCoachConversation, beginCoachTurn, appendCoachReply, readCoachConversation } = await import('./chat-history')
    vi.stubGlobal('window', { michiAI: { chat: vi.fn() } })
    const id = await createCoachConversation('停止の会話', 'Asia/Tokyo'), text = '緊急停止して', command = parseCoachAuthorityCommand(text)!
    // Same order as SavedCoachConversation: the stop runs before the local turn begins.
    const reply = await runCoachAuthorityCommand(command)
    const turn = await beginCoachTurn(id, (await readCoachConversation(id)).conversation.revision, { text, mode: 'local', taskId: null, goalId: null, sourceIds: [], memoryIds: [] })
    await appendCoachReply(turn, reply, 'template')
    const saved = await readCoachConversation(id)
    expect(saved.messages.map(message => [message.role, message.origin])).toEqual([['user', 'human'], ['assistant', 'template']])
    expect(saved.messages[1].text).toContain('緊急停止')
    expect(automationStopsFor(await settings(), changePolicyFor(await settings()))).toEqual({ aiProcessing: true, aiChanges: true, notifications: true, routines: true })
    expect((window as unknown as { michiAI: { chat: ReturnType<typeof vi.fn> } }).michiAI.chat).not.toHaveBeenCalled()
  })
})

describe('N09 stops reach every AI entrance', () => {
  it.each(['emergency', 'aiChanges'] as const)('task assist (%s stop): an AI proposal prepared before the stop is refused even after resuming; new AI proposals are refused; the manual draft still saves', async kind => {
    const drafts = draftsFromText('返却25pt', '2026-10-01'), prepared = await prepareAssistedTasks(drafts, 'ai')
    await (kind === 'emergency' ? emergencyStop('button') : reduceAuthority('aiChanges', 'coach-command'))
    const audits = await db.audits.count()
    await expect(applyAssistedTasks(prepared, prepared.digest)).rejects.toThrow('作り直して')
    expect(await db.tasks.count()).toBe(0); expect(await db.audits.count()).toBe(audits)
    await expect(prepareAssistedTasks(drafts, 'ai')).rejects.toThrow('停止中')
    const manual = await prepareAssistedTasks(drafts, 'manual')
    expect(await applyAssistedTasks(manual, manual.digest)).toHaveLength(1)
    // Resumes advance the epoch again, so the proposal made before the stop stays unusable.
    if (kind === 'emergency') await resumeAuthorityFromUI(owner, humanClick(), 'aiProcessing', (await previewResume('aiProcessing')).token)
    await resumeAuthorityFromUI(owner, humanClick(), 'aiChanges', (await previewResume('aiChanges')).token)
    await expect(applyAssistedTasks(prepared, prepared.digest)).rejects.toThrow('作り直して')
    expect(await db.tasks.count()).toBe(1); expect((await db.audits.toArray()).filter(audit => audit.operation === 'assist.approved').map(audit => audit.detail)).toEqual([expect.stringContaining('origin=human')])
    const fresh = await prepareAssistedTasks(drafts, 'ai')
    expect(await applyAssistedTasks(fresh, fresh.digest)).toHaveLength(1)
  })
  it('after an emergency stop, saving the coach connection keeps AI off; only the resume preview + native click turns it on (one automation.resume)', async () => {
    await emergencyStop('button')
    await saveAIModel('synthetic/other-model')
    expect(await settings()).toMatchObject({ aiEnabled: false, aiModel: 'synthetic/other-model' })
    await expect(resumeAuthorityFromUI(owner, new Event('click'), 'aiProcessing', (await previewResume('aiProcessing')).token)).rejects.toMatchObject({ code: 'HUMAN_APPROVAL_REQUIRED' })
    expect((await settings()).aiEnabled).toBe(false)
    await resumeAuthorityFromUI(owner, humanClick(), 'aiProcessing', (await previewResume('aiProcessing')).token)
    expect((await settings()).aiEnabled).toBe(true)
    expect((await db.audits.toArray()).filter(audit => audit.operation === 'automation.resume').map(audit => JSON.parse(audit.detail).scope)).toEqual(['aiProcessing'])
  })
  it('the PC-operation and file-connection screens offer only the resume preview, never a direct enable (server-rendered)', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createElement } = await import('react')
    const { default: AIProcessingResume } = await import('./AIProcessingResume')
    await db.settings.update('main', { aiModel: undefined })
    // Without a model the resume still works: the file bridge and PC operations need no key.
    await emergencyStop('button')
    const html = renderToStaticMarkup(createElement(AIProcessingResume, { settings: await settings(), label: 'PC操作用にAI処理の再開内容を確認' }))
    expect(html).toContain('PC操作用にAI処理の再開内容を確認'); expect(html).not.toContain('本人としてAI処理を再開する')
    expect((await settings()).aiEnabled).toBe(false)
    const preview = await previewResume('aiProcessing')
    expect(preview.effects.join('')).toContain('モデル未設定')
    await resumeAuthorityFromUI(owner, humanClick(), 'aiProcessing', preview.token)
    expect((await settings()).aiEnabled).toBe(true)
  })
})
