import { resolveZonedLocalTime, validClock, validLocalDateTime, type AmbiguousTimePolicy, type NonexistentTimePolicy } from './zoned-time'

/** RFC 5545 RRULE subset: FREQ DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT xor UNTIL, BYDAY (with ordinals),
 * BYMONTHDAY (negative from month end), BYMONTH, BYSETPOS and WKST. Expansion works on local wall date-times. */
export type RRuleFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
export type RRuleByDay = { weekday: number; ordinal: number | null }
export type RRuleSpec = { freq: RRuleFrequency; interval: number; count: number | null; until: string | null; byDay: RRuleByDay[]; byMonthDay: number[]; byMonth: number[]; bySetPos: number[]; wkst: number }
export type RRuleExpansion = { occurrences: string[]; truncated: boolean }
export const rruleWeekdayCodes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
export const rruleSeriesLimit = 1000
const frequencies: RRuleFrequency[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']
const supportedKeys = ['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'WKST']

function fail(message: string): never { throw new Error(message) }
function integer(raw: string, low: number, high: number, name: string) {
  if (!/^[+-]?\d{1,5}$/.test(raw)) fail(`RRULEの${name}は整数です`)
  const value = Number(raw)
  if (value < low || value > high || value === 0 && low < 0) fail(`RRULEの${name}が範囲外です`)
  return value
}
function untilValid(value: string) {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value)
  if (!match) return false
  const date = `${match[1]}-${match[2]}-${match[3]}`
  if (new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) return false
  return match[4] === undefined || Number(match[4]) < 24 && Number(match[5]) < 60 && Number(match[6]) < 60
}
const mondayFirst = (weekday: number) => (weekday + 6) % 7
export function parseRRule(text: string): RRuleSpec {
  if (typeof text !== 'string' || !text.trim() || text.length > 500) fail('RRULEを指定してください')
  const parts = new Map<string, string>()
  for (const pair of text.trim().replace(/^RRULE:/i, '').split(';')) {
    const match = /^([A-Za-z]+)=([^=;]+)$/.exec(pair)
    if (!match) fail('RRULEの形式が不正です')
    const key = match[1].toUpperCase()
    if (parts.has(key)) fail(`RRULEの${key}が重複しています`)
    if (!supportedKeys.includes(key)) fail(`RRULEの${key}は未対応です`)
    parts.set(key, match[2].toUpperCase())
  }
  const freq = parts.get('FREQ') as RRuleFrequency | undefined
  if (!freq || !frequencies.includes(freq)) fail('FREQはDAILY・WEEKLY・MONTHLY・YEARLYのいずれかです')
  const list = <T>(key: string, parse: (raw: string) => T): T[] => parts.has(key) ? parts.get(key)!.split(',').map(parse) : []
  const interval = parts.has('INTERVAL') ? integer(parts.get('INTERVAL')!, 1, 1000, 'INTERVAL') : 1
  const count = parts.has('COUNT') ? integer(parts.get('COUNT')!, 1, 10000, 'COUNT') : null
  const until = parts.get('UNTIL') ?? null
  if (count !== null && until !== null) fail('COUNTとUNTILは同時に指定できません')
  if (until !== null && !untilValid(until)) fail('UNTILの日付・日時が不正です')
  const byMonth = list('BYMONTH', raw => integer(raw, 1, 12, 'BYMONTH'))
  const byMonthDay = list('BYMONTHDAY', raw => integer(raw, -31, 31, 'BYMONTHDAY'))
  const bySetPos = list('BYSETPOS', raw => integer(raw, -366, 366, 'BYSETPOS'))
  const byDay = list('BYDAY', raw => {
    const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(raw)
    if (!match) fail('RRULEのBYDAYが不正です')
    const ordinal = match[1] === undefined ? null : Number(match[1])
    if (ordinal !== null && (ordinal === 0 || Math.abs(ordinal) > 53)) fail('BYDAYの順位が範囲外です')
    return { weekday: rruleWeekdayCodes.indexOf(match[2] as typeof rruleWeekdayCodes[number]), ordinal }
  })
  const wkst = parts.has('WKST') ? rruleWeekdayCodes.indexOf(parts.get('WKST') as typeof rruleWeekdayCodes[number]) : 1
  if (wkst < 0) fail('RRULEのWKSTが不正です')
  for (const [name, values] of [['BYMONTH', byMonth], ['BYMONTHDAY', byMonthDay], ['BYSETPOS', bySetPos], ['BYDAY', byDay.map(day => `${day.ordinal}:${day.weekday}`)]] as const) if (new Set<unknown>(values).size !== values.length) fail(`RRULEの${name}が重複しています`)
  if (byDay.some(day => day.ordinal !== null) && freq !== 'MONTHLY' && freq !== 'YEARLY') fail('順位付きBYDAYはMONTHLY・YEARLYだけで使えます')
  if (byDay.some(day => day.ordinal !== null && Math.abs(day.ordinal) > 5) && (freq === 'MONTHLY' || byMonth.length)) fail('月内のBYDAY順位は1〜5です')
  if (byMonthDay.length && freq === 'WEEKLY') fail('BYMONTHDAYはWEEKLYと組み合わせられません')
  if (bySetPos.length && !byDay.length && !byMonthDay.length && !byMonth.length) fail('BYSETPOSは他のBY指定と組み合わせてください')
  return { freq, interval, count, until, byDay: byDay.sort((a, b) => mondayFirst(a.weekday) - mondayFirst(b.weekday) || (a.ordinal ?? 0) - (b.ordinal ?? 0)), byMonthDay: byMonthDay.sort((a, b) => a - b), byMonth: byMonth.sort((a, b) => a - b), bySetPos: bySetPos.sort((a, b) => a - b), wkst }
}
export function serializeRRule(spec: RRuleSpec): string {
  const parts = [`FREQ=${spec.freq}`]
  if (spec.interval !== 1) parts.push(`INTERVAL=${spec.interval}`)
  if (spec.count !== null) parts.push(`COUNT=${spec.count}`)
  if (spec.until !== null) parts.push(`UNTIL=${spec.until}`)
  if (spec.byMonth.length) parts.push(`BYMONTH=${spec.byMonth.join(',')}`)
  if (spec.byMonthDay.length) parts.push(`BYMONTHDAY=${spec.byMonthDay.join(',')}`)
  if (spec.byDay.length) parts.push(`BYDAY=${spec.byDay.map(day => `${day.ordinal ?? ''}${rruleWeekdayCodes[day.weekday]}`).join(',')}`)
  if (spec.bySetPos.length) parts.push(`BYSETPOS=${spec.bySetPos.join(',')}`)
  if (spec.wkst !== 1) parts.push(`WKST=${rruleWeekdayCodes[spec.wkst]}`)
  return parts.join(';')
}
/** One stored spelling per rule, so equal rules compare equal and model/grammar candidates can be matched exactly. */
export const canonicalRRule = (text: string) => serializeRRule(parseRRule(text))

const dayNumber = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86400000
const dateOf = (day: number) => new Date(day * 86400000).toISOString().slice(0, 10)
const weekdayOf = (day: number) => ((day + 4) % 7 + 7) % 7
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()
const monthStart = (year: number, month: number) => Date.UTC(year, month - 1, 1) / 86400000
function nthWeekdays(first: number, last: number, entry: RRuleByDay): number[] {
  const all: number[] = []
  for (let day = first + ((entry.weekday - weekdayOf(first)) % 7 + 7) % 7; day <= last; day += 7) all.push(day)
  if (entry.ordinal === null) return all
  const chosen = entry.ordinal > 0 ? all[entry.ordinal - 1] : all[all.length + entry.ordinal]
  return chosen === undefined ? [] : [chosen]
}
const expandByDay = (first: number, last: number, byDay: RRuleByDay[]) => byDay.flatMap(entry => nthWeekdays(first, last, entry))
const limitByDay = (days: number[], first: number, last: number, byDay: RRuleByDay[]) => { const allowed = new Set(expandByDay(first, last, byDay)); return days.filter(day => allowed.has(day)) }
function monthDays(year: number, month: number, byMonthDay: number[]) {
  const count = daysIn(year, month), start = monthStart(year, month)
  return byMonthDay.map(value => value > 0 ? value : count + value + 1).filter(value => value >= 1 && value <= count).map(value => start + value - 1)
}
function candidates(spec: RRuleSpec, start: { day: number; year: number; month: number; date: number; weekday: number }, period: number): { first: number; days: number[] } {
  const unique = (days: number[]) => [...new Set(days)].sort((a, b) => a - b)
  const inMonths = (days: number[]) => spec.byMonth.length ? days.filter(day => spec.byMonth.includes(Number(dateOf(day).slice(5, 7)))) : days
  if (spec.freq === 'DAILY') {
    const day = start.day + period * spec.interval
    let days = inMonths([day])
    if (spec.byMonthDay.length) { const date = dateOf(day), year = Number(date.slice(0, 4)), month = Number(date.slice(5, 7)); days = days.filter(value => monthDays(year, month, spec.byMonthDay).includes(value)) }
    if (spec.byDay.length) days = days.filter(value => spec.byDay.some(entry => entry.weekday === weekdayOf(value)))
    return { first: day, days }
  }
  if (spec.freq === 'WEEKLY') {
    const first = start.day - ((start.weekday - spec.wkst) % 7 + 7) % 7 + period * spec.interval * 7
    const week = Array.from({ length: 7 }, (_, index) => first + index)
    return { first, days: inMonths(week.filter(day => spec.byDay.length ? spec.byDay.some(entry => entry.weekday === weekdayOf(day)) : weekdayOf(day) === start.weekday)) }
  }
  if (spec.freq === 'MONTHLY') {
    const index = start.year * 12 + start.month - 1 + period * spec.interval, year = Math.floor(index / 12), month = index % 12 + 1
    const first = monthStart(year, month), last = first + daysIn(year, month) - 1
    if (spec.byMonth.length && !spec.byMonth.includes(month)) return { first, days: [] }
    let days: number[]
    if (spec.byMonthDay.length) { days = monthDays(year, month, spec.byMonthDay); if (spec.byDay.length) days = limitByDay(days, first, last, spec.byDay) }
    else if (spec.byDay.length) days = expandByDay(first, last, spec.byDay)
    else days = start.date <= daysIn(year, month) ? [first + start.date - 1] : []
    return { first, days: unique(days) }
  }
  const year = start.year + period * spec.interval, first = monthStart(year, 1), last = monthStart(year + 1, 1) - 1
  let days: number[] = []
  if (spec.byMonth.length) {
    for (const month of spec.byMonth) {
      const monthFirst = monthStart(year, month), monthLast = monthFirst + daysIn(year, month) - 1
      if (spec.byMonthDay.length) { let values = monthDays(year, month, spec.byMonthDay); if (spec.byDay.length) values = limitByDay(values, monthFirst, monthLast, spec.byDay); days.push(...values) }
      else if (spec.byDay.length) days.push(...expandByDay(monthFirst, monthLast, spec.byDay))
      else if (start.date <= daysIn(year, month)) days.push(monthFirst + start.date - 1)
    }
  } else if (spec.byMonthDay.length) {
    for (let month = 1; month <= 12; month++) days.push(...monthDays(year, month, spec.byMonthDay))
    if (spec.byDay.length) days = limitByDay(days, first, last, spec.byDay)
  } else if (spec.byDay.length) days = expandByDay(first, last, spec.byDay)
  else if (start.date <= daysIn(year, start.month)) days = [monthStart(year, start.month) + start.date - 1]
  return { first, days: unique(days) }
}
function setPositions(days: number[], positions: number[]) {
  if (!positions.length) return days
  return [...new Set(positions.map(position => position > 0 ? days[position - 1] : days[days.length + position]).filter((day): day is number => day !== undefined))].sort((a, b) => a - b)
}
export type RRuleDSTPolicy = { nonexistent: NonexistentTimePolicy; ambiguous: AmbiguousTimePolicy }
function untilLimit(until: string | null, timezone: string | undefined, dst: RRuleDSTPolicy): (local: string) => boolean {
  if (until === null) return () => true
  const date = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`
  if (until.length === 8) return local => local.slice(0, 10) <= date
  const clock = `${until.slice(9, 11)}:${until.slice(11, 13)}`
  if (!until.endsWith('Z')) return local => local <= `${date}T${clock}`
  if (!timezone) fail('UTCのUNTILを使うにはタイムゾーンが必要です')
  const limit = Date.parse(`${date}T${clock}:${until.slice(13, 15)}.000Z`)
  // UNTIL bounds the instant the occurrence is actually placed at; a skipped gap time creates nothing, so it does not end the series.
  return local => { const resolved = resolveZonedLocalTime(local.slice(0, 10), local.slice(11), timezone, dst); return resolved.at === null ? true : Date.parse(resolved.at) <= limit }
}
function validLocalList(values: string[], name: string) {
  if (!Array.isArray(values) || values.length > 1000 || values.some(value => !validLocalDateTime(value)) || new Set(values).size !== values.length) fail(`${name}は重複のない現地日時（YYYY-MM-DDTHH:mm）1000件以内です`)
}
/** Lists local occurrences whose date lies in [from, to]. COUNT counts RRULE instances from DTSTART before EXDATE removal (RFC 5545 3.8.5.1).
 * DTSTART itself is an occurrence only when it matches the rule; RDATE adds and EXDATE removes exact local date-times. */
export function expandRRule(input: { dtstart: string; rrule: string | RRuleSpec; rdates?: string[]; exdates?: string[]; from: string; to: string; timezone?: string; limit?: number; dst?: RRuleDSTPolicy }): RRuleExpansion {
  if (!validLocalDateTime(input.dtstart)) fail('DTSTARTは現地日時（YYYY-MM-DDTHH:mm）で指定してください')
  for (const value of [input.from, input.to]) if (!validLocalDateTime(`${value}T00:00`)) fail('展開期間の日付が不正です')
  if (input.from > input.to) fail('展開期間の順序が不正です')
  const rdates = input.rdates ?? [], exdates = input.exdates ?? [], limit = input.limit ?? rruleSeriesLimit
  validLocalList(rdates, 'RDATE'); validLocalList(exdates, 'EXDATE')
  const spec = typeof input.rrule === 'string' ? parseRRule(input.rrule) : parseRRule(serializeRRule(input.rrule))
  const time = input.dtstart.slice(11), startDay = dayNumber(input.dtstart.slice(0, 10)), fromDay = dayNumber(input.from), toDay = dayNumber(input.to)
  const start = { day: startDay, year: Number(input.dtstart.slice(0, 4)), month: Number(input.dtstart.slice(5, 7)), date: Number(input.dtstart.slice(8, 10)), weekday: weekdayOf(startDay) }
  const withinUntil = untilLimit(spec.until, input.timezone, input.dst ?? { nonexistent: 'next_valid', ambiguous: 'earlier' }), found = new Set<string>()
  let period = 0, emitted = 0
  if (spec.count === null && fromDay > startDay) {
    // Without COUNT nothing before the window affects it, so jump to the period just before `from`.
    const span = spec.freq === 'DAILY' ? fromDay - startDay : spec.freq === 'WEEKLY' ? Math.floor((fromDay - (startDay - ((start.weekday - spec.wkst) % 7 + 7) % 7)) / 7) : spec.freq === 'MONTHLY' ? (Number(input.from.slice(0, 4)) - start.year) * 12 + Number(input.from.slice(5, 7)) - start.month : Number(input.from.slice(0, 4)) - start.year
    period = Math.max(0, Math.floor(span / spec.interval) - 1)
  }
  for (let guard = 0; ; guard++, period++) {
    if (guard > 200000) fail('RRULEの展開が長すぎます。期間や条件を確認してください')
    const current = candidates(spec, start, period)
    if (current.first > toDay) break
    let stop = false
    for (const day of setPositions(current.days, spec.bySetPos)) {
      if (day < startDay) continue
      const local = `${dateOf(day)}T${time}`
      if (!withinUntil(local)) { stop = true; break }
      emitted++
      if (day >= fromDay && day <= toDay) found.add(local)
      if (spec.count !== null && emitted >= spec.count) { stop = true; break }
    }
    if (stop) break
  }
  for (const value of rdates) if (value.slice(0, 10) >= input.from && value.slice(0, 10) <= input.to) found.add(value)
  for (const value of exdates) found.delete(value)
  const occurrences = [...found].sort()
  return { occurrences: occurrences.slice(0, limit), truncated: occurrences.length > limit }
}

const japaneseWeekdays = ['日', '月', '火', '水', '木', '金', '土']
function ordinalLabel(ordinal: number) { return ordinal === -1 ? '最終' : ordinal < 0 ? `最後から${-ordinal}番目の` : `第${ordinal}` }
function monthDayLabel(value: number) { return value === -1 ? '月末' : value < 0 ? `月末の${-value - 1}日前` : `${value}日` }
/** Owner-facing summary in Japanese; the stored RRULE text stays the authority. */
export function describeRRule(text: string, dtstart?: string): string {
  const spec = parseRRule(text), every = spec.interval === 1
  // YEARLY without BYMONTH expands BYMONTHDAY in every month and counts BYDAY ordinals within the whole year (RFC 5545).
  const yearWide = spec.freq === 'YEARLY' && !spec.byMonth.length
  const head = spec.freq === 'DAILY' ? every ? '毎日' : `${spec.interval}日ごと` : spec.freq === 'WEEKLY' ? every ? '毎週' : `${spec.interval}週ごと` : spec.freq === 'MONTHLY' ? every ? '毎月' : `${spec.interval}か月ごと` : every ? '毎年' : `${spec.interval}年ごと`
  const weekdays = [1, 2, 3, 4, 5]
  const workdays = spec.byDay.length === 5 && spec.byDay.every(day => day.ordinal === null && weekdays.includes(day.weekday))
  const singleWorkday = workdays && spec.bySetPos.length === 1 ? spec.bySetPos[0] : null
  const days = singleWorkday !== null ? singleWorkday === -1 ? '最終平日' : singleWorkday > 0 ? `第${singleWorkday}平日` : `最後から${-singleWorkday}番目の平日` : spec.byDay.map(day => `${day.ordinal === null ? '' : `${yearWide ? '年内の' : ''}${ordinalLabel(day.ordinal)}`}${japaneseWeekdays[day.weekday]}曜`).join('・')
  const positions = `${spec.bySetPos.length && singleWorkday === null ? `（候補の${spec.bySetPos.map(value => value === -1 ? '最後' : value < 0 ? `最後から${-value}番目` : `${value}番目`).join('・')}）` : ''}${spec.freq === 'YEARLY' && spec.bySetPos.length && spec.byMonth.length !== 1 ? '（年内の候補全体で）' : ''}`
  const months = spec.byMonth.map(month => `${month}月`).join('・')
  const end = spec.count !== null ? ` / ${spec.count}回まで` : spec.until !== null ? ` / ${spec.until.slice(0, 4)}-${spec.until.slice(4, 6)}-${spec.until.slice(6, 8)}まで` : ''
  const implicit = !spec.byDay.length && !spec.byMonthDay.length && dtstart ? spec.freq === 'WEEKLY' ? `${japaneseWeekdays[weekdayOf(dayNumber(dtstart.slice(0, 10)))]}曜` : spec.freq === 'MONTHLY' ? `${Number(dtstart.slice(8, 10))}日` : spec.freq === 'YEARLY' ? `${spec.byMonth.length ? '' : `${Number(dtstart.slice(5, 7))}月`}${Number(dtstart.slice(8, 10))}日` : '' : ''
  return `${head}${months ? ` ${months}` : ''}${spec.byMonthDay.length ? ` ${yearWide ? '各月 ' : ''}${spec.byMonthDay.map(monthDayLabel).join('・')}` : ''}${days ? ` ${days}` : ''}${positions}${implicit ? ` ${implicit}` : ''}${dtstart && validClock(dtstart.slice(11)) ? ` ${dtstart.slice(11)}` : ''}${end}`
}
