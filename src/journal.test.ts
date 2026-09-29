import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { createTracker, currentDayNoteContext, recordTrackerEntry, saveDayNote, setDayNoteSummary } from './journal'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('任意記録と日記', () => {
  it('気力を空欄として記録し、0と区別して非公開のまま保持する', async () => {
    const id = await createTracker('気力', '段階', 0, 5)
    await recordTrackerEntry(id, null)
    await recordTrackerEntry(id, 0)
    const values = (await db.trackerEntries.toArray()).map(entry => entry.value)
    expect(values).toContain(null)
    expect(values).toContain(0)
    expect((await db.trackerDefinitions.get(id))?.private).toBe(true)
    expect(await db.ledger.count()).toBe(0)
  })

  it('本人の日記を編集しても要約を上書きせず、版と鮮度を追える', async () => {
    const id = await saveDayNote('2026-10-01', 'Asia/Tokyo', '最初のメモ')
    await setDayNoteSummary(id, 0, 'AIの要約', 'ai')
    await saveDayNote('2026-10-01', 'Asia/Tokyo', '訂正したメモ')
    const edited = (await db.dayNotes.get(id))!
    expect(edited).toMatchObject({ humanText: '訂正したメモ', aiSummary: 'AIの要約', humanRevision: 2, summaryRevision: 1, summaryOfHumanRevision: 1 })
    expect(currentDayNoteContext(edited)).toEqual({ humanText: '訂正したメモ', summary: null, summaryStale: true })
    await setDayNoteSummary(id, 1, '訂正後の要約', 'human')
    const latest = (await db.dayNotes.get(id))!
    expect(currentDayNoteContext(latest)).toEqual({ humanText: '訂正したメモ', summary: '訂正後の要約', summaryStale: false })
    expect(latest.history.map(item => item.kind)).toEqual(['summary', 'human', 'summary'])
  })

  it('AI応答中に本文が変わった場合は古い本文の要約を保存しない', async () => {
    const id = await saveDayNote('2026-10-01', 'Asia/Tokyo', '元の本文')
    await saveDayNote('2026-10-01', 'Asia/Tokyo', '新しい本文')
    await expect(setDayNoteSummary(id, 0, '元の本文を要約', 'ai', 1)).rejects.toThrow('別の画面')
    expect((await db.dayNotes.get(id))?.aiSummary).toBeNull()
    await setDayNoteSummary(id, 0, '新しい本文を要約', 'ai', 2)
    expect((await db.dayNotes.get(id))?.summaryOrigin).toBe('ai')
  })
})
