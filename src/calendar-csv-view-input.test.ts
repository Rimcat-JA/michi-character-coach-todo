import { describe, expect, it, vi } from 'vitest'
import { calendarCSVRetentionUntil, CSV_FILE_LIMIT, readCalendarCSVFile } from './calendar-csv-view-input'

const file = (bytes: Uint8Array) => ({ size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer })
describe('CSV画面の原本と保持期限入力', () => {
  it('UTF-8の日本語・BOM・原改行を切り捨てずにbytesを維持する', async () => {
    const bytes = new TextEncoder().encode('\uFEFFrecord_id,record_revision,date,status\r\n本人,1,2026-10-01,closed\r\n')
    expect(await readCalendarCSVFile(file(bytes))).toEqual(bytes)
  })
  it('1MiB超過と空ファイルは内容を読む前に拒否する', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0))
    await expect(readCalendarCSVFile({ size: CSV_FILE_LIMIT + 1, arrayBuffer })).rejects.toThrow('1MiB')
    await expect(readCalendarCSVFile({ size: 0, arrayBuffer })).rejects.toThrow('空でない')
    expect(arrayBuffer).not.toHaveBeenCalled()
  })
  it('不正なUTF-8を置換文字へ変えて取り込まない', async () => {
    await expect(readCalendarCSVFile(file(new Uint8Array([0xc3, 0x28])))).rejects.toThrow('UTF-8')
  })
  it('ブラウザの英語の読取エラーを日本語の案内に置き換える', async () => {
    await expect(readCalendarCSVFile({ size: 1, arrayBuffer: async () => { throw new DOMException('A requested file or directory could not be found', 'NotFoundError') } })).rejects.toThrow('ファイルを読み取れませんでした')
  })
  it('読取前後で変わったサイズを拒否する', async () => {
    await expect(readCalendarCSVFile({ ...file(new Uint8Array([65])), size: 2 })).rejects.toThrow('サイズが変わりました')
  })
  it('タイムゾーンを明示した保持期限をUTCへ正確に変換する', () => {
    expect(calendarCSVRetentionUntil('2030-10-01T12:00', 'Asia/Tokyo')).toBe('2030-10-01T03:00:00.000Z')
  })
  it.each([['', 'Asia/Tokyo'], ['2030-10-01T12:00', ''], ['2030-10-01', 'Asia/Tokyo'], ['2020-01-01T12:00', 'Asia/Tokyo']])('未指定・過去の保持期限を拒否する: %s %s', (value, timezone) => {
    expect(() => calendarCSVRetentionUntil(value, timezone)).toThrow()
  })
  it('夏時間の重複・欠落時刻から保持期限を推測しない', () => {
    expect(() => calendarCSVRetentionUntil('2030-11-03T01:30', 'America/New_York')).toThrow()
    expect(() => calendarCSVRetentionUntil('2030-03-10T02:30', 'America/New_York')).toThrow()
  })
})
