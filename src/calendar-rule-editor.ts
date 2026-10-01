import { addDays, emptyScore, validateScore, type ScoreInput } from './domain'
import type { CalendarRule, CalendarRuleStep, CalendarRuleTrigger, RecurrenceUnfinishedPolicy, RRuleCalendarTrigger } from './calendar-resolver'
import { canonicalRRule, describeRRule, expandRRule, parseRRule, serializeRRule, type RRuleByDay, type RRuleFrequency } from './rrule'

export function calendarRuleEditorDefinition(rule: CalendarRule) {
  return structuredClone(rule.editions?.at(-1)?.definition ?? { title: rule.title, enabled: rule.enabled, trigger: rule.trigger, steps: rule.steps })
}

/** A blank formula display is unchanged; clearing a displayed manual value is explicit. */
export function calendarRuleEditorScore(previous: ScoreInput | null | undefined, pointText: string): ScoreInput {
  const score = structuredClone(previous ?? emptyScore()), points = pointText.trim()
  if (points === '') {
    if (score.mode === 'manual') { score.mode = 'unset'; score.manualPoints = null }
    return score
  }
  const manualPoints = Number(points)
  const next = { ...score, mode: 'manual' as const, manualPoints }
  validateScore(next)
  return next
}

export function calendarRuleEditorSteps(rule: CalendarRule | undefined, first: Omit<CalendarRuleStep, 'key' | 'score'>, pointText: string): CalendarRuleStep[] {
  const previous = rule ? calendarRuleEditorDefinition(rule).steps : []
  const { dueTime, ...rest } = first
  const edited: CalendarRuleStep = { ...rest, key: previous[0]?.key ?? 'main', score: first.kind === 'task' ? calendarRuleEditorScore(previous[0]?.score, pointText) : null, ...(dueTime ? { dueTime } : {}) }
  return [edited, ...previous.slice(1)]
}

const weekdayLabels = ['日', '月', '火', '水', '木', '金', '土']
export const unfinishedPolicyLabels: Record<RecurrenceUnfinishedPolicy, string> = { keep_all: '未完了の回をすべて残す', keep_latest: '新しい回が始まったら未着手の古い回を取消', generate_after_completion: '完了するまで次の回を作らない' }
export function describeCalendarTrigger(trigger: CalendarRuleTrigger): string {
  if (trigger.kind === 'weekly') return `毎週${trigger.weekdays.map(day => weekdayLabels[day]).join('・')}曜 ${trigger.time}`
  if (trigger.kind === 'monthly_business') return `毎月の${trigger.from === 'start' ? '最初' : '最後'}から第${trigger.ordinal}営業日 ${trigger.time}`
  if (trigger.kind === 'activity_relative') return `活動の${trigger.edge === 'start' ? '開始' : '終了'}から ${trigger.offsetDays}日 ${trigger.offsetMinutes}分`
  if (trigger.kind === 'rrule') return `${describeRRule(trigger.rrule, trigger.dtstart)}（開始 ${trigger.dtstart.replace('T', ' ')}${trigger.exdates.length ? ` / 除外${trigger.exdates.length}件` : ''}${trigger.rdates.length ? ` / 追加${trigger.rdates.length}件` : ''} / 夏時間：${trigger.nonexistentTime === 'skip' ? 'ない時刻の回は作らない' : 'ない時刻は切替前の時差で作る'}・二度ある時刻は${trigger.ambiguousTime === 'earlier' ? '前' : '後'}）`
  return `前回の完了から${trigger.afterDays}日後 ${trigger.time}（最初 ${trigger.firstDate} / ${unfinishedPolicyLabels[trigger.unfinishedPolicy]}）`
}

/** Form values of the RRULE editor; month end is its own preset, distinct from day 31 (which skips short months). */
export type RRuleForm = { freq: RRuleFrequency; interval: string; monthMode: 'dtstart' | 'monthdays' | 'month_end' | 'weekdays' | 'last_workday'; weekdays: number[]; ordinals: string; monthDays: string; months: number[]; setPos: string; end: 'none' | 'count' | 'until'; count: string; until: string }
export const emptyRRuleForm = (): RRuleForm => ({ freq: 'WEEKLY', interval: '1', monthMode: 'dtstart', weekdays: [1], ordinals: '', monthDays: '', months: [], setPos: '', end: 'none', count: '10', until: '' })
const numbers = (text: string) => text.split(/[,、\s]+/).map(value => value.trim()).filter(Boolean).map(value => { if (!/^[+-]?\d+$/.test(value)) throw new Error('数値をカンマ区切りで入力してください'); return Number(value) })
export function rruleFromForm(form: RRuleForm): string {
  const interval = Number(form.interval)
  const ordinals = numbers(form.ordinals)
  let byDay: RRuleByDay[] = [], byMonthDay: number[] = [], bySetPos: number[] = numbers(form.setPos)
  const monthly = form.freq === 'MONTHLY' || form.freq === 'YEARLY'
  if (form.freq === 'WEEKLY' || form.freq === 'DAILY' && form.monthMode === 'weekdays') byDay = form.weekdays.map(weekday => ({ weekday, ordinal: null }))
  if (monthly && form.monthMode === 'weekdays') byDay = form.weekdays.flatMap((weekday): RRuleByDay[] => ordinals.length ? ordinals.map(ordinal => ({ weekday, ordinal })) : [{ weekday, ordinal: null }])
  if (monthly && form.monthMode === 'monthdays') byMonthDay = numbers(form.monthDays)
  if (monthly && form.monthMode === 'month_end') byMonthDay = [-1]
  // BYSETPOS applies to the whole yearly set, so several months would leave only the last weekday of the last month.
  if (form.freq === 'YEARLY' && form.monthMode === 'last_workday' && form.months.length !== 1) throw new Error('年ごとの最終平日は対象の月を1つだけ選んでください。複数の月で毎月の最終平日にするには「月ごと」と対象の月を選んでください')
  if (monthly && form.monthMode === 'last_workday') { byDay = [1, 2, 3, 4, 5].map(weekday => ({ weekday, ordinal: null })); bySetPos = [-1] }
  const until = form.end === 'until' ? form.until.replaceAll('-', '') : null
  return canonicalRRule(serializeRRule({ freq: form.freq, interval, count: form.end === 'count' ? Number(form.count) : null, until, byDay, byMonthDay, byMonth: monthly || form.freq === 'DAILY' ? form.months : [], bySetPos, wkst: 1 }))
}
/** Changing the frequency or the month-day mode clears a BYSETPOS chosen for the old structure. */
export const rruleFormStructure = (form: RRuleForm, patch: Partial<Pick<RRuleForm, 'freq' | 'monthMode'>>): RRuleForm => ({ ...form, ...patch, setPos: '' })
/** Hints for choices whose RFC 5545 meaning differs from what the labels suggest; saved rules are never rewritten. */
export function rruleFormNotes(form: RRuleForm): string[] {
  if (form.freq !== 'YEARLY') return []
  const notes: string[] = []
  if (!form.months.length && (form.monthMode === 'monthdays' || form.monthMode === 'month_end')) notes.push('対象の月が空欄のため毎月作られます。年1回にするには対象の月を選んでください')
  if (!form.months.length && form.monthMode === 'weekdays' && form.ordinals.trim()) notes.push('対象の月が空欄のため、第何は年内の順位として数えます')
  if (form.monthMode === 'last_workday') notes.push('年ごとの最終平日は選んだ1つの月の最終平日です。複数の月で毎月にするには「月ごと」を選んでください')
  return notes
}
export function rruleForm(text: string): RRuleForm {
  const spec = parseRRule(text), base = emptyRRuleForm()
  const lastWorkday = spec.bySetPos.length === 1 && spec.bySetPos[0] === -1 && spec.byDay.length === 5 && spec.byDay.every(day => day.ordinal === null && day.weekday >= 1 && day.weekday <= 5)
  return { ...base, freq: spec.freq, interval: String(spec.interval), monthMode: lastWorkday ? 'last_workday' : spec.byMonthDay.length === 1 && spec.byMonthDay[0] === -1 ? 'month_end' : spec.byMonthDay.length ? 'monthdays' : spec.byDay.length ? 'weekdays' : 'dtstart', weekdays: [...new Set(spec.byDay.map(day => day.weekday))], ordinals: [...new Set(spec.byDay.flatMap(day => day.ordinal === null ? [] : [day.ordinal]))].join(','), monthDays: spec.byMonthDay.join(','), months: spec.byMonth, setPos: lastWorkday ? '' : spec.bySetPos.join(','), end: spec.count !== null ? 'count' : spec.until !== null ? 'until' : 'none', count: spec.count === null ? base.count : String(spec.count), until: spec.until === null ? '' : `${spec.until.slice(0, 4)}-${spec.until.slice(4, 6)}-${spec.until.slice(6, 8)}` }
}
/** "2026-10-12" means that day at the series time; "2026-10-12T15:00" is an exact local date-time. */
/** Stored values at the series time are shown as bare dates, so they keep following the series time when it changes. */
export const localDateTimeText = (values: string[], time: string) => values.map(value => value.slice(11) === time ? value.slice(0, 10) : value).join(', ')
/** An entry still at the old series time follows a new series time; an entry with its own explicit clock stays. */
export const followSeriesClock = (values: string[], oldTime: string, newTime: string) => [...new Set(values.map(value => value.slice(11) === oldTime ? `${value.slice(0, 10)}T${newTime}` : value))].sort()
export const localDateTimeList = (text: string, time: string) => [...new Set(text.split(/[,、\s]+/).map(value => value.trim()).filter(Boolean).map(value => /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${time}` : value))].sort()
/** RFC 5545 THISANDFUTURE: COUNT counts from DTSTART, so a "from this date onward" edition that keeps DTSTART must
 * leave out the instances its own rule would have had before fromDate and keep only what the series still had left.
 * DTSTART is kept because it also fixes the implicit day, weekday and interval phase. */
export function rebaseFutureCount(base: CalendarRule, trigger: RRuleCalendarTrigger, fromDate: string): { trigger: RRuleCalendarTrigger; remaining: number } | null {
  const spec = parseRRule(trigger.rrule), before = addDays(fromDate, -1)
  if (spec.count === null || trigger.dtstart.slice(0, 10) > before) return null
  let index = -1
  for (const [position, edition] of (base.editions ?? []).entries()) if (edition.scope.kind === 'all_uncompleted' || edition.scope.kind === 'this_and_future' && fromDate >= edition.scope.fromDate) index = position
  const governing = index < 0 ? base.trigger : base.editions![index].definition.trigger
  if (governing.kind !== 'rrule' || parseRRule(governing.rrule).count === null) return null
  const count = (dtstart: string, rrule: string) => { if (dtstart.slice(0, 10) > before) return 0; const expansion = expandRRule({ dtstart, rrule, from: dtstart.slice(0, 10), to: before, limit: 20000 }); if (expansion.truncated) throw new Error('指定日より前の回が多すぎるため回数（COUNT）を引き継げません。開始日か回数を見直してください'); return expansion.occurrences.length }
  const remaining = spec.count - count(governing.dtstart, governing.rrule)
  if (remaining <= 0) throw new Error('指定日より前に回数（COUNT）を使い切っているため、以後の変更を作れません。回数か終了日を見直してください')
  const total = count(trigger.dtstart, serializeRRule({ ...spec, count: null })) + remaining
  return { trigger: { ...trigger, rrule: canonicalRRule(serializeRRule({ ...spec, count: total })) }, remaining }
}
