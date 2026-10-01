import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { emptyScore, today, type Routine, type Task, type TimeBlock } from './domain'
import CalendarPlanningView from './CalendarPlanningView'
import { calendarItemDetail, calendarItems, calendarItemWhen } from './calendar-view-model'
import { resolveLocalCalendarTime } from './calendar-resolver'
import { calendarFixture } from './calendar-test-fixtures'
import { CalendarRulesView } from './CalendarRulesView'
import LegacyRoutineConversionView from './LegacyRoutineConversionView'

const legacy: Routine = { id: 'legacy', title: '旧ルーティン', cadence: 'daily', interval: 2, weekdays: [], monthDay: 1, startDate: '2026-10-01', endDate: null, excludedDates: [], afterTaskId: null, score: emptyScore(), project: '', active: true, revision: 1, createdAt: '2026-10-01T00:00:00.000Z' }
const never = () => Promise.reject(new Error('not used'))

describe('繰り返し設定の画面', () => {
  it('共通ルーティンの周期に繰り返し規則と完了起点を選べ、個人の暦の雛形を示す', () => {
    const html = renderToStaticMarkup(<CalendarRulesView state={calendarFixture()} onPrepareConfiguration={never} onPrepareImport={never} onPrepareGeneration={never} onApply={never} />)
    expect(html).toContain('繰り返し規則（毎日・N週ごと・第N曜日・月末・毎年など）')
    expect(html).toContain('前回の完了からN日後')
    expect(html).toContain('個人の暦（全曜日）を使う')
  })
  it('旧形式のルーティンだけに本人確認つきの移行を表示し、移行済みには表示しない', () => {
    const html = renderToStaticMarkup(<LegacyRoutineConversionView routines={[legacy]} state={calendarFixture()} />)
    expect(html).toContain('旧形式のルーティンを共通ルーティンへ移行'); expect(html).toContain('自動では移行しません'); expect(html).toContain('旧ルーティン（2日ごと）')
    expect(renderToStaticMarkup(<LegacyRoutineConversionView routines={[{ ...legacy, active: false }]} state={calendarFixture()} />)).toBe('')
  })
  it('時刻付き締め切りをAgenda・日表示で現地の締切時刻として示し、9:00の枠の後に並べる', () => {
    const date = today(), dueAt = resolveLocalCalendarTime(date, '17:00', 'Asia/Tokyo').at!
    const task = { id: 'deadline', generationKey: 'deadline', routineId: null, title: '申請書の提出', notes: '', project: '', containerId: null, labels: [], scheduledDate: null, dueDate: date, dueAt, dueTimezone: 'Asia/Tokyo', score: emptyScore(), effectivePoints: null, assessmentId: 'a', status: 'open', revision: 1, createdAt: `${date}T00:00:00.000Z`, updatedAt: `${date}T00:00:00.000Z`, deletedAt: null } as unknown as Task
    const block = { id: 'morning', ownerId: 'me', kind: 'activity', category: '朝の学習', projectId: null, date, startMinute: 540, endMinute: 600, timezone: 'Asia/Tokyo', taskIds: [], sessionIds: [], closed: false, revision: 1, createdAt: `${date}T00:00:00.000Z`, updatedAt: `${date}T00:00:00.000Z` } as unknown as TimeBlock
    const items = calendarItems([], [block], [task], 'Asia/Tokyo')
    expect(items.map(item => item.id)).toEqual(['block:morning', 'deadline:deadline'])
    expect(calendarItemWhen(items[1])).toBe('締切 17:00（Asia/Tokyo）'); expect(calendarItemDetail(items[1])).toBe('締切 17:00')
    expect(calendarItemWhen(items[0])).toBe(`${date}T09:00:00 〜 ${date}T10:00:00`)
    const html = renderToStaticMarkup(<CalendarPlanningView blocks={[block]} events={[]} tasks={[task]} projects={[]} sessions={[]} ownerId="me" run={never} />)
    expect(html).toContain('締切 17:00（Asia/Tokyo）'); expect(html).not.toContain('null'); expect(html).not.toContain(dueAt)
    expect(html.indexOf('朝の学習')).toBeLessThan(html.indexOf('締切：申請書の提出'))
  })
})
