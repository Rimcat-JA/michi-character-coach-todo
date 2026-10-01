import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { createTasksAtomic, newTaskInput } from './commands'
import { uid } from './domain'
import { deleteSource, purgeExpiredSources, readSource, summarizeSelectedSource } from './source-library'
import { purgeExpiredCoachContext } from './context-retention'
import { appendCoachReply, beginCoachTurn, clearCoachTurnAuthority, createCoachConversation, maxChatSourceRefs, previewCoachTurnContext } from './chat-history'
import { createCoachMemory } from './coach-memory'
import { createGoal, createGoalCheckIn } from './goals'
import { clearDetectionAuthority } from './detection-run'
import { captureSnapshot, restoreBackup } from './backup'
import { quoteDigest } from './task-source-evidence'
import { adoptDetectedTask, enableSyntheticAI, importWorkSlack, quoteModel, secretQuote } from './source-quote-fixtures'

// Synthetic fake-indexeddb regressions only: no real device, account, network or model.
const failures = vi.hoisted(() => ({ memoryPurge: 0 }))
vi.mock('./coach-memory', async original => {
  const actual = await original<typeof import('./coach-memory')>()
  return { ...actual, purgeExpiredMemories: async () => { if (failures.memoryPurge > 0) { failures.memoryPurge--; throw new Error('合成の後処理失敗') } return actual.purgeExpiredMemories() } }
})

beforeEach(async () => {
  failures.memoryPurge = 0
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T03:00:00.000Z'))
  await db.delete(); await db.open(); await ensureSettings(); await enableSyntheticAI(); clearDetectionAuthority(); clearCoachTurnAuthority()
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

const quoteFragment = '顧客ZETA'
async function erasedState(sourceId: string) {
  await expect(readSource(sourceId)).rejects.toThrow()
  expect(await db.contextSources.get(sourceId)).toMatchObject({ deletedAt: expect.any(String), title: '削除した資料' })
  expect(await db.contextSnapshots.where('sourceId').equals(sourceId).count()).toBe(0); expect(await db.sourceSummaries.where('sourceId').equals(sourceId).count()).toBe(0); expect(await db.taskSourceEvidence.where('sourceId').equals(sourceId).count()).toBe(0)
  expect((await db.coachMessages.toArray()).filter(message => message.role === 'assistant')).toEqual([])
  expect(JSON.stringify(await Promise.all(db.tables.map(table => table.toArray())))).not.toContain(quoteFragment)
}

describe('K11 復元後の後処理が失敗しても、この端末で削除した資料は戻らない', () => {
  it('復元のコミット後に後処理が例外で止まっても、削除記録と原文・要約・AI返信なしの状態が残る', async () => {
    const { sourceId } = await adoptDetectedTask()
    await summarizeSelectedSource(sourceId, (await db.contextSources.get(sourceId))!.revision, quoteModel, async () => '合成要約: 顧客ZETAの見積')
    const conversationId = await createCoachConversation('資料を使う会話', 'Asia/Tokyo'), conversation = (await db.coachConversations.get(conversationId))!
    await appendCoachReply(await beginCoachTurn(conversationId, conversation.revision, { text: '選んだ資料を確認したい', mode: 'ai', sourceIds: [sourceId] }), '合成AI返信: 顧客ZETAの件ですね', 'live_ai')
    const saved = await captureSnapshot()
    await deleteSource(sourceId, (await db.contextSources.get(sourceId))!.revision)
    failures.memoryPurge = 1
    await expect(restoreBackup(saved)).rejects.toThrow('合成の後処理失敗')
    await erasedState(sourceId)
    await purgeExpiredCoachContext()
    await erasedState(sourceId)
  })
})

describe('K11 期限切れの一括整理はタスク・監査をロックしない', () => {
  it('タスク・監査・受領記録の長い書込みトランザクション中でも、期限切れ資料の消去が完了する', async () => {
    const ids = await Promise.all(Array.from({ length: 5 }, () => importWorkSlack({ retentionUntil: '2026-10-05T00:00:00.000Z' })))
    await createTasksAtomic(Array.from({ length: 60 }, (_, index) => ({ ...newTaskInput(), title: `合成タスク${index}` })))
    await db.audits.bulkAdd(Array.from({ length: 300 }, (_, index) => ({ id: uid(), taskId: null, operation: 'synthetic.audit', at: new Date().toISOString(), detail: `合成監査${index}` })))
    vi.setSystemTime(new Date('2026-10-05T00:00:00.000Z'))
    let release!: () => void, started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }), holding = new Promise<void>(resolve => { started = resolve })
    const holder = db.transaction('rw', db.tasks, db.audits, db.commands, async () => { await db.audits.count(); started(); await Dexie.waitFor(gate) })
    await holding
    // Run as its own top-level transaction; IndexedDB still serializes it against the holder if their stores overlap.
    await Dexie.ignoreTransaction(() => purgeExpiredSources())
    for (const id of ids) expect(await db.contextSources.get(id)).toMatchObject({ deletedAt: expect.any(String), title: '削除した資料' })
    expect(await db.contextSnapshots.count()).toBe(0)
    release(); await holder
    expect(await db.tasks.count()).toBe(60); expect((await db.audits.toArray()).filter(row => row.operation === 'synthetic.audit')).toHaveLength(300)
  })
})

describe('K08 会話の出典refは保存とバックアップで同じ上限を使う', () => {
  async function fullSelection() {
    const { taskId } = await adoptDetectedTask()
    const goalId = await createGoal({ title: '本人の目標', description: '', parentId: null, dueDate: null, containerId: null, taskIds: [], habitIds: [], manualPercent: null, checkInCadence: null, checkInQuestion: '' })
    for (const date of ['2026-09-28', '2026-09-29', '2026-09-30']) await createGoalCheckIn(goalId, date, `本人の回答${date}`)
    const sourceIds: string[] = [], memoryIds: string[] = []
    for (let index = 0; index < 10; index++) { sourceIds.push(await importWorkSlack({ text: `選択資料${index}\n本文${index}` })); memoryIds.push(await createCoachMemory({ kind: 'explicit', text: `本人のメモ${index}` })) }
    return { taskId, goalId, sourceIds, memoryIds, mode: 'ai' as const }
  }
  it('最大選択（タスクの根拠つき・目標とチェックイン3件・資料10件・記憶10件）のAI会話でもバックアップを作成・復元できる', async () => {
    const selection = await fullSelection(), preview = await previewCoachTurnContext(selection)
    expect(preview.sources.length).toBe(26); expect(preview.sources.length).toBeLessThanOrEqual(maxChatSourceRefs)
    const conversationId = await createCoachConversation('最大選択', 'Asia/Tokyo')
    await appendCoachReply(await beginCoachTurn(conversationId, 1, { ...selection, text: '全部を見て相談したい' }), '合成AI返信', 'live_ai')
    const saved = await captureSnapshot()
    expect(saved.coachMessages!.map(message => message.selectedSources.length)).toEqual([26, 26])
    await restoreBackup(saved)
    expect(await db.coachMessages.count()).toBe(2)
  })
  it('根拠の資料が多く上限を超える選択は、プレビューで止め、会話を保存しない', async () => {
    const selection = await fullSelection(), owner = (await db.settings.get('main'))!, quoteSha256 = await quoteDigest(secretQuote)
    for (let index = 0; index < 6; index++) {
      const sourceId = await importWorkSlack(), source = (await db.contextSources.get(sourceId))!
      await db.taskSourceEvidence.add({ id: `synthetic:${index}`, ownerId: owner.profileId, datasetId: owner.datasetId, taskId: selection.taskId, sourceId, snapshotRevision: 1, permissionRevision: source.permissionRevision, spanId: `${sourceId}:1:1`, quote: secretQuote, quoteSha256, supports: [], runId: 'synthetic-run', candidateId: 'synthetic-candidate', createdAt: new Date().toISOString() })
    }
    await expect(previewCoachTurnContext(selection)).rejects.toThrow('選択した資料・記憶が多すぎます')
    const conversationId = await createCoachConversation('上限超過', 'Asia/Tokyo')
    await expect(beginCoachTurn(conversationId, 1, { ...selection, text: '全部を見て相談したい' })).rejects.toThrow('選択した資料・記憶が多すぎます')
    expect(await db.coachMessages.count()).toBe(0)
    expect((await db.audits.toArray()).filter(row => row.detail.includes('"coach-chat"'))).toEqual([])
    await expect(captureSnapshot()).resolves.toBeDefined()
  })
})
