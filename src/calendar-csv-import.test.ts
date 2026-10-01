import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { calendarCSVHeaders, csvUTF8Digest, parseCalendarCSVImport, type CSVParseOptions } from './calendar-csv-import'

afterEach(() => vi.restoreAllMocks())
const bytes = (text: string) => new TextEncoder().encode(text)
const options = (kind: 'calendar' | 'roster' = 'calendar', timezone = 'Asia/Tokyo'): CSVParseOptions => ({ kind, timezone, fromDate: '2026-10-01', toDate: '2026-11-30', personRef: kind === 'roster' ? 'staff-001' : null })
const calendar = (body: string) => calendarCSVHeaders.calendar.join(',') + '\n' + body
const roster = (body: string) => calendarCSVHeaders.roster.join(',') + '\n' + body

describe('固定CSV形式・UTF8・RFC4180の読み取り', () => {
  it('BOM/日本語/カンマ/二重引用符を厳密に読み、literal byte/spanとrawquotehashを残す', async () => {
    const text = '\ufeff' + calendar('"日本語,""安定ID""",1,2026-10-02,closed\r\n'), result = await parseCalendarCSVImport(bytes(text), options()), row = result.rows[0]
    expect(row.externalId).toBe('日本語,"安定ID"'); expect(row).toMatchObject({ recordNumber: 2, lineStart: 2, lineEnd: 2, date: '2026-10-02', status: 'closed' })
    expect(new TextDecoder().decode(bytes(text).slice(row.byteStart, row.byteEnd))).toBe(row.quote)
    expect(row.byteEnd - row.byteStart).toBe(bytes(row.quote).length); expect(row.quoteHash).toBe(await csvUTF8Digest(row.quote)); expect(result.fileSha256).toMatch(/^[a-f0-9]{64}$/)
  })
  it('多行の他人行もRFC構文とphysical/logical位置だけを読み、本人以外の値を返さない', async () => {
    const result = await parseCalendarCSVImport(bytes(roster('other,1,"別人\n秘密情報",true,scheduled,2026-10-02,09:00,2026-10-02,17:00\nself,1,staff-001,true,scheduled,2026-10-02,22:00,2026-10-03,06:00\n')), options('roster'))
    expect(result.excludedOtherPerson).toBe(1); expect(result.rows).toHaveLength(1); expect(result.rows[0]).toMatchObject({ recordNumber: 3, lineStart: 4, lineEnd: 4, startAt: '2026-10-02T13:00:00.000Z', endAt: '2026-10-02T21:00:00.000Z' }); expect(JSON.stringify(result)).not.toContain('秘密情報')
  })
  it('同じ選択行でも他人の内容変更はfingerprintだけが変わり、選択body・quoteは同じ', async () => {
    const own = 'self,1,staff-001,true,scheduled,2026-10-02,09:00,2026-10-02,17:00\n'
    const first = await parseCalendarCSVImport(bytes(roster(own + 'other,1,secret-A,true,scheduled,,,,\n')), options('roster')), second = await parseCalendarCSVImport(bytes(roster(own + 'other,1,secret-B,true,scheduled,,,,\n')), options('roster'))
    expect(first.fileSha256).not.toBe(second.fileSha256); expect(first.bodyHash).toBe(second.bodyHash); expect(first.rows).toEqual(second.rows); expect(JSON.stringify(first)).not.toContain('secret-A')
  })
  it('下書き・未割当・他人・期間外を除外し、空表へ置換しない表示にする', async () => {
    const result = await parseCalendarCSVImport(bytes(roster('draft,99,staff-001,false,cancelled,,,,\nother,1,not-me,true,scheduled,,,,\nunassigned,1,,true,scheduled,,,,\nold,1,staff-001,true,cancelled,2026-09-01,09:00,2026-09-01,17:00\n')), options('roster'))
    expect(result).toMatchObject({ rows: [], excludedDraft: 1, excludedOtherPerson: 2, excludedOutsidePeriod: 1 }); expect(result.warnings[0]).toContain('置換しません')
  })
  it('headerだけのファイルは選択0件とし取消を生成しない', async () => { expect((await parseCalendarCSVImport(bytes(calendar('')), options())).rows).toEqual([]) })
  it.each(['x,1,2026-10-02,closed\rx,2,2026-10-03,open', '"x"junk,1,2026-10-02,closed', 'x"quote,1,2026-10-02,closed', '"x,1,2026-10-02,closed', 'x,1,2026-10-02,closed,extra', 'x,1,2026-10-02,closed\n\n'])('不正なRFC構文%sは推測で直さない', async body => { await expect(parseCalendarCSVImport(bytes(calendar(body)), options())).rejects.toThrow('CSV') })
  it.each(['record_revision,record_id,date,status\n1,x,2026-10-02,closed', 'record_id,record_revision,date,status,extra\nx,1,2026-10-02,closed,x', 'record_id,record_revision,date,status\nx,01,2026-10-02,closed', 'record_id,record_revision,date,status\nx,1,2026-02-30,closed', 'record_id,record_revision,date,status\nx,1,2026-10-02,unknown', 'record_id,record_revision,date,status\nx,1,2026-10-02,closed\nx,2,2026-10-03,open'])('未知・不正な固定列/版/日付/状態を拒否する', async text => { await expect(parseCalendarCSVImport(bytes(text), options())).rejects.toThrow() })
  it('UTF8不正bytes・NUL・1MiB超過を拒否する', async () => {
    await expect(parseCalendarCSVImport(new Uint8Array([255, 254]), options())).rejects.toThrow('UTF-8'); await expect(parseCalendarCSVImport(bytes(calendar('x,1,2026-10-02,closed\0')), options())).rejects.toThrow('制御文字'); await expect(parseCalendarCSVImport(new Uint8Array(1048577), options())).rejects.toThrow('1MiB')
  })
  it.each(['self,1,staff-001,yes,scheduled,2026-10-02,09:00,2026-10-02,17:00', 'self,1,staff-001,true,scheduled,2026-10-02,22:00,2026-10-02,06:00', 'self,1,staff-001,true,cancelled,2026-10-02,22:00,,06:00', 'self,1,staff-001,true,scheduled,2026-10-02,9:00,2026-10-02,17:00'])('公開勤務の状態・終了日・時刻を推定しない', async body => { await expect(parseCalendarCSVImport(bytes(roster(body)), options('roster'))).rejects.toThrow() })
  it.each(['2026-11-01,01:30,2026-11-01,02:30', '2026-03-08,02:30,2026-03-08,04:00'])('IANA夏時間の重複/欠損を無断解決しない', async times => {
    const selected = options('roster', 'America/New_York'); selected.fromDate = '2026-01-01'; selected.toDate = '2026-12-31'
    await expect(parseCalendarCSVImport(bytes(roster(`self,1,staff-001,true,scheduled,${times}`)), selected)).rejects.toThrow()
  })
})
