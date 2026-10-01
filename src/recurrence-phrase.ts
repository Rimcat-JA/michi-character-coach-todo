import { serializeRRule, type RRuleByDay, type RRuleSpec } from './rrule'

/** What a quoted phrase states about recurrence. Time zone, start, DST and unfinished-occurrence choices come from the owner's selection. */
export type RecurrencePattern =
  { kind: 'weekly'; weekdays: number[] } |
  { kind: 'monthly_business'; ordinal: number; from: 'start' | 'end' } |
  { kind: 'rrule'; rrule: string } |
  { kind: 'completion_relative'; afterDays: number }
export class RecurrencePhraseError extends Error {}
function fail(message: string): never { throw new RecurrencePhraseError(message) }

const W = '[日月火水木金土]', DAY_LIST = `${W}(?:曜(?:日)?)?(?:\\s*[・、,と]\\s*${W}(?:曜(?:日)?)?)*曜(?:日)?`
const ONCE = '(?:ごと|毎|に\\s*[1１一]\\s*(?:回|度))'
const MONTHS_UNIT = '(?:か月|ヶ月|カ月|ヵ月|ケ月)'
const MONTH_PREFIX = `(?:毎月|(\\d{1,2})\\s*${MONTHS_UNIT}\\s*${ONCE}(?:の|に)?|隔月(?:の|に|で)?)`
const ENGLISH_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const ENGLISH_DAY = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)'
const ENGLISH_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const ENGLISH_MONTH = `(?:${ENGLISH_MONTHS.join('|')})`
const ORDINAL_WORDS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, last: -1 }
// "月曜日" has the weekday only in its first character; the trailing 日 is not Sunday.
const weekdaysIn = (text: string) => [...new Set(text.split(/\s*[・、,と]\s*/).map(part => { const name = part.trim().replace(/曜(?:日)?$/, ''); if (name.length !== 1 || !'日月火水木金土'.includes(name)) fail('曜日の並びを確認してください'); return '日月火水木金土'.indexOf(name) }))].sort((a, b) => a - b)
const englishWeekdays = (text: string) => [...new Set([...text.toLowerCase().matchAll(new RegExp(ENGLISH_DAY, 'g'))].map(match => ENGLISH_DAYS.indexOf(match[0])))].sort((a, b) => a - b)
function rrule(spec: Partial<RRuleSpec> & Pick<RRuleSpec, 'freq'>): RecurrencePattern {
  return { kind: 'rrule', rrule: serializeRRule({ interval: 1, count: null, until: null, byDay: [], byMonthDay: [], byMonth: [], bySetPos: [], wkst: 1, ...spec }) }
}
function interval(raw: string | undefined, fallback: number, max: number) {
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > max) fail('繰り返しの間隔が範囲外です')
  return value
}
function monthDay(raw: string) { const value = Number(raw); if (!Number.isInteger(value) || value < 1 || value > 31) fail('月の日付は1〜31日です'); return value }
function yearlyDay(month: number, day: number) { if (month < 1 || month > 12 || day < 1 || day > [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]) fail('毎年の月日が存在しません'); return { byMonth: [month], byMonthDay: [day] } }
function ordinal(raw: string) { const value = Number(raw); if (!Number.isInteger(value) || value < 1 || value > 5) fail('月内の順位は第1〜第5です'); return value }
const byDays = (weekdays: number[], ordinals: (number | null)[]): RRuleByDay[] => weekdays.flatMap(weekday => ordinals.map(value => ({ weekday, ordinal: value })))

type Recognizer = { pattern: RegExp; build: (match: RegExpMatchArray, text: string) => RecurrencePattern }
const recognizers: Recognizer[] = [
  // Business-calendar ordinals use the person's selected business calendar, never national holidays.
  { pattern: /(?:毎月|月)(?:の)?\s*(?:(月初|月末|最初|最後)から\s*)?第\s*(\d{1,2})\s*(?:営業日|稼働日)/g, build: match => { const value = Number(match[2]); if (value < 1 || value > 31) fail('営業日順位が範囲外です'); return { kind: 'monthly_business', ordinal: value, from: match[1] === '月末' || match[1] === '最後' ? 'end' : 'start' } } },
  { pattern: /(?:毎月(?:の)?\s*)?(?:最終|最後の)(?:の)?\s*(?:営業日|稼働日)/g, build: () => ({ kind: 'monthly_business', ordinal: 1, from: 'end' }) },
  { pattern: /(?:前回(?:の)?)?完了(?:して(?:から)?|から|後|の)\s*(\d{1,4})\s*(日|週間|週)\s*(?:後|経ったら|たったら)?/g, build: match => ({ kind: 'completion_relative', afterDays: interval(match[1], 1, 3650) * (match[2] === '日' ? 1 : 7) }) },
  { pattern: new RegExp(`\\b(\\d{1,4})\\s+(days?|weeks?)\\s+after\\s+(?:the\\s+)?(?:last\\s+|previous\\s+)?(?:completion|(?:it\\s+is\\s+|I\\s+)?(?:complete|completed|finish|finished))\\b`, 'gi'), build: match => ({ kind: 'completion_relative', afterDays: interval(match[1], 1, 3650) * (match[2].toLowerCase().startsWith('day') ? 1 : 7) }) },
  { pattern: /毎年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, build: match => rrule({ freq: 'YEARLY', ...yearlyDay(Number(match[1]), Number(match[2])) }) },
  { pattern: new RegExp(`毎年\\s*(\\d{1,2})\\s*月\\s*(?:の)?\\s*第\\s*(\\d)\\s*(${W})曜(?:日)?`, 'g'), build: match => { const month = Number(match[1]); if (month < 1 || month > 12) fail('月が存在しません'); return rrule({ freq: 'YEARLY', byMonth: [month], byDay: byDays(weekdaysIn(match[3]), [ordinal(match[2])]) }) } },
  { pattern: new RegExp(`毎年\\s*(\\d{1,2})\\s*月\\s*(?:の)?\\s*(?:最終|最後の)\\s*(${W})曜(?:日)?`, 'g'), build: match => { const month = Number(match[1]); if (month < 1 || month > 12) fail('月が存在しません'); return rrule({ freq: 'YEARLY', byMonth: [month], byDay: byDays(weekdaysIn(match[2]), [-1]) }) } },
  { pattern: /毎年\s*(\d{1,2})\s*月\s*(?:の)?\s*(?:末日|末|最終日)/g, build: match => { const month = Number(match[1]); if (month < 1 || month > 12) fail('月が存在しません'); return rrule({ freq: 'YEARLY', byMonth: [month], byMonthDay: [-1] }) } },
  { pattern: new RegExp(`\\b(?:every\\s+year\\s+on|annually\\s+on|every)\\s+(${ENGLISH_MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'), build: match => rrule({ freq: 'YEARLY', ...yearlyDay(ENGLISH_MONTHS.indexOf(match[1].toLowerCase()) + 1, Number(match[2])) }) },
  { pattern: new RegExp(`${MONTH_PREFIX}\\s*(?:の)?\\s*(\\d{1,2}\\s*日(?:\\s*[・、,と]\\s*\\d{1,2}\\s*日)*)(?!\\s*(?:以降|以後|以内|前|後|ごと|毎|おき))`, 'g'), build: match => rrule({ freq: 'MONTHLY', interval: match[0].startsWith('隔月') ? 2 : interval(match[1], 1, 120), byMonthDay: [...match[2].matchAll(/\d{1,2}/g)].map(value => monthDay(value[0])) }) },
  { pattern: new RegExp(`${MONTH_PREFIX}\\s*(?:の)?\\s*(?:末日|末|最終日)|月末(?!\\s*から)(?!\\s*(?:の)?\\s*(?:第\\s*\\d+\\s*)?(?:営業日|稼働日))|月の最終日`, 'g'), build: match => rrule({ freq: 'MONTHLY', interval: match[0].startsWith('隔月') ? 2 : interval(match[1], 1, 120), byMonthDay: [-1] }) },
  { pattern: new RegExp(`(?:${MONTH_PREFIX}\\s*(?:の)?\\s*)?(第\\s*\\d(?:\\s*[・、,と]\\s*第?\\s*\\d)*)\\s*(${DAY_LIST})`, 'g'), build: match => rrule({ freq: 'MONTHLY', interval: match[0].startsWith('隔月') ? 2 : interval(match[1], 1, 120), byDay: byDays(weekdaysIn(match[3]), [...match[2].matchAll(/\d/g)].map(value => ordinal(value[0]))) }) },
  { pattern: new RegExp(`(?:${MONTH_PREFIX}\\s*(?:の)?\\s*)?(?:最終|最後の)\\s*(${DAY_LIST})`, 'g'), build: match => rrule({ freq: 'MONTHLY', interval: match[0].startsWith('隔月') ? 2 : interval(match[1], 1, 120), byDay: byDays(weekdaysIn(match[2]), [-1]) }) },
  { pattern: new RegExp(`(?:${MONTH_PREFIX}\\s*(?:の)?\\s*)?(最終|最後の|最初の|第\\s*1\\s*)平日`, 'g'), build: match => rrule({ freq: 'MONTHLY', interval: match[0].startsWith('隔月') ? 2 : interval(match[1], 1, 120), byDay: byDays([1, 2, 3, 4, 5], [null]), bySetPos: [/最終|最後/.test(match[2]) ? -1 : 1] }) },
  { pattern: new RegExp(`(?:隔月|(\\d{1,2})\\s*${MONTHS_UNIT}\\s*${ONCE})`, 'g'), build: match => rrule({ freq: 'MONTHLY', interval: match[0].startsWith('隔月') ? 2 : interval(match[1], 1, 120) }) },
  { pattern: /\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\s+of\s+(?:every|each)\s+month\b|\b(?:every\s+month|monthly)\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)\b/gi, build: match => rrule({ freq: 'MONTHLY', byMonthDay: [monthDay(match[1] ?? match[2])] }) },
  { pattern: /\b(?:on\s+)?the\s+last\s+day\s+of\s+(?:every|each)\s+month\b|\bevery\s+month[- ]end\b/gi, build: () => rrule({ freq: 'MONTHLY', byMonthDay: [-1] }) },
  { pattern: new RegExp(`\\b(?:on\\s+)?the\\s+(first|second|third|fourth|fifth|last)\\s+(${ENGLISH_DAY})\\s+of\\s+(?:every|each)\\s+month\\b|\\bevery\\s+(first|second|third|fourth|fifth|last)\\s+(${ENGLISH_DAY})\\b`, 'gi'), build: match => rrule({ freq: 'MONTHLY', byDay: byDays(englishWeekdays(match[2] ?? match[4]), [ORDINAL_WORDS[(match[1] ?? match[3]).toLowerCase()]]) }) },
  { pattern: new RegExp(`隔週\\s*(?:の)?\\s*(${DAY_LIST})?`, 'g'), build: match => rrule({ freq: 'WEEKLY', interval: 2, byDay: byDays(match[1] ? weekdaysIn(match[1]) : [], [null]) }) },
  { pattern: new RegExp(`(\\d{1,2})\\s*週(?:間)?\\s*${ONCE}\\s*(?:の|に)?\\s*(${DAY_LIST})?`, 'g'), build: match => rrule({ freq: 'WEEKLY', interval: interval(match[1], 1, 52), byDay: byDays(match[2] ? weekdaysIn(match[2]) : [], [null]) }) },
  { pattern: new RegExp(`\\b(?:every\\s+other\\s+week|biweekly|every\\s+(\\d{1,2})\\s+weeks)(?:\\s+on\\s+(${ENGLISH_DAY}(?:\\s*(?:,|and)\\s*${ENGLISH_DAY})*))?`, 'gi'), build: match => rrule({ freq: 'WEEKLY', interval: match[1] ? interval(match[1], 1, 52) : 2, byDay: byDays(match[2] ? englishWeekdays(match[2]) : [], [null]) }) },
  { pattern: new RegExp(`毎週\\s*(${DAY_LIST})`, 'g'), build: match => ({ kind: 'weekly', weekdays: weekdaysIn(match[1]) }) },
  // 毎月曜/毎日曜 mean "every Monday/Sunday", not monthly/daily.
  { pattern: new RegExp(`毎\\s*(${DAY_LIST})`, 'g'), build: match => ({ kind: 'weekly', weekdays: weekdaysIn(match[1]) }) },
  { pattern: new RegExp(`\\bevery\\s+(${ENGLISH_DAY}(?:\\s*(?:,|and)\\s*${ENGLISH_DAY})*)`, 'gi'), build: match => ({ kind: 'weekly', weekdays: englishWeekdays(match[1]) }) },
  { pattern: /毎日|\bevery\s+day\b|\bdaily\b/gi, build: () => rrule({ freq: 'DAILY' }) },
  { pattern: new RegExp(`(\\d{1,3})\\s*日\\s*${ONCE}|\\bevery\\s+(\\d{1,3})\\s+days\\b`, 'gi'), build: match => rrule({ freq: 'DAILY', interval: interval(match[1] ?? match[2], 1, 366) }) },
]
const leftoverPeriod = new RegExp([
  '毎日', '毎週', '毎月', '毎年', '隔週', '隔月', '月末', '末日', `第\\s*\\d+\\s*(?:${W}|営業日|稼働日|週|平日)`, `(?:最終|最後の)\\s*(?:${W}曜|平日|営業日|稼働日|日)`,
  `完了(?:して|から|後|の)\\s*\\d`, `\\d+\\s*(?:日|週間?|${MONTHS_UNIT}|年)\\s*(?:ごと|毎|おき|に\\s*[1１一]\\s*(?:回|度))`, `${W}曜`,
  '\\bevery\\b', '\\bdaily\\b', '\\bweekly\\b', '\\bmonthly\\b', '\\byearly\\b', '\\bannually\\b', '\\bbiweekly\\b', '\\bfortnight(?:ly)?\\b', `\\b${ENGLISH_DAY}\\b`,
].join('|'), 'i')

function clockOf(meridiem: string | undefined, hourText: string, minuteText: string | undefined) {
  let hour = Number(hourText); const minute = Number(minuteText ?? 0)
  // 午前12時/午後12時 is read both ways in Japanese usage, so it is refused rather than guessed.
  if (meridiem && (hour < 1 || hour > 11)) fail('締め切りの午前・午後の時刻を確認してください')
  if (meridiem?.startsWith('午前')) hour %= 12
  if (meridiem?.startsWith('午後')) hour = hour % 12 + 12
  if (hour > 23 || minute > 59) fail('締め切りの時刻が不正です')
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}
/** One explicit clock deadline (締め切りは17時 / 17:00まで). The clock is blanked in `rest` so it is not read as the series time. */
export function deadlineClock(raw: string): { time: string | null; rest: string } {
  const text = raw.normalize('NFKC'), found: { start: number; end: number; time: string }[] = []
  const clock = '((?:午前|午後)\\s*)?(\\d{1,2})(?::(\\d{2})|時(?:\\s*(\\d{1,2})分)?)(?![\\d分半間])'
  for (const pattern of [new RegExp(`(?:締め?切り|締切|期限)(?:は|を|:|時刻は|の時刻は|\\s)*(?:当日の?)?\\s*${clock}`, 'g'), new RegExp(`${clock}\\s*まで(?:に)?`, 'g')]) {
    for (const match of text.matchAll(pattern)) {
      const time = clockOf(match[1]?.trim(), match[2], match[3] ?? match[4]), offset = match[0].search(/\d|午前|午後/), start = match.index! + offset
      if (!found.some(item => start < item.end && item.start < match.index! + match[0].length)) found.push({ start, end: match.index! + match[0].length, time })
    }
  }
  if (new Set(found.map(item => item.time)).size > 1) fail('締め切り時刻を一つ指定してください')
  let rest = text
  for (const item of found) rest = rest.slice(0, item.start) + ' '.repeat(item.end - item.start) + rest.slice(item.end)
  return { time: found[0]?.time ?? null, rest }
}
/** Deterministic reading of one owner/quoted recurrence phrase. Anything alternative, excluded, approximate,
 * multi-period or partly unreadable is refused so the person sets it in the manual editor. */
export function groundRecurrencePhrase(raw: string): RecurrencePattern {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 4000) fail('周期の原文がありません')
  const text = raw.normalize('NFKC')
  if (/または|もしくは|あるいは|\bor\b|\beither\b|曜(?:日)?\s*か\s*[日月火水木金土]|営業日\s*か|日\s*か\s*\d|週\s*か\s*\d/i.test(text)) fail('周期の選択肢を一つに確認してください')
  if (/以外|除く|除外|\bexcept\b|\bexcluding\b|\bunless\b/i.test(text)) fail('周期の除外条件は手動設定で確認してください')
  if (/くらい|ぐらい|程度|ごろ|頃|前後|たまに|ときどき|時々|適当|なるべく|できれば|随時|適宜|気が向|\babout\b|\baround\b|\broughly\b|\bsometimes\b|\boccasionally\b|\bevery\s+few\b/i.test(text)) fail('おおよその周期は確定できません。具体的な周期を指定してください')
  if (/\d+\s*(?:日|週間?|か月|ヶ月|カ月|ヵ月|年)\s*おき/.test(text)) fail('「〜おき」は数え方が曖昧です。「〜ごと」で指定してください')
  if (/[一二三四五六七八九十]+\s*(?:日|週|か月|ヶ月|曜|営業日)/.test(text.replace(/[1１一]\s*(?:回|度)/g, ''))) fail('漢数字の周期は数字で指定してください')
  if (/完了/.test(text) && /\d+\s*(?:か月|ヶ月|カ月|ヵ月|年)\s*(?:後|経)/.test(text)) fail('完了からの間隔は日数か週数で指定してください')
  // Conditions, ranges and holiday shifts the grammar does not read would otherwise be dropped silently. The business-day
  // and weekday recognizers and full calendar dates (開始・終了日) are taken out first so they stay readable.
  const conditions = text.replace(/\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}-\d{2}-\d{2}/g, ' ').replace(/(?:月初|月末|最初|最後)から\s*第\s*\d+\s*(?:営業日|稼働日)|第\s*\d+\s*(?:営業日|稼働日)|(?:最終|最後の)(?:の)?\s*(?:営業日|稼働日|平日)|(?:最初の|第\s*1\s*)平日/g, ' ')
  if (/平日|土日|週末|祝|休日|休み|営業日|稼働日|の場合|場合は|翌週|前週|翌月|前月|あたり|辺り|付近|近く|(?<!\d)(?:(?!1\s*回)\d+|(?<!に\s*)1)\s*回(?!\s*(?:ごと|毎))|[〜～~]|\d\s*日\s*(?:から|まで)|月末\s*か|末日\s*か|日\s*か\s*(?:\d|月末|末日)|\bweekdays?\b|\bweekends?\b|\bholidays?\b|\bbusiness\s+days?\b|\btimes\b/i.test(conditions)) fail('周期の条件・範囲・振替は読み取れません。手動設定で確認してください')
  const matches: { start: number; end: number; pattern: RecurrencePattern }[] = []
  for (const recognizer of recognizers) for (const match of text.matchAll(recognizer.pattern)) if (match[0].trim()) matches.push({ start: match.index!, end: match.index! + match[0].length, pattern: recognizer.build(match, text) })
  matches.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
  const accepted: typeof matches = []
  for (const match of matches) if (!accepted.some(other => match.start < other.end && other.start < match.end)) accepted.push(match)
  for (const match of accepted) if (/^\s*(?:の)?\s*(?:[+\-−]?\d+\s*(?:日|週間?|時間|分)\s*(?:前|後)|前日|翌日|以後|以降|以内)/.test(text.slice(match.end)) || match.pattern.kind === 'completion_relative' && /^\s*(?:前|まえ)/.test(text.slice(match.end))) fail('周期からの追加日数・範囲は手動設定で確認してください')
  let rest = text
  for (const match of accepted) rest = rest.slice(0, match.start) + ' '.repeat(match.end - match.start) + rest.slice(match.end)
  if (leftoverPeriod.test(rest)) fail('周期表現の一部を読み取れません。手動設定で確認してください')
  const distinct = [...new Map(accepted.map(match => [JSON.stringify(match.pattern), match.pattern])).values()]
  if (distinct.length !== 1) fail(distinct.length ? '複数の周期を一つにまとめられません。使用する周期を一つ指定してください' : '明示された周期が見つかりません')
  const pattern = distinct[0]
  if (pattern.kind === 'weekly' && !pattern.weekdays.length) fail('毎週の曜日を指定してください')
  return pattern
}
