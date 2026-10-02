import { periodRange } from './period-planning'
import type { CalendarEvent, Task, TimeBlock } from './domain'
import { localTimeAt } from './zoned-time'

export type CalendarDisplay = 'day' | 'week' | 'month' | 'agenda' | 'timeline'
export type CalendarItem = { id: string; source: 'event' | 'block' | 'task' | 'deadline'; title: string; date: string; startAt: string; endAt: string | null; timezone: string; revision: number; allDay: boolean }
const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
const zonedDate = (iso: string, timezone: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))

export function calendarItems(events: CalendarEvent[], blocks: TimeBlock[], tasks: Task[], timezone: string): CalendarItem[] {
  const result: CalendarItem[] = []
  for (const event of events) result.push({ id: `event:${event.id}`, source: 'event', title: event.title, date: zonedDate(event.startAt, event.timezone), startAt: event.startAt, endAt: event.endAt, timezone: event.timezone, revision: event.revision ?? 1, allDay: false })
  for (const block of blocks) result.push({ id: `block:${block.id}`, source: 'block', title: block.category, date: block.date, startAt: `${block.date}T${clock(block.startMinute)}:00`, endAt: `${block.date}T${clock(block.endMinute)}:00`, timezone: block.timezone, revision: block.revision, allDay: false })
  for (const task of tasks) if (!task.deletedAt && task.scheduledDate) result.push({ id: `task:${task.id}`, source: 'task', title: task.title, date: task.scheduledDate, startAt: task.scheduledDate, endAt: null, timezone, revision: task.revision, allDay: true })
  // A clock deadline is a point in time in its own zone; date-only deadlines stay off the time views.
  for (const task of tasks) if (!task.deletedAt && task.status === 'open' && task.dueAt && task.dueTimezone) result.push({ id: `deadline:${task.id}`, source: 'deadline', title: `締切：${task.title}`, date: zonedDate(task.dueAt, task.dueTimezone), startAt: task.dueAt, endAt: null, timezone: task.dueTimezone, revision: task.revision, allDay: false })
  // A deadline instant is UTC; it sorts by its local clock in its own zone, like the local start of a time block.
  const key = (item: CalendarItem) => item.source === 'deadline' ? `${item.date}T${localTimeAt(item.startAt, item.timezone)}:00` : item.startAt
  return result.sort((a, b) => a.date.localeCompare(b.date) || key(a).localeCompare(key(b)) || a.id.localeCompare(b.id))
}
/** List line for an item: a clock deadline is one local time in its zone, never a raw UTC range. */
export const calendarItemWhen = (item: CalendarItem) => item.allDay ? '終日' : item.source === 'deadline' ? `締切 ${localTimeAt(item.startAt, item.timezone)}（${item.timezone}）` : `${item.startAt} 〜 ${item.endAt}`
export const calendarItemDetail = (item: CalendarItem) => item.source === 'deadline' ? `締切 ${localTimeAt(item.startAt, item.timezone)}` : `開始 ${item.startAt} · 終了 ${item.endAt ?? '終日'}`

export function calendarView(items: CalendarItem[], selectedDate: string, display: CalendarDisplay) {
  if (display === 'day' || display === 'timeline') return items.filter(item => item.date === selectedDate)
  if (display === 'week') { const range = periodRange('week', selectedDate); return items.filter(item => item.date >= range.startDate && item.date <= range.endDate) }
  if (display === 'month') return items.filter(item => item.date.startsWith(selectedDate.slice(0, 7)))
  return items.filter(item => item.date >= selectedDate)
}
