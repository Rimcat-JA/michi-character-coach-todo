import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput, updateTask } from './commands'
import { emptyScore, type Completion, type WorkSession } from './domain'
import { captureReviewActual, currentReviewSummary, refreshReviewActual, reviewAIContext, reviewObservation, reviewRange, saveReviewAnswer, setReviewSummary } from './review-coach'

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-30T03:00:00.000Z'))
  await db.delete(); await db.open(); await ensureSettings()
})
afterEach(() => { vi.useRealTimers() })
const review = (answer: string, kind: 'morning' | 'evening' | 'weekly' = 'evening', expectedAnswerRevision?: number) => saveReviewAnswer({ date: '2026-09-30', timezone: 'Asia/Tokyo', kind, answer, expectedAnswerRevision })

describe('朝夕・週次レビュー', () => {
  it('実績0、本人回答0、空欄を失敗と断定せず保存する', async () => {
    const id = await review('0')
    const saved = (await db.reviewRecords.get(id))!
    expect(saved.answer).toBe('0')
    expect(saved.actual).toMatchObject({ completed: [], minutes: 0, points: 0, unscoredCount: 0 })
    expect(reviewObservation(saved.actual)).not.toContain('失敗')
    expect(reviewObservation(saved.actual)).toContain('記録はありません')
    await review('', 'evening', 1)
    expect((await db.reviewRecords.get(id))?.answer).toBe('')
    expect(await db.ledger.count()).toBe(0)
  })

  it('元の計画を残して既存タスクを再計画し、実績の取得では報酬を追加しない', async () => {
    const input = { ...newTaskInput(), title: '返却', scheduledDate: '2026-09-30', score: { ...emptyScore(), mode: 'manual' as const, manualPoints: 25 } }
    const taskId = await createTask(input)
    const id = await review('余裕に合わせて調整', 'morning')
    await updateTask(taskId, 1, { ...input, title: '返却の予定変更', scheduledDate: '2026-10-02' })
    await completeTask(taskId, 2)
    const ledgerBefore = await db.ledger.toArray()
    await refreshReviewActual(id, 1)
    await refreshReviewActual(id, 2)
    const record = (await db.reviewRecords.get(id))!
    expect(record.plan.entries).toMatchObject([{ taskId, title: '返却', scheduledDate: '2026-09-30', points: 25, revision: 1 }])
    expect(record.actual).toMatchObject({ completed: [{ taskId, points: 25 }], points: 25, unscoredCount: 0 })
    expect(record.history.filter(event => event.kind === 'actual')).toHaveLength(2)
    expect(await db.ledger.toArray()).toEqual(ledgerBefore)
    expect((await db.tasks.get(taskId))?.scheduledDate).toBe('2026-10-02')
  })

  it('AI応答中の本人回答変更を検出し、原文と要約履歴を別々に保持する', async () => {
    const id = await review('当初の回答')
    await setReviewSummary(id, 0, '最初のAI要約', 'ai', 1, 1)
    await review('訂正した本人回答', 'evening', 1)
    await expect(setReviewSummary(id, 1, '当初の古い応答', 'ai', 1, 1)).rejects.toThrow('別の画面')
    const edited = (await db.reviewRecords.get(id))!
    expect(edited.answer).toBe('訂正した本人回答')
    expect(edited.aiSummary).toBe('最初のAI要約')
    expect(currentReviewSummary(edited)).toEqual({ summary: null, stale: true })
    await setReviewSummary(id, 1, '本人が直した要約', 'human', 2, 1)
    await setReviewSummary(id, 2, null, 'human', 2, 1)
    const deleted = (await db.reviewRecords.get(id))!
    expect(currentReviewSummary(deleted)).toEqual({ summary: null, stale: false })
    expect(deleted.history.map(event => event.kind)).toEqual(['summary', 'answer', 'summary', 'summary'])
    expect(deleted.history).toContainEqual(expect.objectContaining({ kind: 'answer', answer: '当初の回答', revision: 1 }))
    expect(reviewAIContext(deleted)).not.toContain('最初のAI要約')
  })

  it('実績更新中に到着したAI要約も拒否し、回答の二重編集を競合にする', async () => {
    const id = await review('保存回答')
    await refreshReviewActual(id, 1)
    await expect(setReviewSummary(id, 0, '古い実績の要約', 'ai', 1, 1)).rejects.toThrow('別の画面')
    await review('新しい回答', 'evening', 1)
    await expect(review('別画面の回答', 'evening', 1)).rejects.toThrow('別の画面')
    expect((await db.reviewRecords.get(id))?.aiSummary).toBeNull()
  })

  it('週次期間と日付・タイムゾーンを検証し、所有者の違うレビューを変更しない', async () => {
    expect(reviewRange('2026-09-30', 'weekly')).toEqual({ rangeStart: '2026-09-28', rangeEnd: '2026-10-04' })
    await expect(saveReviewAnswer({ date: '2026-02-30', timezone: 'Asia/Tokyo', kind: 'evening', answer: '' })).rejects.toThrow()
    await expect(saveReviewAnswer({ date: '2026-09-30', timezone: 'Not/AZone', kind: 'evening', answer: '' })).rejects.toThrow('タイムゾーン')
    const id = await review('本人回答')
    await db.settings.update('main', { profileId: 'another-person' })
    await expect(setReviewSummary(id, 0, '他人の要約', 'human', 1, 1)).rejects.toThrow('本人')
    await expect(refreshReviewActual(id, 1)).rejects.toThrow('本人')
    expect((await db.reviewRecords.get(id))?.answer).toBe('本人回答')
  })

  it('実績の重複と跨日の時間区間を統合し、未確定ポイントを0確定にしない', () => {
    const completion: Completion = { id: 'completion', taskId: 'task', currentAt: '2026-09-29T15:30:00.000Z', originalAt: '2026-09-29T15:30:00.000Z', originalPoints: null, netPoints: null, scoreState: 'pending', title: '記録', project: '' }
    const sessions: WorkSession[] = [
      { id: 'sessionA', taskId: 'task', startedAt: '2026-09-29T14:30:00.000Z', endedAt: '2026-09-29T15:30:00.000Z', minutes: 60 },
      { id: 'sessionB', taskId: 'task', startedAt: '2026-09-29T15:15:00.000Z', endedAt: '2026-09-29T16:00:00.000Z', minutes: 45 }
    ]
    const actual = captureReviewActual([completion, completion], [...sessions, sessions[0]], '2026-09-30', '2026-09-30', 'Asia/Tokyo')
    expect(actual).toMatchObject({ completed: [{ completionId: 'completion', points: null }], points: 0, unscoredCount: 1, minutes: 60, sessionIds: ['sessionA', 'sessionB'] })
    expect(captureReviewActual([completion], sessions, '2026-09-30', '2026-09-30', 'UTC').completed).toEqual([])
  })
})
