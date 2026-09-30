import 'fake-indexeddb/auto'
import { liveQuery } from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { availableMemoryContext, createCoachMemory, memoryForSelectedChat, memorySourceFromOption } from './coach-memory'
import { appendCoachReply, beginCoachTurn, createCoachConversation, previewCoachTurnContext, readCoachConversation, searchCoachHistory, setConversationRetention } from './chat-history'
import { currentSourceSummaries, defaultSourcePermissions, importLocalSource, readSource, searchSources, setSourcePermissions, summarizeSelectedSource } from './source-library'
import { refreshLocalRetrieval, searchLocalContext } from './local-retrieval'
import { purgeExpiredCoachContext } from './context-retention'

const model = 'deepseek/deepseek-v4.1-flash', retentionUntil = '2026-10-01T03:01:00.000Z'
let ownerId: string
beforeEach(async () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T03:00:00.000Z')); await db.delete(); await db.open(); ownerId = (await ensureSettings()).profileId; await db.settings.update('main', { aiEnabled: true, aiModel: model }) })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

function readInLiveQuery<T>(querier: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let subscription: { unsubscribe(): void } | undefined
    const timeout = setTimeout(() => { subscription?.unsubscribe(); reject(new Error('liveQueryが完了しません')) }, 2000)
    subscription = liveQuery(querier).subscribe({ next: value => { clearTimeout(timeout); subscription?.unsubscribe(); resolve(value) }, error: failure => { clearTimeout(timeout); subscription?.unsubscribe(); reject(failure) } })
  })
}
async function fixture() {
  const sourceId = await importLocalSource({ title: '資料liveQuery回帰', provider: 'slack', externalId: 'readonly-fixture', conversation: '選択した会話', author: '本人', sourceUrl: null, date: '2026-10-01', fromDate: '2026-09-01', toDate: '2026-10-01', text: '資料の本人原文', permissions: { ...defaultSourcePermissions(), aiEgress: true }, allowedModels: [model], retentionUntil })
  await summarizeSelectedSource(sourceId, 1, model, async () => '資料の保存済み要約')
  const sourceRef = await memorySourceFromOption({ kind: 'library', refId: sourceId, summary: true, label: '本人が選択した要約' }, ownerId)
  const memoryId = await createCoachMemory({ kind: 'inferred', text: '資料の推測メモ', sources: [sourceRef], retentionUntil })
  const conversationId = await createCoachConversation('期限なしの本人会話', 'Asia/Tokyo')
  const turn = await beginCoachTurn(conversationId, 1, { text: '資料の本人相談', mode: 'ai', memoryIds: [memoryId], sourceIds: [sourceId] })
  await appendCoachReply(turn, '資料由来の保存済みAI応答', 'live_ai')
  const expiringId = await createCoachConversation('期限付き本人会話', 'Asia/Tokyo')
  const local = await beginCoachTurn(expiringId, 1, { text: '資料の期限付き本人文章', mode: 'local' }); await appendCoachReply(local, '資料の期限付き定型応答', 'template')
  await setConversationRetention(expiringId, 3, retentionUntil)
  return { sourceId, memoryId, conversationId, expiringId }
}
async function persisted() { return { settings: await db.settings.toArray(), memories: await db.coachMemories.toArray(), sources: await db.contextSources.toArray(), snapshots: await db.contextSnapshots.toArray(), summaries: await db.sourceSummaries.toArray(), conversations: await db.coachConversations.toArray(), messages: await db.coachMessages.toArray() } }

describe('コーチ読込みはDexie liveQuery内で書き込まない', () => {
  it('本人メモ・資料・要約・送信preview・会話・統合検索を本物のliveQueryから読める', async () => {
    const f = await fixture(), before = await persisted(), settingsPut = vi.spyOn(db.settings, 'put'), memoryPut = vi.spyOn(db.coachMemories, 'put')
    const result = await readInLiveQuery(async () => {
      const memories = await availableMemoryContext(ownerId), memory = await memoryForSelectedChat(f.memoryId, ownerId, model), source = await readSource(f.sourceId), summaries = await currentSourceSummaries(f.sourceId)
      const preview = await previewCoachTurnContext({ mode: 'ai', memoryIds: [f.memoryId], sourceIds: [f.sourceId] }), conversation = await readCoachConversation(f.conversationId)
      const sourceSearch = await searchSources('資料', '2026-09-01', '2026-10-01'), chatSearch = await searchCoachHistory('資料', '2026-09-01', '2026-10-01'), search = (await searchLocalContext('資料', '2026-09-01', '2026-10-01'))!, refreshed = await refreshLocalRetrieval(search)
      return { memories, memory, source, summaries, preview, conversation, sourceSearch, chatSearch, refreshed }
    })
    expect(result.memories.inferred[0].text).toBe('資料の推測メモ'); expect(result.memory.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.source.snapshot.text).toBe('資料の本人原文'); expect(result.summaries[0].text).toBe('資料の保存済み要約')
    expect(result.preview.context).toContain('推測・未確認'); expect(result.conversation.messages).toHaveLength(2)
    expect(result.sourceSearch.hits).toHaveLength(1); expect(result.chatSearch.hits.length).toBeGreaterThan(0); expect(result.refreshed!.hits.length).toBeGreaterThan(0)
    expect(settingsPut).not.toHaveBeenCalled(); expect(memoryPut).not.toHaveBeenCalled(); expect(await persisted()).toEqual(before)
  })

  it('期限ちょうどでもliveQueryは即除外し、native cleanupが別経路で物理消去する', async () => {
    const f = await fixture(), previous = (await searchLocalContext('資料', '2026-09-01', '2026-10-01'))!
    vi.setSystemTime(new Date(retentionUntil))
    const result = await readInLiveQuery(async () => {
      const memories = await availableMemoryContext(ownerId), summaries = await currentSourceSummaries(f.sourceId), conversation = await readCoachConversation(f.conversationId), search = await searchLocalContext('資料', '2026-09-01', '2026-10-01'), refreshed = await refreshLocalRetrieval(previous), preview = await previewCoachTurnContext({ mode: 'ai' })
      const refused: string[] = []
      for (const read of [() => readSource(f.sourceId), () => memoryForSelectedChat(f.memoryId, ownerId, model), () => readCoachConversation(f.expiringId), () => previewCoachTurnContext({ mode: 'ai', memoryIds: [f.memoryId] })]) {
        try { await read() } catch (failure) { refused.push(failure instanceof Error ? failure.message : String(failure)) }
      }
      return { memories, summaries, conversation, search, refreshed, preview, refused }
    })
    expect(result.memories).toEqual({ explicit: [], inferred: [] }); expect(result.summaries).toEqual([]); expect(result.refused).toHaveLength(4)
    expect(result.conversation.messages.map(item => item.role)).toEqual(['user']); expect(result.preview.context).toBeNull()
    for (const hits of [result.search!.hits, result.refreshed!.hits]) expect(hits.every(hit => hit.kind === 'conversation' && hit.documentId === f.conversationId && hit.author === '本人')).toBe(true)
    expect(await db.contextSnapshots.count()).toBe(1); expect((await db.coachMemories.get(f.memoryId))!.text).toBe('資料の推測メモ'); expect(await db.coachMessages.count()).toBe(4)
    await purgeExpiredCoachContext()
    expect(await db.contextSnapshots.count()).toBe(0); expect(await db.sourceSummaries.count()).toBe(0)
    expect((await db.coachMemories.get(f.memoryId))!.text).toBe(''); expect((await db.coachConversations.get(f.expiringId))!.deletedAt).toBe(retentionUntil)
    expect(await db.coachMessages.count()).toBe(1)
  })

  it('資料許可取消のnative書込み後に購読中の統合検索から古い引用が消える', async () => {
    const f = await fixture(), previous = (await searchLocalContext('資料', '2026-09-01', '2026-10-01'))!, emissions: number[] = [], failures: unknown[] = []
    const subscription = liveQuery(() => refreshLocalRetrieval(previous)).subscribe({ next: value => emissions.push(value?.hits.length ?? -1), error: failure => failures.push(failure) })
    try {
      await vi.waitFor(() => expect(emissions.length).toBe(1))
      await setSourcePermissions(f.sourceId, 1, { ...defaultSourcePermissions(), index: false }, [], null)
      await vi.waitFor(() => expect(emissions.length).toBeGreaterThan(1))
      expect(emissions[0]).toBeGreaterThan(emissions.at(-1)!); expect(failures).toEqual([])
      expect((await readInLiveQuery(() => refreshLocalRetrieval(previous)))!.hits.every(hit => hit.kind !== 'library')).toBe(true)
    } finally { subscription.unsubscribe() }
  })
})
