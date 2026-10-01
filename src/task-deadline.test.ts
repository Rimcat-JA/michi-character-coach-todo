import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { bulkUpdateTasksAtomic, createTask, newTaskInput, updateTask } from './commands'
import { dueText, taskDueAt, taskDueKind, taskDueTime, validateTaskDue, type Task } from './domain'
import { urgency } from './planning'
import { calendarItems, calendarView } from './calendar-view-model'
import { deadlineReminderAt } from './reminders'
import { printTaskRows } from './printing'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })
const tokyo = (date = '2026-10-31', time = '17:00') => ({ dueDate: date, dueAt: taskDueAt(date, time, 'Asia/Tokyo'), dueTimezone: 'Asia/Tokyo' })

describe('時刻付き締め切り（due_kind none/date/datetime）', () => {
  it('2026-10-31 17:00 Asia/Tokyoを保存・再読込し、日付と時刻を同時に別値で持たない', async () => {
    expect(tokyo()).toEqual({ dueDate: '2026-10-31', dueAt: '2026-10-31T08:00:00.000Z', dueTimezone: 'Asia/Tokyo' })
    const id = await createTask({ ...newTaskInput(), title: '申請書の提出', ...tokyo() })
    const saved = (await db.tasks.get(id))!
    expect(saved).toMatchObject({ dueDate: '2026-10-31', dueAt: '2026-10-31T08:00:00.000Z', dueTimezone: 'Asia/Tokyo' })
    expect([taskDueKind(saved), taskDueTime(saved), dueText(saved, 'Asia/Tokyo'), dueText(saved, 'Europe/London')]).toEqual(['datetime', '17:00', '2026-10-31 17:00', '2026-10-31 17:00（Asia/Tokyo）'])
    expect([taskDueKind({ dueDate: '2026-10-31', dueAt: null }), taskDueKind({ dueDate: null, dueAt: null })]).toEqual(['date', 'none'])
    await expect(createTask({ ...newTaskInput(), title: '不一致', ...tokyo(), dueDate: '2026-11-01' })).rejects.toThrow('一致しません')
    await expect(createTask({ ...newTaskInput(), title: '日付なし', ...tokyo(), dueDate: null })).rejects.toThrow('一致しません')
    expect(() => validateTaskDue({ dueDate: '2026-10-31', dueAt: '2026-10-31T08:00:00.000Z', dueTimezone: null })).toThrow('タイムゾーン')
    expect(() => validateTaskDue({ dueDate: '2026-10-31', dueAt: '2026-10-31 17:00', dueTimezone: 'Asia/Tokyo' })).toThrow('UTC')
    expect(() => validateTaskDue({ dueDate: '2026-10-31', dueAt: null, dueTimezone: 'Asia/Tokyo' })).toThrow('タイムゾーン')
  })
  it('夏時間で存在しない・二度ある現地時刻は推測せず理由を示して拒否する', () => {
    expect(() => taskDueAt('2026-03-08', '02:30', 'America/New_York')).toThrow('存在しない時刻')
    expect(() => taskDueAt('2026-11-01', '01:30', 'America/New_York')).toThrow('二度ある時刻')
    expect(taskDueAt('2026-03-08', '03:30', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z')
  })
  it('時刻を知らない編集は締め切り日が同じ間だけ時刻を保ち、日付の解除は時刻も解除する', async () => {
    const id = await createTask({ ...newTaskInput(), title: '申請書の提出', ...tokyo() })
    let task = (await db.tasks.get(id))!
    const legacyEditor = { ...newTaskInput(), title: '申請書の提出（改名）', dueDate: task.dueDate }
    await updateTask(id, task.revision, legacyEditor); task = (await db.tasks.get(id))!
    expect(task).toMatchObject({ title: '申請書の提出（改名）', dueAt: '2026-10-31T08:00:00.000Z' })
    await expect(updateTask(id, task.revision, { ...legacyEditor, dueDate: '2026-11-02' })).rejects.toThrow('一致しません')
    await expect(bulkUpdateTasksAtomic([{ id, revision: task.revision }], { dueDate: '2026-11-02' })).rejects.toThrow('一致しません')
    await bulkUpdateTasksAtomic([{ id, revision: task.revision }], { dueDate: null }); task = (await db.tasks.get(id))!
    expect(task).toMatchObject({ dueDate: null, dueAt: null, dueTimezone: null })
  })
  it('期限超過・Agenda・印刷・通知は時刻付き締め切りを使う', () => {
    const task = { ...newTaskInput(), id: 'deadline', generationKey: 'deadline', routineId: null, title: '申請書の提出', ...tokyo('2026-10-01'), effectivePoints: null, assessmentId: 'a', status: 'open', revision: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', deletedAt: null } as Task
    expect(urgency(task, '2026-10-01', '2026-10-01T07:59:00.000Z')).toBe('今日')
    expect(urgency(task, '2026-10-01', '2026-10-01T08:00:00.000Z')).toBe('期限超過')
    expect(urgency({ dueDate: '2026-10-01' }, '2026-10-01', '2026-10-01T14:00:00.000Z')).toBe('今日')
    const agenda = calendarView(calendarItems([], [], [task], 'Europe/London'), '2026-10-01', 'agenda')
    expect(agenda).toEqual([{ id: 'deadline:deadline', source: 'deadline', title: '締切：申請書の提出', date: '2026-10-01', startAt: '2026-10-01T08:00:00.000Z', endAt: null, timezone: 'Asia/Tokyo', revision: 1, allDay: false }])
    expect(calendarItems([], [], [{ ...task, status: 'completed' }], 'Asia/Tokyo')).toEqual([])
    expect(printTaskRows([task], '2026-10-01', '2026-10-01')[0]).toMatchObject({ dueDate: '2026-10-01', dueTime: '17:00', dueTimezone: 'Asia/Tokyo' })
    expect(deadlineReminderAt(task, 30)).toBe('2026-10-01T07:30:00.000Z')
    expect(() => deadlineReminderAt({ dueAt: null }, 30)).toThrow('締め切り')
  })
})
