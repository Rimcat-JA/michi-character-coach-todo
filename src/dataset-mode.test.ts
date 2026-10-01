import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './db'
import { completeTask, createTask, newTaskInput, updateTask } from './commands'
import { applyChangeSet, approveChangeSetFromUI, prepareTaskChanges, type ChangeContext } from './change-set'
import { validateSnapshot } from './backup-validation'
import { captureSnapshot, restoreBackup } from './backup'
import { purgeExpiredCalendarOriginals } from './calendar-import-retention'
import { emptyCoachNotificationState, reserveCoachNotification, type NotificationGuard, type NotificationRequest } from './coach-notifications'
import { prepareCoachNotificationDelivery } from './coach-notification-save'
import { saveAchievementPolicyFromUI } from './achievements-save'
import { achievementTestGateway } from './achievements-test-fixtures'
import type { GitHubAchievementsGateway } from './github-publish-types'
import { acceptMoveBundle, cancelMove, completeMoveOnSender, currentDatasetMode, exportFork, forkSnapshot, moveCompletionCode, startMove } from './dataset-mode'
import { replaceWithHandoff } from './handoff'
import { validateHandoffManifest } from './handoff-manifest'
import { counts, exportFile, humanClick, inputOf, manualTask, PASSWORD, readBundle, resetDevices, switchDevice } from './device-test-fixtures'

beforeEach(() => resetDevices())
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
async function owner(): Promise<ChangeContext> { const settings = (await db.settings.get('main'))!; return { principal: { id: settings.profileId, kind: 'human' }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: ['title', 'scheduledDate'], sourceRevisions: [] } }
async function rows() { return { ...await counts(), audits: (await db.audits.toArray()).filter(row => row.operation !== 'dataset_move_started').length, commands: await db.commands.count(), titles: (await db.tasks.toArray()).map(task => `${task.title}:${task.revision}:${task.status}`).sort() } }
async function move(files: string[] = []) { await startMove(PASSWORD, humanClick(), content => { files.push(content) }); return files }

describe('I05 移行中の凍結（DATASET_FROZEN）', () => {
  it('凍結中はタスク作成・編集・完了・承認済みChangeSetの適用がすべて失敗し、部分的な書込みも残らない', async () => {
    await switchDevice('A')
    const id = await manualTask('移行前のタスク', 25), context = await owner()
    const prepared = await prepareTaskChanges([{ taskId: id, expectedRevision: 1, patch: { scheduledDate: '2026-10-20' } }], context)
    const approval = await approveChangeSetFromUI(prepared, context, humanClick())
    await move()
    expect(await currentDatasetMode()).toBe('frozen')
    const before = await rows(), task = (await db.tasks.get(id))!
    await expect(createTask({ ...newTaskInput(), title: '凍結中の新規' })).rejects.toMatchObject({ code: 'DATASET_FROZEN', message: expect.stringContaining('凍結中') })
    await expect(updateTask(id, task.revision, { ...inputOf(task), title: '凍結中の編集' })).rejects.toMatchObject({ code: 'DATASET_FROZEN' })
    await expect(completeTask(id, task.revision)).rejects.toMatchObject({ code: 'DATASET_FROZEN' })
    await expect(applyChangeSet(prepared, approval, context, 'frozen-apply')).rejects.toMatchObject({ code: 'DATASET_FROZEN' })
    expect(await rows()).toEqual(before)
  })

  it('凍結中でも記録系（書き出し・引継ぎ記録・保持期限の整理・設定の最終書出日時）は動く', async () => {
    await switchDevice('A')
    await manualTask('記録系', 10)
    await move()
    await expect(purgeExpiredCalendarOriginals()).resolves.toBeUndefined()
    const file = await exportFile()
    expect(file.snapshot.tasks).toHaveLength(1)
    expect((await db.settings.get('main'))!.lastBackupAt).not.toBeNull()
    expect(await db.handoffHeads.where('direction').equals('export').count()).toBe(2)
    expect(await currentDatasetMode()).toBe('frozen')
  })

  it('完了コード前の取消で送出側は再開でき、誤ったコードは拒否されて凍結のまま', async () => {
    await switchDevice('A')
    await manualTask('取消の対象', 10)
    await move()
    await expect(cancelMove(new Event('click'))).rejects.toThrow('本人確認')
    await cancelMove(humanClick())
    expect(await currentDatasetMode()).toBe('active')
    await createTask({ ...newTaskInput(), title: '再開後の新規' })
    await move()
    await expect(completeMoveOnSender('AAAA-AAAA', humanClick())).rejects.toThrow('一致しません')
    expect(await currentDatasetMode()).toBe('frozen')
  })

  it('本人の明示的な復元は凍結中の端末にも適用でき、有効な状態へ戻して保留中の移行を無効にする', async () => {
    await switchDevice('A')
    await manualTask('復元前', 10)
    const saved = await captureSnapshot()
    await move()
    await restoreBackup(saved)
    expect(await currentDatasetMode()).toBe('active'); expect((await db.localDevice.get('main'))!.pendingMove).toBeNull()
    await createTask({ ...newTaskInput(), title: '復元後の新規' })
    await expect(cancelMove(humanClick())).rejects.toThrow('取り消せる移行')
  })

  it('A→Bの移行: Bは検証後に有効、Aは完了コードで読み取り専用になり完了操作は日本語で失敗する', async () => {
    await switchDevice('A')
    const id = await manualTask('移行するタスク', 25)
    const [text] = await move(), moveId = (await db.localDevice.get('main'))!.pendingMove!.moveId
    await switchDevice('B')
    await manualTask('Bの古いデータ', 1)
    const snapshot = await readBundle(text)
    expect(snapshot.handoff).toMatchObject({ kind: 'move', move_id: moveId })
    await expect(acceptMoveBundle(snapshot, humanClick())).rejects.toThrow('別データセット')
    const code = await acceptMoveBundle(snapshot, humanClick(), { confirmDifferentDataset: true })
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/); expect(code).toBe(await moveCompletionCode(moveId, snapshot.handoff!.kind === 'move' ? snapshot.handoff!.move_secret : ''))
    expect(await currentDatasetMode()).toBe('active'); expect((await db.settings.get('main'))!.lineage).toMatchObject({ moveId })
    await completeTask(id, 1)
    expect((await db.handoffHeads.get(`import:${snapshot.handoff!.bundle_id}`))!.moveCode).toBe(code)
    await switchDevice('A')
    await completeMoveOnSender(code.toLowerCase(), humanClick())
    expect(await currentDatasetMode()).toBe('read_only')
    await expect(completeTask(id, 1)).rejects.toThrow('読み取り専用')
    expect((await db.tasks.get(id))!.status).toBe('open')
  })
})

describe('I05 fork（別dataset_idの独立コピー）', () => {
  it('新しいdataset_idと系譜を持ち、取り込んでもGitHub投稿・通知の試行は0件', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T03:00:00.000Z'))
    await switchDevice('A')
    const taskId = await manualTask('forkするタスク', 20), source = (await db.settings.get('main'))!, at = new Date().toISOString()
    const gateway = { status: vi.fn(async () => structuredClone(achievementTestGateway)), publish: vi.fn(), recordReceipt: vi.fn(), reconcile: vi.fn(), configure: vi.fn(), inspectConfiguration: vi.fn() } as unknown as GitHubAchievementsGateway
    await saveAchievementPolicyFromUI({ threshold: 10, allowedCategoryIds: [], allowedEvidenceKinds: ['user_statement'], requireAttachment: false, enabled: true }, humanClick(), gateway)
    const request: NotificationRequest = { id: 'fork-notice', purpose: 'direct_reply', category: 'reply', target: { kind: 'task', id: taskId, revision: 1 }, ruleId: 'fixture:fork', ruleRevision: '1', ruleWindow: 'fork', notBefore: at, expiresAt: new Date(Date.now() + 3600000).toISOString(), destinationIds: ['in-app'], sourceRefs: [], text: { factual: '保存した通知文', savedAI: null }, intervalMinutes: null, maxCount: null, endDate: null }
    const guard: NotificationGuard = { ownerId: source.profileId, datasetId: source.datasetId, authorityEpoch: 0, sourcePermissionRevision: 0, aiEnabled: false, target: { ...request.target, active: true }, rule: { id: request.ruleId, revision: '1', active: true, sentCount: 0 }, sources: [], availableDestinationIds: ['in-app'] }
    const reserved = reserveCoachNotification(emptyCoachNotificationState(source.profileId, source.datasetId, 'Asia/Tokyo'), request, guard, at)
    expect(reserved.intent).not.toBeNull()
    await db.settings.update('main', { notificationState: reserved.state })
    const files: string[] = []
    const { datasetId } = await exportFork(PASSWORD, humanClick(), content => { files.push(content) })
    expect(datasetId).not.toBe(source.datasetId); expect(await currentDatasetMode()).toBe('active'); expect((await db.settings.get('main'))!.datasetId).toBe(source.datasetId)
    await switchDevice('B')
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy)
    const fork = await readBundle(files[0])
    expect(fork.handoff).toMatchObject({ kind: 'fork', dataset_id: datasetId, parent_dataset_id: source.datasetId, base_bundle_id: null })
    expect(fork.achievementPolicies).toEqual([]); expect(fork.achievementExports).toEqual([])
    await replaceWithHandoff(fork, { confirmDifferentDataset: true })
    const settings = (await db.settings.get('main'))!
    expect(settings.datasetId).toBe(datasetId); expect(settings.aiEnabled).toBe(false)
    expect(settings.lineage).toMatchObject({ parentDatasetId: source.datasetId, ancestorDatasetIds: [source.datasetId], moveId: null })
    expect(await db.achievementPolicies.count()).toBe(0); expect(await db.achievementExports.count()).toBe(0)
    expect(settings.notificationState!.intents.flatMap(intent => intent.deliveries.map(delivery => delivery.state)).every(state => state === 'canceled')).toBe(true)
    expect(await prepareCoachNotificationDelivery('fork-notice', 'in-app')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled(); expect(gateway.publish).not.toHaveBeenCalled()
    expect(await db.tasks.get(taskId)).toMatchObject({ title: 'forkするタスク' })
    await createTask({ ...newTaskInput(), title: 'fork先で編集できる' })
  })

  it('検証器: forkと系譜は往復でき、不正な系譜・移行情報は拒否する', async () => {
    await switchDevice('A')
    await manualTask('検証', 5)
    const snapshot = await captureSnapshot(), fork = forkSnapshot(snapshot, 'fork-dataset-id', new Date().toISOString())
    expect(() => validateSnapshot(JSON.parse(JSON.stringify(fork)))).not.toThrow()
    const self = structuredClone(fork); self.settings[0].lineage = { ...self.settings[0].lineage!, parentDatasetId: 'fork-dataset-id', ancestorDatasetIds: ['fork-dataset-id'] }
    expect(() => validateSnapshot(self)).toThrow('系譜')
    const extra = structuredClone(fork); (extra.settings[0].lineage as unknown as Record<string, unknown>).owner = 'x'
    expect(() => validateSnapshot(extra)).toThrow('系譜')
    expect(() => validateHandoffManifest({ bundle_id: 'b', kind: 'move', dataset_id: 'd', source_device_id: 's', exported_at: new Date().toISOString(), base_bundle_id: null, move_id: 'm', move_secret: 'short' }, 'd')).toThrow('移行情報')
    expect(() => validateHandoffManifest({ bundle_id: 'b', kind: 'sync', dataset_id: 'd', source_device_id: 's', exported_at: new Date().toISOString(), base_bundle_id: null }, 'd')).toThrow('項目')
  })
})
