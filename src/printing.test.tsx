import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { newTaskInput } from './commands'
import { emptyScore, type Task } from './domain'
import { printTaskRows } from './printing'
import PrintPreview from './PrintPreview'

const task = (index: number): Task => ({ ...newTaskInput(), id: String(index), generationKey: String(index), routineId: null, title: index === 3 ? '確認 sk-abcdefghijklmnopqrstuvwxyz012345' : `印刷項目${index}`, notes: '非公開メモ https://private.example/secret', project: '学習', labels: ['非公開'], scheduledDate: '2026-10-01', score: { ...emptyScore(), mode: 'manual', manualPoints: 1 }, effectivePoints: 1, assessmentId: String(index), status: 'open', revision: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', deletedAt: null })

describe('選択タスクの印刷', () => {
  it('50件を重複・末尾欠落なく描画し、メモ・URL・secretを除外する', () => {
    const tasks = Array.from({ length: 50 }, (_, index) => task(index + 1))
    const rows = printTaskRows(tasks, '', '')
    expect(rows).toHaveLength(50)
    expect(new Set(rows.map(row => row.id)).size).toBe(50)
    expect(rows.at(-1)?.title).toBe('印刷項目50')
    const html = renderToStaticMarkup(<PrintPreview tasks={tasks} onClose={() => undefined} />)
    expect((html.match(/<tr>/g) ?? [])).toHaveLength(51)
    expect(html).toContain('印刷項目50')
    expect(html).not.toContain('非公開メモ')
    expect(html).not.toContain('private.example')
    expect(html).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
    expect(html).toContain('[secret]')
    expect(printTaskRows(tasks, '2026-10-02', '2026-10-03')).toHaveLength(0)
  })
})
