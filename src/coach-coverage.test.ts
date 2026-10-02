import 'fake-indexeddb/auto'
import { beforeEach, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { importLocalSource, defaultSourcePermissions, setSourcePermissions } from './source-library'
import { createCoachConversation, previewCoachTurnContext, beginCoachTurn, appendCoachReply, readCoachConversation } from './chat-history'
import { captureSnapshot } from './backup'
import { validateSnapshot } from './backup-validation'
beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings(); await db.settings.update('main', { aiEnabled: true, aiModel: 'fixture/model' }) })
async function source(fromDate: string, toDate: string, aiEgress = true) { return importLocalSource({ title: `取得${fromDate}`, text: '提出してください', provider: 'slack', externalId: fromDate, conversation: '仕事channel', author: '同僚', sourceUrl: null, date: toDate, fromDate, toDate, permissions: { ...defaultSourcePermissions(), aiEgress }, allowedModels: aiEgress ? ['fixture/model'] : [], retentionUntil: null }) }
it('欠落期間・範囲外・引用をAI文脈と決定的カードへ保存し、断定には注意を付ける', async () => {
  const sourceIds = [await source('2026-09-01', '2026-09-10'), await source('2026-09-20', '2026-09-30')]
  const preview = await previewCoachTurnContext({ mode: 'ai', sourceIds })
  expect(preview.context).toContain('欠落期間 2026-09-11〜2026-09-19'); expect(preview.context).toContain('全履歴ではない')
  const id = await createCoachConversation(), turn = await beginCoachTurn(id, 1, { text: '4月の依頼は？', mode: 'ai', sourceIds, expectedContextDigest: preview.digest })
  await appendCoachReply(turn, '全履歴を確認しましたが依頼はありません', 'live_ai')
  const reply = (await readCoachConversation(id)).messages[1]
  expect(reply.text).toBe('全履歴を確認しましたが依頼はありません'); expect(reply.coverageCard?.origin).toBe('template'); expect(reply.coverageCard?.warning).toBe(true); expect(reply.coverageCard?.text).toContain('選択資料の引用'); expect(reply.coverageCard?.text).toContain('未取得・未確認')

  const backup = await captureSnapshot(); expect(() => validateSnapshot(backup)).not.toThrow()
})
it('AI未許可の資料は送信文脈から拒否し、端末内の参照ではカードを付ける', async () => {
  const sourceId = await source('2026-09-02', '2026-10-01', false)
  await expect(previewCoachTurnContext({ mode: 'ai', sourceIds: [sourceId] })).rejects.toThrow('AI送信')
  const id = await createCoachConversation(), turn = await beginCoachTurn(id, 1, { text: '半年前の依頼', mode: 'local', sourceIds: [sourceId] }); await appendCoachReply(turn, '端末内の確認です', 'template')
  expect((await readCoachConversation(id)).messages[1].coverageCard?.text).toContain('2026-09-02〜2026-10-01')
})
it('確認後の許可取消は送信開始を拒否し、以前のカード引用も消す', async () => {
  const sourceId = await source('2026-09-02', '2026-10-01'), preview = await previewCoachTurnContext({ mode: 'ai', sourceIds: [sourceId] }), id = await createCoachConversation()
  await setSourcePermissions(sourceId, 1, defaultSourcePermissions(), [], null)
  await expect(beginCoachTurn(id, 1, { text: '依頼', mode: 'ai', sourceIds: [sourceId], expectedContextDigest: preview.digest })).rejects.toThrow()
  expect(await db.coachMessages.count()).toBe(0)
})
