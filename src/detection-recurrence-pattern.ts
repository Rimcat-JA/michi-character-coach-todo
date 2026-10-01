import { defaultUnfinishedPolicy, type CalendarRule, type RecurrenceUnfinishedPolicy } from './calendar-resolver'
import { deadlineClock, groundRecurrencePhrase } from './recurrence-phrase'
import type { AmbiguousTimePolicy, NonexistentTimePolicy } from './zoned-time'

/** Owner selections that a quote can never supply: the series start, a clock deadline the person chose, DST and unfinished-occurrence handling. */
export type VerifiedRecurrenceOptions = { startDate?: string; dueTime?: string | null; nonexistentTime?: NonexistentTimePolicy; ambiguousTime?: AmbiguousTimePolicy; unfinishedPolicy?: RecurrenceUnfinishedPolicy }

/** Only the verified original quote establishes the period. A model's expression
 * and calendar_ref are display hints and cannot choose a calendar or a trigger. */
export function verifiedRecurrenceTrigger(raw: string, time: string, options: VerifiedRecurrenceOptions = {}): CalendarRule['trigger'] {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('周期の原文と本人が選んだ時刻を確認してください')
  const original = raw.normalize('NFKC').trim()
  const unsupported = () => new Error('この周期の原文は安全に定義へ対応できません。原文を確認してルーティン補助へ本人の指示を入力してください')
  if (/しない|不要|取り消|取消|撤回/.test(original)) throw unsupported()
  // A quoted clock deadline is kept only as the clock the owner selected for the step deadline; otherwise it needs manual review.
  let deadline: ReturnType<typeof deadlineClock>
  try { deadline = deadlineClock(original) } catch { throw unsupported() }
  if (deadline.time !== null && deadline.time !== (options.dueTime ?? null)) throw unsupported()
  const text = deadline.rest
  // Approximate times, time ranges and unsupported clock spellings also require manual review.
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
  let pattern: ReturnType<typeof groundRecurrencePhrase>
  try { pattern = groundRecurrencePhrase(unconsumed) } catch { throw unsupported() }
  if (pattern.kind === 'weekly') return { kind: 'weekly', weekdays: pattern.weekdays, time }
  if (pattern.kind === 'monthly_business') return { kind: 'monthly_business', ordinal: pattern.ordinal, from: pattern.from, time }
  if (!options.startDate) throw new Error('この周期には本人が選ぶ開始日が必要です')
  if (pattern.kind === 'rrule') return { kind: 'rrule', dtstart: `${options.startDate}T${time}`, rrule: pattern.rrule, rdates: [], exdates: [], nonexistentTime: options.nonexistentTime ?? 'skip', ambiguousTime: options.ambiguousTime ?? 'earlier' }
  return { kind: 'completion_relative', firstDate: options.startDate, time, afterDays: pattern.afterDays, unfinishedPolicy: options.unfinishedPolicy ?? defaultUnfinishedPolicy }
}
