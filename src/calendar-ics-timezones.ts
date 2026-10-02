import { validateDate } from './domain'
import { resolveWindowsTimezone } from './windows-timezones'

export type ICSProperty = { name: string; params: Record<string, string>; value: string; line: number }
type Transition = { at: number; from: number; to: number }
type ZoneDefinition = { zone: string; observances: ICSProperty[][] }
function fail(message: string): never { throw new Error(`ICS: ${message}`) }
export function knownCalendarTimezone(value: string) {
  const zone = resolveWindowsTimezone(value)
  try { return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone }
  catch { return fail(`タイムゾーン ${value} は未対応です`) }
}
/** Only well-formed, bounded known components are removed; their text remains in the original digest. */
export function separateICSAuxiliary(rows: ICSProperty[]) {
  const output: ICSProperty[] = [], definitions: ZoneDefinition[] = [], warnings: string[] = [], stack: string[] = []
  let zoneRows: ICSProperty[] = [], observances: ICSProperty[][] = [], observation: ICSProperty[] = []
  for (const row of rows) {
    if (row.name === 'BEGIN') {
      if (Object.keys(row.params).length) fail('componentのパラメーターは未対応です')
      const parent = stack.at(-1)
      if (!(row.value === 'VCALENDAR' && !parent || row.value === 'VEVENT' && parent === 'VCALENDAR' || row.value === 'VTIMEZONE' && parent === 'VCALENDAR' || ['STANDARD', 'DAYLIGHT'].includes(row.value) && parent === 'VTIMEZONE' || row.value === 'VALARM' && parent === 'VEVENT')) fail(`${row.value}のcomponent・入れ子は未対応です`)
      stack.push(row.value)
      if (row.value === 'VTIMEZONE') { zoneRows = []; observances = [] }
      else if (row.value === 'STANDARD' || row.value === 'DAYLIGHT') observation = []
      else if (row.value === 'VALARM') warnings.push('アラームは取り込みません')
      else output.push(row)
    } else if (row.name === 'END') {
      if (Object.keys(row.params).length || stack.pop() !== row.value) fail('componentが閉じていません')
      if (row.value === 'STANDARD' || row.value === 'DAYLIGHT') { observances.push(observation); if (observances.length > 50) fail('VTIMEZONEの定義が多すぎます') }
      else if (row.value === 'VTIMEZONE') {
        if (zoneRows.some(prop => !['TZID', 'LAST-MODIFIED', 'TZURL'].includes(prop.name) || Object.keys(prop.params).length)) fail('VTIMEZONEの指定は未対応です')
        const ids = zoneRows.filter(prop => prop.name === 'TZID')
        if (ids.length !== 1 || !observances.length) fail('VTIMEZONEにはTZIDとSTANDARD/DAYLIGHTが必要です')
        const zone = knownCalendarTimezone(ids[0].value)
        if (definitions.some(def => def.zone === zone) || definitions.length >= 100) fail('VTIMEZONEが重複・上限超過です')
        definitions.push({ zone, observances })
      } else if (row.value !== 'VALARM') output.push(row)
    } else if (stack.at(-1) === 'VTIMEZONE') zoneRows.push(row)
    else if (['STANDARD', 'DAYLIGHT'].includes(stack.at(-1) ?? '')) observation.push(row)
    else if (stack.at(-1) !== 'VALARM') output.push(row)
  }
  if (stack.length) fail('componentが未完了です')
  if (rows.some(row => row.params.TZID && resolveWindowsTimezone(row.params.TZID) !== row.params.TZID || row.name === 'TZID' && resolveWindowsTimezone(row.value) !== row.value)) warnings.push('Windowsのタイムゾーン名はCLDR 48の既定地域で対応付けました')
  return { rows: output, definitions, warnings }
}
function offset(value: string) {
  if (!/^[+-]\d{4}(?:\d{2})?$/.test(value)) fail('TZOFFSETは±HHMM（SS）で指定してください')
  const hour = Number(value.slice(1, 3)), minute = Number(value.slice(3, 5)), second = Number(value.slice(5) || 0)
  if (hour > 23 || minute > 59 || second > 59 || value === '-0000' || value === '-000000') fail('TZOFFSETの値が不正です')
  return (hour * 3600 + minute * 60 + second) * (value[0] === '-' ? -1 : 1)
}
function localMilliseconds(value: string) {
  if (!/^\d{8}T\d{6}$/.test(value)) fail('VTIMEZONEの日時はローカルYYYYMMDDTHHMMSSです')
  const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
  validateDate(date, 'VTIMEZONEの日付')
  const time = `${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}`
  if (!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) fail('VTIMEZONEの時刻が不正です')
  return Date.parse(`${date}T${time}.000Z`)
}
function intlOffset(zone: string, at: number) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  const part = (name: string) => parts.find(row => row.type === name)!.value
  return (Date.parse(`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`) - Math.floor(at / 1000) * 1000) / 1000
}
function transitions(rows: ICSProperty[], lastYear: number): Transition[] {
  if (rows.some(row => !['DTSTART', 'TZOFFSETFROM', 'TZOFFSETTO', 'TZNAME', 'RRULE', 'RDATE'].includes(row.name) || Object.keys(row.params).some(key => row.name !== 'TZNAME' || key !== 'LANGUAGE'))) fail('STANDARD/DAYLIGHTの指定は未対応です')
  const one = (name: string) => { const found = rows.filter(row => row.name === name); if (found.length !== 1) fail(`${name}は一つ必要です`); return found[0].value }
  const start = one('DTSTART'), from = offset(one('TZOFFSETFROM')), to = offset(one('TZOFFSETTO')), first = localMilliseconds(start)
  const times = [first, ...rows.filter(row => row.name === 'RDATE').flatMap(row => row.value.split(',').map(localMilliseconds))]
  const rules = rows.filter(row => row.name === 'RRULE')
  if (rules.length > 1) fail('VTIMEZONEのRRULEが重複しています')
  if (rules.length) {
    const rule: Record<string, string> = {}
    for (const pair of rules[0].value.split(';')) {
      const [key, value, extra] = pair.split('=')
      if (!key || !value || extra || Object.hasOwn(rule, key) || !['FREQ', 'BYMONTH', 'BYDAY', 'BYMONTHDAY', 'UNTIL', 'INTERVAL'].includes(key)) fail('VTIMEZONEのRRULEは未対応です')
      rule[key] = value
    }
    const month = Number(rule.BYMONTH), weekday = /^(-?[1-5])(SU|MO|TU|WE|TH|FR|SA)$/.exec(rule.BYDAY ?? '')
    if (rule.FREQ !== 'YEARLY' || rule.INTERVAL && rule.INTERVAL !== '1' || !Number.isInteger(month) || month < 1 || month > 12 || Boolean(rule.BYDAY) === Boolean(rule.BYMONTHDAY) || rule.BYDAY && !weekday || rule.BYMONTHDAY && !/^-?([1-9]|[12]\d|3[01])$/.test(rule.BYMONTHDAY)) fail('VTIMEZONEは年周期の月・序数曜日または月日だけ対応します')
    const until = rule.UNTIL ? /^\d{8}T\d{6}Z$/.test(rule.UNTIL) ? localMilliseconds(rule.UNTIL.slice(0, -1)) : fail('VTIMEZONEのUNTILはUTCです') : Infinity
    const firstYear = Number(start.slice(0, 4))
    if (lastYear - firstYear > 500) fail('VTIMEZONEの検証期間が長すぎます')
    for (let year = firstYear; year <= lastYear; year++) {
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
      let day = Number(rule.BYMONTHDAY)
      if (weekday) {
        const ordinal = Number(weekday[1]), wanted = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'].indexOf(weekday[2])
        day = ordinal > 0 ? 1 + (wanted - new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 7) % 7 + (ordinal - 1) * 7 : lastDay - (new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay() - wanted + 7) % 7 + (ordinal + 1) * 7
      } else if (day < 0) day = lastDay + day + 1
      if (day < 1 || day > lastDay) continue
      const at = Date.UTC(year, month - 1, day) + first % 86400000
      if (at >= first && at - from * 1000 <= until) times.push(at)
    }
  }
  if (times.length > 25000) fail('VTIMEZONEの展開上限を超えています')
  return [...new Set(times)].map(at => ({ at: at - from * 1000, from, to }))
}
export function verifyICSTimezones(definitions: ZoneDefinition[], references: { timezone: string; at: string }[], lastYear: number) {
  for (const definition of definitions) {
    const timeline = definition.observances.flatMap(rows => transitions(rows, lastYear)).sort((a, b) => a.at - b.at)
    for (let index = 1; index < timeline.length; index++) if (timeline[index].at === timeline[index - 1].at && timeline[index].to !== timeline[index - 1].to) fail('VTIMEZONEの切替が矛盾しています')
    for (const reference of references.filter(row => knownCalendarTimezone(row.timezone) === definition.zone)) {
      const at = Date.parse(reference.at), transition = timeline.findLast(row => row.at <= at)
      if (!transition || intlOffset(definition.zone, at) !== transition.to) fail(`VTIMEZONE ${definition.zone} のTZOFFSETTOが参照日時のIntlと一致しません`)
    }
  }
}
