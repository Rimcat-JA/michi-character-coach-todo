import { describe, expect, it } from 'vitest'
import { calendarItems, calendarView } from './calendar-view-model'
import type { CalendarEvent } from './domain'

describe('カレンダー表示の共通view model', () => {
  it('同じ予定を日・週・月・Agenda・Timelineで開いても時刻・timezone・revisionが一致する', () => {
    const event: CalendarEvent = { id: 'meeting-1', ownerId: 'me', kind: 'meeting', title: '打ち合わせ', startAt: '2026-10-01T01:00:00.000Z', endAt: '2026-10-01T02:00:00.000Z', timezone: 'Asia/Tokyo', linkedTaskId: null, createdAt: '2026-09-29T00:00:00.000Z' }
    const items = calendarItems([event], [], [], 'Asia/Tokyo')
    const views = (['day', 'week', 'month', 'agenda', 'timeline'] as const).map(display => calendarView(items, '2026-10-01', display)[0])
    expect(views).toHaveLength(5)
    expect(views.every(value => value?.id === 'event:meeting-1')).toBe(true)
    expect(views.map(value => [value.startAt, value.endAt, value.timezone, value.revision])).toEqual(Array(5).fill(['2026-10-01T01:00:00.000Z', '2026-10-01T02:00:00.000Z', 'Asia/Tokyo', 1]))
    expect(views[0].date).toBe('2026-10-01')
  })
})
