import { describe, expect, it } from 'vitest'
import { emptyScore, type Task } from './domain'
import { reviewDueTasks, suggestedTasks } from './planning'

function task(id: string, overrides: Partial<Task> = {}): Task {
  return { id, generationKey: id, routineId: null, title: id, notes: '', project: '', labels: [], scheduledDate: null, dueDate: null, targetDate: null, reviewDate: null, availableFrom: null, importance: 1, score: emptyScore(), effectivePoints: null, assessmentId: id, status: 'open', revision: 1, createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z', deletedAt: null, ...overrides }
}

describe('日付に基づく候補と見直し', () => {
  it('明日開始のタスクを今日の候補から外し、元のタスクを保持する', () => {
    const deferred = task('deferred', { availableFrom: '2026-10-02' })
    expect(suggestedTasks([deferred, task('ready')], '2026-10-01').map(value => value.id)).toEqual(['ready'])
    expect(deferred.status).toBe('open')
  })
  it('見直し日は作業完了と別に通知対象を選ぶ', () => {
    const review = task('review', { reviewDate: '2026-10-01', dueDate: '2026-10-05' })
    expect(reviewDueTasks([review], '2026-09-30')).toEqual([])
    expect(reviewDueTasks([review], '2026-10-01').map(value => value.id)).toEqual(['review'])
    expect(review.status).toBe('open')
    expect(review.dueDate).toBe('2026-10-05')
  })
})
