import type { CalendarRule } from './calendar-resolver'

/** Only the verified original quote establishes the period. A model's expression
 * and calendar_ref are display hints and cannot choose a calendar or a trigger. */
export function verifiedRecurrenceTrigger(raw: string, time: string): CalendarRule['trigger'] {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('周期の原文と本人が選んだ時刻を確認してください')
  const text = raw.normalize('NFKC').trim()
  const unsupported = () => new Error('この周期の原文は安全に定義へ対応できません。原文を確認してルーティン補助へ本人の指示を入力してください')
  if (/または|もしくは|あるいは|以外|除く|除外|[日月火水木金土](?:曜(?:日)?)?\s*か\s*[日月火水木金土]|営業日\s*か|\b(?:or|either|except|excluding)\b|しない|不要|取り消|取消|撤回|隔週|隔月|毎日|毎年|\b(?:daily|yearly|fortnightly)\b/i.test(text)) throw unsupported()
  if (/営業日(?:の)?\s*(?:[+\-−]?\d+\s*日)?(?:前|後|以後|以降|以内|頃|ころ|ごろ)/.test(text)) throw unsupported()
  // A date-only task deadline cannot preserve a quoted clock deadline. Approximate
  // times, time ranges and unsupported clock spellings also require manual review.
  if (/(?:期限|締め?切り|締切).*(?:\d{1,2}時|\d{1,2}:\d{2})|(?:\d{1,2}時(?:\d{1,2}分)?|\d{1,2}:\d{2}).*(?:まで|期限|締め?切り|締切)|時半|(?:時|:\d{2})(?:頃|ころ|ごろ|くらい|前|後|以降)|\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b|\bat\s+\d/i.test(text)) throw unsupported()
  const clocks: string[] = [], consumed: { start: number; end: number }[] = []
  for (const match of text.matchAll(/(\d{1,2}):(\d{2})/g)) {
    const start = match.index!, end = start + match[0].length
    if (/\d/.test(text[start - 1] ?? '') || /[\d:]/.test(text[end] ?? '')) throw unsupported()
    clocks.push(`${match[1].padStart(2, '0')}:${match[2]}`); consumed.push({ start, end })
  }
  for (const match of text.matchAll(/(?:(午前|午後)\s*)?(\d{1,2})時(?:\s*(\d{1,2})分)?/g)) {
    const start = match.index!, end = start + match[0].length
    if (/\d/.test(text[start - 1] ?? '') || /[\d分秒半]/.test(text[end] ?? '')) throw unsupported()
    let hour = Number(match[2]); const minute = Number(match[3] ?? '0')
    if (match[1] && (hour < 1 || hour > 12)) throw unsupported()
    if (match[1] === '午後') hour = hour % 12 + 12
    if (match[1] === '午前') hour %= 12
    clocks.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`)
    consumed.push({ start, end })
  }
  let unconsumed = text
  for (const range of consumed.sort((a, b) => b.start - a.start)) unconsumed = unconsumed.slice(0, range.start) + ' '.repeat(range.end - range.start) + unconsumed.slice(range.end)
  if (/\d+\s*[:時分秒]|:\s*\d|[零〇一二三四五六七八九十]+時|午前|午後|\b(?:noon|midnight)\b|\d+\s*h(?:\d|\b)/i.test(unconsumed)) throw unsupported()
  if (clocks.length > 1 || clocks.some(clock => !/^([01]\d|2[0-3]):[0-5]\d$/.test(clock) || clock !== time)) throw new Error('原文に明示された時刻と本人の選択が一致しません。手動で確認してください')
  const patterns: CalendarRule['trigger'][] = []
  const compactWeekly = text.match(/毎週\s*([日月火水木金土](?:\s*[・、,と]\s*[日月火水木金土])+)(?:曜(?:日)?)/g)
  if (compactWeekly?.length === 1) {
    const list = compactWeekly[0].replace(/^毎週\s*/, '').replace(/曜(?:日)?$/, '')
    const weekdays = [...new Set(list.split(/\s*[・、,と]\s*/).map(day => '日月火水木金土'.indexOf(day)))].sort((a, b) => a - b)
    patterns.push({ kind: 'weekly', weekdays, time })
  }
  const japaneseWeekly = text.match(/毎週\s*((?:[日月火水木金土]曜(?:日)?(?:\s*[・、,と]\s*)?)+)/g)
  if (japaneseWeekly?.length === 1) {
    const weekdays = [...new Set([...japaneseWeekly[0].matchAll(/([日月火水木金土])曜/g)].map(match => '日月火水木金土'.indexOf(match[1])))].sort((a, b) => a - b)
    if (weekdays.length) patterns.push({ kind: 'weekly', weekdays, time })
  }
  const englishWeekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const englishWeekly = text.match(/\bevery\s+(?:(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)(?:\s*(?:,|and)\s*)?)+/gi)
  if (englishWeekly?.length === 1) {
    const weekdays = [...new Set([...englishWeekly[0].matchAll(/Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday/gi)].map(match => englishWeekdays.findIndex(day => day.toLowerCase() === match[0].toLowerCase())))].sort((a, b) => a - b)
    if (weekdays.length) patterns.push({ kind: 'weekly', weekdays, time })
  }
  const monthly = [...text.matchAll(/毎月(?:の)?\s*(?:(月初|月末)から\s*)?第\s*([1-9]\d?)\s*営業日/g)]
  if (monthly.length === 1) patterns.push({ kind: 'monthly_business', ordinal: Number(monthly[0][2]), from: monthly[0][1] === '月末' ? 'end' : 'start', time })
  const lastBusiness = text.match(/毎月(?:の)?\s*(?:最終|最後の)営業日/g)
  if (lastBusiness?.length === 1) patterns.push({ kind: 'monthly_business', ordinal: 1, from: 'end', time })
  const periodCount = [...text.matchAll(/毎週|毎月|\bevery\s+(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|week|month)/gi)].length
  if (patterns.some(pattern => pattern.kind === 'monthly_business') && [...text.matchAll(/第\s*\d+\s*営業日|(?:最終|最後の)営業日/g)].length !== 1) throw unsupported()
  if (periodCount !== 1 || patterns.length !== 1 || patterns[0].kind === 'monthly_business' && patterns[0].ordinal > 31) throw unsupported()
  return patterns[0]
}
