import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { defaultSourcePermissions, importLocalSource, setSourcePermissions } from './source-library'
import { appendCoachReply, beginCoachTurn, createCoachConversation, deleteCoachConversation, setConversationRetention } from './chat-history'
import { refreshLocalRetrieval, searchLocalContext } from './local-retrieval'
import { purgeExpiredCoachContext } from './context-retention'

let ownerId: string
beforeEach(async () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T03:00:00.000Z')); await db.delete(); await db.open(); ownerId = (await ensureSettings()).profileId })
afterEach(() => { vi.useRealTimers() })
async function source(change: { index?: boolean; retentionUntil?: string } = {}) { return importLocalSource({ title: '選択Slack export', provider: 'slack', externalId: '17000000000000000001', conversation: '本人が選択したchannel', author: '同僚', sourceUrl: null, date: '2026-10-01', fromDate: '2026-09-02', toDate: '2026-10-01', text: '資料の確認を依頼します\nCafe\u0301😀の資料', permissions: { ...defaultSourcePermissions(), index: change.index ?? true }, allowedModels: [], retentionUntil: change.retentionUntil ?? null }) }

describe('資料と端末内会話をまとめた文字検索', () => {
  it('両方を引用・版・0基準位置つきで返し、意味検索実装を装わない', async () => {
    const sourceId = await source(), id = await createCoachConversation(), turn = await beginCoachTurn(id, 1, { text: '資料を来週確認します', mode: 'local' }); await appendCoachReply(turn, '端末内の応答', 'template')
    const result = (await searchLocalContext('資料', '2026-09-02', '2026-10-01'))!
    expect(result.engine).toBe('lexical'); expect(result.hits.map(hit => hit.kind)).toContain('library'); expect(result.hits.map(hit => hit.kind)).toContain('conversation')
    for (const hit of result.hits) { const raw = hit.kind === 'library' ? (await db.contextSnapshots.get(`${sourceId}:1`))!.text : (await db.coachMessages.get(hit.id))!.text; expect(raw.slice(hit.start, hit.end)).toBe(hit.quote) }
    expect(result.coverage.every(range => range.complete === false)).toBe(true); expect(result.notice).toContain('意味検索・vector検索は未提供')
  })
  it('owner/index/期間を検索前に絞り、取得30日から半年前の全履歴確認を断定しない', async () => {
    await source({ index: false })
    expect((await searchLocalContext('資料', '2026-09-02', '2026-10-01'))!.hits).toEqual([])
    const sourceId = await source(); await setSourcePermissions(sourceId, 1, defaultSourcePermissions(), [], null)
    const old = (await searchLocalContext('資料', '2026-03-01', '2026-03-31'))!
    expect(old.hits).toEqual([]); expect(old.notice).toContain('未取得'); expect(old.coverage).toEqual([])
    const own = (await searchLocalContext('資料', '2026-09-02', '2026-10-01'))!
    await db.settings.update('main', { profileId: 'foreign-owner' })
    expect(await refreshLocalRetrieval(own)).toBeNull(); expect((await searchLocalContext('資料', '2026-09-02', '2026-10-01'))!.hits).toEqual([])
    await db.settings.update('main', { profileId: ownerId, datasetId: 'restored-dataset' }); expect(await refreshLocalRetrieval(own)).toBeNull()
  })
  it('permission取消と会話削除後に以前の引用を再表示しない', async () => {
    const sourceId = await source(), id = await createCoachConversation(), turn = await beginCoachTurn(id, 1, { text: '資料に関する本人会話', mode: 'local' }); await appendCoachReply(turn, '定型文', 'template')
    const result = (await searchLocalContext('資料', '2026-09-02', '2026-10-01'))!
    await setSourcePermissions(sourceId, 1, { ...defaultSourcePermissions(), index: false }, [], null); await deleteCoachConversation(id, 3)
    const refreshed = await refreshLocalRetrieval(result)
    expect(refreshed!.hits).toEqual([]); expect(refreshed!.coverage).toEqual([])
  })
  it('結果再読込は期限切れを即除外し、native cleanupで原文と会話を物理消去する', async () => {
    const sourceId = await source({ retentionUntil: '2026-10-01T03:01:00.000Z' }), id = await createCoachConversation(), turn = await beginCoachTurn(id, 1, { text: '資料についての期限付き会話', mode: 'local' }); await appendCoachReply(turn, '定型文', 'template'); await setConversationRetention(id, 3, '2026-10-01T03:01:00.000Z')
    const result = (await searchLocalContext('資料', '2026-09-02', '2026-10-01'))!
    vi.setSystemTime(new Date('2026-10-01T03:02:00.000Z'))
    expect((await refreshLocalRetrieval(result))!.hits).toEqual([])
    expect(await db.contextSnapshots.where('sourceId').equals(sourceId).count()).toBe(1); expect(await db.coachMessages.where('conversationId').equals(id).count()).toBe(2)
    await purgeExpiredCoachContext()
    expect(await db.contextSnapshots.where('sourceId').equals(sourceId).count()).toBe(0); expect(await db.coachMessages.where('conversationId').equals(id).count()).toBe(0)
    expect((await db.coachConversations.get(id))!.deletedAt).toBeTruthy()
  })
})
