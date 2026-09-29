import { describe, expect, it } from 'vitest'
import { selectedTaskContext } from './ai'
import { emptyScore, type Task } from './domain'

const task: Task = {
  id: 'private-id', generationKey: 'private-generation', routineId: null,
  title: '資料を読む', notes: '共有を選んだメモ', project: '社内プロジェクト', labels: ['秘密ラベル'],
  scheduledDate: '2026-10-01', dueDate: '2026-10-03', targetDate: null,
  reviewDate: null, availableFrom: null, importance: 1, score: emptyScore(),
  effectivePoints: 25, assessmentId: 'private-assessment', status: 'open', revision: 1,
  createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', deletedAt: null
}

describe('AIへ送るタスク情報', () => {
  it('未選択なら保存済みタスクを送らない', () => {
    expect(selectedTaskContext(undefined)).toBeNull()
  })

  it('選択した項目だけに限定し、内部ID・ラベル・プロジェクトを含めない', () => {
    const context = selectedTaskContext(task)
    expect(context).toContain('資料を読む')
    expect(context).toContain('共有を選んだメモ')
    expect(context).toContain('2026-10-03')
    expect(context).toContain('25pt')
    expect(context).not.toContain('private-id')
    expect(context).not.toContain('秘密ラベル')
    expect(context).not.toContain('社内プロジェクト')
  })

  it('長いメモを送信上限に収める', () => {
    expect(selectedTaskContext({ ...task, notes: 'a'.repeat(10000) })!.length).toBeLessThanOrEqual(5000)
  })
})
