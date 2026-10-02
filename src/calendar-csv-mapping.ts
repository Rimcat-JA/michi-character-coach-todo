import { canonicalJSON, contentDigest } from './canonical'
import { addDays, validateDate } from './domain'
import { calendarCSVHeaders, csvBytesDigest, parseCalendarCSVImport, type CSVParseOptions, type ParsedCalendarCSVImport } from './calendar-csv-import'

export type CSVMappingProfile = {
  version: 1; name: string; revision: number; kind: 'calendar' | 'roster'; encoding: 'utf-8' | 'shift_jis'; delimiter: ',' | '\t' | ';'; headerRow: number; dataStartRow: number
  columns: Record<string, { headerText: string; index: number }>
  dateFormat: 'YYYY-MM-DD' | 'YYYY/M/D' | 'YYYY年M月D日' | 'M/D'; explicitYear: number | null
  timeFormat: 'HH:MM' | 'H:MM' | 'H時MM分'; endDayRule: 'explicit_end_date' | 'next_day_when_end<=start'
  statusMap: Record<string, string>; publishedMap: Record<string, boolean>
  recordIdStrategy: 'column' | 'derived'; revisionStrategy: 'column' | 'import_order'
}
export type CSVMappingBinding = { profile: CSVMappingProfile; digest: string; sequence: number }
export type MappedCSVRowEvidence = { rawBase64: string; normalizedQuote: string; profileDigest: string }
export type CSVRawRecord = { cells: string[]; quote: string; bytes: Uint8Array; recordNumber: number; lineStart: number; lineEnd: number; byteStart: number; byteEnd: number }
function bad(message: string): never { throw new Error(`列対応: ${message}`) }
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype)
const int = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max
const keys = ['version', 'name', 'revision', 'kind', 'encoding', 'delimiter', 'headerRow', 'dataStartRow', 'columns', 'dateFormat', 'explicitYear', 'timeFormat', 'endDayRule', 'statusMap', 'publishedMap', 'recordIdStrategy', 'revisionStrategy']
export function validateCSVMappingProfile(value: unknown): asserts value is CSVMappingProfile {
  if (!plain(value) || canonicalJSON(Object.keys(value).sort()) !== canonicalJSON([...keys].sort()) || value.version !== 1 || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120 || !int(value.revision, 1, 2147483647)) bad('設定の名前・版・形式を確認してください')
  for (const [key, allowed] of Object.entries({ kind: ['calendar', 'roster'], encoding: ['utf-8', 'shift_jis'], delimiter: [',', '\t', ';'], dateFormat: ['YYYY-MM-DD', 'YYYY/M/D', 'YYYY年M月D日', 'M/D'], timeFormat: ['HH:MM', 'H:MM', 'H時MM分'], endDayRule: ['explicit_end_date', 'next_day_when_end<=start'], recordIdStrategy: ['column', 'derived'], revisionStrategy: ['column', 'import_order'] })) if (!allowed.includes(String(value[key]))) bad(`${key}が未対応です`)
  if (!int(value.headerRow, 1, 20) || !int(value.dataStartRow, Number(value.headerRow) + 1, 40) || value.explicitYear !== null && !int(value.explicitYear, 1900, 9999) || value.dateFormat === 'M/D' && value.explicitYear === null) bad('見出し行・開始行・明示した年を確認してください')
  if (!plain(value.columns) || Object.keys(value.columns).length > 10) bad('列の対応を指定してください')
  const required = value.kind === 'calendar' ? ['date', 'status'] : ['person_ref', 'published', 'status', 'start_date', 'start_time', 'end_time', ...(value.endDayRule === 'explicit_end_date' ? ['end_date'] : [])]
  if (value.recordIdStrategy === 'column') required.push(value.kind === 'calendar' ? 'record_id' : 'shift_id')
  if (value.revisionStrategy === 'column') required.push('record_revision')
  if (required.some(field => !Object.hasOwn(value.columns as object, field))) bad('必要な列が未指定です')
  const allowedColumns = [...calendarCSVHeaders[value.kind as 'calendar' | 'roster'], 'slot'] as string[]
  for (const [key, column] of Object.entries(value.columns)) if (!allowedColumns.includes(key) || !plain(column) || Object.keys(column).length !== 2 || typeof column.headerText !== 'string' || !column.headerText || column.headerText.length > 200 || !int(column.index, 0, 99)) bad('列名と位置が不正です')
  const statuses = value.kind === 'calendar' ? ['open', 'closed', 'withdrawn'] : ['scheduled', 'cancelled']
  if (!plain(value.statusMap) || !Object.keys(value.statusMap).length || Object.keys(value.statusMap).length > 100 || Object.entries(value.statusMap).some(([key, status]) => !key || key.length > 100 || !statuses.includes(String(status)))) bad('状態の語彙対応を指定してください')
  if (!plain(value.publishedMap) || Object.keys(value.publishedMap).length > 100 || Object.entries(value.publishedMap).some(([key, published]) => !key || key.length > 100 || typeof published !== 'boolean') || value.kind === 'roster' && !Object.keys(value.publishedMap).length) bad('公開状態の語彙対応を指定してください')
}
export function bytesBase64(bytes: Uint8Array) { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text) }
export function base64Bytes(text: string) { if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text) || text.length > 90000) bad('原文bytesが不正です'); return Uint8Array.from(atob(text), char => char.charCodeAt(0)) }
/** Delimiters, quotes and line breaks are never Shift_JIS trailing bytes. Scan the original bytes, not UTF-8 re-encoding. */
export function readCSVRawRecords(input: Uint8Array, encoding: CSVMappingProfile['encoding'], delimiter: CSVMappingProfile['delimiter']): CSVRawRecord[] {
  if (!(input instanceof Uint8Array) || !input.length || input.length > 1048576) bad('1MiB以内の空でないファイルを選んでください')
  const decode = (bytes: Uint8Array) => { try { const result = new TextDecoder(encoding, { fatal: true }).decode(bytes); if ([...result].some(char => char.charCodeAt(0) === 127 || char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0)))) bad('制御文字があります'); return result } catch { return bad(`${encoding}として読めません`) } }
  decode(input)
  const result: CSVRawRecord[] = [], sep = delimiter.charCodeAt(0)
  let start = encoding === 'utf-8' && input[0] === 239 && input[1] === 187 && input[2] === 191 ? 3 : 0, index = start, line = 1, lineStart = 1, cells: string[] = [], cell: number[] = [], state: 'plain' | 'quoted' | 'closed' = 'plain'
  const field = () => { cells.push(decode(Uint8Array.from(cell))); cell = []; state = 'plain' }
  const emit = (end: number) => { field(); if (end === start || end - start > 65536 || result.length >= 10001 || cells.length > 100 || line > 25000) bad('空行・行数・列数・長さを確認してください'); const bytes = input.slice(start, end); result.push({ cells, quote: decode(bytes), bytes, recordNumber: result.length + 1, lineStart, lineEnd: line, byteStart: start, byteEnd: end }); cells = [] }
  while (index < input.length) {
    const byte = input[index]
    if (byte === 13 && input[index + 1] !== 10) bad('単独CR改行は使えません')
    if (state === 'quoted') {
      if (byte === 34) { if (input[index + 1] === 34) { cell.push(34); index += 2; continue }; state = 'closed'; index++; continue }
      if (byte === 10) line++
      cell.push(byte); index++; continue
    }
    if (byte === sep) { field(); index++; continue }
    if (byte === 10 || byte === 13) { emit(index); index += byte === 13 ? 2 : 1; line++; start = index; lineStart = line; continue }
    if (state === 'closed') bad('閉じた引用符の後は区切りか改行だけです')
    if (byte === 34) { if (cell.length) bad('引用符はセル先頭だけです'); state = 'quoted'; index++; continue }
    cell.push(byte); index++
  }
  if (state === 'quoted') bad('引用符が閉じていません')
  if (index > start) emit(index)
  return result
}
const escape = (value: string) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
function mappedDate(value: string, profile: CSVMappingProfile) {
  let date: string
  if (profile.dateFormat === 'YYYY-MM-DD') { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) bad('日付形式が設定と一致しません'); date = value }
  else { const pattern = profile.dateFormat === 'YYYY/M/D' ? /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/ : profile.dateFormat === 'YYYY年M月D日' ? /^(\d{4})年(\d{1,2})月(\d{1,2})日$/ : /^(\d{1,2})\/(\d{1,2})$/; const match = value.match(pattern); if (!match) bad('日付形式が設定と一致しません'); const parts = profile.dateFormat === 'M/D' ? [String(profile.explicitYear), match![1], match![2]] : match!.slice(1); date = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}` }
  validateDate(date!, '資料の日付'); return date!
}
function mappedClock(value: string, profile: CSVMappingProfile) {
  const match = value.match(profile.timeFormat === 'HH:MM' ? /^(\d{2}):(\d{2})$/ : profile.timeFormat === 'H:MM' ? /^(\d{1,2}):(\d{2})$/ : /^(\d{1,2})時(\d{2})分$/)
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) bad('時刻形式が設定と一致しません'); return `${match![1].padStart(2, '0')}:${match![2]}`
}
export async function parseMappedCalendarCSV(input: Uint8Array, options: CSVParseOptions, binding: CSVMappingBinding): Promise<ParsedCalendarCSVImport> {
  validateCSVMappingProfile(binding.profile)
  const profile = structuredClone(binding.profile), digest = await contentDigest(profile)
  if (binding.digest !== digest || profile.kind !== options.kind || !int(binding.sequence, 1, 2147483647)) bad('設定のhash・対象・取込順が一致しません')
  const records = readCSVRawRecords(input, profile.encoding, profile.delimiter), header = records[profile.headerRow - 1]
  if (!header || Object.values(profile.columns).some(column => header.cells[column.index] !== column.headerText)) bad('見出しの文字と位置が設定と一致しません。列を対応し直してください')
  const selected: { raw: CSVRawRecord; normalized: string; overnight: boolean }[] = []
  let excludedOtherPerson = 0, excludedDraft = 0
  for (const raw of records.slice(profile.dataStartRow - 1)) {
    if (raw.cells.length !== header.cells.length) bad(`レコード${raw.recordNumber}の列数が見出しと異なります`)
    const get = (field: string) => profile.columns[field] ? raw.cells[profile.columns[field].index] : ''
    if (options.kind === 'roster') {
      if (get('person_ref').normalize('NFC') !== options.personRef?.normalize('NFC')) { excludedOtherPerson++; continue }
      if (!Object.hasOwn(profile.publishedMap, get('published'))) bad(`レコード${raw.recordNumber}の公開状態が未対応です`)
      if (!profile.publishedMap[get('published')]) { excludedDraft++; continue }
    }
    if (!Object.hasOwn(profile.statusMap, get('status'))) bad(`レコード${raw.recordNumber}の状態「${get('status')}」は未対応です`)
    const date = mappedDate(get(options.kind === 'calendar' ? 'date' : 'start_date'), profile), status = profile.statusMap[get('status')]
    const start = options.kind === 'roster' ? mappedClock(get('start_time'), profile) : '', end = options.kind === 'roster' ? mappedClock(get('end_time'), profile) : ''
    const overnight = options.kind === 'roster' && profile.endDayRule === 'next_day_when_end<=start' && end <= start
    const endDate = options.kind === 'roster' ? profile.endDayRule === 'explicit_end_date' ? mappedDate(get('end_date'), profile) : addDays(date, overnight ? 1 : 0) : ''
    const id = profile.recordIdStrategy === 'column' ? get(options.kind === 'calendar' ? 'record_id' : 'shift_id') : `derived:${await contentDigest([options.personRef?.normalize('NFC') ?? '', date, get('slot') || start])}`
    const revision = profile.revisionStrategy === 'column' ? get('record_revision') : String(binding.sequence)
    const fields = options.kind === 'calendar' ? [id, revision, date, status] : [id, revision, get('person_ref'), 'true', status, date, start, endDate, end]
    selected.push({ raw, normalized: fields.map(escape).join(','), overnight })
  }
  const canonical = calendarCSVHeaders[options.kind].join(',') + '\n' + selected.map(row => row.normalized).join('\n') + (selected.length ? '\n' : '')
  const parsed = await parseCalendarCSVImport(new TextEncoder().encode(canonical), options)
  for (const row of parsed.rows) {
    const original = selected[row.recordNumber - 2]
    Object.assign(row, { quote: original.raw.quote, quoteHash: await csvBytesDigest(original.raw.bytes), recordNumber: original.raw.recordNumber, lineStart: original.raw.lineStart, lineEnd: original.raw.lineEnd, byteStart: original.raw.byteStart, byteEnd: original.raw.byteEnd, mapped: { rawBase64: bytesBase64(original.raw.bytes), normalizedQuote: original.normalized, profileDigest: digest } })
    if (original.overnight) parsed.warnings.push(`レコード${row.recordNumber}: 本人が選んだ翌日規則を適用しました`)
  }
  for (const row of parsed.outsidePeriodRecords) { const original = selected[row.recordNumber - 2]; row.recordNumber = original.raw.recordNumber; row.lineStart = original.raw.lineStart }
  parsed.excludedOtherPerson += excludedOtherPerson; parsed.excludedDraft += excludedDraft; parsed.fileSha256 = await csvBytesDigest(input); parsed.mapping = { ...binding, profile }
  if (profile.recordIdStrategy === 'derived') parsed.warnings.push('日付と枠からIDを作ります。日付移動は別の記録になり、古い勤務は自動取消しません。差分を個別に確認してください')
  if (profile.revisionStrategy === 'import_order') parsed.warnings.push('資料の新旧は本人の確認した取込順です。元の発行版を検証したことにはなりません')
  return parsed
}
export async function verifyMappedCSVQuote(rawBase64: string, quote: string, normalizedQuote: string, binding: CSVMappingBinding, options: CSVParseOptions) {
  const profile = binding.profile, raw = base64Bytes(rawBase64)
  if (new TextDecoder(profile.encoding, { fatal: true }).decode(raw) !== quote) bad('原文bytesと表示が一致しません')
  // Header bytes are ASCII-independent for SJIS: verify the row directly using the same normalizer, with the profile's decoded headers.
  const row = readCSVRawRecords(raw, profile.encoding, profile.delimiter)
  if (row.length !== 1) bad('保持する原文は本人の一行だけです')
  const header = Array.from({ length: row[0].cells.length }, (_, index) => Object.values(profile.columns).find(column => column.index === index)?.headerText ?? `未指定${index}`).map(value => `"${value.replace(/"/g, '""')}"`).join(profile.delimiter)
  const utfProfile = { ...profile, encoding: 'utf-8' as const, headerRow: 1, dataStartRow: 2 }
  const parsed = await parseMappedCalendarCSV(new TextEncoder().encode(header + '\n' + quote), { ...options, verify: true }, { profile: utfProfile, digest: await contentDigest(utfProfile), sequence: binding.sequence })
  if (parsed.rows.length !== 1 || parsed.excludedDraft + parsed.excludedOtherPerson + parsed.excludedOutsidePeriod || parsed.rows[0].mapped?.normalizedQuote !== normalizedQuote) bad('保持した行と正規化値が一致しません')
  return raw
}
