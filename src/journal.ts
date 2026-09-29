import { ConflictError } from './commands'
import { db } from './db'
import { uid, validateDate, type DayNote } from './domain'

export async function createTracker(name: string, unit: string, min: number, max: number): Promise<string> {
  name = name.trim(); unit = unit.trim()
  if (!name || name.length > 100 || !unit || unit.length > 30 || !Number.isFinite(min) || !Number.isFinite(max) || min >= max || min < -1000000 || max > 1000000) throw new Error('記録項目の名前・単位・範囲を確認してください')
  return db.transaction('rw', [db.trackerDefinitions, db.settings], async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('設定がありません')
    const id = uid(), at = new Date().toISOString()
    await db.trackerDefinitions.add({ id, ownerId: settings.profileId, name, unit, min, max, private: true, createdAt: at, updatedAt: at })
    return id
  })
}

export async function recordTrackerEntry(trackerId: string, value: number | null, note = '', recordedAt = new Date().toISOString()): Promise<string> {
  if (!Number.isFinite(Date.parse(recordedAt)) || new Date(recordedAt).toISOString() !== recordedAt || note.length > 1000) throw new Error('記録時刻・メモが不正です')
  return db.transaction('rw', [db.trackerDefinitions, db.trackerEntries, db.settings], async () => {
    const definition = await db.trackerDefinitions.get(trackerId), settings = await db.settings.get('main')
    if (!definition || !settings || definition.ownerId !== settings.profileId) throw new Error('記録項目がありません')
    if (value !== null && (!Number.isFinite(value) || value < definition.min || value > definition.max)) throw new Error(`値は${definition.min}〜${definition.max}で指定してください`)
    const id = uid()
    await db.trackerEntries.add({ id, trackerId, value, recordedAt, source: 'user', note })
    return id
  })
}

function validZone(zone: string) { try { new Intl.DateTimeFormat('ja-JP', { timeZone: zone }) } catch { throw new Error('timezoneが不正です') } }
export async function saveDayNote(date: string, timezone: string, humanText: string): Promise<string> {
  validateDate(date, '日付'); validZone(timezone)
  if (humanText.length > 50000) throw new Error('本文は50000文字以内にしてください')
  return db.transaction('rw', [db.dayNotes, db.settings], async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('設定がありません')
    const id = `${settings.profileId}:${date}:${timezone}`, at = new Date().toISOString()
    const previous = await db.dayNotes.get(id)
    if (previous?.humanText === humanText && !previous.deletedAt) return id
    if (previous) {
      await db.dayNotes.put({ ...previous, humanText, humanRevision: previous.humanRevision + 1, history: [...previous.history, { kind: 'human', text: previous.humanText, at: previous.updatedAt, revision: previous.humanRevision }], updatedAt: at, deletedAt: null })
    } else {
      await db.dayNotes.add({ id, ownerId: settings.profileId, date, timezone, humanText, aiSummary: null, summaryOrigin: null, humanRevision: 1, summaryRevision: 0, summaryOfHumanRevision: null, history: [], createdAt: at, updatedAt: at, deletedAt: null })
    }
    return id
  })
}

export async function setDayNoteSummary(id: string, expectedSummaryRevision: number, summary: string | null, origin: 'ai' | 'human', expectedHumanRevision?: number): Promise<void> {
  if (summary !== null && summary.length > 10000) throw new Error('要約は10000文字以内にしてください')
  await db.transaction('rw', db.dayNotes, async () => {
    const note = await db.dayNotes.get(id)
    if (!note || note.deletedAt) throw new Error('日記がありません')
    if (note.summaryRevision !== expectedSummaryRevision) throw new ConflictError()
    if (expectedHumanRevision !== undefined && note.humanRevision !== expectedHumanRevision) throw new ConflictError()
    const at = new Date().toISOString()
    await db.dayNotes.put({ ...note, aiSummary: summary?.trim() || null, summaryOrigin: summary?.trim() ? origin : null, summaryRevision: note.summaryRevision + 1, summaryOfHumanRevision: summary?.trim() ? note.humanRevision : null, history: [...note.history, { kind: 'summary', text: note.aiSummary, at: note.updatedAt, revision: note.summaryRevision }], updatedAt: at })
  })
}

export function currentDayNoteContext(note: DayNote): { humanText: string; summary: string | null; summaryStale: boolean } {
  const summaryStale = note.aiSummary !== null && note.summaryOfHumanRevision !== note.humanRevision
  return { humanText: note.humanText, summary: summaryStale ? null : note.aiSummary, summaryStale }
}
