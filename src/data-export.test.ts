import { describe, expect, it } from 'vitest'
import { tasksToCsv, tasksToIcs } from './data-export'
import { emptyScore, type Task } from './domain'

const task: Task = {
  id: 'task-1', generationKey: 'task-1', routineId: null, title: '=危険,改行\n二行目', notes: '確認', project: '仕事', labels: ['A'],
  scheduledDate: '2026-10-01', dueDate: '2026-10-03', targetDate: null, reviewDate: null, availableFrom: null,
  importance: 1, score: { ...emptyScore(), mode: 'manual', manualPoints: 25 }, effectivePoints: 25,
  assessmentId: 'assessment-1', status: 'open', revision: 1, createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z', deletedAt: null
}

describe('持ち出し形式', () => {
  it('CSVは改行と式として解釈される先頭文字を安全にエスケープする', () => {
    const csv = tasksToCsv([task])
    expect(csv).toContain('"\'=危険,改行\n二行目"')
    expect(csv).toContain('"25"')
    expect(csv.split('\r\n').at(-1)).toBe('')
  })
  it('ICSは予定日・期限を別項目として出力する', () => {
    const ics = tasksToIcs([task], '2026-09-29T00:00:00.000Z')
    expect(ics).toContain('DTSTART;VALUE=DATE:20261001')
    expect(ics).toContain('DUE;VALUE=DATE:20261003')
    expect(ics).toContain('SUMMARY:=危険\\,改行\\n二行目')
  })
})
