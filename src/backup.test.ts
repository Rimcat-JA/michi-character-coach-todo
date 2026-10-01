import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput, completeTask, correctCompletion, undoCompletion } from './commands'
import { emptyScore } from './domain'
import { createContainer } from './containers'
import { addChecklistItem, convertChecklistItem } from './checklist'
import { createLabelDefinition, createLabelGroup } from './labels'
import { instantiateTemplate, saveTaskTemplate } from './templates'
import { addTaskAttachment, addTaskComment, addTaskNote, getTaskAttachment } from './materials'
import { addTaskDependency } from './dependencies'
import { assignTaskToBucket, createPlanningBucket } from './period-planning'
import { createCalendarEvent, createTimeBlock } from './calendar-planning'
import { rolloverTask } from './rollover'
import { createThemeRule } from './themes'
import { assignDaySection, setDaySectionMode } from './day-sections'
import { createSmartList, removeSmartList } from './smart-lists'
import { setFocusProjects } from './focus-projects'
import { setSpotlight } from './focus-tools'
import { captureDayProgressBaseline, createTimeTarget } from './progress'
import { createHabit, recordHabitLog } from './habits'
import { createGoal, createGoalCheckIn } from './goals'
import { createTracker, recordTrackerEntry, saveDayNote } from './journal'
import { recordPomodoro, startPomodoro } from './pomodoro'
import { addWallTile } from './wall'
import { saveWorkflowPreset } from './workflows'
import { saveAppearance } from './appearance'
import { createReminder, dispatchDueReminders } from './reminders'
import { saveKeybinding } from './shortcuts'
import { saveCharacterProfile } from './character'
import { saveCustomScreen, saveDashboardWidgets } from './dashboard'
import { captureSnapshot, exportBackup, exportPortableJson, inspectBackup, restoreBackup } from './backup'
import { validateSnapshot, type Snapshot } from './backup-validation'
import { saveReviewAnswer, setReviewSummary } from './review-coach'
import { createCoachMemory, deleteCoachMemory, editCoachMemory, memorySourceFromOption } from './coach-memory'
import { applyTripBundle } from './trip-bundle-save'
import { prepareTripBundle } from './trip-bundles'
import { applyChangeSet, changePolicyFor, prepareTaskChanges, type ChangeContext } from './change-set'
import { defaultSourcePermissions, importLocalSource, summarizeSelectedSource } from './source-library'
import { appendCoachReply, beginCoachTurn, createCoachConversation, saveCoachDraft, setConversationRetention } from './chat-history'
import { calendarFixture, monthlyRule } from './calendar-test-fixtures'
import { applyCalendarProposalFromUI, prepareCalendarConfiguration, prepareCalendarGeneration } from './calendar-rules-save'
import { beginCoachNotificationDelivery, emptyCoachNotificationState, reserveCoachNotification, settleCoachNotificationDelivery, type NotificationGuard, type NotificationRequest } from './coach-notifications'
import { fileBridgeReceiptKey, fileBridgeScopeKey, type FileBridgeApplicationReceipt, type FileBridgeRegistration } from './file-bridge-types'
import { readFileBridgeApplicationReceipt } from './file-bridge-commands'
import { contentDigest } from './canonical'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

async function snapshot(): Promise<Snapshot> {
  const attachments = await Promise.all((await db.taskAttachments.toArray()).map(async ({ blob, ...item }) => ({ ...item, contentBase64: btoa(Array.from(new Uint8Array(await blob.arrayBuffer()), value => String.fromCharCode(value)).join('')) })))
  return {
    format: 'coachbundle', version: 1, exportedAt: new Date().toISOString(),
    contextSources: await db.contextSources.toArray(), contextSnapshots: await db.contextSnapshots.toArray(), sourceSummaries: await db.sourceSummaries.toArray(), sourceArtifacts: await db.sourceArtifacts.toArray(),
    coachConversations: await db.coachConversations.toArray(), coachMessages: await db.coachMessages.toArray(), calendarRules: await db.calendarRules.toArray(),
    tasks: await db.tasks.toArray(), assessments: await db.assessments.toArray(),
    completions: await db.completions.toArray(), ledger: await db.ledger.toArray(),
    routines: await db.routines.toArray(), sessions: await db.sessions.toArray(),
    commands: await db.commands.toArray(), audits: await db.audits.toArray(),
    settings: await db.settings.toArray(), containers: await db.containers.toArray(), checklistItems: await db.checklistItems.toArray(), labelGroups: await db.labelGroups.toArray(), labelDefinitions: await db.labelDefinitions.toArray(), savedTemplates: await db.savedTemplates.toArray(), taskNotes: await db.taskNotes.toArray(), taskComments: await db.taskComments.toArray(), taskAttachments: attachments, taskDependencies: await db.taskDependencies.toArray(), planningBuckets: await db.planningBuckets.toArray(), timeBlocks: await db.timeBlocks.toArray(), calendarEvents: await db.calendarEvents.toArray(), rollovers: await db.rollovers.toArray(), themeRules: await db.themeRules.toArray(), smartLists: await db.smartLists.toArray(), focusSelections: await db.focusSelections.toArray(), habits: await db.habits.toArray(), habitLogs: await db.habitLogs.toArray(), goals: await db.goals.toArray(), goalCheckIns: await db.goalCheckIns.toArray(), trackerDefinitions: await db.trackerDefinitions.toArray(), trackerEntries: await db.trackerEntries.toArray(), dayNotes: await db.dayNotes.toArray(), pomodoroCycles: await db.pomodoroCycles.toArray()
  }
}

describe('バックアップの復元前検証', () => {
  it.each(['captureSnapshot', 'JSON出力', '暗号化出力'] as const)('%sの実経路は期限切れの原文・履歴・下書き・派生本文を出力前に消去する', async route => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] }); vi.setSystemTime(new Date('2026-10-01T03:00:00.000Z'))
    const retentionUntil = '2026-10-02T00:00:00.000Z', model = 'deepseek/deepseek-v4.1-flash'
    await db.settings.update('main', { aiEnabled: true, aiModel: model })
    const memoryId = await createCoachMemory({ kind: 'explicit', text: '消去対象メモ旧本文', retentionUntil })
    await editCoachMemory(memoryId, 1, 'explicit', '消去対象メモ訂正本文')
    const sourceId = await importLocalSource({ title: '消去対象資料名', provider: 'slack', externalId: 'expired-export', conversation: '消去対象チャンネル', author: '消去対象発言者', sourceUrl: null, date: '2026-10-01', fromDate: '2026-09-01', toDate: '2026-10-01', text: '消去対象資料原文\r\n消去対象資料二行目', permissions: { ...defaultSourcePermissions(), aiEgress: true }, allowedModels: [model], retentionUntil })
    await summarizeSelectedSource(sourceId, 1, model, async () => '消去対象資料AI要約')
    const currentSettings = (await db.settings.get('main'))!
    const sourceRef = await memorySourceFromOption({ kind: 'library', refId: sourceId, summary: true, label: '選択した資料要約' }, currentSettings.profileId)
    const sourceMemoryId = await createCoachMemory({ kind: 'inferred', text: '消去対象資料由来メモ', sources: [sourceRef] })
    await editCoachMemory(sourceMemoryId, 1, 'inferred', '消去対象資料由来メモ訂正文')
    await db.sourceArtifacts.add({ id: 'expired-cache', sourceId, ownerId: currentSettings.profileId, sourceRevision: 1, permissionRevision: 1, kind: 'cache', payload: '消去対象資料cache', createdAt: new Date().toISOString() })
    const conversationId = await createCoachConversation('消去対象会話名', 'Asia/Tokyo')
    const turn = await beginCoachTurn(conversationId, 1, { text: '消去対象本人会話本文', mode: 'local' })
    await appendCoachReply(turn, '消去対象会話応答', 'template')
    const conversation = (await db.coachConversations.get(conversationId))!
    await saveCoachDraft(conversationId, conversation.draftRevision, '消去対象入力途中の下書き')
    await setConversationRetention(conversationId, conversation.revision, retentionUntil)
    expect((await db.coachMemories.get(memoryId))!.history[0].text).toBe('消去対象メモ旧本文')
    expect((await db.coachConversations.get(conversationId))!.draft).toBe('消去対象入力途中の下書き')
    expect(await db.contextSnapshots.count()).toBe(1)
    vi.setSystemTime(new Date(retentionUntil))
    let saved: Snapshot
    if (route === 'captureSnapshot') saved = await captureSnapshot()
    else {
      let downloaded: Blob | undefined
      const anchor = { href: '', download: '', click: vi.fn() }
      vi.stubGlobal('document', { createElement: vi.fn(() => anchor) })
      vi.spyOn(URL, 'createObjectURL').mockImplementation(content => { if (!(content instanceof Blob)) throw new Error('出力はBlobで保存します'); downloaded = content; return 'blob:backup-regression' })
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
      const password = 'backup-regression-password'
      if (route === 'JSON出力') await exportPortableJson()
      else await exportBackup(password)
      expect(anchor.click).toHaveBeenCalledOnce(); expect(downloaded).toBeDefined()
      expect(anchor.download).toMatch(route === 'JSON出力' ? /\.json$/ : /\.coachbundle$/)
      saved = await inspectBackup(new File([downloaded!], anchor.download, { type: 'application/json' }), route === 'JSON出力' ? '' : password)
      if (route === '暗号化出力') expect((await db.settings.get('main'))!.lastBackupAt).toBe(retentionUntil)
    }
    expect(JSON.stringify(saved)).not.toContain('消去対象')
    expect(saved.coachMemories!.find(item => item.id === memoryId)).toMatchObject({ text: '', history: [], contentPurged: 'retention', deletedAt: retentionUntil })
    expect(saved.coachMemories!.find(item => item.id === sourceMemoryId)).toMatchObject({ text: '', history: [], sourcePurged: true, deletedAt: retentionUntil })
    expect(saved.coachConversations!.find(item => item.id === conversationId)).toMatchObject({ title: '削除した会話', draft: '', pendingMessageId: null, deletedAt: retentionUntil })
    expect(saved.contextSnapshots).toEqual([]); expect(saved.sourceSummaries).toEqual([]); expect(saved.sourceArtifacts).toEqual([]); expect(saved.coachMessages).toEqual([])
    expect(await db.contextSnapshots.count()).toBe(0); expect(await db.sourceSummaries.count()).toBe(0); expect(await db.sourceArtifacts.count()).toBe(0); expect(await db.coachMessages.count()).toBe(0)
    expect(await db.coachMemories.toArray()).toEqual(saved.coachMemories)
    expect(await db.coachConversations.toArray()).toEqual(saved.coachConversations)
    expect(saved.memoryTombstones!.every(item => item.reason === 'retention' || item.reason === 'source-deleted')).toBe(true)
    await restoreBackup(saved)
    expect(JSON.stringify(await captureSnapshot())).not.toContain('消去対象')
  })

  it('実際のsnapshot復元は待機・送信中の通知を取消し、通知権限版を進めて配信済み履歴を保持する', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T03:00:00.000Z'))
    const taskId = await createTask({ ...newTaskInput(), title: '通知復元の対象' }), settings = (await db.settings.get('main'))!, policy = changePolicyFor(settings), at = new Date().toISOString()
    let state = emptyCoachNotificationState(settings.profileId, settings.datasetId, 'Asia/Tokyo')
    const guards = new Map<string, NotificationGuard>()
    for (const status of ['queued', 'sending', 'accepted_by_provider'] as const) {
      const request: NotificationRequest = { id: `restore-notice:${status}`, purpose: 'direct_reply', category: 'reply', target: { kind: 'task', id: taskId, revision: 1 }, ruleId: `fixture:${status}`, ruleRevision: '1', ruleWindow: status, notBefore: at, expiresAt: '2026-10-01T04:00:00.000Z', destinationIds: ['in-app'], sourceRefs: [], text: { factual: '保存した通知文', savedAI: null }, intervalMinutes: null, maxCount: null, endDate: null }
      const guard: NotificationGuard = { ownerId: settings.profileId, datasetId: settings.datasetId, authorityEpoch: policy.epoch, sourcePermissionRevision: policy.sourcePermissionRevision, aiEnabled: false, target: { ...request.target, active: true }, rule: { id: request.ruleId, revision: '1', active: true, sentCount: 0 }, sources: [], availableDestinationIds: ['in-app'] }
      guards.set(request.id, guard)
      const reserved = reserveCoachNotification(state, request, guard, at); expect(reserved.intent).not.toBeNull(); state = reserved.state
      if (status !== 'queued') {
        const sending = beginCoachNotificationDelivery(state, request.id, 'in-app', `attempt:${status}`, guard, at); expect(sending.payload).not.toBeNull(); state = sending.state
        if (status === 'accepted_by_provider') state = settleCoachNotificationDelivery(state, request.id, 'in-app', `attempt:${status}`, status, at)
      }
    }
    await db.settings.update('main', { notificationState: state })
    const saved = await captureSnapshot()
    await restoreBackup(saved)
    const restored = (await db.settings.get('main'))!.notificationState!
    expect(restored.policy.epoch).toBe(state.policy.epoch + 1)
    expect(restored.intents.map(item => item.deliveries[0].state)).toEqual(['canceled', 'canceled', 'accepted_by_provider'])
    expect(restored.intents.every(item => item.policyEpoch < restored.policy.epoch)).toBe(true)
    expect(restored.intents[2].deliveries[0].attemptId).toBe('attempt:accepted_by_provider')
    expect(beginCoachNotificationDelivery(restored, 'restore-notice:queued', 'in-app', 'replayed-attempt', guards.get('restore-notice:queued')!, at).payload).toBeNull()
    expect(saved.settings[0].notificationState).toEqual(state)
    expect(() => validateSnapshot({ ...saved, settings: [{ ...saved.settings[0], notificationState: restored }] })).not.toThrow()
  })

  it('実snapshotの復元でfilebridge scope権限だけを除外し、適用済みreceiptとタスク・台帳を維持する', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '適用済み外部提案を保持するタスク', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } }), settings = (await db.settings.get('main'))!, policy = changePolicyFor(settings), at = new Date().toISOString()
    const registration: FileBridgeRegistration = { schema_version: '1', owner_id: settings.profileId, dataset_id: settings.datasetId, policy_epoch: policy.epoch, source_permission_revision: policy.sourcePermissionRevision, task_ids: [taskId], client: { id: crypto.randomUUID(), dataset_id: settings.datasetId, intended_host: 'codex', transport: 'stdio', status: 'active', revision: 1, grant_epoch: 1, grant: { keys: ['tasks:read', 'tasks:prepare', 'changes:submit', 'commands:read'], project_ids: [], fields: ['notes'], mutation_mode: 'require_approval', max_operations_per_day: 10, max_schedule_shift_days: 3, max_point_delta: 0, allow_external_context: false, allow_handoffs: false, expires_at: new Date(Date.now() + 3600000).toISOString() } } }
    const scope = { version: 1, registration }, scopeKey = fileBridgeScopeKey(settings.profileId, settings.datasetId)
    const receipt: FileBridgeApplicationReceipt = { version: 1, commandId: crypto.randomUUID(), fileDigest: 'a'.repeat(64), applicationDigest: 'b'.repeat(64), ownerId: settings.profileId, datasetId: settings.datasetId, clientId: registration.client.id, policyEpoch: policy.epoch, sourcePermissionRevision: policy.sourcePermissionRevision, registrationRevision: 1, grantEpoch: 1, taskIds: [taskId], appliedAt: at }
    await db.commands.add({ key: scopeKey, hash: await contentDigest(scope), resultId: JSON.stringify(scope), at })
    await db.commands.add({ key: fileBridgeReceiptKey(receipt.commandId), hash: receipt.applicationDigest, resultId: JSON.stringify(receipt), at })
    const saved = await captureSnapshot(), invalidate = vi.fn(async () => undefined)
    vi.stubGlobal('window', { michiFileBridge: { invalidate } })
    expect(saved.commands.some(item => item.key === scopeKey)).toBe(true)
    expect(await readFileBridgeApplicationReceipt(receipt.commandId)).toEqual(receipt)
    await db.commands.clear()
    await restoreBackup(saved)
    expect(invalidate).toHaveBeenCalledOnce()
    expect(await db.commands.get(scopeKey)).toBeUndefined()
    expect(await readFileBridgeApplicationReceipt(receipt.commandId)).toEqual(receipt)
    expect(await db.tasks.toArray()).toEqual(saved.tasks); expect(await db.ledger.toArray()).toEqual(saved.ledger)
    expect((await db.tasks.get(taskId))!.score.manualPoints).toBe(25)
    expect((await captureSnapshot()).commands.every(item => !item.key.startsWith('filebridge:scope:'))).toBe(true)
    expect(saved.commands.some(item => item.key === scopeKey)).toBe(true)
  })

  it('共通カレンダーと完了実績を復元し、古い承認案と対応先の欠落を拒否する', async () => {
    const current = (await db.settings.get('main'))!, state = calendarFixture()
    state.ownerId = current.profileId; state.datasetId = current.datasetId
    state.bindings.forEach(binding => { binding.personId = current.profileId })
    state.activities = []; state.bindings[0].activityIds = []
    state.rules = [monthlyRule()]
    const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true })
    const { contexts, bindings, calendars, activities, sources, facts, rules } = state
    await applyCalendarProposalFromUI(await prepareCalendarConfiguration({ contexts, bindings, calendars, activities, sources, facts, rules }, 1, '2026-10-01', '2026-11-30'), event)
    await applyCalendarProposalFromUI(await prepareCalendarGeneration('2026-10-01', '2026-11-30'), event)
    const task = (await db.tasks.toArray())[0]; await completeTask(task.id, task.revision)
    const pending = await prepareCalendarGeneration('2026-10-01', '2026-11-30'), saved = await snapshot()
    const invalid = structuredClone(saved); invalid.calendarRules![0].instances[0].entityId = 'missing-task'
    await expect(restoreBackup(invalid)).rejects.toThrow('カレンダー')
    expect(await db.tasks.get(task.id)).toBeDefined()
    await restoreBackup(saved)
    expect(await db.calendarRules.toArray()).toEqual(saved.calendarRules)
    expect(await db.ledger.toArray()).toEqual(saved.ledger)
    await expect(applyCalendarProposalFromUI(pending, event)).rejects.toThrow('登録済み')
    const fresh = await prepareCalendarGeneration('2026-10-01', '2026-11-30')
    expect(fresh.plan).toMatchObject({ creates: [], updates: [], cancels: [], skippedCompleted: 1 })
  })
  it('会話と下書きを復元し、復元前の応答権限は失効する', async () => {
    const id = await createCoachConversation('復元する会話', 'Asia/Tokyo')
    await saveCoachDraft(id, 1, '本人の送信文')
    const initial = (await db.coachConversations.get(id))!
    const first = await beginCoachTurn(id, initial.revision, { text: '本人の送信文', mode: 'local' })
    await appendCoachReply(first, '端末内の定型応答', 'template')
    const current = (await db.coachConversations.get(id))!
    await saveCoachDraft(id, current.draftRevision, '入力途中の本人文章')
    const pending = await beginCoachTurn(id, current.revision, { text: '追加の本人文章', mode: 'local' })
    const saved = await snapshot()
    await restoreBackup(saved)
    expect((await db.coachConversations.get(id))?.draft).toBe('入力途中の本人文章')
    expect(await db.coachMessages.count()).toBe(3)
    await expect(appendCoachReply(pending, '復元前の応答は採用しない', 'template')).rejects.toThrow()
    expect(await db.coachMessages.count()).toBe(3)
    const invalid = structuredClone(saved)
    invalid.coachMessages![0].ownerId = 'another-owner'
    await expect(restoreBackup(invalid)).rejects.toThrow('コーチ会話')
    expect(await db.coachMessages.count()).toBe(3)
  })
  it('資料を復元し、本文ハッシュ偽装は既存データを残して拒否する', async () => {
    const sourceId = await importLocalSource({ title: '本人が選んだ会話', provider: 'line', externalId: '17200000000000000001', conversation: '本人の会話', author: null, sourceUrl: null, date: '2026-10-01', fromDate: '2026-09-01', toDate: '2026-10-01', text: '本人: 返却を済ませます\r\n別の資料', permissions: defaultSourcePermissions(), allowedModels: [], retentionUntil: null })
    const saved = await snapshot()
    await db.contextSnapshots.clear(); await db.contextSources.clear()
    await restoreBackup(saved)
    expect((await db.contextSources.get(sourceId))?.externalId).toBe('17200000000000000001')
    expect((await db.contextSnapshots.toArray())[0].originalText).toContain('\r\n')
    const taskId = await createTask({ ...newTaskInput(), title: '破損復元でも残すタスク' })
    const invalid = structuredClone(saved)
    invalid.contextSnapshots![0].sha256 = '0'.repeat(64)
    await expect(restoreBackup(invalid)).rejects.toThrow('資料')
    expect(await db.tasks.get(taskId)).toBeDefined()
    const legacy = structuredClone(saved)
    delete legacy.contextSources; delete legacy.contextSnapshots; delete legacy.sourceSummaries; delete legacy.sourceArtifacts
    await restoreBackup(legacy)
    expect(await db.contextSources.count()).toBe(0)
    expect(await db.contextSnapshots.count()).toBe(0)
  })
  it('配分した外出と推測の削除記録を復元し、復元前の変更許可は失効する', async () => {
    const first = await createTask({ ...newTaskInput(), title: '外出1', score: { ...emptyScore(), mode: 'manual', manualPoints: 5 } })
    const second = await createTask({ ...newTaskInput(), title: '外出2' })
    const attributes = { minutes: 0, difficulty: 0, uncertainty: 0, coordination: 0, physical: 0 }
    const proposal = await prepareTripBundle(await db.tasks.toArray(), { title: '復元する外出', travelMinutes: 0, members: [{ taskId: first, attributes }, { taskId: second, attributes }] })
    await applyTripBundle(proposal, [first])
    const memoryId = await createCoachMemory({ kind: 'inferred', text: '本人が入力した未確認の推測' })
    await deleteCoachMemory(memoryId, 1)
    const settings = (await db.settings.get('main'))!
    const context: ChangeContext = { principal: { id: settings.profileId, kind: 'human' }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: ['notes', 'scheduledDate'], sourceRevisions: [] }
    const task = (await db.tasks.get(first))!
    const pending = await prepareTaskChanges([{ taskId: first, expectedRevision: task.revision, patch: { notes: '復元後は適用しない' } }], context)
    const saved = await snapshot()
    saved.tripBundles = await db.tripBundles.toArray()
    saved.coachMemories = await db.coachMemories.toArray()
    saved.memoryTombstones = await db.memoryTombstones.toArray()
    validateSnapshot(saved)
    const duplicate = structuredClone(saved)
    duplicate.tripBundles!.push({ ...duplicate.tripBundles![0], id: 'duplicate-bundle' })
    expect(() => validateSnapshot(duplicate)).toThrow('重複')
    await restoreBackup(saved)
    expect(await db.tripBundles.toArray()).toEqual(saved.tripBundles)
    expect(await db.coachMemories.toArray()).toEqual(saved.coachMemories)
    expect(await db.memoryTombstones.toArray()).toEqual(saved.memoryTombstones)
    await expect(applyChangeSet(pending, null, context, 'restored')).rejects.toMatchObject({ code: 'UNVERIFIED_CHANGE_SET' })
    expect(await db.ledger.count()).toBe(0)
  })
  it('本人回答・計画・実績・要約を別々に復元し、古い形式ではレビューを空にする', async () => {
    const id = await saveReviewAnswer({ date: '2026-09-30', timezone: 'Asia/Tokyo', kind: 'evening', answer: '明日に再計画する' })
    await setReviewSummary(id, 0, '保存済み実績は0件', 'human', 1, 1)
    const saved = await snapshot()
    saved.reviewRecords = await db.reviewRecords.toArray()
    validateSnapshot(saved)
    await db.reviewRecords.clear()
    await restoreBackup(saved)
    expect(await db.reviewRecords.get(id)).toEqual(saved.reviewRecords[0])
    expect(await db.ledger.count()).toBe(0)
    delete saved.reviewRecords
    await restoreBackup(saved)
    expect(await db.reviewRecords.count()).toBe(0)
  })
  it('見直し通知の日付・対象版を復元し、不正値と履歴の付替えを拒否する', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '見直し通知の保存', reviewDate: '2026-09-29' })
    const start = new Date(2026, 8, 29, 8)
    await createReminder('review', taskId, '09:00', ['in-app'], start)
    await dispatchDueReminders(new Date(2026, 8, 29, 9))
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    const invalidDate = structuredClone(saved)
    invalidDate.settings[0].reminderState!.rules[0].reviewDate = '2026-02-30'
    expect(() => validateSnapshot(invalidDate)).toThrow('見直し')
    const invalidRevision = structuredClone(saved)
    invalidRevision.settings[0].reminderState!.events[0].reviewRevision = 0
    expect(() => validateSnapshot(invalidRevision)).toThrow('見直し')
    const detached = structuredClone(saved)
    detached.settings[0].reminderState!.events[0].targetId = 'other'
    expect(() => validateSnapshot(detached)).toThrow('通知履歴')
    await db.settings.update('main', { reminderState: undefined })
    await restoreBackup(saved)
    expect((await db.settings.get('main'))!.reminderState!.events[0]).toMatchObject({ kind: 'review', reviewDate: '2026-09-29', reviewRevision: 1 })
    expect(await dispatchDueReminders(new Date(2026, 8, 29, 10))).toEqual([])
  })
  it('Smart List削除後も停止した毎日通知の履歴を安全に書き出せる', async () => {
    const id = await createSmartList('消す一覧', { type: 'condition', field: 'status', operator: 'eq', value: 'open' })
    await createReminder('smart-daily', id, '09:00')
    await saveCustomScreen({ leftListId: id })
    await removeSmartList(id)
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    await restoreBackup(saved)
    expect((await db.settings.get('main'))?.reminderState?.rules[0].enabled).toBe(false)
  })
  it('ダッシュボードと分割画面を復元し、未知の一覧参照を拒否する', async () => {
    const listId = await createSmartList('画面用', { type: 'condition', field: 'status', operator: 'eq', value: 'open' })
    await saveDashboardWidgets(['sync', 'today'])
    await saveCustomScreen({ leftListId: listId })
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    const corrupt = structuredClone(saved)
    corrupt.settings[0].customScreen!.leftListId = 'missing'
    expect(() => validateSnapshot(corrupt)).toThrow('カスタム画面')
    await db.settings.update('main', { dashboardWidgets: undefined, customScreen: undefined })
    await restoreBackup(saved)
    expect((await db.settings.get('main'))).toMatchObject({ dashboardWidgets: ['sync', 'today'], customScreen: { leftListId: listId } })
  })
  it('キャラクター設定を復元し、権限項目の混入を拒否する', async () => {
    await saveCharacterProfile({ tone: 'direct', avoidPhrases: ['急いで'] })
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    const corrupt = structuredClone(saved)
    Object.assign(corrupt.settings[0].characterProfile!, { notifications: true })
    expect(() => validateSnapshot(corrupt)).toThrow('キャラクター設定')
    await db.settings.update('main', { characterProfile: undefined })
    await restoreBackup(saved)
    expect((await db.settings.get('main'))?.characterProfile?.tone).toBe('direct')
  })
  it('キー設定を復元し、重複割り当てを拒否する', async () => {
    await saveKeybinding('newTask', 'Ctrl+Shift+N')
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    const invalid = structuredClone(saved)
    invalid.settings[0].keybindings!.quickJump = 'Ctrl+Shift+N'
    expect(() => validateSnapshot(invalid)).toThrow('重複')
    await db.settings.update('main', { keybindings: undefined })
    await restoreBackup(saved)
    expect((await db.settings.get('main'))?.keybindings?.newTask).toBe('Ctrl+Shift+N')
  })
  it('通知予約と履歴を復元し、存在しない対象と不正な宛先を拒否する', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '通知対象' })
    const start = new Date(2026, 8, 29, 10)
    await createReminder('bug-me', taskId, '', ['in-app'], start)
    await dispatchDueReminders(new Date(2026, 8, 29, 10, 30))
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    const missing = structuredClone(saved)
    missing.settings[0].reminderState!.rules[0].targetId = 'missing'
    expect(() => validateSnapshot(missing)).toThrow('通知予約')
    const invalidChannel = structuredClone(saved)
    invalidChannel.settings[0].reminderState!.rules[0].channels = ['other'] as never
    expect(() => validateSnapshot(invalidChannel)).toThrow('通知予約')
    await db.settings.update('main', { reminderState: undefined })
    await restoreBackup(saved)
    expect((await db.settings.get('main'))?.reminderState?.events).toHaveLength(1)
  })
  it('見た目の設定を復元し、不正な配色を拒否する', async () => {
    await saveAppearance({ theme: 'high-contrast', accent: 'blue', fontScale: 110, iconStyle: 'bold' })
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    const corrupt = structuredClone(saved)
    corrupt.settings[0].appearance!.accent = 'invalid' as 'blue'
    expect(() => validateSnapshot(corrupt)).toThrow('見た目')
    await db.settings.update('main', { appearance: undefined })
    await restoreBackup(saved)
    expect((await db.settings.get('main'))?.appearance).toMatchObject({ theme: 'high-contrast', accent: 'blue', fontScale: 110, iconStyle: 'bold' })
  })
  it('版付きワークフローを復元し、共有対象外の設定を含むものを拒否する', async () => {
    await saveWorkflowPreset('自分の設定')
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    const corrupt = structuredClone(saved)
    Object.assign(corrupt.settings[0].workflowPresets![0].config, { notifications: true })
    expect(() => validateSnapshot(corrupt)).toThrow('ワークフロー設定')
    await db.settings.update('main', { workflowPresets: [] })
    await restoreBackup(saved)
    expect((await db.settings.get('main'))?.workflowPresets?.[0].name).toBe('自分の設定')
  })
  it('機能の表示設定を復元し、未知の機能を拒否する', async () => {
    await db.settings.update('main', { hiddenFeatures: ['wall', 'journal'] })
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    const corrupt = structuredClone(saved)
    corrupt.settings[0].hiddenFeatures!.push('unknown')
    expect(() => validateSnapshot(corrupt)).toThrow('機能の表示')
    await db.settings.update('main', { hiddenFeatures: [] })
    await restoreBackup(saved)
    expect((await db.settings.get('main'))?.hiddenFeatures).toEqual(['wall', 'journal'])
  })
  it('画面内の機能（音声・PC操作など）の表示設定も復元し、壊れたIDを拒否する', async () => {
    await db.settings.update('main', { hiddenFeatures: ['voice', 'localActions', 'fileBridge', 'wall'] })
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    for (const broken of [['voice', 'voice'], ['voice ', 'avatar'], ['Voice']]) {
      const corrupt = structuredClone(saved); corrupt.settings[0].hiddenFeatures = broken
      expect(() => validateSnapshot(corrupt)).toThrow('機能の表示')
    }
    await db.settings.update('main', { hiddenFeatures: [] })
    await restoreBackup(saved)
    expect((await db.settings.get('main'))?.hiddenFeatures).toEqual(['voice', 'localActions', 'fileBridge', 'wall'])
  })
  it('N09の操作別設定・時間帯・停止スイッチを復元し、委任できない設定を拒否する', async () => {
    const { presetRules } = await import('./automation-policy')
    const policy = changePolicyFor((await db.settings.get('main'))!)
    await db.settings.update('main', { automation: 'custom', changePolicy: { ...policy, operations: presetRules('A2'), allowedHours: { 'task.schedule': { start: '09:00', end: '18:00' } }, stops: { notifications: true, routines: false } } })
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    const expand = structuredClone(saved); expand.settings[0].changePolicy!.operations = presetRules('A1').map(rule => rule.operation === 'authority.expand' ? { ...rule, mode: 'auto_within_bounds' as const } : rule)
    expect(() => validateSnapshot(expand)).toThrow()
    const level = structuredClone(saved); Object.assign(level.settings[0].changePolicy!, { policy_level: 'A3' })
    expect(() => validateSnapshot(level)).toThrow()
    const unknownPreset = structuredClone(saved); Object.assign(unknownPreset.settings[0], { automation: 'A4' })
    expect(() => validateSnapshot(unknownPreset)).toThrow('設定が不正')
    await db.settings.update('main', { automation: 'A1', changePolicy: policy })
    await restoreBackup(saved)
    const restored = (await db.settings.get('main'))!, restoredPolicy = changePolicyFor(restored)
    expect(restored.automation).toBe('custom')
    expect(restoredPolicy).toMatchObject({ operations: presetRules('A2'), allowedHours: { 'task.schedule': { start: '09:00', end: '18:00' } }, stops: { notifications: true, routines: false } })
  })
  it('停止前のバックアップを復元しても、停止スイッチとAI停止は戻らず、epochは現在より進む', async () => {
    const { emergencyStop } = await import('./automation-control')
    await db.settings.update('main', { aiEnabled: true, aiModel: 'synthetic/model' })
    const saved = await snapshot()
    expect(changePolicyFor(saved.settings[0]).stops).toBeUndefined()
    await emergencyStop('button')
    const stopped = changePolicyFor((await db.settings.get('main'))!)
    await restoreBackup(saved)
    const restored = (await db.settings.get('main'))!, policy = changePolicyFor(restored)
    expect(restored.aiEnabled).toBe(false)
    expect(policy).toMatchObject({ aiChangesEnabled: false, stops: { notifications: true, routines: true } })
    expect(policy.epoch).toBeGreaterThan(stopped.epoch)
    // A fresh install (no current row) keeps the snapshot as it is.
    await db.settings.clear(); await restoreBackup(saved)
    expect((await db.settings.get('main'))!.aiEnabled).toBe(true)
  })
  it('PCとスマホのナビゲーションを別々に復元し、不正な機能名を拒否する', async () => {
    await db.settings.update('main', { navDesktop: [], navMobile: ['today', 'wall'] })
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    const corrupt = structuredClone(saved)
    corrupt.settings[0].navMobile!.push('unknown')
    expect(() => validateSnapshot(corrupt)).toThrow('ナビゲーション')
    await db.settings.update('main', { navDesktop: ['tasks'], navMobile: [] })
    await restoreBackup(saved)
    expect((await db.settings.get('main'))).toMatchObject({ navDesktop: [], navMobile: ['today', 'wall'] })
  })
  it('Wallの配置を復元し、不正な座標を拒否する', async () => {
    const id = await createTask({ ...newTaskInput(), title: '付箋' })
    await addWallTile(id, '準備')
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    const corrupt = structuredClone(saved)
    corrupt.settings[0].wallTiles![0].x = 99
    expect(() => validateSnapshot(corrupt)).toThrow('Wall')
    await db.settings.update('main', { wallTiles: [] })
    await restoreBackup(saved)
    expect((await db.settings.get('main'))?.wallTiles).toEqual([{ taskId: id, x: 0, y: 0, group: '準備' }])
  })
  it('有効な実績と取消履歴を復元できる', async () => {
    const input = { ...newTaskInput(), title: '復元するタスク', score: { ...emptyScore(), mode: 'manual' as const, manualPoints: 20 } }
    const id = await createTask(input)
    await completeTask(id, 1)
    await correctCompletion(id, 25, '実績を訂正')
    await undoCompletion(id, 2)
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    await db.tasks.clear()
    await restoreBackup(saved)
    expect((await db.tasks.get(id))?.title).toBe('復元するタスク')
    expect((await db.ledger.toArray()).reduce((sum, entry) => sum + entry.delta, 0)).toBe(0)
  })

  it('台帳の不一致を拒否し現在のデータを保持する', async () => {
    const id = await createTask({ ...newTaskInput(), title: '保護対象', score: { ...emptyScore(), mode: 'manual', manualPoints: 20 } })
    await completeTask(id, 1)
    const corrupt = await snapshot()
    corrupt.ledger[0].delta = 99
    await expect(restoreBackup(corrupt)).rejects.toThrow('台帳の合計')
    expect((await db.tasks.get(id))?.title).toBe('保護対象')
    expect((await db.ledger.toArray())[0].delta).toBe(20)
  })

  it('重複キー、欠落した評価、不正な日時を拒否する', async () => {
    await createTask({ ...newTaskInput(), title: '一件目' })
    await createTask({ ...newTaskInput(), title: '二件目' })
    const valid = await snapshot()
    const duplicate = structuredClone(valid)
    duplicate.tasks[1].generationKey = duplicate.tasks[0].generationKey
    expect(() => validateSnapshot(duplicate)).toThrow('重複')
    const missing = structuredClone(valid)
    missing.assessments = []
    expect(() => validateSnapshot(missing)).toThrow('評価参照')
    const badDate = structuredClone(valid)
    badDate.tasks[0].createdAt = 'yesterday'
    expect(() => validateSnapshot(badDate)).toThrow('履歴')
  })
  it('認証情報のような未対応設定を取り込まない', async () => {
    const data = await snapshot()
    const injected = { ...data, settings: [{ ...data.settings[0], apiKey: 'synthetic-test-only' }] }
    expect(() => validateSnapshot(injected)).toThrow('未対応の項目')
  })
  it('version付きJSONを検証して復元候補を返す', async () => {
    await createTask({ ...newTaskInput(), title: 'JSONの対象' })
    const data = await snapshot()
    const file = new File([JSON.stringify(data)], 'portable.json', { type: 'application/json' })
    const inspected = await inspectBackup(file, '')
    expect(inspected.tasks[0].title).toBe('JSONの対象')
    expect(inspected.format).toBe('coachbundle')
  })
  it('階層付きタスクを復元し参照を保つ', async () => {
    const parent = await createContainer({ kind: 'category', name: '生活', parentId: null })
    const child = await createContainer({ kind: 'project', name: '買い物', parentId: parent })
    const id = await createTask({ ...newTaskInput(), title: '食品を買う', containerId: child })
    const saved = await snapshot()
    await db.containers.clear(); await db.tasks.clear()
    await restoreBackup(saved)
    expect((await db.tasks.get(id))?.containerId).toBe(child)
    expect((await db.containers.get(child))?.parentId).toBe(parent)
  })
  it('配分済みチェック項目と子タスクを一緒に復元する', async () => {
    const parent = await createTask({ ...newTaskInput(), title: '親', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
    const item = await addChecklistItem(parent, '子にする項目')
    const child = await convertChecklistItem(item, 1, 10)
    const saved = await snapshot()
    await db.checklistItems.clear(); await db.tasks.clear()
    await restoreBackup(saved)
    expect((await db.checklistItems.get(item))?.convertedTaskId).toBe(child)
    expect((await db.tasks.get(parent))?.effectivePoints).toBe(30)
    expect((await db.tasks.get(child))?.effectivePoints).toBe(10)
  })
  it('singleグループを保持して復元し、二値指定の破損を拒否する', async () => {
    const group = await createLabelGroup('場所', 'single')
    await createLabelDefinition('家', group); await createLabelDefinition('外', group)
    const id = await createTask({ ...newTaskInput(), title: '準備', labels: ['家'] })
    const saved = await snapshot()
    const corrupt = structuredClone(saved)
    corrupt.tasks[0].labels = ['家', '外']
    await expect(restoreBackup(corrupt)).rejects.toThrow('1つだけ')
    await db.labelGroups.clear(); await db.labelDefinitions.clear(); await db.tasks.clear()
    await restoreBackup(saved)
    expect((await db.labelGroups.get(group))?.selectionMode).toBe('single')
    expect((await db.tasks.get(id))?.labels).toEqual(['家'])
  })
  it('保存済みテンプレートを復元して新しい発生回を作る', async () => {
    const source = await createTask({ ...newTaskInput(), title: '準備' })
    await addChecklistItem(source, '持ち物')
    const template = await saveTaskTemplate(source, '準備')
    const saved = await snapshot()
    await db.savedTemplates.clear()
    await restoreBackup(saved)
    expect((await db.savedTemplates.get(template))?.version).toBe(1)
    const created = await instantiateTemplate(template)
    expect((await db.checklistItems.where('taskId').equals(created.taskIds[0]).first())?.done).toBe(false)
  })
  it('ノート・コメント・添付の内容とハッシュを検証して復元する', async () => {
    const task = await createTask({ ...newTaskInput(), title: '資料' })
    await addTaskNote(task, '**確認**', 'self'); await addTaskComment(task, '確認しました')
    const id = await addTaskAttachment(task, new File(['contents'], 'memo.txt', { type: 'text/plain' }))
    const saved = await snapshot()
    const corrupt = structuredClone(saved)
    corrupt.taskAttachments![0].contentBase64 = btoa('tampered')
    await expect(restoreBackup(corrupt)).rejects.toThrow('ハッシュ')
    expect(await db.taskAttachments.count()).toBe(1)
    await db.taskAttachments.clear(); await db.taskNotes.clear(); await db.taskComments.clear()
    await restoreBackup(saved)
    expect((await db.taskNotes.toArray())[0].body).toBe('**確認**')
    expect((await db.taskComments.toArray())[0].body).toBe('確認しました')
    expect((await getTaskAttachment(id, (await ensureSettings()).profileId)).name).toBe('memo.txt')
  })
  it('依存関係を復元し、循環するバックアップは拒否する', async () => {
    const a = await createTask({ ...newTaskInput(), title: 'A' }), b = await createTask({ ...newTaskInput(), title: 'B' })
    await addTaskDependency(b, a)
    const saved = await snapshot()
    const corrupt = structuredClone(saved)
    corrupt.taskDependencies!.push({ id: crypto.randomUUID(), taskId: a, dependsOnId: b, createdAt: new Date().toISOString() })
    await expect(restoreBackup(corrupt)).rejects.toThrow('循環')
    await db.taskDependencies.clear()
    await restoreBackup(saved)
    expect((await db.taskDependencies.toArray())[0]).toMatchObject({ taskId: b, dependsOnId: a })
  })
  it('期間計画への割当を復元する', async () => {
    const bucket = await createPlanningBucket('quarter', '2026-10-01')
    const id = await createTask({ ...newTaskInput(), title: '計画済み' })
    await assignTaskToBucket(id, 1, bucket)
    const saved = await snapshot()
    await db.tasks.clear(); await db.planningBuckets.clear()
    await restoreBackup(saved)
    expect((await db.tasks.get(id))?.planBucketId).toBe(bucket)
    expect((await db.planningBuckets.get(bucket))?.kind).toBe('quarter')
  })
  it('時間枠と会議を別資源として復元する', async () => {
    const block = await createTimeBlock({ kind: 'activity', category: '学習', projectId: null, date: '2026-10-01', startMinute: 540, endMinute: 600, timezone: 'Asia/Tokyo' })
    const event = await createCalendarEvent({ kind: 'meeting', title: '会議', startAt: '2026-10-01T01:00:00.000Z', endAt: '2026-10-01T02:00:00.000Z', timezone: 'Asia/Tokyo', linkedTaskId: null })
    const saved = await snapshot()
    await db.timeBlocks.clear(); await db.calendarEvents.clear()
    await restoreBackup(saved)
    expect((await db.timeBlocks.get(block))?.category).toBe('学習')
    expect((await db.calendarEvents.get(event))?.title).toBe('会議')
  })
  it('初回予定日と繰越履歴を復元する', async () => {
    const id = await createTask({ ...newTaskInput(), title: '繰越', scheduledDate: '2026-10-01' })
    await rolloverTask(id, 1, '2026-10-02')
    const saved = await snapshot()
    await db.rollovers.clear(); await db.tasks.clear()
    await restoreBackup(saved)
    expect((await db.tasks.get(id))?.firstScheduledDate).toBe('2026-10-01')
    expect((await db.rollovers.where('taskId').equals(id).first())?.toDate).toBe('2026-10-02')
  })
  it('重点テーマと気力属性を復元する', async () => {
    const id = await createTask({ ...newTaskInput(), title: '執筆', project: '執筆', energyNeed: 0, focusNeed: null, positiveFeeling: 3 })
    const rule = await createThemeRule({ category: '執筆', weekdays: [2], startDate: null, endDate: null, strength: 2 })
    const saved = await snapshot()
    await db.tasks.clear(); await db.themeRules.clear()
    await restoreBackup(saved)
    expect(await db.tasks.get(id)).toMatchObject({ energyNeed: 0, focusNeed: null, positiveFeeling: 3 })
    expect((await db.themeRules.get(rule))?.weekdays).toEqual([2])
  })
  it('今日の表示区分とタスクの割当を復元する', async () => {
    const id = await createTask({ ...newTaskInput(), title: '午前の作業' })
    await assignDaySection(id, 1, 'dayHalf', 'morning')
    await setDaySectionMode('halfday')
    const saved = await snapshot()
    await db.tasks.clear()
    await restoreBackup(saved)
    expect((await db.tasks.get(id))?.dayHalf).toBe('morning')
    expect((await db.settings.get('main'))?.daySectionMode).toBe('halfday')
  })
  it('Smart Listの条件を復元し、不正な演算子を拒否する', async () => {
    const id = await createSmartList('短時間', { type: 'condition', field: 'minutes', operator: 'lte', value: 15 })
    const saved = await snapshot()
    await db.smartLists.clear()
    await restoreBackup(saved)
    expect((await db.smartLists.get(id))?.name).toBe('短時間')
    const corrupt = structuredClone(saved)
    corrupt.smartLists![0].ast = { type: 'condition', field: 'minutes', operator: 'eval' } as never
    expect(() => validateSnapshot(corrupt)).toThrow('演算子')
  })
  it('本人の重点案件と表示件数を復元する', async () => {
    await createTask({ ...newTaskInput(), title: '案件B', project: 'B' })
    await setFocusProjects('2026-10-01', ['B'], 'user')
    await db.settings.update('main', { taskListLimit: 5 })
    const saved = await snapshot()
    await db.focusSelections.clear()
    await restoreBackup(saved)
    expect((await db.focusSelections.toArray())[0]).toMatchObject({ projects: ['B'], source: 'user' })
    expect((await db.settings.get('main'))?.taskListLimit).toBe(5)
  })
  it('Spotlight参照を復元してもタスクは増えない', async () => {
    const id = await createTask({ ...newTaskInput(), title: '集中する作業' })
    await setSpotlight(id, 1, true)
    const saved = await snapshot()
    await db.tasks.clear()
    await restoreBackup(saved)
    expect(await db.tasks.count()).toBe(1)
    expect((await db.tasks.get(id))?.spotlightOrder).toBe(1)
  })
  it('時間目標と当日進捗の固定基準を復元する', async () => {
    const containerId = await createContainer({ kind: 'project', name: '学習', parentId: null })
    const taskId = await createTask({ ...newTaskInput(), title: '練習', scheduledDate: '2026-10-01' })
    await createTimeTarget(containerId, '2026-10-01', '2026-10-07', 180)
    await captureDayProgressBaseline('2026-10-01')
    const saved = await snapshot()
    await db.settings.put({ ...(await db.settings.get('main'))!, timeTargets: [], dayProgressBaseline: undefined })
    await restoreBackup(saved)
    const settings = await db.settings.get('main')
    expect(settings?.timeTargets?.[0].targetMinutes).toBe(180)
    expect(settings?.dayProgressBaseline?.entries[0].taskId).toBe(taskId)
  })
  it('習慣と訂正履歴を復元し、参照先のないログを拒否する', async () => {
    const habitId = await createHabit({ title: '読書', direction: 'increase', unit: '分', targetAmount: 20, cadence: 'daily', weekdays: [0, 1, 2, 3, 4, 5, 6], timezone: 'Asia/Tokyo', routineId: null })
    await recordHabitLog(habitId, '2026-10-01', 10)
    await recordHabitLog(habitId, '2026-10-01', 20, '訂正')
    const saved = await snapshot()
    const invalid = structuredClone(saved)
    invalid.habitLogs![0].habitId = 'missing'
    expect(() => validateSnapshot(invalid)).toThrow('習慣ログ')
    await db.habitLogs.clear(); await db.habits.clear()
    await restoreBackup(saved)
    expect((await db.habitLogs.get(`${habitId}:2026-10-01`))?.history).toHaveLength(1)
  })
  it('目標とチェックインを復元する', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '目標の作業' })
    const goalId = await createGoal({ title: '習得', description: '', parentId: null, dueDate: null, containerId: null, taskIds: [taskId], habitIds: [], manualPercent: null, checkInCadence: 'weekly', checkInQuestion: '進捗は？' })
    await createGoalCheckIn(goalId, '2026-10-01', '進めた')
    const saved = await snapshot()
    await db.goalCheckIns.clear(); await db.goals.clear()
    await restoreBackup(saved)
    expect((await db.goals.get(goalId))?.taskIds).toEqual([taskId])
    expect((await db.goalCheckIns.where('goalId').equals(goalId).first())?.answer).toBe('進めた')
  })
  it('空欄の気力記録と日記を復元する', async () => {
    const trackerId = await createTracker('気力', '段階', 0, 5)
    await recordTrackerEntry(trackerId, null)
    const noteId = await saveDayNote('2026-10-01', 'Asia/Tokyo', '本人のメモ')
    const saved = await snapshot()
    await db.trackerEntries.clear(); await db.trackerDefinitions.clear(); await db.dayNotes.clear()
    await restoreBackup(saved)
    expect((await db.trackerEntries.where('trackerId').equals(trackerId).first())?.value).toBeNull()
    expect((await db.dayNotes.get(noteId))?.humanText).toBe('本人のメモ')
  })
  it('ポモドーロ回数をタスクや作業区間と別に復元する', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '集中' })
    const runtime = startPomodoro(taskId, 25, '2026-10-01T10:00:00.000Z')
    await recordPomodoro(runtime, '2026-10-01T10:25:00.000Z')
    const saved = await snapshot()
    await db.pomodoroCycles.clear()
    await restoreBackup(saved)
    expect((await db.pomodoroCycles.toArray())[0]).toMatchObject({ taskId, targetMinutes: 25, elapsedMinutes: 25 })
  })
})
