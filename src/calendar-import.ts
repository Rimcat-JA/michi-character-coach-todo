import { canonicalJSON, contentDigest } from './canonical'
import { addDays, validateDate } from './domain'
import { calendarDateAt, resolveLocalCalendarTime, type CalendarRulesState, type ICSComponentVersion, type ScheduleFact } from './calendar-resolver'
import { loadCalendarRulesState, prepareCalendarConfiguration, type CalendarConfigurationProposal, type CalendarRulesConfiguration } from './calendar-rules-save'
import { validateCalendarRulesState } from './calendar-rules-validation'

type ICSProperty = { name: string; params: Record<string, string>; value: string; line: number }
export type ICSTime = { kind: 'date' | 'utc' | 'zoned' | 'floating'; date: string; time: string | null; timezone: string; at: string; key: string }
export type ICSRecurrence = { frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY'; interval: number; count: number | null; until: ICSTime | null; weekdays: number[] | null; monthDays: number[] | null }
export type ICSComponent = {
  uid: string; recurrenceId: ICSTime | null; sequence: number; dtstamp: string; lastModified: string | null; title: string | null
  status: 'confirmed' | 'tentative' | 'cancelled'; start: ICSTime | null; end: ICSTime | null; durationSeconds: number | null; durationDays: number | null
  recurrence: ICSRecurrence | null; rdates: ICSTime[]; exdates: ICSTime[]; properties: { name: string; params: Record<string, string>; value: string }[]
}
export type ICSOccurrence = { uid: string; recurrenceId: string | null; title: string; status: 'scheduled' | 'cancelled'; startAt: string; endAt: string; timezone: string; allDay: boolean; componentKey: string }
export type ParsedCalendarImport = { originalText: string; name: string | null; components: ICSComponent[]; occurrences: ICSOccurrence[]; exclusions: { uid: string; recurrenceId: string }[]; warnings: string[]; fromDate: string; toDate: string; readOnly: true }
export type CalendarImportOptions = { timezone: string; fromDate: string; toDate: string; allowFloating?: boolean }
export type ICSImportTarget = { contextId: string; bindingId: string; calendarId: string; feedId: string; title: string; retentionUntil: string | null }
export type ICSImportPreview = {
  parsed: ParsedCalendarImport; next: CalendarRulesConfiguration; sourceId: string; noOp: boolean; added: number; updated: number; canceled: number; unchanged: number
  duplicates: { uid: string; recurrenceId: string | null; sourceId: string }[]; warnings: string[]
  changes: { before: Extract<ScheduleFact, { kind: 'external_event' }> | null; after: Extract<ScheduleFact, { kind: 'external_event' }> }[]
}
export type PreparedCalendarImport = { preview: ICSImportPreview; proposal: CalendarConfigurationProposal | null }
const dayNames: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000)
const componentKey = (uid: string, recurrenceId: string | null) => JSON.stringify([uid, recurrenceId])
function error(message: string, line?: number): never { throw new Error(`ICS${line ? ` ${line}行` : ''}: ${message}`) }
function timezone(value: string) { try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return value } catch { return error(`タイムゾーン ${value} は未対応です`) } }
function integer(value: string, max: number, name: string) { if (!/^(0|[1-9]\d*)$/.test(value) || Number(value) > max) error(`${name}の値が不正です`); return Number(value) }
function forbiddenControl(value: string) { return [...value].some(char => { const code = char.charCodeAt(0); return code === 127 || code < 32 && ![9, 10, 13].includes(code) }) }
function text(value: string, name: string, max = 300) {
  let decoded = ''
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char !== '\\') { decoded += char; continue }
    const escaped = value[++index]
    if (!escaped || !['\\', ',', ';', 'n', 'N'].includes(escaped)) error(`${name}のエスケープが不正です`)
    decoded += escaped === 'n' || escaped === 'N' ? '\n' : escaped
  }
  if (!decoded.trim() || decoded.length > max || forbiddenControl(decoded)) error(`${name}の文字・長さが不正です`)
  return decoded.normalize('NFC')
}
function splitHeader(value: string, separator: string) {
  const parts: string[] = []; let quote = false, start = 0
  for (let i = 0; i < value.length; i++) { if (value[i] === '"') quote = !quote; if (!quote && value[i] === separator) { parts.push(value.slice(start, i)); start = i + 1 } }
  if (quote) error('引用符が閉じていません'); parts.push(value.slice(start)); return parts
}
function properties(input: string): ICSProperty[] {
  if (typeof input !== 'string' || !input || new TextEncoder().encode(input).length > 1048576 || new TextDecoder().decode(new TextEncoder().encode(input)) !== input || input.includes('\ufffd') || forbiddenControl(input)) error('UTF-8の1MiB以内のICSファイルを選んでください')
  const rows = input.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n'); if (rows.some(row => row.includes('\r'))) error('改行が不正です')
  const unfolded: { value: string; line: number }[] = []
  rows.forEach((row, index) => { if (/^[ \t]/.test(row)) { if (!unfolded.length || !unfolded[unfolded.length - 1].value) error('折返し元の行がありません', index + 1); unfolded[unfolded.length - 1].value += row.slice(1) } else if (row) unfolded.push({ value: row, line: index + 1 }) })
  if (unfolded.length > 25000 || unfolded.some(row => row.value.length > 65536)) error('行数・1行の長さの上限を超えています')
  return unfolded.map(row => {
    let quote = false, separator = -1
    for (let index = 0; index < row.value.length; index++) { if (row.value[index] === '"') quote = !quote; if (!quote && row.value[index] === ':') { separator = index; break } }
    if (separator < 0) error('プロパティの区切りがありません', row.line)
    const header = splitHeader(row.value.slice(0, separator), ';'), name = header.shift()!.toUpperCase(), params: Record<string, string> = {}
    if (!/^[A-Z][A-Z0-9-]*$/.test(name)) error('プロパティ名が不正です', row.line)
    for (const parameter of header) {
      const at = parameter.indexOf('='), key = parameter.slice(0, at).toUpperCase(), raw = parameter.slice(at + 1)
      if (at < 1 || !/^[A-Z][A-Z0-9-]*$/.test(key) || Object.hasOwn(params, key) || !raw || raw.includes('^')) error('未対応・重複したパラメーターです', row.line)
      params[key] = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
    }
    return { name, params, value: row.value.slice(separator + 1), line: row.line }
  })
}
function assertParams(property: ICSProperty, allowed: string[]) { if (Object.keys(property.params).some(key => !allowed.includes(key))) error(`${property.name}のパラメーターは未対応です`, property.line) }
function dateValue(value: string): string {
  if (!/^\d{8}$/.test(value)) return error('日付はYYYYMMDDで指定してください')
  const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`; validateDate(date, 'ICS日付'); return date
}
function timeValue(property: ICSProperty, options: CalendarImportOptions): ICSTime {
  assertParams(property, ['VALUE', 'TZID'])
  const value = property.value, type = property.params.VALUE ?? 'DATE-TIME'
  if (type === 'DATE') {
    if (property.params.TZID) error('DATEにTZIDは指定できません', property.line)
    const date = dateValue(value), zone = timezone(options.timezone), resolved = resolveLocalCalendarTime(date, '00:00', zone)
    if (!resolved.at) error(resolved.reason!, property.line)
    return { kind: 'date', date, time: null, timezone: zone, at: resolved.at, key: `D:${date}` }
  }
  if (type !== 'DATE-TIME' || !/^\d{8}T\d{6}Z?$/.test(value)) error('DATE-TIMEの表現は未対応です', property.line)
  const date = dateValue(value.slice(0, 8)), time = `${value.slice(9, 11)}:${value.slice(11, 13)}`, seconds = Number(value.slice(13, 15))
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || seconds > 59) error('時刻・うるう秒は未対応です', property.line)
  if (value.endsWith('Z')) {
    if (property.params.TZID) error('UTC時刻にTZIDは指定できません', property.line)
    const at = `${date}T${time}:${String(seconds).padStart(2, '0')}.000Z`
    return { kind: 'utc', date, time: `${time}:${String(seconds).padStart(2, '0')}`, timezone: 'UTC', at, key: `T:${at}` }
  }
  const kind = property.params.TZID ? 'zoned' : 'floating'
  if (kind === 'floating' && !options.allowFloating) error('タイムゾーンのない時刻です。適用するタイムゾーンを本人が確認してください', property.line)
  const zone = timezone(property.params.TZID ?? options.timezone), resolved = resolveLocalCalendarTime(date, time, zone)
  if (!resolved.at) error(resolved.reason!, property.line)
  const at = new Date(Date.parse(resolved.at) + seconds * 1000).toISOString()
  return { kind, date, time: `${time}:${String(seconds).padStart(2, '0')}`, timezone: zone, at, key: `T:${at}` }
}
function shifted(time: ICSTime, date: string, options: CalendarImportOptions): ICSTime {
  const raw = date.replaceAll('-', '') + (time.kind === 'date' ? '' : `T${time.time!.replaceAll(':', '')}${time.kind === 'utc' ? 'Z' : ''}`)
  return timeValue({ name: 'DTSTART', value: raw, line: 0, params: time.kind === 'date' ? { VALUE: 'DATE' } : time.kind === 'zoned' ? { TZID: time.timezone } : {} }, { ...options, timezone: time.timezone, allowFloating: true })
}
function duration(value: string) {
  const match = /^(?:P(\d+)W|P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/.exec(value)
  if (!match || !match.slice(1).some(Boolean)) return error('DURATIONは正の週・日・時分秒のみ対応します')
  const days = Number(match[1] ?? 0) * 7 + Number(match[2] ?? 0), seconds = Number(match[3] ?? 0) * 3600 + Number(match[4] ?? 0) * 60 + Number(match[5] ?? 0)
  if (days * 86400 + seconds <= 0 || days * 86400 + seconds > 7 * 86400) error('予定の長さは7日以内にしてください')
  return { days, seconds }
}
function recurrence(property: ICSProperty, start: ICSTime, options: CalendarImportOptions): ICSRecurrence {
  assertParams(property, [])
  const parts: Record<string, string> = {}
  for (const pair of property.value.split(';')) { const [key, value, extra] = pair.split('='); if (!key || !value || extra || Object.hasOwn(parts, key) || !['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'WKST'].includes(key)) error('RRULEの指定は未対応・重複です', property.line); parts[key] = value }
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(parts.FREQ) || parts.COUNT && parts.UNTIL || parts.WKST && parts.WKST !== 'MO') error('このRRULEは未対応です。日・週・月の明示周期を確認してください', property.line)
  const frequency = parts.FREQ as ICSRecurrence['frequency'], interval = parts.INTERVAL ? integer(parts.INTERVAL, 1000, 'INTERVAL') : 1, count = parts.COUNT ? integer(parts.COUNT, 10000, 'COUNT') : null
  if (!interval || count === 0) error('INTERVAL/COUNTは1以上です', property.line)
  const weekdays = parts.BYDAY ? parts.BYDAY.split(',').map(value => { if (!Object.hasOwn(dayNames, value)) error('ordinal BYDAYは未対応です', property.line); return dayNames[value] }) : null
  const monthDays = parts.BYMONTHDAY ? parts.BYMONTHDAY.split(',').map(value => { if (!/^-?([1-9]|[12]\d|3[01])$/.test(value)) error('BYMONTHDAYが不正です', property.line); return Number(value) }) : null
  if (weekdays && (frequency !== 'WEEKLY' || new Set(weekdays).size !== weekdays.length) || monthDays && (frequency !== 'MONTHLY' || new Set(monthDays).size !== monthDays.length)) error('RRULEの組み合わせは未対応です', property.line)
  if (weekdays && !weekdays.includes(new Date(`${start.date}T12:00:00Z`).getUTCDay())) error('DTSTARTとBYDAYが一致していません', property.line)
  if (monthDays) { const last = new Date(`${start.date.slice(0, 7)}-01T12:00:00Z`); last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0); if (!monthDays.some(day => day > 0 ? day === Number(start.date.slice(8)) : last.getUTCDate() + day + 1 === Number(start.date.slice(8)))) error('DTSTARTとBYMONTHDAYが一致していません', property.line) }
  const until = parts.UNTIL ? timeValue({ name: 'UNTIL', value: parts.UNTIL, params: start.kind === 'date' ? { VALUE: 'DATE' } : {}, line: property.line }, options) : null
  if (until && (start.kind === 'date' ? until.kind !== 'date' : until.kind !== 'utc') || until && until.at < start.at) error('UNTILの型・順序を確認してください', property.line)
  return { frequency, interval, count, until, weekdays, monthDays }
}

function parseComponent(rows: ICSProperty[], options: CalendarImportOptions, method: string | null): ICSComponent {
  const allowed = new Set(['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'DURATION', 'SUMMARY', 'DESCRIPTION', 'LOCATION', 'STATUS', 'SEQUENCE', 'LAST-MODIFIED', 'CREATED', 'TRANSP', 'CLASS', 'URL', 'ORGANIZER', 'ATTENDEE', 'CATEGORIES', 'PRIORITY', 'RRULE', 'RDATE', 'EXDATE', 'RECURRENCE-ID'])
  for (const row of rows) if (!allowed.has(row.name)) error(`${row.name}は未対応です。内容を確認して取り込み直してください`, row.line)
  const one = (name: string) => { const found = rows.filter(row => row.name === name); if (found.length > 1) error(`${name}が重複しています`, found[1].line); return found[0] ?? null }
  const uid = one('UID'), stamp = one('DTSTAMP'), startRow = one('DTSTART'), endRow = one('DTEND'), durationRow = one('DURATION'), statusRow = one('STATUS'), ridRow = one('RECURRENCE-ID')
  if (!uid || !stamp) error('VEVENTにはUIDとDTSTAMPが必要です')
  assertParams(uid, []); assertParams(stamp, [])
  const dtstamp = timeValue(stamp, options); if (dtstamp.kind !== 'utc') error('DTSTAMPはUTC時刻です', stamp.line)
  const sequenceRow = one('SEQUENCE'), modifiedRow = one('LAST-MODIFIED'), titleRow = one('SUMMARY')
  if (sequenceRow) assertParams(sequenceRow, [])
  const sequence = sequenceRow ? integer(sequenceRow.value, 2147483647, 'SEQUENCE') : 0
  const lastModified = modifiedRow ? timeValue(modifiedRow, options) : null; if (lastModified && lastModified.kind !== 'utc') error('LAST-MODIFIEDはUTC時刻です', modifiedRow!.line)
  if (statusRow) assertParams(statusRow, [])
  if (statusRow && !['CONFIRMED', 'TENTATIVE', 'CANCELLED'].includes(statusRow.value)) error('STATUSが不正です', statusRow.line)
  const status = method === 'CANCEL' || statusRow?.value === 'CANCELLED' ? 'cancelled' : statusRow?.value === 'TENTATIVE' ? 'tentative' : 'confirmed'
  if (method === 'CANCEL' && statusRow && statusRow.value !== 'CANCELLED') error('METHOD:CANCELとSTATUSが矛盾しています')
  const start = startRow ? timeValue(startRow, options) : null, end = endRow ? timeValue(endRow, options) : null, recurrenceId = ridRow ? timeValue(ridRow, options) : null
  if (!start && status !== 'cancelled') error('取消以外のVEVENTにはDTSTARTが必要です')
  if (end && !start || endRow && durationRow) error('DTENDとDURATIONの組み合わせが不正です')
  if (end && start && (end.kind !== start.kind || end.timezone !== start.timezone || end.at <= start.at)) error('DTSTART/DTENDの型・timezone・順序を確認してください')
  let durationSeconds: number | null = null, durationDays: number | null = null
  if (end && start) { if (start.kind === 'date') durationDays = daysBetween(start.date, end.date); else durationSeconds = (Date.parse(end.at) - Date.parse(start.at)) / 1000 }
  if (durationRow) { assertParams(durationRow, []); const parsed = duration(durationRow.value); if (start?.kind === 'date' && parsed.seconds) error('終日予定のDURATIONに時分秒は指定できません'); durationDays = parsed.days; durationSeconds = parsed.seconds }
  if (start && !end && !durationRow) { if (start.kind === 'date') durationDays = 1; else if (status !== 'cancelled') error('終了時刻のない瞬間予定は未対応です。長さを推定しません') }
  if ((durationDays ?? 0) * 86400 + (durationSeconds ?? 0) > 7 * 86400) error('予定の長さは7日以内です')
  if (recurrenceId && start && (recurrenceId.kind === 'date') !== (start.kind === 'date')) error('RECURRENCE-IDとDTSTARTの値型が一致しません')
  const ruleRow = one('RRULE'), recurrenceRule = ruleRow && start ? recurrence(ruleRow, start, options) : null
  if (ruleRow && !start || recurrenceId && ruleRow) error('この繰り返し例外の指定は未対応です')
  const multiTimes = (name: string) => rows.filter(row => row.name === name).flatMap(row => row.value.split(',').map(value => timeValue({ ...row, value }, options)))
  const rdates = multiTimes('RDATE'), exdates = multiTimes('EXDATE')
  if ((rdates.length || exdates.length) && (!start || recurrenceId)) error('RDATE/EXDATEの対象が不明です')
  if ([...rdates, ...exdates].some(value => (value.kind === 'date') !== (start!.kind === 'date') || value.timezone !== start!.timezone)) error('RDATE/EXDATEの型・timezoneがDTSTARTと一致しません')
  if (new Set(rdates.map(row => row.key)).size !== rdates.length || new Set(exdates.map(row => row.key)).size !== exdates.length || rdates.length > 1000 || exdates.length > 1000) error('RDATE/EXDATEが重複・上限超過です')
  if (titleRow) assertParams(titleRow, ['LANGUAGE'])
  if (one('TRANSP') && one('TRANSP')!.value !== 'OPAQUE') error('透明予定は未対応です。時間容量へ誤反映しないため取込を保留します')
  for (const row of rows.filter(row => ['CREATED', 'DESCRIPTION', 'LOCATION', 'CLASS', 'URL', 'ORGANIZER', 'ATTENDEE', 'CATEGORIES', 'PRIORITY', 'TRANSP'].includes(row.name))) {
    if (['DESCRIPTION', 'LOCATION', 'CATEGORIES'].includes(row.name)) assertParams(row, ['LANGUAGE'])
    else if (row.name === 'ORGANIZER' || row.name === 'ATTENDEE') assertParams(row, ['CN', 'ROLE', 'PARTSTAT', 'RSVP', 'CUTYPE', 'SENT-BY', 'MEMBER', 'DELEGATED-TO', 'DELEGATED-FROM', 'LANGUAGE'])
    else assertParams(row, [])
  }
  for (const name of ['CREATED', 'DESCRIPTION', 'LOCATION', 'CLASS', 'URL', 'ORGANIZER', 'PRIORITY']) one(name)
  const created = one('CREATED'); if (created && timeValue(created, options).kind !== 'utc') error('CREATEDはUTC時刻です')
  const component: ICSComponent = { uid: text(uid.value, 'UID', 500), recurrenceId, sequence, dtstamp: dtstamp.at, lastModified: lastModified?.at ?? null, title: titleRow ? text(titleRow.value, 'SUMMARY') : null, status, start, end, durationSeconds, durationDays, recurrence: recurrenceRule, rdates, exdates, properties: rows.map(({ name, params, value }) => ({ name, params, value })).sort((a, b) => canonicalJSON(a) < canonicalJSON(b) ? -1 : canonicalJSON(a) > canonicalJSON(b) ? 1 : 0) }
  if (!component.title && status !== 'cancelled' && !recurrenceId) error('SUMMARYのない予定は名称確認が必要です')
  return component
}

async function rawDigest(value: string) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('') }
/** Verify still-retained originals before restoring a backup. Hashes are of literal UTF-8 bytes. */
export async function verifyCalendarOriginalDigests(states: CalendarRulesState[]): Promise<void> { for (const state of states) { validateCalendarRulesState(state); for (const source of state.sources) for (const snapshot of source.ics?.snapshots ?? []) if (snapshot.originalText !== null && await rawDigest(snapshot.originalText) !== snapshot.sha256) error('原本のSHA-256が一致しません') } }
async function stableId(prefix: string, value: unknown) { return `${prefix}:${(await contentDigest(value)).slice(0, 32)}` }
function configuration(state: CalendarRulesState): CalendarRulesConfiguration { const { contexts, bindings, calendars, activities, sources, facts, rules } = state; return structuredClone({ contexts, bindings, calendars, activities, sources, facts, rules }) }
type ExternalFact = Extract<ScheduleFact, { kind: 'external_event' }>

/** No DB writes: imported facts become events only through a later native generation approval. */
export async function prepareICSConfiguration(state: CalendarRulesState, target: ICSImportTarget, parsed: ParsedCalendarImport, at = new Date().toISOString()): Promise<ICSImportPreview> {
  validateCalendarRulesState(state)
  if (!target.feedId.trim() || target.feedId.length > 120 || !target.title.trim() || target.title.length > 300) error('取込元の固定名・資料名を指定してください')
  if (new Date(at).toISOString() !== at || target.retentionUntil !== null && (!Number.isFinite(Date.parse(target.retentionUntil)) || new Date(target.retentionUntil).toISOString() !== target.retentionUntil || target.retentionUntil <= at)) error('保持期限は未来のUTC日時を指定してください')
  const context = state.contexts.find(item => item.id === target.contextId), binding = state.bindings.find(item => item.id === target.bindingId), calendar = state.calendars.find(item => item.id === target.calendarId)
  if (!context || !binding || !calendar || binding.contextId !== context.id || calendar.contextId !== context.id || binding.personId !== state.ownerId || !binding.confirmed) error('本人に適用される対象・参加条件・カレンダーを確認してください')
  const validFrom = [context.validFrom, binding.validFrom, calendar.validFrom].sort().at(-1)!, validTo = [context.validTo, binding.validTo, calendar.validTo].sort()[0]
  if (parsed.fromDate < validFrom || parsed.toDate > validTo) error('取込期間が本人の適用期間を外れています')
  const next = configuration(state), sourceId = await stableId('ics-source', [state.ownerId, context.id, target.feedId]), previous = state.sources.find(item => item.id === sourceId)
  if (previous && (!previous.ics || previous.ics.feedId !== target.feedId)) error('取込元の識別子が衝突しています')
  const uidHashes = new Map<string, string>(); for (const component of parsed.components) if (!uidHashes.has(component.uid)) uidHashes.set(component.uid, `sha256:${await contentDigest(component.uid)}`)
  const hashUID = (uid: string) => uidHashes.get(uid)!
  const heads = new Map((previous?.ics?.components ?? []).map(item => [componentKey(item.uid, item.recurrenceId), item]))
  for (const component of parsed.components) { const head = { ...componentVersion(component, await contentDigest(component)), uid: hashUID(component.uid) }, prior = heads.get(componentKey(head.uid, head.recurrenceId)); if (prior) compareICSComponentVersions(head, prior); heads.set(componentKey(head.uid, head.recurrenceId), head) }
  const duplicates: ICSImportPreview['duplicates'] = []
  for (const component of parsed.components) for (const source of state.sources) if (source.id !== sourceId && source.contextId === context.id && source.ics?.components.some(item => item.uid === hashUID(component.uid))) duplicates.push({ uid: component.uid, recurrenceId: component.recurrenceId?.key ?? null, sourceId: source.id })
  const activityByUID = new Map<string, string>()
  for (const component of parsed.components) {
    if (activityByUID.has(component.uid)) continue
    const activityId = await stableId('ics-activity', [sourceId, hashUID(component.uid)]); activityByUID.set(component.uid, activityId)
    const existing = next.activities.find(item => item.id === activityId)
    if (existing && (existing.bindingId !== binding.id || existing.calendarId !== calendar.id || existing.weekdays.length || existing.contextId !== context.id)) error('同じ取込元の本人適用先が変わりました。既存予定の対応を確認してください')
    if (!existing && parsed.occurrences.some(item => item.uid === component.uid && item.status === 'scheduled')) next.activities.push({ id: activityId, contextId: context.id, bindingId: binding.id, calendarId: calendar.id, title: component.title ?? parsed.occurrences.find(item => item.uid === component.uid)!.title, eventKind: 'other', weekdays: [], startTime: '09:00', endTime: '10:00', endDayOffset: 0, validFrom, validTo, revision: 1 })
  }
  const bound = next.bindings.find(item => item.id === binding.id)!, newActivities = [...activityByUID.values()].filter(id => next.activities.some(item => item.id === id) && !bound.activityIds.includes(id))
  if (newActivities.length) { bound.activityIds.push(...newActivities); bound.revision++ }
  let added = 0, updated = 0, canceled = 0, unchanged = 0
  const changes: ICSImportPreview['changes'] = []
  const incomingKeys = new Set(parsed.components.map(item => componentKey(hashUID(item.uid), item.recurrenceId?.key ?? null)))
  const protectedExceptions = new Set<string>()
  for (const head of previous?.ics?.components ?? []) if (head.recurrenceId !== null && !incomingKeys.has(componentKey(head.uid, head.recurrenceId))) protectedExceptions.add(await stableId('ics-occurrence', [head.uid, head.recurrenceId]))
  const touched = new Set<string>()
  function saveFact(fact: ExternalFact) {
    const prior = next.facts.find(item => item.id === fact.id)
    if (prior && prior.kind !== 'external_event') error('予定識別子が衝突しています')
    if (prior && canonicalJSON({ ...prior, revision: 1 }) === canonicalJSON({ ...fact, revision: 1 })) { unchanged++; return }
    if (prior) { fact.revision = prior.revision + 1; next.facts = next.facts.filter(item => item.id !== fact.id); if (fact.status === 'cancelled' && prior.status !== 'cancelled') canceled++; else updated++ } else added++
    next.facts.push(fact); changes.push({ before: prior ? structuredClone(prior) : null, after: structuredClone(fact) })
  }
  for (const occurrence of parsed.occurrences) {
    const externalId = await stableId('ics-occurrence', [hashUID(occurrence.uid), occurrence.recurrenceId]), id = await stableId('ics-fact', [sourceId, hashUID(occurrence.uid), occurrence.recurrenceId]), activityId = activityByUID.get(occurrence.uid)!
    if (protectedExceptions.has(externalId) && !incomingKeys.has(componentKey(hashUID(occurrence.uid), occurrence.recurrenceId))) continue
    const prior = next.facts.find(item => item.id === id)
    const ownDate = calendarDateAt(occurrence.startAt, context.timezone)
    if (ownDate < validFrom || ownDate > validTo) error('例外予定が本人への適用期間を外れています')
    if (!next.activities.some(item => item.id === activityId)) { if (occurrence.status === 'cancelled' && !prior) continue; error('予定に対応する活動がありません') }
    touched.add(id)
    saveFact({ id, sourceId, contextId: context.id, activityId, externalId, revision: 1, validity: 'active', supersedes: [], kind: 'external_event', status: occurrence.status, startAt: occurrence.startAt, endAt: occurrence.endAt, timezone: occurrence.timezone, allDay: occurrence.allDay, title: occurrence.title })
  }
  const excludedIds = new Set<string>()
  for (const exclusion of parsed.exclusions) excludedIds.add(await stableId('ics-fact', [sourceId, hashUID(exclusion.uid), exclusion.recurrenceId]))
  const explicitCancels = new Set<string>(), canceledActivities = new Set<string>()
  for (const component of parsed.components.filter(item => item.status === 'cancelled')) {
    if (component.recurrenceId) explicitCancels.add(await stableId('ics-fact', [sourceId, hashUID(component.uid), component.recurrenceId.key]))
    else canceledActivities.add(activityByUID.get(component.uid)!)
  }
  const representedSeries = new Set(parsed.components.filter(item => item.recurrence && item.status !== 'cancelled').map(item => activityByUID.get(item.uid)!))
  for (const prior of [...next.facts].filter((item): item is ExternalFact => item.kind === 'external_event' && item.sourceId === sourceId && item.status !== 'cancelled')) {
    const date = calendarDateAt(prior.startAt, context.timezone), ruleExcludes = representedSeries.has(prior.activityId) && date >= parsed.fromDate && date <= parsed.toDate && !touched.has(prior.id) && !protectedExceptions.has(prior.externalId)
    if (explicitCancels.has(prior.id) || excludedIds.has(prior.id) || canceledActivities.has(prior.activityId) || ruleExcludes) saveFact({ ...prior, status: 'cancelled' })
  }
  const rawHash = await rawDigest(parsed.originalText), previousSnapshot = previous?.ics?.snapshots.at(-1), sameSnapshot = previousSnapshot?.sha256 === rawHash && previousSnapshot.fromDate === parsed.fromDate && previousSnapshot.toDate === parsed.toDate
  const metadataSame = previous?.title === target.title.trim() && previous?.status === 'current' && previous.ics?.retentionUntil === target.retentionUntil && canonicalJSON(previous.ics.components) === canonicalJSON([...heads.values()])
  const noOp = Boolean(sameSnapshot && metadataSame && !added && !updated && !canceled && !newActivities.length)
  if (!noOp) {
    if ((previous?.ics?.snapshots.length ?? 0) >= 20) error('この取込元は20版までです。保持期限を設定して原本を整理してから再取込してください')
    const revision = (previous?.revision ?? 0) + 1, dates = next.facts.filter((item): item is ExternalFact => item.kind === 'external_event' && item.sourceId === sourceId).map(item => calendarDateAt(item.startAt, context.timezone))
    const source = { id: sourceId, contextId: context.id, title: target.title.trim(), authorityScope: 'activity' as const, coverageFrom: [parsed.fromDate, previous?.coverageFrom ?? parsed.fromDate, ...dates].sort()[0], coverageTo: [parsed.toDate, previous?.coverageTo ?? parsed.toDate, ...dates].sort().at(-1)!, status: 'current' as const, revision, importedAt: at, bodyHash: rawHash, ics: { feedId: target.feedId, readOnly: true as const, retentionUntil: target.retentionUntil, snapshots: [...(previous?.ics?.snapshots ?? []), { revision, sha256: rawHash, originalText: parsed.originalText, importedAt: at, fromDate: parsed.fromDate, toDate: parsed.toDate }], components: [...heads.values()] } }
    next.sources = [...next.sources.filter(item => item.id !== sourceId), source]
  }
  validateCalendarRulesState({ ...state, ...next, revision: state.revision + (noOp ? 0 : 1) })
  return { parsed, next, sourceId, noOp, added, updated, canceled, unchanged, duplicates, changes, warnings: [...parsed.warnings, ...(duplicates.length ? ['他の取込元に同じUIDがあります。既存の取込元を選び、重複を解決してください'] : [])] }
}
export async function prepareCalendarICSImport(target: ICSImportTarget, input: string, options: Omit<CalendarImportOptions, 'timezone'>): Promise<PreparedCalendarImport> {
  const state = await loadCalendarRulesState(), context = state.contexts.find(item => item.id === target.contextId)
  if (!context) error('対象を選んでください')
  const parsed = parseCalendarImport(input, { ...options, timezone: context.timezone }), preview = await prepareICSConfiguration(state, target, parsed)
  return { preview, proposal: preview.noOp || preview.duplicates.length ? null : await prepareCalendarConfiguration(preview.next, state.revision, parsed.fromDate, parsed.toDate) }
}
/** SEQUENCE cannot regress. Equal versions with equal clocks and different content conflict. */
export function compareICSComponentVersions(next: ICSComponentVersion, previous: ICSComponentVersion): 'same' | 'newer' {
  if (next.uid !== previous.uid || next.recurrenceId !== previous.recurrenceId) error('版比較のUID/RECURRENCE-IDが一致しません')
  if (next.sequence < previous.sequence || next.dtstamp < previous.dtstamp || (next.lastModified ?? next.dtstamp) < (previous.lastModified ?? previous.dtstamp)) error('SEQUENCE・DTSTAMP・LAST-MODIFIEDが古い版です')
  const equal = next.sequence === previous.sequence && next.dtstamp === previous.dtstamp && (next.lastModified ?? next.dtstamp) === (previous.lastModified ?? previous.dtstamp)
  if (equal && next.digest !== previous.digest) error('同じ版・更新時刻で内容が矛盾しています')
  return equal ? 'same' : 'newer'
}
function componentVersion(component: ICSComponent, digest: string): ICSComponentVersion { return { uid: component.uid, recurrenceId: component.recurrenceId?.key ?? null, sequence: component.sequence, dtstamp: component.dtstamp, lastModified: component.lastModified, digest } }
function endAt(component: ICSComponent, start: ICSTime, options: CalendarImportOptions) {
  const nominal = component.durationDays ? shifted(start, addDays(start.date, component.durationDays), options).at : start.at
  const end = new Date(Date.parse(nominal) + (component.durationSeconds ?? 0) * 1000).toISOString()
  if (end <= start.at) error('終了時刻が不明です。予定の長さは推定しません')
  return end
}
function recurrenceStarts(component: ICSComponent, options: CalendarImportOptions) {
  const first = component.start!, rule = component.recurrence, result: ICSTime[] = [first]
  if (rule) {
    const stop = addDays(options.toDate, 2), dayCount = daysBetween(first.date, stop)
    if (dayCount > 10000) error('繰り返しの起点が27年以上前です。対象期間の具体的な予定を書き出してください')
    let count = 0
    const firstDay = new Date(`${first.date}T12:00:00Z`).getUTCDay(), firstMonday = addDays(first.date, -((firstDay + 6) % 7))
    result.length = 0
    for (let day = 0; day <= dayCount; day++) {
      const date = addDays(first.date, day), weekday = new Date(`${date}T12:00:00Z`).getUTCDay()
      let included = false
      if (rule.frequency === 'DAILY') included = day % rule.interval === 0
      if (rule.frequency === 'WEEKLY') included = Math.floor(daysBetween(firstMonday, date) / 7) % rule.interval === 0 && (rule.weekdays ?? [firstDay]).includes(weekday)
      if (rule.frequency === 'MONTHLY') {
        const months = (Number(date.slice(0, 4)) - Number(first.date.slice(0, 4))) * 12 + Number(date.slice(5, 7)) - Number(first.date.slice(5, 7)), last = new Date(`${date.slice(0, 7)}-01T12:00:00Z`)
        last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0)
        included = months % rule.interval === 0 && (rule.monthDays ?? [Number(first.date.slice(8))]).some(day => (day > 0 ? day : last.getUTCDate() + day + 1) === Number(date.slice(8)))
      }
      if (!included) continue
      const value = shifted(first, date, options)
      if (rule.until && value.at > rule.until.at || rule.count !== null && count >= rule.count) break
      result.push(value); count++
      if (result.length > 10000) error('繰り返しの展開上限を超えています')
    }
  }
  result.push(...component.rdates)
  return [...new Map(result.map(value => [value.key, value])).values()]
}
export function parseCalendarImport(input: string, options: CalendarImportOptions): ParsedCalendarImport {
  timezone(options.timezone); validateDate(options.fromDate, '取込開始日'); validateDate(options.toDate, '取込終了日')
  if (daysBetween(options.fromDate, options.toDate) < 0 || daysBetween(options.fromDate, options.toDate) > 366) error('取込期間は順序の正しい367日以内です')
  const rows = properties(input), header: ICSProperty[] = [], componentRows: ICSProperty[][] = []; let inCalendar = false, ended = false, current: ICSProperty[] | null = null
  for (const row of rows) {
    if (row.name === 'BEGIN' || row.name === 'END') {
      assertParams(row, [])
      if (row.name === 'BEGIN' && row.value === 'VCALENDAR' && !inCalendar && !ended) { inCalendar = true; continue }
      if (row.name === 'END' && row.value === 'VCALENDAR' && inCalendar && !current) { inCalendar = false; ended = true; continue }
      if (row.name === 'BEGIN' && row.value === 'VEVENT' && inCalendar && !current) { current = []; continue }
      if (row.name === 'END' && row.value === 'VEVENT' && current) { componentRows.push(current); current = null; continue }
      error(`${row.value}の入れ子・componentは未対応です。VTIMEZONE/VALARM/添付を自動解釈しません`, row.line)
    }
    if (!inCalendar || ended) error('VCALENDAR外の内容があります', row.line)
    if (current) current.push(row); else header.push(row)
  }
  if (!ended || current || inCalendar || componentRows.length > 1000) error('VCALENDARが未完了、またはVEVENTの上限1000件を超えています')
  const headerOne = (name: string) => { const found = header.filter(row => row.name === name); if (found.length > 1) error(`${name}が重複しています`); return found[0] ?? null }
  for (const row of header) { if (!['VERSION', 'PRODID', 'CALSCALE', 'METHOD', 'X-WR-CALNAME', 'X-WR-TIMEZONE'].includes(row.name)) error(`${row.name}のカレンダー指定は未対応です`, row.line); assertParams(row, []) }
  if (headerOne('VERSION')?.value !== '2.0' || !headerOne('PRODID')) error('VERSION:2.0とPRODIDが必要です')
  if (headerOne('CALSCALE') && headerOne('CALSCALE')!.value !== 'GREGORIAN') error('非グレゴリオ暦は未対応です')
  const method = headerOne('METHOD')?.value ?? null
  if (method !== null && !['PUBLISH', 'CANCEL'].includes(method)) error('会議依頼・返信の自動処理は未対応です。PUBLISHの予定を書き出してください')
  if (headerOne('X-WR-TIMEZONE')) timezone(headerOne('X-WR-TIMEZONE')!.value)
  const selected = new Map<string, ICSComponent>(), warnings: string[] = []
  for (const component of componentRows.map(rows => parseComponent(rows, options, method))) {
    const key = componentKey(component.uid, component.recurrenceId?.key ?? null), previous = selected.get(key)
    if (previous) {
      const nextVersion = componentVersion(component, canonicalJSON(component)), priorVersion = componentVersion(previous, canonicalJSON(previous))
      if (nextVersion.sequence < priorVersion.sequence || nextVersion.sequence === priorVersion.sequence && nextVersion.dtstamp < priorVersion.dtstamp) { compareICSComponentVersions(priorVersion, nextVersion); warnings.push('同一UID/RECURRENCE-IDの古い版は採録しません'); continue }
      if (compareICSComponentVersions(nextVersion, priorVersion) === 'same') continue
      warnings.push('同一UID/RECURRENCE-IDは確認できた新しい版だけを採録します')
    }
    selected.set(key, component)
  }
  const components = [...selected.values()], occurrences: ICSOccurrence[] = [], exclusions: ParsedCalendarImport['exclusions'] = []
  const included = (at: string) => { const date = calendarDateAt(at, options.timezone); return date >= options.fromDate && date <= options.toDate }
  const add = (component: ICSComponent, start: ICSTime, rid: string | null, title: string | null, detached = false) => {
    if (!included(start.at) && !detached) return
    if (!title) error('例外予定の名称が不明です。元の予定を一緒に取り込んでください')
    occurrences.push({ uid: component.uid, recurrenceId: rid, title: component.status === 'tentative' ? `${title}（未確定）` : title, status: component.status === 'cancelled' ? 'cancelled' : 'scheduled', startAt: start.at, endAt: endAt(component, start, options), timezone: start.timezone, allDay: start.kind === 'date', componentKey: componentKey(component.uid, component.recurrenceId?.key ?? null) })
  }
  for (const master of components.filter(component => !component.recurrenceId)) {
    if (!master.start || master.status === 'cancelled') continue
    const recurring = Boolean(master.recurrence || master.rdates.length), overrides = components.filter(component => component.uid === master.uid && component.recurrenceId)
    for (const exclusion of master.exdates) exclusions.push({ uid: master.uid, recurrenceId: exclusion.key })
    for (const start of recurrenceStarts(master, options)) {
      const exception = overrides.find(component => component.recurrenceId!.key === start.key)
      if (master.exdates.some(excluded => excluded.key === start.key)) { if (exception?.status !== 'cancelled' && exception) error('EXDATEと変更例外が矛盾しています'); continue }
      if (exception) continue
      add(master, start, recurring ? start.key : null, master.title)
    }
  }
  for (const exception of components.filter(component => component.recurrenceId)) {
    const master = components.find(component => component.uid === exception.uid && !component.recurrenceId)
    if (master?.start && (master.start.kind === 'date') !== (exception.recurrenceId!.kind === 'date')) error('元系列とRECURRENCE-IDの型が一致しません')
    if (master?.status === 'cancelled' && exception.status !== 'cancelled') error('系列全体の取消と有効な例外が矛盾しています')
    if (exception.start && (exception.durationSeconds !== null || exception.durationDays !== null)) add(exception, exception.start, exception.recurrenceId!.key, exception.title ?? master?.title ?? null, true)
    else if (exception.status !== 'cancelled') error('例外の終了時刻が不明です')
  }
  if (occurrences.length > 1000) error('今回の発生回は1000件までです。期間を短くしてください')
  if (components.some(component => component.start?.kind === 'floating')) warnings.push(`タイムゾーンのない日時に本人選択の ${options.timezone} を適用します`)
  warnings.push('通常回は選択期間内に開始する予定を採録します。繰り返しの変更例外は期間外への移動も保持します。欠落を取消と判断せず、手動ファイルを最新の自動同期とは表示しません')
  return { originalText: input, name: headerOne('X-WR-CALNAME') ? text(headerOne('X-WR-CALNAME')!.value, 'カレンダー名') : null, components, occurrences: occurrences.sort((a, b) => a.startAt.localeCompare(b.startAt)), exclusions, warnings: [...new Set(warnings)], fromDate: options.fromDate, toDate: options.toDate, readOnly: true }
}
