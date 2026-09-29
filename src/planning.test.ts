import { describe, expect, it } from 'vitest'
import { emptyScore, type Task } from './domain'
import { dayCapacity, filterTasksByDates, nextAvailableDate, reviewDueTasks, suggestedTasks } from './planning'

function task(id: string, overrides: Partial<Task> = {}): Task {
  return { id, generationKey: id, routineId: null, title: id, notes: '', project: '', labels: [], scheduledDate: null, dueDate: null, targetDate: null, reviewDate: null, availableFrom: null, importance: 1, score: emptyScore(), effectivePoints: null, assessmentId: id, status: 'open', revision: 1, createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z', deletedAt: null, ...overrides }
}

describe('日付に基づく候補と見直し', () => {
  it('明日開始のタスクを今日の候補から外し、元のタスクを保持する', () => {
    const deferred = task('deferred', { availableFrom: '2026-10-02' })
    expect(suggestedTasks([deferred, task('ready')], '2026-10-01').map(value => value.id)).toEqual(['ready'])
    expect(deferred.status).toBe('open')
  })
  it('延期終了日より前は自動候補へ入れず、表示日は両条件の遅い方にする', () => {
    const deferred = task('deferred', { availableFrom: '2026-10-02', deferredUntil: '2026-10-04' })
    expect(suggestedTasks([deferred], '2026-10-03')).toEqual([])
    expect(nextAvailableDate(deferred)).toBe('2026-10-04')
    expect(suggestedTasks([deferred], '2026-10-04').map(value => value.id)).toEqual(['deferred'])
  })
  it('目標日と外部期限を別々に検索する', () => {
    const first = task('first', { targetDate: '2026-10-02', dueDate: '2026-10-05' })
    const second = task('second', { targetDate: '2026-10-05', dueDate: '2026-10-02' })
    expect(filterTasksByDates([first, second], '2026-10-02', null).map(value => value.id)).toEqual(['first'])
    expect(filterTasksByDates([first, second], null, '2026-10-02').map(value => value.id)).toEqual(['second'])
  })
  it('60分40ptは90分以内でも30pt上限を超え、未知見積を別件数にする', () => {
    const known = task('known', { score: { ...emptyScore(), minutes: 60, mode: 'manual', manualPoints: 40 }, effectivePoints: 40 })
    const unknown = task('unknown')
    expect(dayCapacity([known, unknown], 90, 30)).toEqual({ minutes: 60, points: 40, minutesLimit: 90, pointsLimit: 30, unknownMinutes: 1, unknownPoints: 1, overMinutes: false, overPoints: true })
  })
  it('見直し日は作業完了と別に通知対象を選ぶ', () => {
    const review = task('review', { reviewDate: '2026-10-01', dueDate: '2026-10-05' })
    expect(reviewDueTasks([review], '2026-09-30')).toEqual([])
    expect(reviewDueTasks([review], '2026-10-01').map(value => value.id)).toEqual(['review'])
    expect(review.status).toBe('open')
    expect(review.dueDate).toBe('2026-10-05')
  })
})
