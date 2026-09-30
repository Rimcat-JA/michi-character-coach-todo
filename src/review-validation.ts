import { addDays, validateDate } from './domain'
import type { ReviewRecord } from './review-coach'

const kinds = ['morning', 'evening', 'weekly']
const recordKeys = ['id', 'ownerId', 'date', 'timezone', 'kind', 'rangeStart', 'rangeEnd', 'answer', 'answerRevision', 'plan', 'actual', 'actualRevision', 'aiSummary', 'summaryOrigin', 'summaryRevision', 'summaryOfAnswerRevision', 'summaryOfActualRevision', 'history', 'createdAt', 'updatedAt', 'deletedAt']
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
const text = (value: unknown, max: number, empty = true): value is string => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0)
const point = (value: unknown) => value === null || integer(value, 0, 2147483647)
const revision = (value: unknown, min = 1): value is number => integer(value, min, 1001)
function fail(): never { throw new Error('バックアップのレビュー記録が不正です') }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail()
  return value as Record<string, unknown>
}
function timestamp(value: unknown): asserts value is string {
  if (!text(value, 30, false) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail()
}
function day(value: unknown): asserts value is string {
  if (!text(value, 10, false)) fail()
  try { validateDate(value, 'レビューの日付') } catch { fail() }
}
function uniqueString(value: unknown, max: number): asserts value is string[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => !text(item, 200, false)) || new Set(value).size !== value.length) fail()
}
function validatePlan(value: unknown, updatedAt: string) {
  const snapshot = object(value, ['capturedAt', 'entries'])
  timestamp(snapshot.capturedAt)
  if (snapshot.capturedAt > updatedAt || !Array.isArray(snapshot.entries) || snapshot.entries.length > 5000) fail()
  const ids = new Set<string>()
  for (const raw of snapshot.entries) {
    const entry = object(raw, ['taskId', 'title', 'revision', 'scheduledDate', 'dueDate', 'points', 'minutes', 'status'])
    if (!text(entry.taskId, 200, false) || ids.has(entry.taskId) || !text(entry.title, 300, false) || !integer(entry.revision, 1) || !point(entry.points) ||
      (entry.minutes !== null && !integer(entry.minutes, 0, 10080)) || !['open', 'completed'].includes(entry.status as string)) fail()
    if (entry.scheduledDate !== null) day(entry.scheduledDate)
    if (entry.dueDate !== null) day(entry.dueDate)
    ids.add(entry.taskId)
  }
}
function validateActual(value: unknown, updatedAt: string) {
  const snapshot = object(value, ['capturedAt', 'completed', 'sessionIds', 'minutes', 'points', 'unscoredCount'])
  timestamp(snapshot.capturedAt)
  if (snapshot.capturedAt > updatedAt || !Array.isArray(snapshot.completed) || snapshot.completed.length > 5000 || !integer(snapshot.minutes, 0, 11000) || !integer(snapshot.points, 0) || !integer(snapshot.unscoredCount, 0, 5000)) fail()
  uniqueString(snapshot.sessionIds, 10000)
  const ids = new Set<string>(), tasks = new Set<string>()
  let points = 0, unscored = 0
  for (const raw of snapshot.completed) {
    const entry = object(raw, ['completionId', 'taskId', 'title', 'points'])
    if (!text(entry.completionId, 200, false) || ids.has(entry.completionId) || !text(entry.taskId, 200, false) || tasks.has(entry.taskId) || !text(entry.title, 300, false) || !point(entry.points)) fail()
    ids.add(entry.completionId); tasks.add(entry.taskId)
    if (entry.points === null) unscored += 1
    else points += entry.points as number
  }
  if (points !== snapshot.points || unscored !== snapshot.unscoredCount || !Number.isSafeInteger(points)) fail()
}
function summaryGeneration(summary: unknown, origin: unknown, answerRevision: unknown, actualRevision: unknown, currentAnswerRevision: number, currentActualRevision: number) {
  if (summary === null) {
    if (origin !== null || answerRevision !== null || actualRevision !== null) fail()
  } else if (!text(summary, 10000, false) || !['ai', 'human'].includes(origin as string) || !revision(answerRevision) || answerRevision > currentAnswerRevision || !revision(actualRevision) || actualRevision > currentActualRevision) fail()
}

export function validateReviewRecords(rows: unknown, ownerId: string): asserts rows is ReviewRecord[] | undefined {
  if (rows === undefined) return
  if (!text(ownerId, 200, false) || !Array.isArray(rows) || rows.length > 10000) fail()
  const ids = new Set<string>()
  for (const raw of rows) {
    const record = object(raw, recordKeys)
    day(record.date); day(record.rangeStart); day(record.rangeEnd)
    if (!text(record.id, 400, false) || ids.has(record.id) || record.ownerId !== ownerId || !kinds.includes(record.kind as string) || !text(record.timezone, 100, false)) fail()
    try { new Intl.DateTimeFormat('en-CA', { timeZone: record.timezone }) } catch { fail() }
    if (record.id !== `${ownerId}:${record.date}:${record.timezone}:${record.kind}`) fail()
    const weekday = new Date(`${record.date}T12:00:00`).getDay()
    const expectedStart = record.kind === 'weekly' ? addDays(record.date, -((weekday + 6) % 7)) : record.date
    const expectedEnd = record.kind === 'weekly' ? addDays(expectedStart, 6) : record.date
    if (record.rangeStart !== expectedStart || record.rangeEnd !== expectedEnd || !text(record.answer, 10000) || !revision(record.answerRevision) || !revision(record.actualRevision) || !revision(record.summaryRevision, 0)) fail()
    timestamp(record.createdAt); timestamp(record.updatedAt)
    if (record.updatedAt < record.createdAt) fail()
    if (record.deletedAt !== null) { timestamp(record.deletedAt); if (record.deletedAt < record.createdAt || record.deletedAt > record.updatedAt) fail() }
    validatePlan(record.plan, record.createdAt); validateActual(record.actual, record.updatedAt)
    summaryGeneration(record.aiSummary, record.summaryOrigin, record.summaryOfAnswerRevision, record.summaryOfActualRevision, record.answerRevision, record.actualRevision)
    if (record.summaryRevision === 0 && record.aiSummary !== null) fail()
    if (!Array.isArray(record.history) || record.history.length > 1000) fail()
    const nextRevision = { answer: 1, actual: 1, summary: 0 }
    let previousSummaryAnswer: number | null = null, previousSummaryActual: number | null = null
    let previousAt = record.createdAt
    for (const rawEvent of record.history) {
      if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) fail()
      const kind = (rawEvent as Record<string, unknown>).kind
      if (!['answer', 'actual', 'summary'].includes(kind as string)) fail()
      const eventKind = kind as keyof typeof nextRevision
      const event = object(rawEvent, kind === 'answer' ? ['kind', 'answer', 'revision', 'at'] : kind === 'actual' ? ['kind', 'actual', 'revision', 'at'] : ['kind', 'summary', 'origin', 'ofAnswerRevision', 'ofActualRevision', 'revision', 'at'])
      timestamp(event.at)
      if (event.at < record.createdAt || event.at < previousAt || event.at > record.updatedAt || event.revision !== nextRevision[eventKind]) fail()
      previousAt = event.at
      nextRevision[eventKind] += 1
      if (kind === 'answer' && !text(event.answer, 10000)) fail()
      if (kind === 'actual') validateActual(event.actual, event.at)
      if (kind === 'summary') {
        summaryGeneration(event.summary, event.origin, event.ofAnswerRevision, event.ofActualRevision, record.answerRevision, record.actualRevision)
        if (event.summary !== null && (event.ofAnswerRevision !== previousSummaryAnswer || event.ofActualRevision !== previousSummaryActual)) fail()
        previousSummaryAnswer = nextRevision.answer
        previousSummaryActual = nextRevision.actual
      }
    }
    if (nextRevision.answer !== record.answerRevision || nextRevision.actual !== record.actualRevision || nextRevision.summary !== record.summaryRevision) fail()
    if (record.aiSummary !== null && (record.summaryOfAnswerRevision !== previousSummaryAnswer || record.summaryOfActualRevision !== previousSummaryActual)) fail()
    ids.add(record.id)
  }
}
