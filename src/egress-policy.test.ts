import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput } from './commands'
import { changePolicyFor, clearChangeSetAuthority } from './change-set'
import { setSourcePermissions } from './source-library'
import { beginCoachTurn, clearCoachTurnAuthority, createCoachConversation, previewCoachTurnContext } from './chat-history'
import { clearDetectionAuthority } from './detection-run'
import { prepareCoachTaskRequest } from './coach-task-change'
import { createFileBridgeController } from './file-bridge-commands'
import type { FileBridgeGateway, FileBridgeRegistration, FileBridgeStatus } from './file-bridge-types'
import { ownerNotesForEgress, scoreAssistText } from './egress-policy'
import { adoptDetectedTask, enableSyntheticAI, humanClick, importWorkSlack, otherModel, quoteModel, secretQuote } from './source-quote-fixtures'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings(); await enableSyntheticAI(); clearDetectionAuthority(); clearCoachTurnAuthority(); clearChangeSetAuthority() })
afterEach(() => { vi.restoreAllMocks() })

const legacyNotes = (sourceId: string) => `資料から検出し本人が確認する候補。検出=${quoteModel} / 検証=${quoteModel}（同じモデル、独立評価未通過）\n根拠: explicit_request / requested\n[${sourceId} 内容版1 ${sourceId}:1:1] ${secretQuote}\n期限の原文: ${secretQuote}`
/** A transport spy per route; every payload a route would send is captured here. */
async function sendThroughAllRoutes(taskId: string, ownNotes = '', changeInstruction = 'メモに補足を追記して') {
  const task = (await db.tasks.get(taskId))!, payloads: Record<string, string> = {}
  const preview = await previewCoachTurnContext({ mode: 'ai', taskId })
  const conversationId = await createCoachConversation('送信経路の確認', 'Asia/Tokyo'), conversation = (await db.coachConversations.get(conversationId))!
  const turn = await beginCoachTurn(conversationId, conversation.revision, { text: 'このタスクを整理したい', mode: 'ai', taskId, expectedContextDigest: preview.digest })
  const chat = vi.fn(async (request: unknown) => { payloads.chat = JSON.stringify(request); return '合成応答' })
  await chat({ model: turn.model, message: 'このタスクを整理したい', selectedTask: turn.selectedContext })
  const proposeTaskChange = vi.fn(async (request: unknown) => { payloads.change = JSON.stringify(request); return '{}' })
  await proposeTaskChange((await prepareCoachTaskRequest(task, changeInstruction, (await db.settings.get('main'))!.aiModel!, '2026-10-01', 'Asia/Tokyo')).request)
  const assessScore = vi.fn(async (request: unknown) => { payloads.score = JSON.stringify(request); return '{}' })
  await assessScore({ model: quoteModel, text: scoreAssistText(task.title, task.notes) })
  payloads.bridge = JSON.stringify(await exportThroughBridge(taskId))
  expect(chat).toHaveBeenCalledOnce(); expect(proposeTaskChange).toHaveBeenCalledOnce(); expect(assessScore).toHaveBeenCalledOnce()
  if (ownNotes) for (const route of ['chat', 'change', 'score', 'bridge']) expect(payloads[route], route).toContain(ownNotes)
  return { payloads, preview }
}
async function exportThroughBridge(taskId: string) {
  const settings = (await db.settings.get('main'))!, policy = changePolicyFor(settings), future = new Date(Date.now() + 3600000).toISOString()
  const registration: FileBridgeRegistration = { schema_version: '1', owner_id: settings.profileId, dataset_id: settings.datasetId, policy_epoch: policy.epoch, source_permission_revision: policy.sourcePermissionRevision, task_ids: [taskId], client: { id: crypto.randomUUID(), dataset_id: settings.datasetId, intended_host: 'codex', transport: 'stdio', status: 'active', revision: 1, grant_epoch: 1, grant: { keys: ['tasks:read', 'tasks:prepare', 'changes:submit', 'commands:read'], project_ids: [], fields: ['title', 'notes', 'scheduled_date'], mutation_mode: 'require_approval', max_operations_per_day: 10, max_schedule_shift_days: 3, max_point_delta: 0, allow_external_context: false, allow_handoffs: false, expires_at: future } } }
  const status: FileBridgeStatus = { version: 1, available: true, connected: true, root: 'C:\\synthetic-agent-folder', registration, snapshot: null, results: [], notice: 'Synthetic trusted main gateway' }
  let exported: unknown = null
  const gateway = { status: vi.fn(async () => structuredClone(status)), exportSnapshot: vi.fn(async (request: unknown) => { exported = request; return structuredClone(status) }) } as unknown as FileBridgeGateway
  const controller = createFileBridgeController(gateway)
  await controller.refresh(); await controller.exportSnapshot(humanClick())
  return { exported, withheld: controller.lastEgress() }
}

describe('K08 資料由来の引用は資料ごとの許可がない送信経路へ出ない', () => {
  it('読取だけに戻した仕事Slackの採用タスクは、会話・変更案・点数補助・file bridgeのどれにも引用を出さない', async () => {
    const { sourceId, taskId } = await adoptDetectedTask()
    const source = (await db.contextSources.get(sourceId))!
    await setSourcePermissions(sourceId, source.revision, { ...source.permissions, aiEgress: false }, [], null)
    expect(await db.taskSourceEvidence.where('taskId').equals(taskId).count()).toBe(1)
    const { payloads, preview } = await sendThroughAllRoutes(taskId)
    for (const route of ['chat', 'change', 'score', 'bridge']) expect(payloads[route], route).not.toContain('顧客ZETA')
    expect(preview).toMatchObject({ withheldQuotes: 1, notesWithheld: false })
    expect(preview.sources.map(ref => ref.kind)).toEqual(['task'])
    const audits = (await db.audits.toArray()).filter(audit => audit.operation.startsWith('egress.'))
    expect(audits.map(audit => audit.operation).sort()).toEqual(['egress.coach-chat', 'egress.coach-task-change', 'egress.file-bridge'])
    expect(JSON.stringify(audits)).not.toContain('顧客ZETA'); expect(JSON.parse(audits.find(audit => audit.operation === 'egress.coach-chat')!.detail)).toMatchObject({ destination: 'openrouter', model: quoteModel, tasks: [{ taskId, withheldSourceIds: [sourceId], withheldQuotes: 1 }] })
  })
  it('許可したモデルの会話だけに引用を含め、file bridge・変更案・点数補助では既定で除外し、許可外モデルへ切り替えると除外する', async () => {
    const { sourceId, taskId } = await adoptDetectedTask()
    let { payloads, preview } = await sendThroughAllRoutes(taskId)
    expect(payloads.chat).toContain('顧客ZETA'); expect(preview.sources).toContainEqual(expect.objectContaining({ kind: 'library', id: sourceId }))
    for (const route of ['change', 'score', 'bridge']) expect(payloads[route], route).not.toContain('顧客ZETA')
    expect(JSON.parse(payloads.bridge).withheld).toEqual({ withheldQuotes: 1, notesWithheld: 0 })
    await db.settings.update('main', { aiModel: otherModel });
    ({ payloads, preview } = await sendThroughAllRoutes(taskId))
    expect(payloads.chat).not.toContain('顧客ZETA'); expect(preview.withheldQuotes).toBe(1)
  })
  it('preview後に資料のAI送信許可を取り消すとConflictになり、送信しない', async () => {
    const { sourceId, taskId } = await adoptDetectedTask()
    const preview = await previewCoachTurnContext({ mode: 'ai', taskId })
    expect(preview.context).toContain('顧客ZETA')
    const source = (await db.contextSources.get(sourceId))!
    await setSourcePermissions(sourceId, source.revision, { ...source.permissions, aiEgress: false }, [], null)
    const conversationId = await createCoachConversation('取消後', 'Asia/Tokyo'), conversation = (await db.coachConversations.get(conversationId))!, send = vi.fn()
    await expect(beginCoachTurn(conversationId, conversation.revision, { text: '送信', mode: 'ai', taskId, expectedContextDigest: preview.digest }).then(send)).rejects.toThrow('別の画面で更新')
    expect(send).not.toHaveBeenCalled(); expect(await db.coachMessages.count()).toBe(0)
  })
  it('本人が書いたメモは文字を変えずに4経路へ送る', async () => {
    const own = '本人が書いた補足：月曜に上司へ確認\n[参考] 社内wikiを読む'
    const taskId = await createTask({ ...newTaskInput(), title: '本人の作業', notes: own })
    expect(ownerNotesForEgress(own)).toEqual({ notes: own, withheldQuotes: 0, notesWithheld: false })
    const { payloads, preview } = await sendThroughAllRoutes(taskId, '本人が書いた補足')
    expect(payloads.chat).toContain(JSON.stringify(own).slice(1, -1)); expect(JSON.parse(payloads.bridge).exported.tasks[0].notes).toBe(own)
    expect(preview.withheldQuotes).toBe(0)
  })
  it('旧形式メモは完全一致の機械生成部分だけ送らず、本人が編集した旧形式は手動確認まで送らない', async () => {
    const sourceId = await importWorkSlack({ permissions: { aiEgress: false }, allowedModels: [] })
    const exact = await createTask({ ...newTaskInput(), title: '旧形式の採用タスク', notes: legacyNotes(sourceId) })
    let { payloads, preview } = await sendThroughAllRoutes(exact)
    for (const route of ['chat', 'change', 'score', 'bridge']) expect(payloads[route], route).not.toContain('顧客ZETA')
    expect(payloads.chat).toContain('根拠: explicit_request / requested'); expect(preview).toMatchObject({ withheldQuotes: 1, notesWithheld: false })
    const edited = await createTask({ ...newTaskInput(), title: '旧形式を編集したタスク', notes: `${legacyNotes(sourceId)}\n本人の追記` })
    expect(ownerNotesForEgress((await db.tasks.get(edited))!.notes)).toMatchObject({ notes: '', notesWithheld: true });
    ({ payloads, preview } = await sendThroughAllRoutes(edited, '', '明日に移して'))
    for (const route of ['chat', 'change', 'score', 'bridge']) expect(payloads[route], route).not.toContain('顧客ZETA')
    expect(preview.notesWithheld).toBe(true)
    await expect(prepareCoachTaskRequest((await db.tasks.get(edited))!, 'メモに補足を追記して', quoteModel, '2026-10-01', 'Asia/Tokyo')).rejects.toThrow('資料由来の可能性')
    expect((await db.tasks.get(edited))!.notes).toBe(`${legacyNotes(sourceId)}\n本人の追記`)
  })
})
