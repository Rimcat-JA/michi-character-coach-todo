import { canonicalJSON, contentDigest } from './canonical'
import { validateDate } from './domain'
import { resolveLocalCalendarTime, type CSVRecordHead, type CSVRecordValue, type CSVRowEvidence, type CalendarRulesState, type ScheduleFact, type CSVImportMetadata } from './calendar-resolver'
import { db } from './db'
import { loadCalendarRulesState, prepareCalendarConfiguration, type CalendarRulesConfiguration, type CalendarConfigurationProposal } from './calendar-rules-save'
import { csvEvidenceRowLimit, csvSnapshotLimit, validateCalendarRulesState } from './calendar-rules-validation'
import { captureCalendarCSVAuthorityGeneration, registerCalendarCSVImport } from './calendar-csv-import-save'

export type CSVImportKind = 'calendar' | 'roster'
export type CSVImportTarget = { kind: CSVImportKind; contextId: string; bindingId: string; calendarId: string; activityId: string | null; feedId: string; title: string; retentionUntil: string | null }
export type CSVImportOptions = { fromDate: string; toDate: string }
/** verify re-reads a retained row without resolving UTC instants, so later time-zone rule updates cannot invalidate stored evidence. */
export type CSVParseOptions = CSVImportOptions & { kind: CSVImportKind; timezone: string; personRef: string | null; verify?: boolean }
export type CalendarCSVRow = {
  kind: CSVImportKind; externalId: string; recordId: string; revision: number; status: 'open' | 'closed' | 'withdrawn' | 'scheduled' | 'cancelled'
  date: string | null; personRef: string | null; startDate: string | null; startTime: string | null; endDate: string | null; endTime: string | null; startAt: string | null; endAt: string | null
  digest: string; quote: string; quoteHash: string; recordNumber: number; lineStart: number; lineEnd: number; byteStart: number; byteEnd: number
}
/** outsidePeriodRecords only carries identity and version of the person's own rows outside the period; it is never stored. */
export type ParsedCalendarCSVImport = { kind: CSVImportKind; fileSha256: string; bodyHash: string; normalizedBody: string; rows: CalendarCSVRow[]; outsidePeriodRecords: { recordId: string; revision: number; recordNumber: number; lineStart: number }[]; fromDate: string; toDate: string; excludedDraft: number; excludedOtherPerson: number; excludedOutsidePeriod: number; warnings: string[] }
/** retentionShortened: the new deadline also reaches earlier stored copies, including records absent from this file. */
export type CalendarCSVImportPreview = { sourceId: string; noOp: boolean; retentionShortened: { snapshots: number; otherRecords: number; until: string } | null; added: number; updated: number; canceled: number; unchanged: number; selectedCount: number; excludedDraft: number; excludedOtherPerson: number; excludedOutsidePeriod: number; warnings: string[]; changes: { before: ScheduleFact | null; after: ScheduleFact | null; recordId: string; status: string }[]; parsed: ParsedCalendarCSVImport }
export type PreparedCalendarCSVImport = Readonly<{ id: string; digest: string; preview: CalendarCSVImportPreview; configuration: CalendarConfigurationProposal | null; target: CSVImportTarget; ownerId: string; datasetId: string; policyEpoch: number; sourcePermissionRevision: number; baseDigest: string; referencesDigest: string; createdAt: string; expiresAt: string }>
export const calendarCSVHeaders = { calendar: ['record_id', 'record_revision', 'date', 'status'], roster: ['shift_id', 'record_revision', 'person_ref', 'published', 'status', 'start_date', 'start_time', 'end_date', 'end_time'] } as const
type RawRecord = { cells: string[]; quote: string; recordNumber: number; lineStart: number; lineEnd: number; byteStart: number; byteEnd: number }
function fail(message: string, record?: Pick<RawRecord, 'recordNumber' | 'lineStart'>): never { throw new Error(`CSV${record ? ` レコード${record.recordNumber}（${record.lineStart}行）` : ''}: ${message}`) }
export async function csvUTF8Digest(text: string) { return csvBytesDigest(new TextEncoder().encode(text)) }
async function csvBytesDigest(bytes: Uint8Array) { const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)); return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') }
/** Hash of the saved selected rows, in record order, so reordering the file does not count as a change. */
export function csvEvidenceBodyProjection(format: CSVImportKind, rows: CSVRowEvidence[]) { return { format: 'coach-calendar-csv-selected', version: 1, profile: format, rows: rows.map(({ recordId, recordRevision, digest, factId, quoteSha256, value }) => ({ recordId, recordRevision, digest, factId, quoteSha256, value })).sort((a, b) => a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0) } }
function records(text: string, bomBytes: number): RawRecord[] {
  const positions = new Uint32Array(text.length + 1)
  let byte = bomBytes, character = 0
  for (const codepoint of text) { positions[character] = byte; if (codepoint.length === 2) positions[character + 1] = byte; character += codepoint.length; const code = codepoint.codePointAt(0)!; byte += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4 }
  positions[text.length] = byte
  const result: RawRecord[] = []
  let cells: string[] = [], value = '', state: 'plain' | 'quoted' | 'closed' = 'plain', index = 0, start = 0, line = 1, lineStart = 1
  function emit(end: number) {
    cells.push(value)
    if (end - start > 65536 || result.length >= 10001) fail('レコード数・長さの上限を超えています')
    result.push({ cells, quote: text.slice(start, end), recordNumber: result.length + 1, lineStart, lineEnd: line, byteStart: positions[start], byteEnd: positions[end] })
    cells = []; value = ''; state = 'plain'
  }
  while (index < text.length) {
    const char = text[index]
    if (char === '\r' && text[index + 1] !== '\n') fail('単独のCR改行は使えません')
    if (state === 'quoted') {
      if (char === '"') { if (text[index + 1] === '"') { value += '"'; index += 2; continue }; state = 'closed'; index++; continue }
      if (char === '\r' || char === '\n') { const eol = char === '\r' ? '\r\n' : '\n'; value += eol; index += eol.length; line++; continue }
      value += char; index++; continue
    }
    if (char === ',' || char === '\r' || char === '\n') {
      if (char === ',') { cells.push(value); value = ''; state = 'plain'; index++; continue }
      emit(index); index += char === '\r' ? 2 : 1; line++; start = index; lineStart = line; continue
    }
    if (state === 'closed') fail('閉じた引用符の後はカンマか改行だけです')
    if (char === '"') { if (value) fail('引用符はフィールドの先頭に置いてください'); state = 'quoted'; index++; continue }
    value += char; index++
  }
  if (state === 'quoted') fail('引用符が閉じていません')
  if (start < text.length) emit(text.length)
  return result
}
const canonicalCSV = (cells: string[]) => cells.map(value => `"${value.replace(/\r\n/g, '\n').replaceAll('"', '""')}"`).join(',')
const hasControl = (value: string, allowed: number[] = []) => [...value].some(char => { const code = char.charCodeAt(0); return (code < 32 || code === 127) && !allowed.includes(code) })
function string(value: string, name: string, record: RawRecord, max = 500) { if (!value || value.length > max || hasControl(value)) fail(`${name}の文字・長さを確認してください`, record); return value }
function date(value: string, record: RawRecord) { try { validateDate(value, 'CSV日付') } catch { fail('日付は正しいYYYY-MM-DDで指定してください', record) }; return value }
function revision(value: string, record: RawRecord) { if (!/^[1-9]\d*$/.test(value) || Number(value) > 2147483647) fail('record_revisionは1以上2147483647以下の整数です', record); return Number(value) }
function clock(value: string, record: RawRecord) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('時刻はHH:MMで明示してください', record); return value }
function semantic(row: Omit<CalendarCSVRow, 'digest' | 'quote' | 'quoteHash' | 'recordNumber' | 'lineStart' | 'lineEnd' | 'byteStart' | 'byteEnd'>) { return { kind: row.kind, externalId: row.externalId, revision: row.revision, status: row.status, date: row.date, personRef: row.personRef, startDate: row.startDate, startTime: row.startTime, endDate: row.endDate, endTime: row.endTime, startAt: row.startAt, endAt: row.endAt } }
const rowValue = (row: CalendarCSVRow): CSVRecordValue => row.kind === 'calendar' ? { kind: 'calendar', date: row.date!, status: row.status as 'open' | 'closed' | 'withdrawn' } : { kind: 'roster', status: row.status as 'scheduled' | 'cancelled', startAt: row.startAt!, endAt: row.endAt!, startLocal: `${row.startDate}T${row.startTime}`, endLocal: `${row.endDate}T${row.endTime}` }
export async function csvRecordValueDigest(recordId: string, recordRevision: number, value: CSVRecordValue, target: CSVImportMetadata['target']) { return contentDigest({ recordId, recordRevision, value, target: { bindingId: target.bindingId, calendarId: target.calendarId, activityId: target.activityId, timezone: target.timezone, personRefHash: target.personRefHash } }) }
async function boundRecordDigest(row: CalendarCSVRow, target: CSVImportMetadata['target']) { return csvRecordValueDigest(row.recordId, row.revision, rowValue(row), target) }
export async function parseCalendarCSVImport(input: Uint8Array, options: CSVParseOptions): Promise<ParsedCalendarCSVImport> {
  options = structuredClone(options)
  if (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength > 1048576) fail('UTF-8の1MiB以内のCSVファイルを選んでください')
  const bytes = new Uint8Array(input), bomBytes = bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191 ? 3 : 0
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('UTF-8として読めません。文字コードを確認してください') }
  if (!text || hasControl(text, [9, 10, 13])) fail('空のファイル・制御文字は取り込めません')
  if (!options || !['calendar', 'roster'].includes(options.kind)) fail('CSV形式を本人が選択してください')
  validateDate(options.fromDate, '取込開始'); validateDate(options.toDate, '取込終了')
  if (options.fromDate > options.toDate || (Date.parse(`${options.toDate}T00:00:00Z`) - Date.parse(`${options.fromDate}T00:00:00Z`)) / 86400000 > 366) fail('取込期間は順序の正しい367日以内にしてください')
  try { new Intl.DateTimeFormat('en-US', { timeZone: options.timezone }) } catch { fail('本人が選んだIANAタイムゾーンを確認してください') }
  if (options.kind === 'roster' && (!options.personRef || options.personRef.length > 200)) fail('公開勤務の本人識別子を確認してください')
  const raw = records(text, bomBytes), headers = calendarCSVHeaders[options.kind]
  if (!raw.length || canonicalJSON(raw[0].cells) !== canonicalJSON(headers)) fail(`ヘッダーは ${headers.join(',')} の順序で指定してください`)
  const rows: CalendarCSVRow[] = [], selectedCells: string[][] = [], seen = new Set<string>(), outsidePeriodRecords: ParsedCalendarCSVImport['outsidePeriodRecords'] = []
  let excludedDraft = 0, excludedOtherPerson = 0, excludedOutsidePeriod = 0
  for (const record of raw.slice(1)) {
    if (record.cells.length !== headers.length) fail('ヘッダーと列数が一致しません', record)
    const values = Object.fromEntries(headers.map((name, index) => [name, record.cells[index]]))
    if (options.kind === 'roster') {
      // Unicode normalization only (design 10.2); no trimming or case folding of the person reference.
      if (values.person_ref.normalize('NFC') !== options.personRef!.normalize('NFC')) { excludedOtherPerson++; continue }
      if (values.published === 'false') { excludedDraft++; continue }
      if (values.published !== 'true') fail('publishedはtrueまたはfalseです', record)
    }
    // IDs are compared after NFC so a re-export in another Unicode form is the same record.
    const externalId = string(values.record_id ?? values.shift_id, '安定したレコードID', record).normalize('NFC'), number = revision(values.record_revision, record)
    const status = values.status as CalendarCSVRow['status']
    if (!(options.kind === 'calendar' ? ['open', 'closed', 'withdrawn'] : ['scheduled', 'cancelled']).includes(status)) fail('statusはこのCSV形式の明示状態を指定してください', record)
    const selectedDate = date(values.date ?? values.start_date, record)
    // One line per record in the whole file, so an older version cannot hide outside the period.
    if (seen.has(externalId)) fail('同じレコードIDが重複しています。版を確認して一行にしてください', record); seen.add(externalId)
    if (selectedDate < options.fromDate || selectedDate > options.toDate) { excludedOutsidePeriod++; outsidePeriodRecords.push({ recordId: `sha256:${await contentDigest(externalId)}`, revision: number, recordNumber: record.recordNumber, lineStart: record.lineStart }); continue }
    if (record.lineEnd > 25000) fail('選択する行は25000行目までに置いてください', record)
    let startDate: string | null = null, startTime: string | null = null, endDate: string | null = null, endTime: string | null = null, startAt: string | null = null, endAt: string | null = null
    if (options.kind === 'roster') {
      startDate = selectedDate; startTime = clock(values.start_time, record); endDate = date(values.end_date, record); endTime = clock(values.end_time, record)
      if (!options.verify) {
        const start = resolveLocalCalendarTime(startDate, startTime, options.timezone), end = resolveLocalCalendarTime(endDate, endTime, options.timezone)
        if (!start.at || !end.at) fail(start.reason ?? end.reason ?? '勤務日時を確定できません', record)
        if (end.at <= start.at || Date.parse(end.at) - Date.parse(start.at) > 7 * 86400000) fail('終了日は明示し、勤務の順序・7日以内の長さを確認してください', record)
        startAt = start.at; endAt = end.at
      }
    }
    const value = { kind: options.kind, externalId, recordId: `sha256:${await contentDigest(externalId)}`, revision: number, status, date: options.kind === 'calendar' ? selectedDate : null, personRef: options.kind === 'roster' ? options.personRef : null, startDate, startTime, endDate, endTime, startAt, endAt }
    rows.push({ ...value, digest: await contentDigest(semantic(value)), quote: record.quote, quoteHash: await csvUTF8Digest(record.quote), recordNumber: record.recordNumber, lineStart: record.lineStart, lineEnd: record.lineEnd, byteStart: record.byteStart, byteEnd: record.byteEnd }); selectedCells.push(record.cells)
    if (rows.length > 1000) fail('本人の選択行は1000件以内です')
  }
  const normalizedBody = [headers.join(','), ...selectedCells.map(canonicalCSV)].join('\n') + '\n'
  return { kind: options.kind, fileSha256: await csvBytesDigest(bytes), bodyHash: await csvUTF8Digest(normalizedBody), normalizedBody, rows, outsidePeriodRecords, fromDate: options.fromDate, toDate: options.toDate, excludedDraft, excludedOtherPerson, excludedOutsidePeriod, warnings: rows.length ? [] : ['本人の適用期間に合う公開済みの行がありません。既存資料や予定は置換しません'] }
}

function configuration(state: CalendarRulesState): CalendarRulesConfiguration { const { contexts, bindings, calendars, activities, sources, facts, rules } = state; return structuredClone({ contexts, bindings, calendars, activities, sources, facts, rules }) }
export function csvTargetReferences(state: CalendarRulesState, target: CSVImportTarget) { return { context: state.contexts.find(row => row.id === target.contextId) ?? null, binding: state.bindings.find(row => row.id === target.bindingId) ?? null, calendar: state.calendars.find(row => row.id === target.calendarId) ?? null, activity: target.activityId ? state.activities.find(row => row.id === target.activityId) ?? null : null } }
const storedValue = (csv: CSVImportMetadata, head: CSVRecordHead) => csv.snapshots.find(row => row.revision === head.snapshotRevision)?.rows.find(row => row.rowIndex === head.rowIndex)?.value ?? null
/** Zone-independent comparison of what the file says: dates, local wall times and the explicit status. */
const sameLocalValue = (left: CSVRecordValue, right: CSVRecordValue) => left.kind === 'calendar' && right.kind === 'calendar' ? left.date === right.date && left.status === right.status : left.kind === 'roster' && right.kind === 'roster' && left.status === right.status && left.startLocal === right.startLocal && left.endLocal === right.endLocal
function validateTarget(state: CalendarRulesState, target: CSVImportTarget, options: CSVImportOptions, at: string) {
  const keys = ['kind', 'contextId', 'bindingId', 'calendarId', 'activityId', 'feedId', 'title', 'retentionUntil']
  if (!target || Object.keys(target).length !== keys.length || keys.some(key => !Object.hasOwn(target, key)) || !['calendar', 'roster'].includes(target.kind) || typeof target.feedId !== 'string' || !target.feedId.trim() || target.feedId.length > 120 || typeof target.title !== 'string' || !target.title.trim() || target.title.trim().length > 300) fail('形式・固定取込元・資料名と本人の対象を指定してください')
  if (target.retentionUntil !== null && (typeof target.retentionUntil !== 'string' || !Number.isFinite(Date.parse(target.retentionUntil)) || new Date(target.retentionUntil).toISOString() !== target.retentionUntil || target.retentionUntil <= at)) fail('保持期限は未来のUTC日時を指定してください')
  const refs = csvTargetReferences(state, target), { context, binding, calendar, activity } = refs
  if (!context || !binding || !calendar || binding.contextId !== context.id || calendar.contextId !== context.id || binding.personId !== state.ownerId || !binding.confirmed) fail('対象・確認済み本人適用・カレンダーを明示選択してください')
  if (target.kind === 'calendar' && target.activityId !== null) fail('営業日CSVは活動を指定しません')
  if (target.kind === 'roster' && (!binding.personRef || !activity || activity.contextId !== context.id || activity.bindingId !== binding.id || activity.calendarId !== calendar.id || !binding.activityIds.includes(activity.id) || activity.weekdays.length)) fail('公開勤務CSVには本人識別子と曜日が未設定の専用活動を明示選択してください。通常曜日の活動は変更しません')
  const from = [context.validFrom, binding.validFrom, calendar.validFrom, ...(activity ? [activity.validFrom] : [])].sort().at(-1)!, to = [context.validTo, binding.validTo, calendar.validTo, ...(activity ? [activity.validTo] : [])].sort()[0]
  if (options.fromDate < from || options.toDate > to) fail('選択した取込期間が本人対象・活動の適用期間を外れています')
  return refs as { context: NonNullable<typeof context>; binding: NonNullable<typeof binding>; calendar: NonNullable<typeof calendar>; activity: typeof activity }
}
/** Pure configuration adapter. All actual events/tasks are created by the later common generation approval. */
export async function prepareCSVConfiguration(state: CalendarRulesState, target: CSVImportTarget, parsed: ParsedCalendarCSVImport, at = new Date().toISOString()): Promise<{ preview: CalendarCSVImportPreview; next: CalendarRulesConfiguration }> {
  state = structuredClone(state); target = structuredClone(target); parsed = structuredClone(parsed)
  validateCalendarRulesState(state)
  const { context, binding } = validateTarget(state, target, parsed, at), next = configuration(state)
  const sourceId = `csv-source:${(await contentDigest([state.ownerId, context.id, target.kind, target.feedId])).slice(0, 32)}`, previous = state.sources.find(row => row.id === sourceId)
  const csvTarget: CSVImportMetadata['target'] = { bindingId: binding.id, bindingRevision: binding.revision, calendarId: target.calendarId, activityId: target.activityId, timezone: context.timezone, personRef: target.kind === 'roster' ? binding.personRef : null, personRefHash: target.kind === 'roster' ? `sha256:${await contentDigest(binding.personRef)}` : null }
  if (previous && (!previous.csv || previous.csv.format !== target.kind || previous.csv.feedId !== target.feedId)) fail('同じ取込元IDの資料の形式が異なります。別の取込元IDを指定してください')
  if (previous?.csv?.retiredAt) fail('この取込元IDは終了済みです。別の新しい取込元IDを指定してください。終了前に反映した予定・実績は保持しています')
  if (previous && canonicalJSON({ ...previous.csv!.target, bindingRevision: 0, personRef: null }) !== canonicalJSON({ ...csvTarget, bindingRevision: 0, personRef: null })) fail('この取込元の登録後に本人識別子・カレンダー・活動・タイムゾーンが変わりました。「取込元の終了」で既存の取込元を終了してから、新しい取込元で取り込んでください。既存の予定・実績は保持します')
  // Other CSV sources of the same target, retired ones included: their versions still order the shared records.
  const lineage = state.sources.filter(source => source.id !== sourceId && source.contextId === context.id && source.csv && source.csv.format === target.kind && source.csv.target.calendarId === target.calendarId && source.csv.target.activityId === target.activityId)
  if (!previous) {
    // One live CSV source per calendar or roster activity: a second feed would report the same records twice.
    const sameTarget = lineage.find(source => !source.csv!.retiredAt)
    if (sameTarget) fail(`同じ対象のCSV取込元「${sameTarget.title}」があります。「既存の取込元を更新」で取り込むか、「取込元の終了」で終了してから新しい取込元を作ってください`)
  }
  const lineageHeads = new Map<string, { revision: number; value: CSVRecordValue | null; title: string }>()
  for (const source of lineage) for (const head of source.csv!.heads) { const known = lineageHeads.get(head.recordId); if (!known || head.recordRevision > known.revision) lineageHeads.set(head.recordId, { revision: head.recordRevision, value: storedValue(source.csv!, head), title: source.title }) }
  const csv = previous?.csv, nextRevision = (previous?.revision ?? 0) + 1
  // A known current record whose newer version moved outside the period must not stay current with its old date.
  for (const outside of parsed.outsidePeriodRecords) {
    const where = `（レコード${outside.recordNumber}・${outside.lineStart}行）`, head = csv?.heads.find(row => row.recordId === outside.recordId && row.status === 'current'), known = lineageHeads.get(outside.recordId)
    if (head ? outside.revision < head.recordRevision : known && outside.revision < known.revision) fail(`既存レコードより古い版が取込期間外にあります${where}。元資料を確認してください`)
    if (!head) continue
    const stored = storedValue(csv!, head), storedDate = stored ? stored.kind === 'calendar' ? stored.date : stored.startLocal.slice(0, 10) : null
    if (outside.revision > head.recordRevision || storedDate !== null && storedDate >= parsed.fromDate && storedDate <= parsed.toDate) fail(`取込済みレコードの新しい版・移動先が取込期間外にあります${where}。取込期間を広げて取り込み直してください。対象・活動の有効期間の外へ移った場合は「取込元の終了」で終了し、新しい取込元で取り込んでください。古い日時を最新として扱いません`)
  }
  if (target.kind === 'roster') {
    // The same shift ID with an overlapping time in another roster activity of the person is the same work, not a second shift.
    const siblings = state.sources.filter(source => source.contextId === context.id && source.csv?.format === 'roster' && !source.csv.retiredAt && source.csv.target.bindingId === binding.id && source.csv.target.activityId !== target.activityId)
    for (const row of parsed.rows) for (const source of siblings) {
      const head = source.csv!.heads.find(item => item.recordId === row.recordId && item.status === 'current'), stored = head ? storedValue(source.csv!, head) : null, value = rowValue(row)
      if (stored?.kind === 'roster' && value.kind === 'roster' && stored.startLocal < value.endLocal && value.startLocal < stored.endLocal) fail(`本人の別の勤務活動（取込元「${source.title}」）に、同じシフトIDで時間の重なる勤務があります（レコード${row.recordNumber}・${row.lineStart}行）。同じ勤務を二つの活動で予定にしないよう、取込先の活動を確認してください`)
    }
  }
  const preview: CalendarCSVImportPreview = { sourceId, noOp: true, retentionShortened: null, added: 0, updated: 0, canceled: 0, unchanged: 0, selectedCount: parsed.rows.length, excludedDraft: parsed.excludedDraft, excludedOtherPerson: parsed.excludedOtherPerson, excludedOutsidePeriod: parsed.excludedOutsidePeriod, warnings: [...parsed.warnings], changes: [], parsed: structuredClone(parsed) }
  if (!parsed.rows.length) return { preview, next }
  if (!Number.isSafeInteger(nextRevision)) fail('資料の版が上限に達しています')
  const heads = new Map((csv?.heads ?? []).map(row => [row.recordId, structuredClone(row)])), evidence: CSVRowEvidence[] = []
  for (const row of parsed.rows) {
    const digest = await boundRecordDigest(row, csvTarget), prior = heads.get(row.recordId), existingBefore = prior?.factId ? next.facts.find(fact => fact.id === prior.factId) ?? null : null, before = existingBefore ? structuredClone(existingBefore) : null
    const where = `（レコード${row.recordNumber}・${row.lineStart}行）`, known = prior ? undefined : lineageHeads.get(row.recordId)
    if (prior && row.revision < prior.recordRevision) fail(`既存レコードより古い版です${where}。元資料を確認してください`)
    if (prior && row.revision === prior.recordRevision && digest !== prior.digest) {
      const stored = storedValue(csv!, prior)
      // Same local times but another UTC instant can only come from a time-zone rule update, not from the file.
      fail(stored && sameLocalValue(stored, rowValue(row)) ? `タイムゾーン規則の更新により、同じ版の勤務の現地時刻に対応するUTC時刻が変わりました${where}。この取込元の時刻は登録時のまま保持しています。新しい規則で反映するには「取込元の終了」で終了し、新しい取込元で取り込んでください` : `同じ版で内容が異なります${where}。元資料を確認してください`)
    }
    if (known && (row.revision < known.revision || row.revision === known.revision && known.value && !sameLocalValue(known.value, rowValue(row)))) fail(`終了した取込元「${known.title}」に、このレコードの新しい版または同じ版の異なる内容があります${where}。古い資料を最新として扱いません。元資料を確認してください`)
    const withdrawn = row.status === 'withdrawn', factId = withdrawn ? null : `csv-fact:${(await contentDigest([sourceId, row.recordId, row.revision])).slice(0, 32)}`
    let after: ScheduleFact | null = null
    if (factId) {
      const base = { id: factId, sourceId, contextId: context.id, revision: row.revision, validity: 'active' as const, supersedes: before && before.id !== factId ? [before.id] : before?.supersedes ?? [] }
      after = target.kind === 'calendar' ? { ...base, kind: row.status as 'open' | 'closed', calendarId: target.calendarId, date: row.date! } : { ...base, kind: 'roster_assignment', activityId: target.activityId!, externalId: row.recordId, personRef: csvTarget.personRefHash!, published: true, status: row.status as 'scheduled' | 'cancelled', startAt: row.startAt!, endAt: row.endAt! }
    }
    if (existingBefore && (!after || existingBefore.id !== after.id)) existingBefore.validity = 'withdrawn'
    if (after) { const index = next.facts.findIndex(fact => fact.id === after!.id); if (index >= 0) next.facts[index] = after; else next.facts.push(after) }
    if (!prior) preview.added++
    else if (row.revision === prior.recordRevision && prior.status === (withdrawn ? 'withdrawn' : 'current')) preview.unchanged++
    else if (withdrawn || row.status === 'cancelled' && before?.kind === 'roster_assignment' && before.status !== 'cancelled') preview.canceled++
    else preview.updated++
    const { recordNumber, lineStart, lineEnd, byteStart, byteEnd, quote, quoteHash } = row
    evidence.push({ recordId: row.recordId, recordRevision: row.revision, digest, factId, rowIndex: recordNumber, lineStart, lineEnd, byteStart, byteEnd, quote, quoteSha256: quoteHash, value: rowValue(row) })
    heads.set(row.recordId, { recordId: row.recordId, recordRevision: row.revision, digest, factId, status: withdrawn ? 'withdrawn' : 'current', snapshotRevision: nextRevision, rowIndex: recordNumber })
    if (!prior || row.revision !== prior.recordRevision || prior.status === 'expired') preview.changes.push({ before: before ? structuredClone(before) : null, after: after ? structuredClone(after) : null, recordId: row.recordId, status: row.status })
  }
  const bodyProjection = csvEvidenceBodyProjection(target.kind, evidence), bodyHash = await contentDigest(bodyProjection)
  const last = csv?.snapshots.at(-1)
  // The whole-file hash is metadata only: other people's rows, BOM, line endings or row order never make a new version.
  preview.noOp = Boolean(previous?.status === 'current' && previous.title === target.title.trim() && canonicalJSON(csv!.target) === canonicalJSON(csvTarget) && last?.bodyHash === bodyHash && last.fromDate === parsed.fromDate && last.toDate === parsed.toDate && csv?.retentionUntil === target.retentionUntil && !preview.added && !preview.updated && !preview.canceled)
  preview.parsed.normalizedBody = canonicalJSON(bodyProjection); preview.parsed.bodyHash = bodyHash
  if (preview.noOp) return { preview, next: configuration(state) }
  const snapshot = { revision: nextRevision, fingerprint: parsed.fileSha256, bodyHash, importedAt: at, fromDate: parsed.fromDate, toDate: parsed.toDate, retentionUntil: target.retentionUntil, rows: evidence }
  // A shorter deadline applies to every earlier copy of the originals; a longer one never extends them.
  const shorten = (value: string | null) => target.retentionUntil !== null && (value === null || value > target.retentionUntil) ? target.retentionUntil : value
  const headRows = [...heads.values()].sort((a, b) => a.recordId < b.recordId ? -1 : 1), kept = [...(csv?.snapshots ?? []).map(row => ({ ...row, retentionUntil: shorten(row.retentionUntil) })), snapshot]
  // The deadline is source-wide; the preview discloses which earlier records it reaches.
  const shortened = (csv?.snapshots ?? []).filter(row => shorten(row.retentionUntil) !== row.retentionUntil), selected = new Set(parsed.rows.map(row => row.recordId))
  if (shortened.length && target.retentionUntil) preview.retentionShortened = { snapshots: shortened.length, otherRecords: new Set(shortened.flatMap(row => row.rows.map(item => item.recordId)).filter(recordId => !selected.has(recordId))).size, until: target.retentionUntil }
  // Earlier records that no current record points at and whose facts are all evidenced elsewhere are duplicates.
  for (const old of kept.slice(0, -1)) {
    const others = kept.filter(row => row !== old)
    if (!headRows.some(head => head.snapshotRevision === old.revision) && old.rows.every(row => row.factId === null || others.some(other => other.rows.some(item => item.factId === row.factId)))) kept.splice(kept.indexOf(old), 1)
  }
  if (kept.length > csvSnapshotLimit || kept.reduce((sum, row) => sum + row.rows.length, 0) > csvEvidenceRowLimit || headRows.length > 1000) fail('この取込元に保存できる記録の上限に達しました。「取込元の終了」で終了してから、新しい取込元で取り込んでください。既存の予定・実績は保持します')
  const source = { id: sourceId, contextId: context.id, title: target.title.trim(), authorityScope: target.kind === 'calendar' ? 'calendar' as const : 'roster' as const, coverageFrom: [parsed.fromDate, previous?.coverageFrom ?? parsed.fromDate].sort()[0], coverageTo: [parsed.toDate, previous?.coverageTo ?? parsed.toDate].sort().at(-1)!, status: 'current' as const, revision: nextRevision, importedAt: at, bodyHash, csv: { format: target.kind, feedId: target.feedId, readOnly: true as const, retentionUntil: target.retentionUntil, retiredAt: null, target: csvTarget, heads: headRows, snapshots: kept } }
  next.sources = [...next.sources.filter(row => row.id !== sourceId), source]
  validateCalendarRulesState({ ...state, ...next, revision: state.revision + 1 })
  return { preview, next }
}
export async function prepareCalendarCSVImport(target: CSVImportTarget, bytes: Uint8Array, options: CSVImportOptions): Promise<PreparedCalendarCSVImport> {
  const generation = captureCalendarCSVAuthorityGeneration(), state = await loadCalendarRulesState(), settings = await db.settings.get('main')
  if (!settings) fail('本人の保存先がありません')
  await verifyCSVOriginalDigests([state])
  target = structuredClone(target); options = structuredClone(options)
  const refs = validateTarget(state, target, options, new Date().toISOString())
  const parsed = await parseCalendarCSVImport(bytes, { ...options, kind: target.kind, timezone: refs.context.timezone, personRef: target.kind === 'roster' ? refs.binding.personRef : null })
  const { preview, next } = await prepareCSVConfiguration(state, target, parsed)
  const configuration = preview.noOp ? null : await prepareCalendarConfiguration(next, state.revision, options.fromDate, options.toDate)
  return registerCalendarCSVImport({ preview, configuration, target }, settings, state, generation)
}
/**
 * Retiring is the person's explicit way out of a feed that can no longer be updated (record limit,
 * changed person ID or time zone, expired originals). The source stops supplying facts and stops
 * holding its series for review. Facts, evidence, audits, events, completions and ledger stay; the
 * common generation shows any resulting change for a separate approval and never cancels shifts.
 */
export async function prepareCalendarCSVRetirement(sourceId: string, fromDate: string, toDate: string, eraseOriginals = false): Promise<CalendarConfigurationProposal> {
  const state = await loadCalendarRulesState()
  await verifyCSVOriginalDigests([state])
  const next = configuration(state), source = next.sources.find(row => row.id === sourceId)
  if (!source?.csv) fail('終了するCSV取込元を選んでください')
  if (source.csv.retiredAt) fail('この取込元は既に終了しています')
  source.csv.retiredAt = new Date().toISOString()
  if (eraseOriginals) {
    // Same effect as reaching the deadline now: originals and the CSV person ID go; facts stay as withdrawn history.
    for (const snapshot of source.csv.snapshots) for (const row of snapshot.rows) row.quote = null
    for (const head of source.csv.heads) { head.status = 'expired'; const fact = next.facts.find(item => item.id === head.factId && item.sourceId === source.id); if (fact) fact.validity = 'withdrawn' }
    source.csv.target.personRef = null; source.status = 'stale'
  }
  return prepareCalendarConfiguration(next, state.revision, fromDate, toDate)
}
/** Fingerprint is metadata only: only deliberately retained selected rows can be verified. */
export async function verifyCSVOriginalDigests(states: CalendarRulesState[]): Promise<void> {
  for (const state of states) {
    validateCalendarRulesState(state)
    for (const source of state.sources) {
      const csv = source.csv; if (!csv) continue
      if (csv.target.personRef !== null && `sha256:${await contentDigest(csv.target.personRef)}` !== csv.target.personRefHash) fail('本人識別子の匿名hashが一致しません')
      for (const snapshot of csv.snapshots) {
        if (await contentDigest(csvEvidenceBodyProjection(csv.format, snapshot.rows)) !== snapshot.bodyHash) fail('選択行の正規化hashが一致しません')
        for (const row of snapshot.rows) {
          if (await csvRecordValueDigest(row.recordId, row.recordRevision, row.value, csv.target) !== row.digest) fail('選択行の記録値と根拠hashが一致しません')
          const fact = row.factId ? state.facts.find(item => item.id === row.factId) : null, value = row.value
          if (row.factId && (!fact || fact.sourceId !== source.id || fact.contextId !== source.contextId || fact.revision !== row.recordRevision || (value.kind === 'calendar' ? !['open', 'closed'].includes(fact.kind) || !('date' in fact) || fact.date !== value.date || fact.kind !== value.status || !('calendarId' in fact) || fact.calendarId !== csv.target.calendarId : fact.kind !== 'roster_assignment' || fact.activityId !== csv.target.activityId || fact.externalId !== row.recordId || fact.personRef !== csv.target.personRefHash || fact.published !== true || fact.status !== value.status || fact.startAt !== value.startAt || fact.endAt !== value.endAt))) fail('選択行と保存した日程の事実が一致しません')
          if (value.kind === 'calendar' && value.status === 'withdrawn' ? row.factId !== null : row.factId === null) fail('撤回状態と事実参照が一致しません')
          if (row.quote === null) continue
          if (await csvUTF8Digest(row.quote) !== row.quoteSha256) fail('保持した選択行の引用hashが一致しません')
          // Compare the local values read from the quote with the stored evidence. The UTC instants stay as
          // resolved at import time (bound by row.digest), so a later tz-data update cannot fail backups.
          const parsed = await parseCalendarCSVImport(new TextEncoder().encode(calendarCSVHeaders[csv.format].join(',') + '\n' + row.quote), { kind: csv.format, timezone: csv.target.timezone, personRef: csv.target.personRef, fromDate: snapshot.fromDate, toDate: snapshot.toDate, verify: true })
          const retained = parsed.rows[0]
          // A retained quote is exactly one selected row: no extra, other-person or draft record may ride along.
          if (parsed.rows.length !== 1 || parsed.excludedDraft + parsed.excludedOtherPerson + parsed.excludedOutsidePeriod !== 0 || !retained || retained.recordId !== row.recordId || retained.revision !== row.recordRevision || retained.status !== value.status || (value.kind === 'calendar' ? retained.date !== value.date : `${retained.startDate}T${retained.startTime}` !== value.startLocal || `${retained.endDate}T${retained.endTime}` !== value.endLocal)) fail('保持した選択行とレコードの根拠が一致しません')
        }
      }
    }
  }
}
