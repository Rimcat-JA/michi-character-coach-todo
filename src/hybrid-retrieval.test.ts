import 'fake-indexeddb/auto'
import { beforeEach, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { importLocalSource, defaultSourcePermissions, setSourcePermissions, deleteSource } from './source-library'
import { buildSourceEmbeddings, searchHybrid, refreshHybridRetrieval, embeddingWindows } from './hybrid-retrieval'

const embedding = { provider: 'loopback-openai-compatible' as const, endpoint: 'http://127.0.0.1:8080', model: 'fixture' }
beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings(); await db.settings.update('main', { embedding }) })
async function source(text = '序文\n請求書を届けてください', index = true) {
  return importLocalSource({ title: text.slice(0, 80), text, provider: 'local', externalId: null, conversation: null, author: null, sourceUrl: null, date: '2026-10-01', fromDate: '2026-09-02', toDate: '2026-10-01', permissions: { ...defaultSourcePermissions(), index }, allowedModels: [], retentionUntil: null })
}
const embed = vi.fn(async (inputs: string[]) => inputs.map(text => text.includes('序文') ? [0, 1] : [1, 0]))
it('言い換えを取得し、RRF順序と引用の実際の位置を保持する', async () => {
  const id = await source(); await buildSourceEmbeddings(id, embed)
  const result = (await searchHybrid('インボイスを送付', '2026-09-02', '2026-10-01', embed))!
  expect(result.engine).toBe('hybrid'); expect(result.hits[0].quote).toBe('請求書を届けてください'); expect(result.hits[0].matchedBy).toBe('vector')
  const snapshot = (await db.contextSnapshots.get(`${id}:1`))!
  for (const hit of result.hits) expect(snapshot.text.slice(hit.start, hit.end)).toBe(hit.quote)
  expect(result.coverage.every(row => row.complete === false)).toBe(true)
  expect((await searchHybrid('インボイスを送付', '2026-03-01', '2026-03-31', embed))!.hits).toEqual([])
  expect((await searchHybrid('インボイスを送付', '2026-09-02', '2026-10-01', embed))!.hits).toEqual(result.hits)
})
it('索引不可・他owner・期限切れ資料は作成前に拒否し、送信しない', async () => {
  const id = await source('資料', false), transport = vi.fn(embed)
  await expect(buildSourceEmbeddings(id, transport)).rejects.toThrow('許可'); expect(transport).not.toHaveBeenCalled()
  await db.contextSources.update(id, { permissions: defaultSourcePermissions(), ownerId: 'foreign' })
  await expect(buildSourceEmbeddings(id, transport)).rejects.toThrow('許可')
  const settings = (await db.settings.get('main'))!
  await db.contextSources.update(id, { ownerId: settings.profileId, retentionUntil: '2020-01-01T00:00:00.000Z' })
  await expect(buildSourceEmbeddings(id, transport)).rejects.toThrow('許可'); expect(transport).not.toHaveBeenCalled()
})
it('model/endpoint/dims変更と壊れた索引を無視し、文字検索へ縮退する', async () => {
  const id = await source(); await buildSourceEmbeddings(id, embed)
  await db.settings.update('main', { embedding: { ...embedding, endpoint: 'http://127.0.0.1:8081' } })
  let result = (await searchHybrid('請求書', '2026-09-02', '2026-10-01', embed))!
  expect(result.hits[0].matchedBy).toBe('lexical'); expect(result.indexStates[0].state).toBe('stale')
  await db.settings.update('main', { embedding }); const row = (await db.sourceArtifacts.toArray())[0]
  await db.sourceArtifacts.update(row.id, { payload: '{broken' })
  result = (await searchHybrid('請求書', '2026-09-02', '2026-10-01', async () => { throw new Error('stopped') }))!
  expect(result.engine).toBe('lexical'); expect(result.hits[0].quote).toContain('請求書'); expect(result.notice).toContain('利用できません')
})
it('許可取消と削除で索引と以前の引用を消す', async () => {
  const id = await source(); await buildSourceEmbeddings(id, embed)
  const result = (await searchHybrid('言い換え', '2026-09-02', '2026-10-01', embed))!
  await setSourcePermissions(id, 1, { ...defaultSourcePermissions(), index: false }, [], null)
  expect(await db.sourceArtifacts.count()).toBe(0); expect((await refreshHybridRetrieval(result))!.hits).toEqual([])
  const current = (await db.contextSources.get(id))!; await deleteSource(id, current.revision)
  expect(await db.contextSnapshots.count()).toBe(0)
})
it('通信中の許可変更・凍結・不正応答は索引を保存しない', async () => {
  const id = await source()
  await expect(buildSourceEmbeddings(id, async inputs => { await db.datasetState.put({ id: 'main', mode: 'frozen', updatedAt: new Date().toISOString(), moveId: 'move' }); return embed(inputs) })).rejects.toThrow('凍結')
  expect(await db.sourceArtifacts.count()).toBe(0)
  await db.datasetState.delete('main'); await expect(buildSourceEmbeddings(id, async () => [[NaN], [1]])).rejects.toThrow('不正')
  await expect(buildSourceEmbeddings(id, async inputs => { await setSourcePermissions(id, 1, { ...defaultSourcePermissions(), index: false }, [], null); return embed(inputs) })).rejects.toThrow('変わりました')
  expect(await db.sourceArtifacts.count()).toBe(0)
})
it('長い行の末尾も索引化し、入力を64件/32k文字以内に分割する', async () => {
  expect(embeddingWindows([{ id: 'a', text: 'x'.repeat(601) }])).toHaveLength(2)
  const id = await source(Array.from({ length: 70 }, () => 'x'.repeat(600)).join('\n')), transport = vi.fn(async (inputs: string[]) => { expect(inputs.length).toBeLessThanOrEqual(64); expect(inputs.join('').length).toBeLessThanOrEqual(32000); return inputs.map(() => [1, 0]) })
  await buildSourceEmbeddings(id, transport); expect(transport).toHaveBeenCalledTimes(2)
})
