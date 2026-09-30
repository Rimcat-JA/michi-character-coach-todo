import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { refreshReviewActual, saveReviewAnswer, setReviewSummary, type ReviewRecord } from './review-coach'
import { validateReviewRecords } from './review-validation'

let ownerId: string
beforeEach(async () => { await db.delete(); await db.open(); ownerId = (await ensureSettings()).profileId })
async function record(): Promise<ReviewRecord> {
  const id = await saveReviewAnswer({ date: '2026-09-30', timezone: 'Asia/Tokyo', kind: 'evening', answer: '0' })
  return (await db.reviewRecords.get(id))!
}

describe('レビューのバックアップ検証', () => {
  it('旧バックアップの未設定tableと、本人回答0を保持した正しい記録を許可する', async () => {
    expect(() => validateReviewRecords(undefined, ownerId)).not.toThrow()
    expect(() => validateReviewRecords([], ownerId)).not.toThrow()
    const original = await record()
    expect(() => validateReviewRecords([original], ownerId)).not.toThrow()
    expect(original.answer).toBe('0')
  })

  it('回答・実績・要約の履歴を検証し、古い要約の世代を新しい世代に偽装しない', async () => {
    const original = await record()
    await setReviewSummary(original.id, 0, 'AI要約', 'ai', 1, 1)
    await saveReviewAnswer({ date: original.date, timezone: original.timezone, kind: original.kind, answer: '訂正回答', expectedAnswerRevision: 1 })
    const stale = (await db.reviewRecords.get(original.id))!
    expect(() => validateReviewRecords([stale], ownerId)).not.toThrow()
    const faked = structuredClone(stale)
    faked.summaryOfAnswerRevision = 2
    expect(() => validateReviewRecords([faked], ownerId)).toThrow('レビュー')
    await refreshReviewActual(original.id, 1)
    await setReviewSummary(original.id, 1, '本人による新要約', 'human', 2, 2)
    await setReviewSummary(original.id, 2, null, 'human', 2, 2)
    const latest = (await db.reviewRecords.get(original.id))!
    expect(() => validateReviewRecords([latest], ownerId)).not.toThrow()
  })

  it('別owner・不正キー・日付・timezone・余分な秘密フィールドを拒否する', async () => {
    const original = await record()
    const mutations: ((copy: Record<string, unknown>) => void)[] = [
      copy => { copy.ownerId = 'other-person' }, copy => { copy.id = 'wrong-key' },
      copy => { copy.date = '2026-02-30' }, copy => { copy.timezone = 'Not/AZone' },
      copy => { copy.kind = 'automatic' }, copy => { copy.rangeEnd = '2026-10-01' },
      copy => { copy.key = '秘密を保存しない' }, copy => { copy.updatedAt = 'bad-time' }
    ]
    for (const mutate of mutations) {
      const copy = structuredClone(original) as unknown as Record<string, unknown>
      mutate(copy)
      expect(() => validateReviewRecords([copy], ownerId)).toThrow('レビュー')
    }
    expect(() => validateReviewRecords([original, original], ownerId)).toThrow('レビュー')
  })

  it('実績の合計を再計算し、点数未確定・二重加算・負数を拒否する', async () => {
    const original = await record()
    const valid = structuredClone(original)
    valid.actual.completed = [{ completionId: 'completion', taskId: 'task', title: '記録', points: null }]
    valid.actual.unscoredCount = 1
    expect(() => validateReviewRecords([valid], ownerId)).not.toThrow()
    for (const mutate of [
      (copy: ReviewRecord) => { copy.actual.unscoredCount = 0 },
      (copy: ReviewRecord) => { copy.actual.points = 100 },
      (copy: ReviewRecord) => { copy.actual.completed.push({ ...copy.actual.completed[0], completionId: 'another-completion' }) },
      (copy: ReviewRecord) => { copy.actual.minutes = -1 }
    ]) {
      const copy = structuredClone(valid); mutate(copy)
      expect(() => validateReviewRecords([copy], ownerId)).toThrow('レビュー')
    }
  })

  it('版の欠落・重複・不正な履歴を拒否し、未来の入力世代を受け入れない', async () => {
    const original = await record()
    await setReviewSummary(original.id, 0, 'AI要約', 'ai', 1, 1)
    const valid = (await db.reviewRecords.get(original.id))!
    for (const mutate of [
      (copy: ReviewRecord) => { copy.history = [] },
      (copy: ReviewRecord) => { copy.history.push(copy.history[0]) },
      (copy: ReviewRecord) => { copy.history[0].revision = 99 },
      (copy: ReviewRecord) => { copy.summaryOfActualRevision = 2 },
      (copy: ReviewRecord) => { copy.answerRevision = 1.5 },
      (copy: ReviewRecord) => { copy.plan.capturedAt = '2099-01-01T00:00:00.000Z' }
    ]) {
      const copy = structuredClone(valid); mutate(copy)
      expect(() => validateReviewRecords([copy], ownerId)).toThrow('レビュー')
    }
  })
})
