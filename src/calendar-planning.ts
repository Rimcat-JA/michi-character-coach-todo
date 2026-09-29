import { db, ensureSettings } from './db'
import { uid, validateDate, type CalendarEvent, type Task, type TimeBlock } from './domain'

function validTimezone(value: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format() } catch { throw new Error('タイムゾーンが不正です') }
  return value
}
function validMinute(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0 || value > 1440) throw new Error(`${name}が不正です`)
}
export async function createTimeBlock(input: Pick<TimeBlock, 'kind' | 'category' | 'projectId' | 'date' | 'startMinute' | 'endMinute' | 'timezone'>) {
  const settings = await ensureSettings()
  validateDate(input.date, '枠の日付'); validMinute(input.startMinute, '開始時刻'); validMinute(input.endMinute, '終了時刻'); validTimezone(input.timezone)
  if (input.startMinute >= input.endMinute || input.startMinute >= 1440 || !['activity', 'work_session'].includes(input.kind) || !input.category.trim() || input.category.length > 100) throw new Error('時間枠の内容が不正です')
  return db.transaction('rw', db.timeBlocks, db.containers, async () => {
    if (input.kind === 'work_session') {
      const project = input.projectId && await db.containers.get(input.projectId)
      if (!project || project.deletedAt || project.kind !== 'project' || project.ownerId !== settings.profileId) throw new Error('作業予定のプロジェクトにアクセスできません')
    } else if (input.projectId !== null) throw new Error('活動枠にプロジェクトは指定できません')
    const timestamp = new Date().toISOString(), id = uid()
    await db.timeBlocks.add({ ...input, id, ownerId: settings.profileId, category: input.category.trim(), taskIds: [], linkedSessionId: null, closed: false, revision: 1, createdAt: timestamp, updatedAt: timestamp })
    return id
  })
}

export async function assignTaskToTimeBlock(blockId: string, expectedRevision: number, taskId: string, expectedTaskRevision?: number) {
  const settings = await ensureSettings()
  await db.transaction('rw', db.timeBlocks, db.tasks, db.audits, async () => {
    const block = await db.timeBlocks.get(blockId), task = await db.tasks.get(taskId)
    if (!block || block.ownerId !== settings.profileId || !task || task.deletedAt || task.status !== 'open') throw new Error('時間枠またはタスクにアクセスできません')
    if (block.revision !== expectedRevision) throw new Error('別の画面で時間枠が更新されました')
    if (expectedTaskRevision !== undefined && task.revision !== expectedTaskRevision) throw new Error('別の画面でタスクが更新されました')
    if (block.closed) throw new Error('終了した時間枠は編集できません')
    if (block.taskIds.includes(taskId)) return
    const at = new Date().toISOString()
    await db.timeBlocks.put({ ...block, taskIds: [...block.taskIds, taskId], revision: block.revision + 1, updatedAt: at })
    await db.tasks.put({ ...task, scheduledDate: block.date, revision: task.revision + 1, updatedAt: at })
    await db.audits.add({ id: uid(), taskId, operation: 'assign_time_block', at, detail: blockId })
  })
}

export async function finishTimeBlock(blockId: string, expectedRevision: number) {
  const settings = await ensureSettings()
  await db.transaction('rw', db.timeBlocks, async () => {
    const block = await db.timeBlocks.get(blockId)
    if (!block || block.ownerId !== settings.profileId) throw new Error('時間枠にアクセスできません')
    if (block.revision !== expectedRevision) throw new Error('別の画面で時間枠が更新されました')
    await db.timeBlocks.put({ ...block, closed: true, revision: block.revision + 1, updatedAt: new Date().toISOString() })
  })
}

export async function linkSessionToTimeBlock(blockId: string, expectedRevision: number, sessionId: string) {
  const settings = await ensureSettings()
  await db.transaction('rw', db.timeBlocks, db.sessions, db.tasks, async () => {
    const block = await db.timeBlocks.get(blockId), session = await db.sessions.get(sessionId)
    if (!block || block.ownerId !== settings.profileId || block.kind !== 'work_session' || !session) throw new Error('作業予定または実績時間がありません')
    if (block.revision !== expectedRevision) throw new Error('別の画面で時間枠が更新されました')
    const task = await db.tasks.get(session.taskId)
    if (!task || task.containerId !== block.projectId) throw new Error('実績時間の案件が一致しません')
    await db.timeBlocks.put({ ...block, linkedSessionId: sessionId, revision: block.revision + 1, updatedAt: new Date().toISOString() })
  })
}

export function timeBlockCapacity(date: string, tasks: Task[], blocks: TimeBlock[]) {
  const dayBlocks = blocks.filter(block => block.date === date)
  const intervals = dayBlocks.map(block => [block.startMinute, block.endMinute] as const).sort((a, b) => a[0] - b[0])
  let reservedMinutes = 0, end = 0
  for (const [start, finish] of intervals) { reservedMinutes += Math.max(0, finish - Math.max(start, end)); end = Math.max(end, finish) }
  const assigned = new Set(dayBlocks.flatMap(block => block.taskIds))
  const standalone = tasks.filter(task => !task.deletedAt && task.scheduledDate === date && !assigned.has(task.id))
  return { reservedMinutes, standaloneMinutes: standalone.reduce((sum, task) => sum + (task.score.minutes ?? 0), 0), totalMinutes: reservedMinutes + standalone.reduce((sum, task) => sum + (task.score.minutes ?? 0), 0), unknownMinutes: standalone.filter(task => task.score.minutes === null).length }
}

export async function createCalendarEvent(input: Pick<CalendarEvent, 'kind' | 'title' | 'startAt' | 'endAt' | 'timezone' | 'linkedTaskId'>) {
  const settings = await ensureSettings()
  if (!['meeting', 'class', 'other'].includes(input.kind) || !input.title.trim() || input.title.length > 300 || !/^\d{4}-\d{2}-\d{2}T/.test(input.startAt) || !Number.isFinite(Date.parse(input.startAt)) || !Number.isFinite(Date.parse(input.endAt)) || Date.parse(input.endAt) <= Date.parse(input.startAt)) throw new Error('予定の内容が不正です')
  validTimezone(input.timezone)
  return db.transaction('rw', db.calendarEvents, db.tasks, async () => {
    if (input.linkedTaskId && !(await db.tasks.get(input.linkedTaskId))) throw new Error('リンクするタスクがありません')
    const id = uid()
    await db.calendarEvents.add({ ...input, id, ownerId: settings.profileId, title: input.title.trim(), createdAt: new Date().toISOString() })
    return id
  })
}
