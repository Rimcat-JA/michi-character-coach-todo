import { addDays, emptyScore, validateDate } from './domain'
import { canonicalJSON } from './canonical'
import { calendarRuleEditorDefinition, followSeriesClock, rebaseFutureCount } from './calendar-rule-editor'
import { validateCalendarRulesState } from './calendar-rules-validation'
import { defaultUnfinishedPolicy, type CalendarChangeScope, type CalendarRule, type CalendarRuleTrigger, type CalendarRulesState, type RecurrenceUnfinishedPolicy } from './calendar-resolver'
import { canonicalRRule, parseRRule, serializeRRule } from './rrule'
import { deadlineClock, groundRecurrencePhrase, RecurrencePhraseError, type RecurrencePattern } from './recurrence-phrase'
import type { AmbiguousTimePolicy, NonexistentTimePolicy } from './zoned-time'

export type RoutineAssistSelection = {
  contextId: string; bindingId: string; calendarId: string; activityId: string | null
  timezone: string; validFrom: string; validTo: string; time: string
  stepKind: 'task' | 'event'; durationMinutes: number | null
  scheduledOffsetDays: number; dueOffsetDays: number | null
  /** Owner-chosen clock deadline and DST / unfinished-occurrence choices; absent means none / the shown defaults. */
  dueTime?: string | null; nonexistentTime?: NonexistentTimePolicy; ambiguousTime?: AmbiguousTimePolicy; unfinishedPolicy?: RecurrenceUnfinishedPolicy
}
const optionalSelectionKeys = ['dueTime', 'nonexistentTime', 'ambiguousTime', 'unfinishedPolicy'] as const
export type RoutineAssistInput = {
  message: string; referenceDate: string; targetRuleId: string | null; expectedRuleRevision: number | null
  selection: RoutineAssistSelection; scope: CalendarChangeScope
}
export type RoutineAssistRequest = {
  model: string; message: string; referenceDate: string
  selection: Pick<RoutineAssistSelection, 'contextId' | 'bindingId' | 'calendarId' | 'activityId' | 'timezone' | 'validFrom' | 'validTo' | 'time'> & { calendarName: string; activityName: string | null }
  existingRule: null | Pick<CalendarRule, 'id' | 'revision' | 'title' | 'trigger'>
}
export type RoutineAssistCandidate = { input: RoutineAssistInput; definition: Pick<CalendarRule, 'title' | 'enabled' | 'steps' | 'trigger'>; notices: string[] }

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) }
function exact(value: unknown, fields: string[]): asserts value is Record<string, unknown> { if (!record(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new Error('周期補助の項目が不正です') }
function id(value: unknown) { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) throw new Error('周期補助の対象を明示選択してください') }
function day(value: unknown) { if (typeof value !== 'string' || !value) throw new Error('周期の有効期間を選択してください'); validateDate(value, '周期の有効日') }
function integer(value: unknown, min: number, max: number) { if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error('周期補助の数値が範囲外です') }
export function validateRoutineAssistSelection(input: RoutineAssistInput, state: CalendarRulesState): void {
  exact(input, ['message', 'referenceDate', 'targetRuleId', 'expectedRuleRevision', 'selection', 'scope'])
  if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 4000) throw new Error('周期の本人指示は1〜4000文字で入力してください')
  day(input.referenceDate)
  const selection = input.selection
  if (!record(selection)) throw new Error('周期補助の項目が不正です')
  exact(selection, ['contextId', 'bindingId', 'calendarId', 'activityId', 'timezone', 'validFrom', 'validTo', 'time', 'stepKind', 'durationMinutes', 'scheduledOffsetDays', 'dueOffsetDays', ...optionalSelectionKeys.filter(key => Object.hasOwn(selection, key))])
  if (selection.dueTime !== undefined && selection.dueTime !== null && (typeof selection.dueTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(selection.dueTime) || selection.stepKind !== 'task' || selection.dueOffsetDays === null)) throw new Error('締め切り時刻は締め切り日のあるタスクだけに指定してください')
  if (selection.nonexistentTime !== undefined && !['skip', 'next_valid'].includes(selection.nonexistentTime)) throw new Error('夏時間でない時刻の扱いを選択してください')
  if (selection.ambiguousTime !== undefined && !['earlier', 'later'].includes(selection.ambiguousTime)) throw new Error('夏時間で二度ある時刻の扱いを選択してください')
  if (selection.unfinishedPolicy !== undefined && !['keep_all', 'keep_latest', 'generate_after_completion'].includes(selection.unfinishedPolicy)) throw new Error('未完了の回の扱いを選択してください')
  id(selection.contextId); id(selection.bindingId); id(selection.calendarId)
  if (selection.activityId !== null) id(selection.activityId)
  day(selection.validFrom); day(selection.validTo)
  if (selection.validFrom > selection.validTo) throw new Error('周期の有効期間の順序が不正です')
  if (typeof selection.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(selection.time)) throw new Error('本人が現地時刻を指定してください')
  if (typeof selection.timezone !== 'string' || selection.timezone.length > 100) throw new Error('周期のタイムゾーンを指定してください')
  try { new Intl.DateTimeFormat('en', { timeZone: selection.timezone }).format() } catch { throw new Error('周期のタイムゾーンが不正です') }
  integer(selection.scheduledOffsetDays, -366, 366)
  if (selection.dueOffsetDays !== null) integer(selection.dueOffsetDays, -366, 366)
  if (selection.stepKind === 'task') { if (selection.durationMinutes !== null) throw new Error('タスクに予定専用の時間を指定できません') }
  else if (selection.stepKind === 'event') { integer(selection.durationMinutes, 1, 10080); if (selection.dueOffsetDays !== null) throw new Error('占有予定へタスクの期限を付けられません') }
  else throw new Error('タスクか占有予定かを本人が選択してください')
  const context = state.contexts.find(value => value.id === selection.contextId)
  const binding = state.bindings.find(value => value.id === selection.bindingId)
  const calendar = state.calendars.find(value => value.id === selection.calendarId)
  if (!context || !binding || !calendar || !binding.confirmed || binding.personId !== state.ownerId || binding.contextId !== context.id || calendar.contextId !== context.id || context.timezone !== selection.timezone) throw new Error('本人の対象・参加条件・営業日カレンダー・タイムゾーンを明示選択してください')
  if ([context, binding, calendar].some(value => selection.validFrom < value.validFrom || selection.validTo > value.validTo)) throw new Error('周期の有効期間が選択した本人条件・暦の範囲外です')
  if (selection.activityId !== null) {
    const activity = state.activities.find(value => value.id === selection.activityId)
    if (!activity || activity.contextId !== context.id || activity.bindingId !== binding.id || activity.calendarId !== calendar.id || !binding.activityIds.includes(activity.id) || selection.validFrom < activity.validFrom || selection.validTo > activity.validTo) throw new Error('選択活動が本人の対象・参加条件・暦と一致しません')
  }
  if (input.targetRuleId === null) { if (input.expectedRuleRevision !== null) throw new Error('新しい系列に既存の版を指定できません') }
  else {
    id(input.targetRuleId); integer(input.expectedRuleRevision, 1, Number.MAX_SAFE_INTEGER)
    const old = state.rules.find(value => value.id === input.targetRuleId)
    if (!old || old.revision !== input.expectedRuleRevision) throw new Error('編集するルールの版が変わりました')
    if (old.contextId !== context.id || old.bindingId !== binding.id || old.calendarId !== calendar.id || old.validFrom !== selection.validFrom || old.validTo !== selection.validTo) throw new Error('既存ルールの対象・暦・有効期間を周期補助で付け替えることはできません')
    if (calendarRuleEditorDefinition(old).steps[0].kind !== selection.stepKind) throw new Error('既存ステップの種別変換は手動で確認してください')
  }
  if (!record(input.scope) || typeof input.scope.kind !== 'string') throw new Error('変更範囲を本人が選択してください')
  if (input.scope.kind === 'all_uncompleted') exact(input.scope, ['kind'])
  else if (input.scope.kind === 'this_and_future') { exact(input.scope, ['kind', 'fromDate']); day(input.scope.fromDate) }
  else if (input.scope.kind === 'this_instance') {
    exact(input.scope, ['kind', 'generationKey']); id(input.scope.generationKey)
    const generationKey = input.scope.generationKey
    if (!input.targetRuleId || !state.instances.some(value => value.generationKey === generationKey && value.spec.ruleId === input.targetRuleId)) throw new Error('今回だけ変更する既存の発生回を選択してください')
  } else throw new Error('変更範囲が不正です')
}

export function createRoutineAssistRequest(input: RoutineAssistInput, state: CalendarRulesState, model: string): RoutineAssistRequest {
  validateRoutineAssistSelection(input, state)
  if (typeof model !== 'string' || !/^[\w~./:-]{3,120}$/.test(model)) throw new Error('モデルIDを確認してください')
  const selection = input.selection, old = state.rules.find(value => value.id === input.targetRuleId)
  return { model, message: input.message, referenceDate: input.referenceDate, selection: { contextId: selection.contextId, bindingId: selection.bindingId, calendarId: selection.calendarId, calendarName: state.calendars.find(value => value.id === selection.calendarId)!.name, activityId: selection.activityId, activityName: selection.activityId === null ? null : state.activities.find(value => value.id === selection.activityId)!.title, timezone: selection.timezone, validFrom: selection.validFrom, validTo: selection.validTo, time: selection.time }, existingRule: old ? { id: old.id, revision: old.revision, title: old.title, trigger: structuredClone(calendarRuleEditorDefinition(old).trigger) } : null }
}
function quote(value: unknown, message: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || !message.includes(value)) throw new Error(`${label}が本人の原文と一致しません`)
  return value
}
function readable(text: string) { try { groundRecurrencePhrase(deadlineClock(text).rest); return true } catch { return false } }
function explicitIntent(message: string) {
  const text = message.normalize('NFKC')
  if (/しないで|設定しない|繰り返さない|不要|仮に|もし|例えば|例として|取消し|取り消し|\bnot\b|\bdon'?t\b|\bnever\b|\bif\b/i.test(text)) throw new Error('必要な周期を設定する明示指示を確認してください')
  if (/以外|除く|除外|\bexcept\b|\bexcluding\b/i.test(text)) throw new Error('周期の除外条件は省略できません。本人の手動設定で確認してください')
  if (/履歴|過去|以前|先月|やっていた|していた|しただけ|回やった|回行った/.test(text) && !/にして|設定して|作って|変更して|繰り返して|今後|これから/.test(text)) throw new Error('過去の頻度だけでは将来の必要な系列を作りません')
  // Wording the deterministic reader accepts (e.g. English weekdays) is as explicit as the Japanese keywords.
  if (!/毎週|毎月|毎日|毎年|隔週|隔月|営業日|稼働日|活動|出勤|授業|会議|開始|終了|完了|月末|第\s*\d|最終|最後の|\d+\s*(?:日|週間?|か月|ヶ月|カ月|ヵ月)\s*(?:ごと|毎|に\s*[1一]\s*(?:回|度))|毎[日月火水木金土]曜/.test(text) && !readable(text)) throw new Error('明示された周期または活動からの指定を確認してください')
  if (Number(/毎週|毎日|毎年|隔週|毎[日月火水木金土]曜/.test(text)) + Number(/毎月(?!曜|[日月火水木金土]曜)|月の|月末|隔月/.test(text)) + Number(/開始|終了/.test(text)) + Number(/完了(?:して|から|後|の)\s*\d/.test(text)) > 1) throw new Error('複数の周期や基準を一つに省略できません。使用する周期を一つ指定してください')
  if (/曜(?:日)?\s*(?:か|または|あるいは|もしくは)|営業日\s*(?:か|または|あるいは|もしくは)|(?:毎週|毎月).*(?:あるいは|または|もしくは)|\bor\b|\beither\b/i.test(text)) throw new Error('周期の選択肢を一つに確認してください')
}
/** The trigger's own clock; an activity-relative trigger has none. */
export function routineTriggerTime(trigger: CalendarRuleTrigger): string | null {
  return trigger.kind === 'activity_relative' ? null : trigger.kind === 'rrule' ? trigger.dtstart.slice(11) : trigger.time
}
/** Shown beside the start-date choice; DTSTART = validFrom fixes the first matching date and the interval phase (RFC 5545). */
export const routineAssistStartNote = '繰り返し規則は有効開始日を起点（DTSTART）にし、曜日・日付の指定があるときは起点以降で最初に一致する日が最初の回です。隔週・隔月などの間隔も起点の週・月から数えます（ずらしたいときは有効開始日を最初の回にしたい週・月の日にしてください）。既存の規則を編集するときは、その規則の起点・除外・追加の回・回数を保ちます。完了起点の周期は有効開始日を最初の回にします。上の時刻を予定時刻にし、過去の回をまとめて通知しません。'
/** The target rule's current trigger and, for a "from this date onward" change, the base rule whose COUNT the edition continues. */
export type RoutineAssistPrevious = { trigger?: CalendarRuleTrigger; future?: { base: CalendarRule; fromDate: string } }
export function routineAssistPrevious(input: Pick<RoutineAssistInput, 'targetRuleId' | 'scope'>, state: CalendarRulesState): RoutineAssistPrevious {
  const old = state.rules.find(value => value.id === input.targetRuleId)
  return old ? { trigger: calendarRuleEditorDefinition(old).trigger, ...(input.scope?.kind === 'this_and_future' ? { future: { base: old, fromDate: input.scope.fromDate } } : {}) } : {}
}
/** RRULE and completion-relative triggers take their start, DST and unfinished choices from the owner's selection, never from a model.
 * Editing a rule of the same kind keeps what the grammar cannot state: its start, added/excluded dates, COUNT/UNTIL and earlier choices. */
export function routineAssistTrigger(pattern: RecurrencePattern, selection: RoutineAssistSelection, previous: RoutineAssistPrevious = {}): CalendarRuleTrigger {
  const before = previous.trigger
  if (pattern.kind === 'rrule') {
    if (before?.kind !== 'rrule') return { kind: 'rrule', dtstart: `${selection.validFrom}T${selection.time}`, rrule: canonicalRRule(pattern.rrule), rdates: [], exdates: [], nonexistentTime: selection.nonexistentTime ?? 'skip', ambiguousTime: selection.ambiguousTime ?? 'earlier' }
    const spec = parseRRule(pattern.rrule), kept = parseRRule(before.rrule), carried = spec.count === null && spec.until === null && (kept.count !== null || kept.until !== null), oldTime = before.dtstart.slice(11)
    const trigger: CalendarRuleTrigger = { kind: 'rrule', dtstart: `${before.dtstart.slice(0, 10)}T${selection.time}`, rrule: canonicalRRule(serializeRRule(carried ? { ...spec, count: kept.count, until: kept.until } : spec)), rdates: followSeriesClock(before.rdates, oldTime, selection.time), exdates: followSeriesClock(before.exdates, oldTime, selection.time), nonexistentTime: selection.nonexistentTime ?? before.nonexistentTime, ambiguousTime: selection.ambiguousTime ?? before.ambiguousTime }
    return carried && previous.future ? rebaseFutureCount(previous.future.base, trigger, previous.future.fromDate)?.trigger ?? trigger : trigger
  }
  if (pattern.kind === 'completion_relative') return { kind: 'completion_relative', firstDate: before?.kind === 'completion_relative' ? before.firstDate : selection.validFrom, time: selection.time, afterDays: pattern.afterDays, unfinishedPolicy: selection.unfinishedPolicy ?? (before?.kind === 'completion_relative' ? before.unfinishedPolicy : defaultUnfinishedPolicy) }
  if (pattern.kind === 'weekly') return { kind: 'weekly', weekdays: pattern.weekdays, time: selection.time }
  return { kind: 'monthly_business', ordinal: pattern.ordinal, from: pattern.from, time: selection.time }
}
/** Deterministic reading of the owner's own recurrence wording; used to prefill the manual form and to check model candidates. */
export function groundedRoutinePattern(text: string): RecurrencePattern {
  try { return groundRecurrencePhrase(deadlineClock(text).rest) } catch (error) { if (error instanceof RecurrencePhraseError) throw new Error(`${error.message}。本人の手動設定で確認してください`); throw error }
}
function validateGroundedTrigger(trigger: CalendarRule['trigger'], raw: string, selection: RoutineAssistSelection, previousDueTime: string | null = null, previous: RoutineAssistPrevious = {}) {
  const deadline = deadlineClock(raw), text = deadline.rest
  // A quoted clock deadline is kept only as the owner's selected deadline time, never folded into a date or the series time.
  if (deadline.time !== null && deadline.time !== (selection.dueTime ?? previousDueTime)) throw new Error('時刻付きの本当の締め切りは周期補助で日付へ省略できません。原文の時刻を締め切り時刻として本人が選択してください')
  if (/時半|時\s*\d+(?!\d|分)|(?:時(?:\s*\d+分)?|:\d{2})(?:頃|ころ|ごろ|くらい|前|後|以降)|(?:朝|夜|晩|夕方|昼)\s*\d+時|\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i.test(text)) throw new Error('この時刻表現は省略できません。24時間表記で本人が確認してください')
  const explicitTimes: string[] = []
  for (const match of text.matchAll(/(\d+):(\d+)/g)) {
    if (match[1].length > 2 || match[2].length !== 2) throw new Error('原文の時刻をHH:mmで確認してください')
    explicitTimes.push(`${match[1].padStart(2, '0')}:${match[2]}`)
  }
  for (const match of text.matchAll(/(?:(午前|午後)\s*)?(\d+)時(?:\s*(\d+)分)?/g)) {
    let hour = Number(match[2]); const minute = Number(match[3] ?? 0)
    if (match[1] && (hour < 1 || hour > 12)) throw new Error('原文の午前・午後の時刻を確認してください')
    if (match[1] === '午前') hour %= 12
    if (match[1] === '午後') hour = hour % 12 + 12
    explicitTimes.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`)
  }
  if (explicitTimes.length > 1 || explicitTimes.some(time => !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || time !== selection.time)) throw new Error('原文の現地時刻と本人選択が一致しません。時刻を省略せず確認してください')
  if (trigger.kind === 'rrule' || trigger.kind === 'completion_relative') {
    const pattern = groundedRoutinePattern(text)
    if (canonicalJSON(routineAssistTrigger(pattern, selection, previous)) !== canonicalJSON(trigger)) throw new Error(pattern.kind === trigger.kind ? '候補の周期が本人の原文と一致しません' : '候補の周期の種類が本人の原文と一致しません')
    return
  }
  if (trigger.kind === 'weekly') {
    if (trigger.time !== selection.time || !Array.isArray(trigger.weekdays) || !trigger.weekdays.length || trigger.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(trigger.weekdays).size !== trigger.weekdays.length) throw new Error('毎週の曜日・時刻が明示された周期と一致しません')
    // The weekdays are exactly those the deterministic reader finds (毎週月・水曜, 毎月曜, every Monday and Wednesday).
    const pattern = groundedRoutinePattern(text)
    if (pattern.kind !== 'weekly' || canonicalJSON([...pattern.weekdays].sort()) !== canonicalJSON([...trigger.weekdays].sort())) throw new Error('候補の曜日が本人の原文と一致しません')
  } else if (trigger.kind === 'monthly_business') {
    if (!/毎月|月の|月末|最終(?:の)?(?:営業日|稼働日)|最後の(?:営業日|稼働日)/.test(text) || !/営業日|稼働日/.test(text) || trigger.time !== selection.time || !Number.isInteger(trigger.ordinal) || trigger.ordinal < 1 || trigger.ordinal > 31 || !['start', 'end'].includes(trigger.from)) throw new Error('毎月の営業日順位・時刻が明示された周期と一致しません')
    if (/営業日(?:前|後)/.test(text)) throw new Error('営業日からの追加日数は手動で確認してください')
    if ([...text.matchAll(/第\s*(\d+)\s*(?:営業日|稼働日)/g)].length > 1) throw new Error('複数の営業日順位を一つに省略できません')
    const ordinal = /最終(?:の)?(?:営業日|稼働日)/.test(text) ? 1 : Number(text.match(/第\s*(\d+)\s*(?:営業日|稼働日)/)?.[1])
    const from = /最終|最後から|月末から/.test(text) ? 'end' : 'start'
    if (trigger.ordinal !== ordinal || trigger.from !== from) throw new Error('候補の営業日順位が本人の原文と一致しません')
  } else if (trigger.kind === 'activity_relative') {
    if (selection.activityId === null || trigger.activityId !== selection.activityId || !['start', 'end'].includes(trigger.edge)) throw new Error('本人が選択した活動以外は周期の基準にできません')
    let other: RecurrencePattern | null = null
    try { other = groundRecurrencePhrase(text) } catch { other = null }
    if (other) throw new Error('活動からの相対指定と別の周期を一つにまとめられません')
    const edge = /終了/.test(text) ? 'end' : /開始/.test(text) ? 'start' : null
    if (!edge || edge !== trigger.edge || /開始/.test(text) && /終了/.test(text)) throw new Error('活動の開始か終了かを原文で指定してください')
    const days = [...text.matchAll(/([+-]?\d+)\s*日\s*(前|後)?/g)], minutes = [...text.matchAll(/([+-]?\d+)\s*分\s*(前|後)?/g)]
    if (days.length > 1 || minutes.length > 1) throw new Error('活動からの日数・分数を一つ指定してください')
    const amount = (matches: RegExpMatchArray[]) => matches.length ? Number(matches[0][1]) * (matches[0][2] === '前' ? -1 : 1) : 0
    const offsetDays = /翌日/.test(text) ? 1 : amount(days), offsetMinutes = amount(minutes)
    if (trigger.offsetDays !== offsetDays || trigger.offsetMinutes !== offsetMinutes) throw new Error('活動からの相対日数・分数が本人の原文と一致しません')
  } else throw new Error('この周期表現は手動で確認してください')
  // Weekly and business-day candidates must also be the single period the grammar reads; extra periods are refused.
  const pattern = trigger.kind === 'activity_relative' ? null : groundedRoutinePattern(text)
  if (pattern && canonicalJSON(routineAssistTrigger(pattern, selection, previous)) !== canonicalJSON(trigger)) throw new Error('候補の周期が本人の原文の唯一の周期と一致しません')
}
export function validateRoutineInstructionPeriod(input: RoutineAssistInput, allowSubset = false) {
  const text = input.message.normalize('NFKC'), selection = input.selection
  const datePattern = '(\\d{4}-\\d{2}-\\d{2}|\\d{4}年\\d{1,2}月\\d{1,2}日|今日|明日)'
  const resolve = (raw: string) => {
    const japanese = raw.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/)
    const date = raw === '今日' ? input.referenceDate : raw === '明日' ? addDays(input.referenceDate, 1) : japanese ? `${japanese[1]}-${japanese[2].padStart(2, '0')}-${japanese[3].padStart(2, '0')}` : raw
    validateDate(date, '原文の有効期間'); return date
  }
  const starts = [...text.matchAll(new RegExp(`(?:開始|開始日|有効開始)(?:は|を|:|\\s)*${datePattern}|${datePattern}(?:から|以後)`, 'g'))].map(match => resolve(match[1] ?? match[2]))
  const ends = [...text.matchAll(new RegExp(`(?:終了日|有効終了)(?:は|を|:|\\s)*${datePattern}|${datePattern}まで`, 'g'))].map(match => resolve(match[1] ?? match[2]))
  if (starts.length > 1 || ends.length > 1 || starts.some(date => allowSubset ? date > selection.validFrom : date !== selection.validFrom) || ends.some(date => allowSubset ? date < selection.validTo : date !== selection.validTo)) throw new Error('原文の開始・終了日と本人が選択した有効期間が一致しません')
  const mentioned = [...text.matchAll(new RegExp(datePattern, 'g'))]
  if (mentioned.length > starts.length + ends.length) throw new Error('原文の日付の意味を確認してください。開始・終了日を省略しません')
  if (/来週|来月|今月|年度末|年末/.test(text)) throw new Error('曖昧な開始・終了日は具体的な日付で確認してください')
}
function requestedPoints(message: string): number | null {
  const text = message.normalize('NFKC')
  if (/ポイント|pt\b|点/i.test(text) && /半分|倍|推定|見積|おまかせ|くらい|程度|以下|以上|[〜～]/.test(text)) throw new Error('必要ポイントは具体的な整数を本人が指定してください')
  if (!/\d+\s*(?:pt|ポイント|点)/i.test(text)) return null
  if (/過去|以前|だった|参考|引用|サンプル/.test(text) || /[「『"].*\d+\s*(?:pt|ポイント|点).*?[」』"]/i.test(text)) throw new Error('履歴・引用の点数を現在の本人指定にできません。変更する必要ポイントだけを具体的に指定してください')
  if (/変更しない|変えない|維持|そのまま/.test(text)) throw new Error('周期だけを変更する場合は、点数の変更指示を含めず確認してください')
  if (/半分|倍|推定|見積|おまかせ|くらい|程度|以下|以上|[〜～]|[+\-−]\s*\d+\s*(?:pt|ポイント|点)|\d+\.\d+\s*(?:pt|ポイント|点)/i.test(text)) throw new Error('必要ポイントは具体的な整数を本人が指定してください')
  const matches = [...text.matchAll(/(\d+)\s*(?:pt|ポイント|点)/gi)]
  if (matches.length !== 1) throw new Error('周期で使用する必要ポイントを一つ指定してください')
  const points = Number(matches[0][1]); integer(points, 0, 100000); return points
}
export function parseRoutineAssistAnswer(answer: string, input: RoutineAssistInput, state: CalendarRulesState): RoutineAssistCandidate {
  validateRoutineAssistSelection(input, state); explicitIntent(input.message); validateRoutineInstructionPeriod(input)
  if (typeof answer !== 'string' || answer.length > 20000) throw new Error('周期補助の応答が大きすぎます')
  let parsed: unknown
  try { parsed = JSON.parse(answer) } catch { throw new Error('周期補助の応答を読めません。本人の入力は残っています') }
  if (record(parsed) && parsed.status === 'needs_confirmation') { exact(parsed, ['status', 'reason']); if (typeof parsed.reason !== 'string' || !parsed.reason.trim() || parsed.reason.length > 1000) throw new Error('周期の確認事項が不正です'); throw new Error(`周期を確認してください: ${parsed.reason}`) }
  exact(parsed, ['title_quote', 'recurrence_quote', 'trigger', 'manual_points', 'reason'])
  if (typeof parsed.reason !== 'string' || !parsed.reason.trim() || parsed.reason.length > 1000) throw new Error('周期の候補理由が不正です')
  const recurrence = quote(parsed.recurrence_quote, input.message, '周期の引用')
  if (!record(parsed.trigger)) throw new Error('周期の形式が不正です')
  if (parsed.trigger.kind === 'weekly') exact(parsed.trigger, ['kind', 'weekdays', 'time'])
  else if (parsed.trigger.kind === 'monthly_business') exact(parsed.trigger, ['kind', 'ordinal', 'from', 'time'])
  else if (parsed.trigger.kind === 'activity_relative') exact(parsed.trigger, ['kind', 'activityId', 'edge', 'offsetDays', 'offsetMinutes'])
  else if (parsed.trigger.kind === 'rrule') { exact(parsed.trigger, ['kind', 'rrule']); if (typeof parsed.trigger.rrule !== 'string') throw new Error('RRULEの形式が不正です') }
  else if (parsed.trigger.kind === 'completion_relative') { exact(parsed.trigger, ['kind', 'afterDays']); integer(parsed.trigger.afterDays, 1, 3650) }
  else throw new Error('この周期は本人の手動設定で確認してください')
  // The model only names the rule; start, DST and unfinished choices are filled from the owner's selection.
  const previousTrigger = routineAssistPrevious(input, state)
  const trigger = parsed.trigger.kind === 'rrule' ? routineAssistTrigger({ kind: 'rrule', rrule: String(parsed.trigger.rrule) }, input.selection, previousTrigger) : parsed.trigger.kind === 'completion_relative' ? routineAssistTrigger({ kind: 'completion_relative', afterDays: Number(parsed.trigger.afterDays) }, input.selection, previousTrigger) : parsed.trigger as CalendarRule['trigger']
  const target = state.rules.find(value => value.id === input.targetRuleId), previousDueTime = target ? calendarRuleEditorDefinition(target).steps[0].dueTime ?? null : null
  validateGroundedTrigger(trigger, recurrence, input.selection, previousDueTime, previousTrigger)
  validateGroundedTrigger(trigger, input.message, input.selection, previousDueTime, previousTrigger)
  const points = requestedPoints(input.message)
  if (parsed.manual_points !== points) throw new Error('モデルの点数候補が本人の具体的な指定と一致しません')
  const old = state.rules.find(value => value.id === input.targetRuleId), previous = old ? calendarRuleEditorDefinition(old) : null
  if (previous && parsed.title_quote !== null && !/(?:ルール名|名称|タイトル).*(?:変更|変え|にして|にする|改名)/.test(input.message)) throw new Error('周期変更だけで既存ルールの名称を変更しません')
  const title = parsed.title_quote === null && previous ? previous.title : quote(parsed.title_quote, input.message, '作業名の引用').trim()
  if (!title || title.length > 300) throw new Error('周期の作業名は1〜300文字です')
  const selection = input.selection
  const steps: CalendarRule['steps'] = previous ? structuredClone(previous.steps) : [{ key: 'main', title, kind: selection.stepKind, scheduledOffsetDays: selection.scheduledOffsetDays, dueOffsetDays: selection.dueOffsetDays, score: selection.stepKind === 'task' ? emptyScore() : null, durationMinutes: selection.durationMinutes, ...(selection.dueTime ? { dueTime: selection.dueTime } : {}) }]
  if (!previous) steps[0].title = title
  if (points !== null) { if (steps[0].kind !== 'task') throw new Error('占有予定へ必要ポイントは設定しません'); steps[0].score = { ...steps[0].score!, mode: 'manual', manualPoints: points } }
  const candidate: RoutineAssistCandidate = { input: structuredClone(input), definition: { title, enabled: previous?.enabled ?? true, trigger: structuredClone(trigger), steps }, notices: previous ? ['既存のステップ・点数・完了実績を保持します。本人が指定した変更だけを確認します。'] : ['未指定のポイント・期限・準備作業は追加しません。'] }
  validateRoutineAssistCandidate(candidate, state); return candidate
}
export function validateRoutineAssistCandidate(candidate: RoutineAssistCandidate, state: CalendarRulesState): void {
  exact(candidate, ['input', 'definition', 'notices']); validateRoutineAssistSelection(candidate.input, state)
  exact(candidate.definition, ['title', 'enabled', 'trigger', 'steps'])
  if (!Array.isArray(candidate.notices) || candidate.notices.length > 10 || candidate.notices.some(value => typeof value !== 'string' || value.length > 1000)) throw new Error('周期補助の案内が不正です')
  const input = candidate.input, selection = input.selection, old = state.rules.find(value => value.id === input.targetRuleId)
  const rule: CalendarRule = { id: old?.id ?? 'routine-assist-preview', contextId: selection.contextId, bindingId: selection.bindingId, calendarId: selection.calendarId, originBasis: 'user_instruction', validFrom: selection.validFrom, validTo: selection.validTo, revision: 1, ...structuredClone(candidate.definition) }
  const proposed = { ...structuredClone(state), rules: state.rules.filter(value => value.id !== old?.id).concat(rule), instances: [] }
  validateCalendarRulesState(proposed, state.ownerId, state.datasetId)
  const trigger = candidate.definition.trigger
  if (trigger.kind === 'activity_relative' && trigger.activityId !== selection.activityId || trigger.kind !== 'activity_relative' && routineTriggerTime(trigger) !== selection.time) throw new Error('周期候補の基準活動・時刻が本人選択と一致しません')
  if ((trigger.kind === 'rrule' || trigger.kind === 'completion_relative') && canonicalJSON(trigger) !== canonicalJSON(routineAssistTrigger(trigger.kind === 'rrule' ? { kind: 'rrule', rrule: trigger.rrule } : { kind: 'completion_relative', afterDays: trigger.afterDays }, selection, routineAssistPrevious(input, state)))) throw new Error('繰り返しの開始・夏時間・未完了の扱いが本人選択と一致しません')
  if (old) {
    const previous = calendarRuleEditorDefinition(old)
    if (candidate.definition.enabled !== previous.enabled) throw new Error('周期補助で未指示の停止・再開を行いません')
    if (candidate.definition.steps.length !== previous.steps.length || candidate.definition.steps.some((step, index) => step.key !== previous.steps[index].key || index > 0 && canonicalJSON(step) !== canonicalJSON(previous.steps[index]))) throw new Error('周期補助で未指示のステップを追加・削除・変更できません')
    const before = previous.steps[0], after = candidate.definition.steps[0]
    if (before.title !== after.title || before.kind !== after.kind || before.scheduledOffsetDays !== after.scheduledOffsetDays || before.dueOffsetDays !== after.dueOffsetDays || before.durationMinutes !== after.durationMinutes || (before.dueTime ?? null) !== (after.dueTime ?? null)) throw new Error('既存の作業・予定・期限は周期変更だけで上書きしません')
    const oldScore = before.score, newScore = after.score
    if (oldScore && newScore && canonicalJSON({ ...oldScore, mode: newScore.mode, manualPoints: newScore.manualPoints }) !== canonicalJSON(newScore)) throw new Error('周期補助で既存の採点属性を変更できません')
  } else if (candidate.definition.steps.length !== 1 || candidate.definition.steps[0].title !== candidate.definition.title || candidate.definition.steps[0].kind !== selection.stepKind || candidate.definition.steps[0].scheduledOffsetDays !== selection.scheduledOffsetDays || candidate.definition.steps[0].dueOffsetDays !== selection.dueOffsetDays || candidate.definition.steps[0].durationMinutes !== selection.durationMinutes || (candidate.definition.steps[0].dueTime ?? null) !== (selection.dueTime ?? null)) throw new Error('新しい系列の手順が本人選択と一致しません')
}
/** Called again at native confirmation; a model candidate cannot mint specified values. */
export function validateOwnerRoutineAssistCandidate(candidate: RoutineAssistCandidate, state: CalendarRulesState) {
  validateRoutineAssistCandidate(candidate, state); explicitIntent(candidate.input.message); validateRoutineInstructionPeriod(candidate.input)
  const old = state.rules.find(value => value.id === candidate.input.targetRuleId), previous = old ? calendarRuleEditorDefinition(old) : null
  validateGroundedTrigger(candidate.definition.trigger, candidate.input.message, candidate.input.selection, previous?.steps[0].dueTime ?? null, routineAssistPrevious(candidate.input, state))
  const requested = requestedPoints(candidate.input.message), score = previous?.steps[0].score ?? (candidate.input.selection.stepKind === 'task' ? emptyScore() : null)
  const expected = requested === null ? score : score ? { ...score, mode: 'manual', manualPoints: requested } : null
  if (canonicalJSON(candidate.definition.steps[0].score) !== canonicalJSON(expected) || requested !== null && expected === null) throw new Error('確認候補の点数が本人の指定または保持する既存値と一致しません')
  if (!previous || candidate.definition.title !== previous.title) {
    if (!candidate.input.message.includes(candidate.definition.title) || previous && !/(?:ルール名|名称|タイトル).*(?:変更|変え|にして|にする|改名)/.test(candidate.input.message)) throw new Error('確認候補の名称が本人の明示指示と一致しません')
  }
}
