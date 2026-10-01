import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { acceptAssistedDrafts, acceptTitleQuote, applyAssistedTasks, draftFromText, draftsFromText, prepareAssistedTasks } from './task-assist'
import { db, ensureSettings } from './db'
import { contentDigest } from './canonical'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('タスク入力補助の確定境界', () => {
  it('本人の25ptと明示された期限だけを使い、移動込み時間を作業時間にしない', () => {
    const result = draftFromText('明日までに図書館へ返却。25pt、移動込み45分', '2026-09-29')
    expect(result.input).toMatchObject({ dueDate: '2026-09-30', scheduledDate: null, score: { mode: 'manual', manualPoints: 25, minutes: null } })
    expect(result.notices).toContain('所要時間の内訳が不明です。作業時間を確認してください。')
  })

  it('値が書かれていない場合と曖昧な日付は未設定のままにする', () => {
    const result = draftFromText('明日、図書館へ返却', '2026-09-29')
    expect(result.input).toMatchObject({ scheduledDate: null, dueDate: null, score: { mode: 'unset', manualPoints: null } })
    expect(result.notices.some(text => text.includes('日付の意味が曖昧'))).toBe(true)
  })

  it('点数が複数あれば選ばず、原文は下書きに残す', () => {
    const raw = 'Aは25pt、Bは40pt'
    const result = draftFromText(raw, '2026-09-29')
    expect(result.input.title).toBe(raw)
    expect(result.input.score.manualPoints).toBeNull()
  })

  it('Quick Add表記のptと、重なる期限表現も原文どおりに読む', () => {
    const result = draftFromText('期限明日までに返却 pt:25', '2026-09-29')
    expect(result.input).toMatchObject({ dueDate: '2026-09-30', score: { mode: 'manual', manualPoints: 25 } })
  })

  it('AIが追加した作業・日付・点数を受け入れず、原文にあるタイトルだけ採用する', () => {
    const raw = '明日までに図書館へ返却。25pt'
    expect(acceptTitleQuote(raw, '{"title_quote":"図書館へ返却"}')).toBe('図書館へ返却')
    expect(() => acceptTitleQuote(raw, '{"title_quote":"図書館へ返却して掃除する"}')).toThrow('原文と一致')
    expect(() => acceptTitleQuote(raw, '{"title_quote":"図書館へ返却","dueDate":"2026-09-30"}')).toThrow('形式')
    expect(() => acceptTitleQuote(raw, '掃除する')).toThrow('読めません')
  })

  it('複数候補の点数を各出典に結び付け、25ptの省略と重複を拒否する', () => {
    const raw = '明日までに返却。25pt\nメールを書く。10pt'
    const tasks = [{ title_quote: '返却', source_quote: '明日までに返却。25pt' }, { title_quote: 'メールを書く', source_quote: 'メールを書く。10pt' }]
    const drafts = acceptAssistedDrafts(raw, JSON.stringify({ tasks }), '2026-09-29')
    expect(drafts.map(draft => draft.input.score.manualPoints)).toEqual([25, 10])
    expect(drafts.map(draft => draft.input.dueDate)).toEqual(['2026-09-30', null])
    expect(() => acceptAssistedDrafts(raw, JSON.stringify({ tasks: [{ ...tasks[0], source_quote: '明日までに返却。' }, tasks[1]] }), '2026-09-29')).toThrow('欠け')
    expect(() => acceptAssistedDrafts(raw, JSON.stringify({ tasks: [tasks[0], tasks[0]] }), '2026-09-29')).toThrow('重複')
    expect(draftsFromText(raw, '2026-09-29').map(draft => draft.input.score.manualPoints)).toEqual([25, 10])
  })

  it('内容差し替えは保存せず、同じ承認の再送でタスクと記録を増やさない', async () => {
    await db.settings.update('main', { aiEnabled: true })
    const prepared = await prepareAssistedTasks(draftsFromText('返却25pt\n連絡10pt', '2026-09-29'), 'ai')
    const changed = structuredClone(prepared)
    changed.inputs[0].score.manualPoints = 40
    await expect(applyAssistedTasks(changed, prepared.digest)).rejects.toThrow('内容が変わり')
    expect(await db.tasks.count()).toBe(0)
    const ids = await applyAssistedTasks(prepared, prepared.digest)
    expect(await applyAssistedTasks(prepared, prepared.digest)).toEqual(ids)
    expect(await db.tasks.count()).toBe(2)
    expect((await db.audits.toArray()).filter(audit => audit.operation === 'assist.approved')).toHaveLength(1)
  })

  it('データセット変更と期限切れを拒否し、canonical hashをキー順に依存させない', async () => {
    expect(await contentDigest({ a: 1, b: 2 })).toBe(await contentDigest({ b: 2, a: 1 }))
    const prepared = await prepareAssistedTasks(draftsFromText('返却25pt', '2026-09-29'), 'manual')
    await db.settings.update('main', { datasetId: 'other' })
    await expect(applyAssistedTasks(prepared, prepared.digest)).rejects.toThrow('データセット')
    const expired = { ...prepared, expiresAt: '2020-01-01T00:00:00.000Z' }
    const { digest: _old, ...payload } = expired
    expired.digest = await contentDigest(payload)
    await expect(applyAssistedTasks(expired, expired.digest)).rejects.toThrow('有効期限')
  })
})
it('負数や小数の一部を整数の点数・分数として採用しない', () => {
  for (const text of ['作業 -25pt -30分', '作業 2.5pt 1.5分']) {
    const draft = draftFromText(text, '2026-09-30')
    expect(draft.input.score.manualPoints).toBeNull()
    expect(draft.input.score.minutes).toBeNull()
  }
})
