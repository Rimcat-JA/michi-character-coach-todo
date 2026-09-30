import { ConflictError } from './commands'
import { db } from './db'
import { addDays, validateDate, type Completion, type Task, type WorkSession } from './domain'
import { unionSessionMinutes } from './time-tracking'

export type ReviewKind = 'morning' | 'evening' | 'weekly'
export type ReviewTaskSnapshot = {
  taskId: string; title: string; revision: number; scheduledDate: string | null; dueDate: string | null
  points: number | null; minutes: number | null; status: Task['status']
}
export type ReviewPlanSnapshot = { capturedAt: string; entries: ReviewTaskSnapshot[] }
export type ReviewActualSnapshot = {
  capturedAt: string
  completed: { completionId: string; taskId: string; title: string; points: number | null }[]
  sessionIds: string[]; minutes: number; points: number; unscoredCount: number
}
export type ReviewHistory =
  | { kind: 'answer'; answer: string; revision: number; at: string }
  | { kind: 'actual'; actual: ReviewActualSnapshot; revision: number; at: string }
  | { kind: 'summary'; summary: string | null; origin: 'ai' | 'human' | null; ofAnswerRevision: number | null; ofActualRevision: number | null; revision: number; at: string }
export type ReviewRecord = {
  id: string; ownerId: string; date: string; timezone: string; kind: ReviewKind; rangeStart: string; rangeEnd: string
  answer: string; answerRevision: number; plan: ReviewPlanSnapshot; actual: ReviewActualSnapshot; actualRevision: number
  aiSummary: string | null; summaryOrigin: 'ai' | 'human' | null; summaryRevision: number
  summaryOfAnswerRevision: number | null; summaryOfActualRevision: number | null
  history: ReviewHistory[]; createdAt: string; updatedAt: string; deletedAt: string | null
}

const kinds: ReviewKind[] = ['morning', 'evening', 'weekly']
const MAX_TEXT = 10000
const MAX_HISTORY = 1000
function allowHistory(record: ReviewRecord) { if (record.history.length >= MAX_HISTORY) throw new Error('レビューの変更履歴が1000件に達しています') }
function snapshotRange(rangeStart: string, rangeEnd: string, capturedAt: string) {
  validateDate(rangeStart, '期間開始'); validateDate(rangeEnd, '期間終了')
  if (!rangeStart || !rangeEnd || rangeStart > rangeEnd || rangeEnd > addDays(rangeStart, 6)) throw new Error('レビューの期間を確認してください')
  if (typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt)) || new Date(capturedAt).toISOString() !== capturedAt) throw new Error('レビューの取得日時を確認してください')
}
function validText(text: string, name: string) {
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw new Error(`${name}は10000文字以内で入力してください`)
}
function validTimezone(timezone: string) {
  if (typeof timezone !== 'string' || !timezone || timezone.length > 100) throw new Error('タイムゾーンを確認してください')
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }) }
  catch { throw new Error('タイムゾーンを確認してください') }
}
function formatDate(formatter: Intl.DateTimeFormat, at: number) {
  const parts = formatter.formatToParts(new Date(at))
  return `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}-${parts.find(part => part.type === 'day')!.value}`
}
function dayBoundary(date: string, formatter: Intl.DateTimeFormat): number {
  const center = Date.parse(`${date}T00:00:00Z`)
  let low = center - 48 * 60 * 60 * 1000, high = center + 48 * 60 * 60 * 1000
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (formatDate(formatter, middle) < date) low = middle
    else high = middle
  }
  if (formatDate(formatter, high) !== date) throw new Error('このタイムゾーンには対象の日付がありません')
  return high
}

export function reviewRange(date: string, kind: ReviewKind): { rangeStart: string; rangeEnd: string } {
  if (typeof date !== 'string' || !date) throw new Error('レビューの日付を入力してください')
  validateDate(date, 'レビューの日付')
  if (!kinds.includes(kind)) throw new Error('レビューの種類を確認してください')
  if (kind !== 'weekly') return { rangeStart: date, rangeEnd: date }
  const weekday = new Date(`${date}T12:00:00`).getDay()
  const rangeStart = addDays(date, -((weekday + 6) % 7))
  return { rangeStart, rangeEnd: addDays(rangeStart, 6) }
}

export function captureReviewPlan(tasks: Task[], rangeStart: string, rangeEnd: string, capturedAt = new Date().toISOString()): ReviewPlanSnapshot {
  snapshotRange(rangeStart, rangeEnd, capturedAt)
  const entries = tasks.filter(task => !task.deletedAt && (
    task.scheduledDate !== null && task.scheduledDate >= rangeStart && task.scheduledDate <= rangeEnd ||
    task.status === 'open' && task.dueDate !== null && task.dueDate <= rangeEnd
  )).map(task => ({ taskId: task.id, title: task.title, revision: task.revision, scheduledDate: task.scheduledDate, dueDate: task.dueDate, points: task.effectivePoints, minutes: task.score.minutes, status: task.status }))
  if (entries.length > 5000) throw new Error('レビューの計画対象が5000件を超えています')
  return { capturedAt, entries }
}

export function captureReviewActual(completions: Completion[], sessions: WorkSession[], rangeStart: string, rangeEnd: string, timezone: string, capturedAt = new Date().toISOString()): ReviewActualSnapshot {
  snapshotRange(rangeStart, rangeEnd, capturedAt)
  const formatter = validTimezone(timezone)
  const start = dayBoundary(rangeStart, formatter), end = dayBoundary(addDays(rangeEnd, 1), formatter)
  const completed = [...new Map(completions.filter(completion => completion.currentAt && Date.parse(completion.currentAt) >= start && Date.parse(completion.currentAt) < end)
    .map(completion => [completion.id, { completionId: completion.id, taskId: completion.taskId, title: completion.title, points: completion.netPoints }] as const)).values()]
  const clipped = [...new Map(sessions.map(session => [session.id, session] as const)).values()].flatMap(session => {
    const from = Math.max(start, Date.parse(session.startedAt)), to = Math.min(end, Date.parse(session.endedAt))
    return Number.isFinite(from) && Number.isFinite(to) && to > from ? [{ id: session.id, startedAt: new Date(from).toISOString(), endedAt: new Date(to).toISOString() }] : []
  })
  if (completed.length > 5000 || clipped.length > 10000) throw new Error('レビューの実績対象が多すぎます')
  return { capturedAt, completed, sessionIds: clipped.map(session => session.id), minutes: unionSessionMinutes(clipped), points: completed.reduce((sum, completion) => sum + (completion.points ?? 0), 0), unscoredCount: completed.filter(completion => completion.points === null).length }
}

export function reviewObservation(actual: ReviewActualSnapshot): string {
  if (actual.completed.length === 0 && actual.minutes === 0) return 'この期間に保存された完了・作業時間の記録はありません。休息や記録していない活動について、必要なら本人の言葉で残せます。'
  return `保存された完了は${actual.completed.length}件、作業時間は${actual.minutes}分です。これは本人の価値や成功・失敗の判定ではありません。`
}

export function currentReviewSummary(record: ReviewRecord): { summary: string | null; stale: boolean } {
  const stale = record.aiSummary !== null && (record.summaryOfAnswerRevision !== record.answerRevision || record.summaryOfActualRevision !== record.actualRevision)
  return { summary: stale ? null : record.aiSummary, stale }
}

export function reviewAIContext(record: ReviewRecord): string {
  const text = JSON.stringify({ kind: record.kind, date: record.date, timezone: record.timezone, rangeStart: record.rangeStart, rangeEnd: record.rangeEnd, personAnswer: record.answer, originalPlan: record.plan, recordedActual: record.actual, observation: reviewObservation(record.actual) })
  if (text.length > 50000) throw new Error('レビューがAI送信の文字数上限を超えています。本人回答は保存されています')
  return text
}

export async function saveReviewAnswer(input: { date: string; timezone: string; kind: ReviewKind; answer: string; expectedAnswerRevision?: number }): Promise<string> {
  const range = reviewRange(input.date, input.kind)
  validTimezone(input.timezone); validText(input.answer, '本人回答')
  return db.transaction('rw', [db.reviewRecords, db.settings, db.tasks, db.completions, db.sessions], async () => {
    const settings = await db.settings.get('main')
    if (!settings || typeof settings.profileId !== 'string' || !settings.profileId.trim()) throw new Error('本人の設定がありません')
    const id = `${settings.profileId}:${input.date}:${input.timezone}:${input.kind}`
    const current = await db.reviewRecords.get(id), at = new Date().toISOString()
    if (current) {
      if (current.ownerId !== settings.profileId || current.deletedAt) throw new Error('本人のレビューがありません')
      if (input.expectedAnswerRevision !== undefined && input.expectedAnswerRevision !== current.answerRevision) throw new ConflictError()
      if (current.answer === input.answer) return id
      allowHistory(current)
      const updatedAt = at < current.updatedAt ? current.updatedAt : at
      await db.reviewRecords.put({ ...current, answer: input.answer, answerRevision: current.answerRevision + 1, history: [...current.history, { kind: 'answer', answer: current.answer, revision: current.answerRevision, at: updatedAt }], updatedAt })
    } else {
      if (input.expectedAnswerRevision !== undefined && input.expectedAnswerRevision !== 0) throw new ConflictError()
      const [tasks, completions, sessions] = await Promise.all([db.tasks.toArray(), db.completions.toArray(), db.sessions.toArray()])
      await db.reviewRecords.add({ id, ownerId: settings.profileId, date: input.date, timezone: input.timezone, kind: input.kind, ...range, answer: input.answer, answerRevision: 1, plan: captureReviewPlan(tasks, range.rangeStart, range.rangeEnd, at), actual: captureReviewActual(completions, sessions, range.rangeStart, range.rangeEnd, input.timezone, at), actualRevision: 1, aiSummary: null, summaryOrigin: null, summaryRevision: 0, summaryOfAnswerRevision: null, summaryOfActualRevision: null, history: [], createdAt: at, updatedAt: at, deletedAt: null })
    }
    return id
  })
}

export async function refreshReviewActual(id: string, expectedActualRevision: number): Promise<void> {
  await db.transaction('rw', [db.reviewRecords, db.settings, db.completions, db.sessions], async () => {
    const record = await db.reviewRecords.get(id), settings = await db.settings.get('main')
    if (!record || record.deletedAt || !settings || record.ownerId !== settings.profileId) throw new Error('本人のレビューがありません')
    if (record.actualRevision !== expectedActualRevision) throw new ConflictError()
    allowHistory(record)
    const [completions, sessions] = await Promise.all([db.completions.toArray(), db.sessions.toArray()])
    const clock = new Date().toISOString(), at = clock < record.updatedAt ? record.updatedAt : clock, actual = captureReviewActual(completions, sessions, record.rangeStart, record.rangeEnd, record.timezone, at)
    await db.reviewRecords.put({ ...record, actual, actualRevision: record.actualRevision + 1, history: [...record.history, { kind: 'actual', actual: record.actual, revision: record.actualRevision, at }], updatedAt: at })
  })
}

export async function setReviewSummary(id: string, expectedSummaryRevision: number, summary: string | null, origin: 'ai' | 'human', expectedAnswerRevision: number, expectedActualRevision: number): Promise<void> {
  if (summary !== null) validText(summary, '要約')
  if (!['ai', 'human'].includes(origin)) throw new Error('要約の出典を確認してください')
  await db.transaction('rw', [db.reviewRecords, db.settings], async () => {
    const record = await db.reviewRecords.get(id), settings = await db.settings.get('main')
    if (!record || record.deletedAt || !settings || record.ownerId !== settings.profileId) throw new Error('本人のレビューがありません')
    if (record.summaryRevision !== expectedSummaryRevision || record.answerRevision !== expectedAnswerRevision || record.actualRevision !== expectedActualRevision) throw new ConflictError()
    allowHistory(record)
    const clock = new Date().toISOString(), at = clock < record.updatedAt ? record.updatedAt : clock, nextSummary = summary?.trim() || null
    await db.reviewRecords.put({ ...record, aiSummary: nextSummary, summaryOrigin: nextSummary ? origin : null, summaryRevision: record.summaryRevision + 1, summaryOfAnswerRevision: nextSummary ? record.answerRevision : null, summaryOfActualRevision: nextSummary ? record.actualRevision : null, history: [...record.history, { kind: 'summary', summary: record.aiSummary, origin: record.summaryOrigin, ofAnswerRevision: record.summaryOfAnswerRevision, ofActualRevision: record.summaryOfActualRevision, revision: record.summaryRevision, at }], updatedAt: at })
  })
}
