import { canonicalJSON, contentDigest } from './canonical'
import type { CSVMappingBinding, MappedCSVRowEvidence } from './calendar-csv-mapping'
import { addDays, emptyScore, validateDate, validateScore, type ScoreInput } from './domain'
import { expandRRule, parseRRule, rruleSeriesLimit } from './rrule'
import { resolveZonedLocalTime, type AmbiguousTimePolicy, type NonexistentTimePolicy } from './zoned-time'

export type CalendarContext = { id: string; name: string; domain: 'education' | 'work' | 'other'; timezone: string; validFrom: string; validTo: string; revision: number }
export type ParticipationBinding = { id: string; contextId: string; personId: string; personRef: string | null; activityIds: string[]; weekdays: number[]; validFrom: string; validTo: string; confirmed: boolean; revision: number }
export type BusinessCalendar = { id: string; contextId: string; name: string; weekdays: number[]; validFrom: string; validTo: string; revision: number }
export type CalendarActivity = { id: string; contextId: string; bindingId: string; calendarId: string; title: string; eventKind: 'class' | 'meeting' | 'other'; weekdays: number[]; startTime: string; endTime: string; endDayOffset: number; validFrom: string; validTo: string; revision: number }
export type ICSComponentVersion = { uid: string; recurrenceId: string | null; sequence: number; dtstamp: string; lastModified: string | null; digest: string }
export type ICSImportMetadata = { feedId: string; readOnly: true; retentionUntil: string | null; snapshots: { revision: number; sha256: string; originalText: string | null; importedAt: string; fromDate: string; toDate: string }[]; components: ICSComponentVersion[] }
/** Roster rows keep the local wall times read from the file, so evidence checks do not depend on later time-zone rule updates. */
export type CSVRecordValue = { kind: 'calendar'; date: string; status: 'open' | 'closed' | 'withdrawn' } | { kind: 'roster'; status: 'scheduled' | 'cancelled'; startAt: string; endAt: string; startLocal: string; endLocal: string }
export type CSVRowEvidence = { recordId: string; recordRevision: number; value: CSVRecordValue; digest: string; factId: string | null; rowIndex: number; lineStart: number; lineEnd: number; byteStart: number; byteEnd: number; quote: string | null; quoteSha256: string; mapped?: MappedCSVRowEvidence }
export type CSVRecordHead = { recordId: string; recordRevision: number; digest: string; factId: string | null; status: 'current' | 'expired' | 'withdrawn'; snapshotRevision: number; rowIndex: number }
export type CSVImportSnapshot = { revision: number; fingerprint: string; bodyHash: string; importedAt: string; fromDate: string; toDate: string; retentionUntil: string | null; rows: CSVRowEvidence[]; mapping?: CSVMappingBinding }
export type CSVImportMetadata = { format: 'calendar' | 'roster'; feedId: string; readOnly: true; retentionUntil: string | null; retiredAt: string | null; target: { bindingId: string; bindingRevision: number; calendarId: string; activityId: string | null; timezone: string; personRef: string | null; personRefHash: string | null }; heads: CSVRecordHead[]; snapshots: CSVImportSnapshot[]; mapping?: CSVMappingBinding; mappingHistory?: { fingerprint: string; sequence: number }[]; identityReview?: boolean }
export type ScheduleSource = { id: string; contextId: string; title: string; authorityScope: 'calendar' | 'activity' | 'roster'; coverageFrom: string; coverageTo: string; status: 'current' | 'stale'; revision: number; importedAt: string; bodyHash: string; ics?: ICSImportMetadata; csv?: CSVImportMetadata; acquisition?: { provider: 'ics_url' | 'file_watch' | 'caldav'; qaFixture: boolean; staleByFetch: boolean } }
type FactBase = { id: string; sourceId: string; contextId: string; revision: number; validity: 'active' | 'withdrawn'; supersedes: string[] }
export type ScheduleFact = FactBase & (
  { kind: 'open'; calendarId: string; date: string } |
  { kind: 'closed'; calendarId: string; date: string } |
  { kind: 'substitute_pattern'; calendarId: string; date: string; patternWeekday: number; mode: 'replace' | 'add' } |
  { kind: 'reschedule'; activityId: string; originalDate: string; newDate: string } |
  { kind: 'cancel'; activityId: string; originalDate: string } |
  { kind: 'roster_assignment'; activityId: string; externalId: string; personRef: string; published: boolean; status: 'scheduled' | 'cancelled'; startAt: string; endAt: string } |
  { kind: 'external_event'; activityId: string; externalId: string; status: 'scheduled' | 'cancelled'; startAt: string; endAt: string; timezone: string; allDay: boolean; title: string }
)
/** dueTime (HH:mm) is optional and only stored when the person set a clock deadline, so older rules keep their digest. */
export type CalendarRuleStep = { key: string; title: string; kind: 'task' | 'event'; scheduledOffsetDays: number; dueOffsetDays: number | null; score: ScoreInput | null; durationMinutes: number | null; dueTime?: string }
export type RecurrenceUnfinishedPolicy = 'keep_all' | 'keep_latest' | 'generate_after_completion'
/** Design 5.4: keep_all unless the person chooses otherwise; past occurrences are never notified in bulk. */
export const defaultUnfinishedPolicy: RecurrenceUnfinishedPolicy = 'keep_all'
/** dtstart, RDATE and EXDATE are local wall date-times (YYYY-MM-DDTHH:mm) in the rule context's IANA time zone. */
export type RRuleCalendarTrigger = { kind: 'rrule'; dtstart: string; rrule: string; rdates: string[]; exdates: string[]; nonexistentTime: NonexistentTimePolicy; ambiguousTime: AmbiguousTimePolicy }
export type CompletionRelativeTrigger = { kind: 'completion_relative'; firstDate: string; time: string; afterDays: number; unfinishedPolicy: RecurrenceUnfinishedPolicy }
export type CalendarRuleTrigger =
  { kind: 'weekly'; weekdays: number[]; time: string } |
  { kind: 'monthly_business'; ordinal: number; from: 'start' | 'end'; time: string } |
  { kind: 'activity_relative'; activityId: string; edge: 'start' | 'end'; offsetDays: number; offsetMinutes: number } |
  RRuleCalendarTrigger | CompletionRelativeTrigger
export type CalendarRule = { id: string; contextId: string; bindingId: string; calendarId: string; title: string; originBasis: 'user_instruction' | 'user_approved_rule'; enabled: boolean; validFrom: string; validTo: string; revision: number; steps: CalendarRuleStep[]; trigger: CalendarRuleTrigger; editions?: CalendarRuleEdition[] }
export type CalendarRuleEdition = { id: string; revision: number; scope: CalendarChangeScope; definition: Pick<CalendarRule, 'title' | 'enabled' | 'steps' | 'trigger'> }
export type FactRef = { sourceId: string; factId: string; revision: number }
/** dueAt (UTC) is present only for a clock deadline; dueDate stays its local date in the context time zone. */
export type ResolvedCalendarSpec = { generationKey: string; triggerKey: string; stepKey: string; contextId: string; bindingId: string; activityId: string | null; ruleId: string | null; kind: 'task' | 'event'; title: string; scheduledDate: string | null; dueDate: string | null; score: ScoreInput | null; startAt: string | null; endAt: string | null; eventKind: 'class' | 'meeting' | 'other' | null; timezone: string; sourceRefs: FactRef[]; originBasis: 'activity' | CalendarRule['originBasis']; dueAt?: string }
export type CalendarInstance = { generationKey: string; entityId: string; entityRevision: number; status: 'active' | 'cancelled'; spec: ResolvedCalendarSpec }
export type CalendarRulesState = { id: 'main'; ownerId: string; datasetId: string; revision: number; contexts: CalendarContext[]; bindings: ParticipationBinding[]; calendars: BusinessCalendar[]; activities: CalendarActivity[]; sources: ScheduleSource[]; facts: ScheduleFact[]; rules: CalendarRule[]; instances: CalendarInstance[] }
export type ResolverConflict = { key: string; contextId: string; reason: string; sourceRefs: FactRef[] }
export type CalendarTruncation = { series: string; limit: number; omitted: number; firstOmittedDate: string; reason: string }
export type ResolverNotice = { key: string; contextId: string; reason: string }
export type ResolverResult = { occurrences: ResolvedCalendarSpec[]; cancellations: { generationKey: string; reason: string; sourceRefs: FactRef[] }[]; conflicts: ResolverConflict[]; blockedSeries: string[]; coveredSeries: string[]; truncatedSeries: CalendarTruncation[]; notices: ResolverNotice[] }
/** completedAt is the current completion instant; completion-relative series use it to place the next occurrence. */
export type CurrentCalendarEntity = { generationKey: string; entityId: string; revision: number; status: 'active' | 'cancelled'; completed: boolean; edited: boolean; started: boolean; spec: ResolvedCalendarSpec; completedAt?: string | null }
/** Completion progress of existing occurrences, keyed by generation key. completedDate is local to the occurrence's time zone. */
export type CalendarProgress = Record<string, { completedDate: string | null; scheduledDate: string | null }>
export type CalendarResolveOptions = { progress?: CalendarProgress; today?: string }
export type CalendarChangeScope = { kind: 'all_uncompleted' } | { kind: 'this_and_future'; fromDate: string } | { kind: 'this_instance'; generationKey: string }
export type CalendarChangePlan = { stateRevision: number; ownerId: string; datasetId: string; from: string; to: string; scope: CalendarChangeScope; creates: ResolvedCalendarSpec[]; updates: { before: CurrentCalendarEntity; after: ResolvedCalendarSpec }[]; cancels: { before: CurrentCalendarEntity; reason: string; sourceRefs: FactRef[] }[]; conflicts: ResolverConflict[]; skippedCompleted: number; unchanged: number; truncatedSeries: CalendarTruncation[]; notices: ResolverNotice[]; digest: string }

const dayOfWeek = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay()
const inRange = (date: string, from: string, to: string) => date >= from && date <= to
const ref = (fact: ScheduleFact): FactRef => ({ sourceId: fact.sourceId, factId: fact.id, revision: fact.revision })
const refs = (facts: ScheduleFact[]) => facts.map(ref).sort((a, b) => a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0)
const sortSpecs = (a: ResolvedCalendarSpec, b: ResolvedCalendarSpec) => a.generationKey < b.generationKey ? -1 : a.generationKey > b.generationKey ? 1 : 0
const series = (spec: ResolvedCalendarSpec) => spec.ruleId ? `rule:${spec.ruleId}` : `activity:${spec.activityId}`
function wallParts(at: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))
  const p = Object.fromEntries(parts.map(item => [item.type, item.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, utc: Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) }
}
export const calendarDateAt = (at: string, timezone: string) => wallParts(Date.parse(at), timezone).date
export const calendarTimeAt = (at: string, timezone: string) => wallParts(Date.parse(at), timezone).time
function shiftCalendarDays(at: string, days: number, timezone: string) {
  if (days === 0) return { at, reason: null }
  const wall = wallParts(Date.parse(at), timezone)
  return resolveLocalCalendarTime(addDays(wall.date, days), wall.time, timezone)
}
export function resolveLocalCalendarTime(date: string, time: string, timezone: string): { at: string | null; reason: string | null } {
  validateDate(date, '予定日')
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('予定の時刻が不正です')
  const naive = Date.parse(`${date}T${time}:00.000Z`), offsets = new Set<number>()
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) { const at = naive + hours * 3600000; offsets.add(wallParts(at, timezone).utc - at) }
  const matches = [...offsets].map(offset => naive - offset).filter(at => { const p = wallParts(at, timezone); return p.date === date && p.time === time })
  if (matches.length !== 1) return { at: null, reason: matches.length ? '夏時間の切替で同じ時刻が二度あります。正式なUTC時刻を確認してください' : 'このタイムゾーンでは存在しない時刻です。正式な時刻を確認してください' }
  return { at: new Date(matches[0]).toISOString(), reason: null }
}
function dates(from: string, to: string, maximum = 366): string[] {
  validateDate(from, '開始日'); validateDate(to, '終了日')
  const count = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000)
  if (count < 0 || count > maximum) throw new Error('計算期間は順序の正しい367日以内にしてください')
  return Array.from({ length: count + 1 }, (_, day) => addDays(from, day))
}
function activeFacts(state: CalendarRulesState, contextId: string) {
  const at = new Date().toISOString()
  return state.facts.filter(fact => fact.contextId === contextId && fact.validity === 'active' && state.sources.some(source => source.id === fact.sourceId && source.contextId === contextId && source.status === 'current' && (!source.csv || !source.csv.retiredAt && source.csv.heads.some(head => head.factId === fact.id && head.recordRevision === fact.revision && head.status === 'current' && csvHeadHasRetainedEvidence(source.csv!, head, at)))))
}
/** Feed-independent CSV shift key, scoped by activity so equal shift IDs of different rosters never meet (kept under the 200-character ID limit). */
export const csvRosterTriggerKey = (activityId: string, recordId: string) => `roster-csv:${activityId}:${recordId.slice('sha256:'.length, 'sha256:'.length + 40)}`
/** The earliest deadline the person chose applies to every stored copy; a later import can shorten but never extend it. */
export function csvSnapshotRetentionUntil(csv: Pick<CSVImportMetadata, 'retentionUntil'>, snapshot: Pick<CSVImportSnapshot, 'retentionUntil'>): string | null {
  return [snapshot.retentionUntil, csv.retentionUntil].filter((value): value is string => value !== null).sort()[0] ?? null
}
/** A retained quote establishes a current record; a fingerprint alone cannot restore it. */
export function csvHeadHasRetainedEvidence(csv: CSVImportMetadata, head: CSVRecordHead, at = new Date().toISOString()): boolean {
  if (head.status === 'expired') return false
  const snapshot = csv.snapshots.find(row => row.revision === head.snapshotRevision)
  const evidence = snapshot?.rows.find(row => row.rowIndex === head.rowIndex), until = snapshot ? csvSnapshotRetentionUntil(csv, snapshot) : null
  return Boolean(snapshot && (until === null || until > at) && evidence && evidence.quote !== null && evidence.recordId === head.recordId && evidence.recordRevision === head.recordRevision && evidence.digest === head.digest && evidence.factId === head.factId)
}
function unsuperseded<T extends ScheduleFact>(facts: T[]): T[] {
  return facts.filter(fact => !facts.some(other => other.id !== fact.id && other.supersedes.includes(fact.id)))
}
function businessStatus(calendar: BusinessCalendar, date: string, facts: ScheduleFact[], overrides: ScheduleFact[] = []) {
  const candidates = facts.filter(fact => (fact.kind === 'open' || fact.kind === 'closed') && fact.calendarId === calendar.id && fact.date === date && !overrides.some(other => other.supersedes.includes(fact.id)))
  const relevant = unsuperseded(candidates), open = relevant.filter(fact => fact.kind === 'open'), closed = relevant.filter(fact => fact.kind === 'closed')
  return { open: inRange(date, calendar.validFrom, calendar.validTo) && (open.length ? true : closed.length ? false : calendar.weekdays.includes(dayOfWeek(date))), conflict: Boolean(open.length && closed.length), facts: relevant }
}
function applicable(state: CalendarRulesState, contextId: string, bindingId: string, date: string) {
  const context = state.contexts.find(item => item.id === contextId), binding = state.bindings.find(item => item.id === bindingId && item.contextId === contextId)
  return context && binding && binding.confirmed && binding.personId === state.ownerId && inRange(date, context.validFrom, context.validTo) && inRange(date, binding.validFrom, binding.validTo) ? { context, binding } : null
}
function csvSourceNeedsReview(state: CalendarRulesState, source: ScheduleSource, from: string, to: string, at: string) {
  const csv = source.csv
  // A source the person retired contributes no facts and no longer holds its series for review.
  if (!csv || csv.retiredAt) return false
  if (csv.identityReview) return true
  const overlaps = (left: string, right: string) => left <= to && right >= from
  const binding = state.bindings.find(row => row.id === csv.target.bindingId && row.contextId === source.contextId)
  const context = state.contexts.find(row => row.id === source.contextId)
  // Only the fields the CSV target depends on count as drift; unrelated binding edits do not hold the series.
  const drifted = !binding?.confirmed || binding.personId !== state.ownerId || context?.timezone !== csv.target.timezone || csv.format === 'roster' && (binding.personRef !== csv.target.personRef || !binding.activityIds.includes(csv.target.activityId!))
  if ((source.status === 'stale' || drifted) && overlaps(source.coverageFrom, source.coverageTo)) return true
  return csv.heads.some(head => {
    if (csvHeadHasRetainedEvidence(csv, head, at)) return false
    const fact = state.facts.find(row => row.id === head.factId)
    if (fact && 'date' in fact) return inRange(fact.date, from, to)
    if (fact?.kind === 'roster_assignment') return overlaps(calendarDateAt(fact.startAt, csv.target.timezone), calendarDateAt(fact.endAt, csv.target.timezone))
    const snapshot = csv.snapshots.find(row => row.revision === head.snapshotRevision)
    const evidence = snapshot?.rows.find(row => row.rowIndex === head.rowIndex)
    if (evidence?.value.kind === 'calendar') return inRange(evidence.value.date, from, to)
    if (evidence?.value.kind === 'roster') return overlaps(calendarDateAt(evidence.value.startAt, csv.target.timezone), calendarDateAt(evidence.value.endAt, csv.target.timezone))
    return Boolean(snapshot && overlaps(snapshot.fromDate, snapshot.toDate))
  })
}

const versionOf = (base: CalendarRule, index: number): CalendarRule => index < 0 ? base : { ...base, ...base.editions![index].definition }
const primaryStepKey = (rule: Pick<CalendarRule, 'steps'>) => rule.steps.find(step => step.kind === 'task')?.key ?? rule.steps[0]?.key ?? 'main'
/** editionDate (the base date) picks the version that places the item; contentDate (the item's own date) picks the version that governs its content. */
type ChainItem = { index: number; key: string; date: string; time: string; editionDate: string; contentDate: string; superseded: boolean }
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000)
/** Completion-relative identity is the chain position, so undo/re-completion moves the same next item instead of adding one. */
function completionChain(base: CalendarRule, today: string, progress: CalendarProgress): ChainItem[] {
  const editions = base.editions ?? [], stepKey = primaryStepKey(base), generation = (key: string) => `calendar:rule:${base.id}:${key}:${stepKey}`
  const pick = (key: string, date: string) => chosenEdition(base, generation(key), key, date)
  let firstIndex: number | null = null
  for (let index = editions.length - 1; index >= -1; index--) { const rule = versionOf(base, index); if (rule.trigger.kind === 'completion_relative' && pick('chain:0', rule.trigger.firstDate) === index) { firstIndex = index; break } }
  const items: ChainItem[] = [], first = firstIndex === null ? null : versionOf(base, firstIndex)
  if (!first || first.trigger.kind !== 'completion_relative' || !first.enabled) return items
  items.push({ index: 0, key: 'chain:0', date: first.trigger.firstDate, time: first.trigger.time, editionDate: first.trigger.firstDate, contentDate: first.trigger.firstDate, superseded: false })
  // Every step needs a recorded completion or a due rollover, so the walk ends by itself; the display cap applies only to the window.
  // This bound depends on the data and only guards against corrupt completion records.
  const bound = (Object.keys(progress).length + 1) * (Math.max(0, daysBetween(first.trigger.firstDate, today > base.validTo ? today : base.validTo)) + 2)
  for (let index = 1; ; index++) {
    if (index > bound) throw new Error('完了起点の系列を計算できません。完了記録を確認してください')
    const previous = items[index - 1], previousRule = versionOf(base, pick(previous.key, previous.editionDate)), key = `chain:${index}`
    if (previousRule.trigger.kind !== 'completion_relative') break
    const done = progress[generation(previous.key)]?.completedDate ?? null, later = progress[generation(key)]
    let baseDate: string, fixedDate: string | null = null, rollover = false
    if (done) baseDate = done
    else if (later?.completedDate && later.scheduledDate) { baseDate = previous.date; fixedDate = later.scheduledDate }
    else if (previousRule.trigger.unfinishedPolicy !== 'generate_after_completion' && addDays(previous.date, previousRule.trigger.afterDays) <= today) { baseDate = previous.date; rollover = true }
    else break
    const rule = versionOf(base, pick(key, baseDate))
    if (!rule.enabled || rule.trigger.kind !== 'completion_relative') break
    const step = rule.steps.find(row => row.key === stepKey), date = fixedDate ? addDays(fixedDate, -(step?.scheduledOffsetDays ?? 0)) : addDays(baseDate, rule.trigger.afterDays)
    if (date > base.validTo) break
    // A "from this date onward" change applies by the item's own date, as the change plan's scope does.
    const governing = versionOf(base, pick(key, date))
    if (!governing.enabled || governing.trigger.kind !== 'completion_relative') break
    if (rollover && previousRule.trigger.unfinishedPolicy === 'keep_latest') previous.superseded = true
    items.push({ index, key, date, time: governing.trigger.time, editionDate: baseDate, contentDate: date, superseded: false })
  }
  return items
}
const occurrenceDate = (spec: Pick<ResolvedCalendarSpec, 'scheduledDate' | 'startAt' | 'timezone'>) => spec.scheduledDate ?? calendarDateAt(spec.startAt!, spec.timezone)

export function resolveCalendarOccurrences(state: CalendarRulesState, from: string, to: string, retainedKeys: string[] = [], options: CalendarResolveOptions = {}): ResolverResult {
  const evaluatedAt = new Date().toISOString(), progress = options.progress ?? {}
  if (options.today !== undefined) validateDate(options.today, '基準日')
  dates(from, to)
  const versions = state.rules.flatMap(base => [{ base, editionIndex: -1, rule: base }, ...(base.editions ?? []).map((edition, editionIndex) => ({ base, editionIndex, rule: { ...base, ...edition.definition } }))])
  const offsets = versions.flatMap(({ rule }) => rule.steps.map(step => step.scheduledOffsetDays + (rule.trigger.kind === 'activity_relative' ? rule.trigger.offsetDays + Math.ceil(Math.abs(rule.trigger.offsetMinutes) / 1440) * Math.sign(rule.trigger.offsetMinutes) : 0)))
  const expandedFrom = addDays(from, -Math.max(0, ...offsets) - 1), expandedTo = addDays(to, -Math.min(0, ...offsets) + 1)
  const window = dates(expandedFrom, expandedTo, 1830), occurrences: ResolvedCalendarSpec[] = [], cancellations: ResolverResult['cancellations'] = [], conflicts: ResolverConflict[] = [], blocked = new Set<string>()
  const truncatedSeries: CalendarTruncation[] = [], notices: ResolverNotice[] = [], chains = new Map<string, ChainItem[]>()
  const covered = [...state.activities.map(activity => `activity:${activity.id}`), ...state.rules.map(rule => `rule:${rule.id}`)]
  const activityOccurrences: ResolvedCalendarSpec[] = [], activityCancels: { activityId: string; triggerKey: string; sourceRefs: FactRef[]; reason: string }[] = []
  function conflict(key: string, contextId: string, reason: string, facts: ScheduleFact[] = []) { conflicts.push({ key, contextId, reason, sourceRefs: refs(facts) }) }
  for (const activity of state.activities) {
    const context = state.contexts.find(item => item.id === activity.contextId), calendar = state.calendars.find(item => item.id === activity.calendarId && item.contextId === activity.contextId)
    if (!context || !calendar) { blocked.add(`activity:${activity.id}`); conflict(`activity:${activity.id}`, activity.contextId, '名前付きカレンダーまたは対象が未設定です'); continue }
    const ownBinding = state.bindings.find(item => item.id === activity.bindingId && item.contextId === context.id)
    if (!ownBinding?.confirmed || ownBinding.personId !== state.ownerId || !ownBinding.activityIds.includes(activity.id)) { blocked.add(`activity:${activity.id}`); conflict(`activity:${activity.id}`, activity.contextId, '活動と本人の適用条件を確認してください'); continue }
    const facts = activeFacts(state, activity.contextId)
    if (state.sources.some(source => source.contextId === activity.contextId && source.status === 'stale' && !source.ics && !source.csv)) { blocked.add(`activity:${activity.id}`); conflict(`activity:${activity.id}`, activity.contextId, '資料の取得状態が古いため、休業・取消と判断しません'); continue }
    if (state.sources.some(source => source.contextId === activity.contextId && source.csv && (source.csv.format === 'calendar' && source.csv.target.calendarId === activity.calendarId || source.csv.format === 'roster' && source.csv.target.activityId === activity.id) && csvSourceNeedsReview(state, source, expandedFrom, expandedTo, evaluatedAt))) { blocked.add(`activity:${activity.id}`); conflict(`activity:${activity.id}`, activity.contextId, 'CSV資料の行の保持期限・本人適用・版を確認してください。欠落は予定の取消と判断しません'); continue }
    const externalForActivity = state.facts.filter((fact): fact is Extract<ScheduleFact, { kind: 'external_event' }> => fact.kind === 'external_event' && fact.activityId === activity.id)
    if (externalForActivity.some(fact => state.sources.some(source => source.id === fact.sourceId && (source.status === 'stale' || source.ics?.retentionUntil !== null && source.ics?.retentionUntil !== undefined && source.ics.retentionUntil <= evaluatedAt)))) { blocked.add(`activity:${activity.id}`); conflict(`activity:${activity.id}`, activity.contextId, 'ICSの保持期限・取得状態を確認してください。予定の取消とは判断しません'); continue }
    function emit(triggerKey: string, date: string, selectedFacts: ScheduleFact[], explicitTimes?: { startAt: string; endAt: string }) {
      const retained = retainedKeys.includes(`calendar:activity:${activity.id}:${triggerKey}`) || state.rules.some(rule => rule.trigger.kind === 'activity_relative' && rule.trigger.activityId === activity.id && rule.steps.some(step => retainedKeys.includes(`calendar:rule:${rule.id}:${triggerKey}:${step.key}`)))
      if (!inRange(date, expandedFrom, expandedTo) && !retained) return
      const participation = applicable(state, activity.contextId, activity.bindingId, date)
      if (!participation || !participation.binding.activityIds.includes(activity.id) || !inRange(date, activity.validFrom, activity.validTo)) { blocked.add(`activity:${activity.id}`); conflict(triggerKey, activity.contextId, '本人の適用条件と有効期間を確認してください', selectedFacts); return }
      const status = businessStatus(calendar!, date, facts, selectedFacts)
      if (status.conflict || (selectedFacts.some(fact => fact.kind === 'roster_assignment' || fact.kind === 'reschedule' || fact.kind === 'substitute_pattern') && status.facts.some(fact => fact.kind === 'closed'))) { blocked.add(`activity:${activity.id}`); conflict(triggerKey, activity.contextId, '具体的な勤務・活動と休業の根拠が矛盾しています', [...selectedFacts, ...status.facts]); return }
      const start = explicitTimes ?? { startAt: resolveLocalCalendarTime(date, activity.startTime, context!.timezone).at, endAt: resolveLocalCalendarTime(addDays(date, activity.endDayOffset), activity.endTime, context!.timezone).at }
      if (!start.startAt || !start.endAt || Date.parse(start.endAt) <= Date.parse(start.startAt)) { blocked.add(`activity:${activity.id}`); conflict(triggerKey, activity.contextId, '開始・終了時刻が不明、夏時間で曖昧、または順序が不正です', selectedFacts); return }
      const spec: ResolvedCalendarSpec = { generationKey: `calendar:activity:${activity.id}:${triggerKey}`, triggerKey, stepKey: 'activity', contextId: context!.id, bindingId: activity.bindingId, activityId: activity.id, ruleId: null, kind: 'event', title: activity.title, scheduledDate: null, dueDate: null, score: null, startAt: start.startAt, endAt: start.endAt, eventKind: activity.eventKind, timezone: context!.timezone, sourceRefs: refs([...selectedFacts, ...status.facts]), originBasis: 'activity' }
      activityOccurrences.push(spec); if (inRange(date, from, to) || retainedKeys.includes(spec.generationKey)) occurrences.push(spec)
    }
    function cancel(triggerKey: string, reason: string, selectedFacts: ScheduleFact[]) {
      cancellations.push({ generationKey: `calendar:activity:${activity.id}:${triggerKey}`, reason, sourceRefs: refs(selectedFacts) }); activityCancels.push({ activityId: activity.id, triggerKey, reason, sourceRefs: refs(selectedFacts) })
    }
    const anchors = new Set(window)
    for (const fact of facts) if ((fact.kind === 'reschedule' || fact.kind === 'cancel') && fact.activityId === activity.id && (inRange(fact.originalDate, expandedFrom, expandedTo) || fact.kind === 'reschedule' && inRange(fact.newDate, expandedFrom, expandedTo) || retainedKeys.some(key => key.includes(`:anchor:${fact.originalDate}`)))) anchors.add(fact.originalDate)
    for (const anchor of [...anchors].sort()) {
      const participation = applicable(state, activity.contextId, activity.bindingId, anchor)
      if (!participation || !participation.binding.activityIds.includes(activity.id) || !activity.weekdays.includes(dayOfWeek(anchor)) || !participation.binding.weekdays.includes(dayOfWeek(anchor)) || !inRange(anchor, activity.validFrom, activity.validTo)) continue
      const triggerKey = `anchor:${anchor}`, modifications = unsuperseded(facts.filter((fact): fact is Extract<ScheduleFact, { kind: 'cancel' | 'reschedule' }> => (fact.kind === 'cancel' || fact.kind === 'reschedule') && fact.activityId === activity.id && fact.originalDate === anchor))
      const moves = modifications.filter(fact => fact.kind === 'reschedule'), cancels = modifications.filter(fact => fact.kind === 'cancel')
      if (cancels.length && moves.length || new Set(moves.map(fact => fact.newDate)).size > 1) { blocked.add(`activity:${activity.id}`); conflict(triggerKey, activity.contextId, '取消・振替の事実が矛盾しています', modifications); continue }
      if (cancels.length) { cancel(triggerKey, '明示された活動の取消', cancels); continue }
      const actual = moves[0]?.newDate ?? anchor
      const substitutes = unsuperseded(facts.filter((fact): fact is Extract<ScheduleFact, { kind: 'substitute_pattern' }> => fact.kind === 'substitute_pattern' && fact.calendarId === calendar.id && fact.date === actual))
      if (!moves.length && substitutes.some(fact => fact.mode === 'replace')) { cancel(triggerKey, '曜日パターンの明示的な置換', substitutes); continue }
      const status = businessStatus(calendar, actual, facts)
      if (status.conflict) { blocked.add(`activity:${activity.id}`); conflict(triggerKey, activity.contextId, '営業・休業の事実が矛盾しています', status.facts); continue }
      if (!moves.length && !status.open) { if (status.facts.length) cancel(triggerKey, '明示された休業', status.facts); continue }
      emit(triggerKey, actual, modifications)
    }
    const substitutes = facts.filter((fact): fact is Extract<ScheduleFact, { kind: 'substitute_pattern' }> => fact.kind === 'substitute_pattern' && fact.calendarId === calendar.id && (inRange(fact.date, expandedFrom, expandedTo) || retainedKeys.some(key => key.includes(`:substitute:${fact.id}`))))
    for (const fact of substitutes) {
      const sameDate = unsuperseded(substitutes.filter(other => other.date === fact.date))
      if (!sameDate.some(other => other.id === fact.id)) continue
      if (sameDate.length > 1) { blocked.add(`activity:${activity.id}`); conflict(`substitute:${fact.id}`, activity.contextId, '同日の振替が複数あります。置換する事実と振替IDを確認してください', sameDate); continue }
      const binding = state.bindings.find(item => item.id === activity.bindingId)
      if (activity.weekdays.includes(fact.patternWeekday) && binding?.weekdays.includes(fact.patternWeekday)) emit(`substitute:${fact.id}`, fact.date, [fact])
    }
    const binding = state.bindings.find(item => item.id === activity.bindingId)
    const rosterFacts = facts.filter((fact): fact is Extract<ScheduleFact, { kind: 'roster_assignment' }> => {
      if (fact.kind !== 'roster_assignment' || fact.activityId !== activity.id || !fact.published || !binding?.confirmed || binding.personId !== state.ownerId || binding.personRef === null) return false
      const csv = state.sources.find(source => source.id === fact.sourceId)?.csv
      return csv ? csv.format === 'roster' && csv.target.bindingId === binding.id && csv.target.personRef === binding.personRef && fact.personRef === csv.target.personRefHash : fact.personRef === binding.personRef
    })
    // CSV shifts are identified by the stable external record, not by the feed, so a replacement feed
    // updates the same occurrence and two feeds reporting one shift differently become a conflict.
    const rosterIdentity = (fact: Extract<ScheduleFact, { kind: 'roster_assignment' }>) => state.sources.find(source => source.id === fact.sourceId)?.csv ? `csv:${fact.externalId}` : `${fact.sourceId}:${fact.externalId}`
    for (const identity of new Set(rosterFacts.map(rosterIdentity))) {
      const candidates = unsuperseded(rosterFacts.filter(fact => rosterIdentity(fact) === identity)), fact = candidates[0]
      if (!fact) continue
      const triggerKey = identity.startsWith('csv:') ? csvRosterTriggerKey(activity.id, identity.slice(4)) : `roster:${identity}`
      if (new Set(candidates.map(candidate => `${candidate.status}:${candidate.startAt}:${candidate.endAt}`)).size > 1) { blocked.add(`activity:${activity.id}`); conflict(triggerKey, context.id, '同じ本人シフトの日時・取消状態が矛盾しています', candidates); continue }
      const date = calendarDateAt(fact.startAt, context.timezone)
      if (!inRange(date, expandedFrom, expandedTo) && !retainedKeys.some(key => key.includes(`:${triggerKey}`))) continue
      if (fact.status === 'cancelled') cancel(triggerKey, '本人の公開勤務割当が取消された', candidates)
      else emit(triggerKey, date, candidates, fact)
    }
    const externalFacts = facts.filter((fact): fact is Extract<ScheduleFact, { kind: 'external_event' }> => fact.kind === 'external_event' && fact.activityId === activity.id)
    for (const identity of new Set(externalFacts.map(fact => `${fact.sourceId}:${fact.externalId}`))) {
      const candidates = unsuperseded(externalFacts.filter(fact => `${fact.sourceId}:${fact.externalId}` === identity)), fact = candidates[0]
      if (!fact) continue
      const triggerKey = `external:${identity}`, generationKey = `calendar:activity:${activity.id}:${triggerKey}`
      if (new Set(candidates.map(candidate => canonicalJSON({ status: candidate.status, startAt: candidate.startAt, endAt: candidate.endAt, timezone: candidate.timezone, allDay: candidate.allDay, title: candidate.title }))).size > 1) { blocked.add(`activity:${activity.id}`); conflict(triggerKey, context.id, '同じ外部予定の日時・版・取消が矛盾しています', candidates); continue }
      const date = calendarDateAt(fact.startAt, context.timezone), retained = retainedKeys.includes(generationKey)
      if (!inRange(date, expandedFrom, expandedTo) && !retained) continue
      if (fact.status === 'cancelled') { cancel(triggerKey, 'ICSに明示された予定の取消', candidates); continue }
      if (!applicable(state, activity.contextId, activity.bindingId, date) || !inRange(date, activity.validFrom, activity.validTo)) { blocked.add(`activity:${activity.id}`); conflict(triggerKey, context.id, 'ICS予定の本人適用・有効期間を確認してください', candidates); continue }
      // A real imported meeting is independent of workday/holiday defaults.
      const spec: ResolvedCalendarSpec = { generationKey, triggerKey, stepKey: 'activity', contextId: context.id, bindingId: activity.bindingId, activityId: activity.id, ruleId: null, kind: 'event', title: fact.allDay ? `${fact.title}（終日）` : fact.title, scheduledDate: null, dueDate: null, score: null, startAt: fact.startAt, endAt: fact.endAt, eventKind: activity.eventKind, timezone: context.timezone, sourceRefs: refs(candidates), originBasis: 'activity' }
      activityOccurrences.push(spec); if (inRange(date, from, to) || retained) occurrences.push(spec)
    }
  }

  for (const { base, editionIndex, rule } of versions) {
    if (!rule.enabled) continue
    const context = state.contexts.find(item => item.id === rule.contextId), calendar = state.calendars.find(item => item.id === rule.calendarId && item.contextId === rule.contextId)
    if (!context || !calendar) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}`, rule.contextId, '本人のカレンダーを選択してください'); continue }
    const binding = state.bindings.find(item => item.id === rule.bindingId && item.contextId === context.id)
    if (!binding?.confirmed || binding.personId !== state.ownerId) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}`, context.id, 'ルールの本人適用を確認してください'); continue }
    const facts = activeFacts(state, context.id)
    // RRULE and completion-relative series are pure owner-defined calendar math and never read business-day facts.
    const calendarFree = rule.trigger.kind === 'rrule' || rule.trigger.kind === 'completion_relative'
    if (rule.trigger.kind !== 'weekly' && !calendarFree && state.sources.some(source => source.contextId === context.id && source.status === 'stale' && !source.csv)) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}`, rule.contextId, '資料取得が古いため、新しい回・取消を確定しません'); continue }
    // Monthly rules are reviewed over exactly the months they evaluate, not the neighbouring months of the ±1-day window.
    const stepOffsets = rule.steps.map(step => step.scheduledOffsetDays), monthlyFrom = addDays(from, -Math.max(0, ...stepOffsets)), monthlyTo = addDays(to, -Math.min(0, ...stepOffsets))
    const calendarFrom = rule.trigger.kind === 'monthly_business' ? `${monthlyFrom.slice(0, 7)}-01` : expandedFrom
    const calendarTo = rule.trigger.kind === 'monthly_business' ? new Date(Date.UTC(Number(monthlyTo.slice(0, 4)), Number(monthlyTo.slice(5, 7)), 0)).toISOString().slice(0, 10) : expandedTo
    if (!calendarFree && state.sources.some(source => source.contextId === context.id && source.csv && (source.csv.format === 'calendar' && source.csv.target.calendarId === rule.calendarId || source.csv.format === 'roster' && rule.trigger.kind === 'activity_relative' && source.csv.target.activityId === rule.trigger.activityId) && csvSourceNeedsReview(state, source, calendarFrom, calendarTo, evaluatedAt))) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}`, rule.contextId, 'CSV資料の行の保持期限・本人適用・版を確認してください。新しい回と取消を確定しません'); continue }
    // editionDate is the date each version gate uses, so the step and its trigger pick the same rule version.
    const triggers: { key: string; at: string; editionDate: string; sourceRefs: FactRef[]; activityId: string | null }[] = []
    if (rule.trigger.kind === 'activity_relative') {
      const trigger = rule.trigger
      if (blocked.has(`activity:${trigger.activityId}`)) { blocked.add(`rule:${rule.id}`); continue }
      for (const event of activityOccurrences.filter(item => item.activityId === trigger.activityId)) {
        if (!rule.steps.some(step => chosenEdition(base, `calendar:rule:${rule.id}:${event.triggerKey}:${step.key}`, event.triggerKey, calendarDateAt(event.startAt!, context.timezone)) === editionIndex)) continue
        const edge = trigger.edge === 'start' ? event.startAt! : event.endAt!
        const shifted = shiftCalendarDays(edge, trigger.offsetDays, context.timezone)
        if (!shifted.at) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}:${event.triggerKey}`, context.id, shifted.reason!); continue }
        const at = new Date(Date.parse(shifted.at) + trigger.offsetMinutes * 60000).toISOString()
        triggers.push({ key: event.triggerKey, at, editionDate: calendarDateAt(event.startAt!, context.timezone), sourceRefs: event.sourceRefs, activityId: trigger.activityId })
      }
      for (const cancelled of activityCancels.filter(item => item.activityId === trigger.activityId)) for (const step of rule.steps) cancellations.push({ generationKey: `calendar:rule:${rule.id}:${cancelled.triggerKey}:${step.key}`, reason: cancelled.reason, sourceRefs: cancelled.sourceRefs })
    } else if (rule.trigger.kind === 'weekly') {
      for (const date of window) if (rule.trigger.weekdays.includes(dayOfWeek(date))) {
        if (!rule.steps.some(step => chosenEdition(base, `calendar:rule:${rule.id}:anchor:${date}:${step.key}`, `anchor:${date}`, date) === editionIndex)) continue
        const wall = resolveLocalCalendarTime(date, rule.trigger.time, context.timezone)
        if (!wall.at) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}:${date}`, context.id, wall.reason!); continue }
        triggers.push({ key: `anchor:${date}`, at: wall.at, editionDate: date, sourceRefs: [], activityId: null })
      }
    } else if (rule.trigger.kind === 'rrule') {
      const trigger = rule.trigger
      // Window-limited expansion; the per-series cap below reports any cut explicitly. UNTIL is checked at the instant the owner's DST choice places the occurrence.
      const expansion = expandRRule({ dtstart: trigger.dtstart, rrule: trigger.rrule, from: expandedFrom, to: expandedTo, timezone: context.timezone, limit: rruleSeriesLimit * 4, dst: { nonexistent: trigger.nonexistentTime, ambiguous: trigger.ambiguousTime } })
      if (expansion.truncated) truncatedSeries.push({ series: `rule:${rule.id}`, limit: rruleSeriesLimit * 4, omitted: 1, firstOmittedDate: expansion.occurrences.at(-1)!.slice(0, 10), reason: 'RRULEの展開上限を超えたため、表示期間の先の回は計算していません' })
      // Older or imported "from this date onward" editions may have used up COUNT before their change date; say so instead of ending silently.
      const scope = editionIndex < 0 ? null : base.editions![editionIndex].scope, spec = parseRRule(trigger.rrule)
      if (scope?.kind === 'this_and_future' && spec.count !== null && trigger.dtstart.slice(0, 10) < scope.fromDate && expandedTo >= scope.fromDate && expandRRule({ dtstart: trigger.dtstart, rrule: spec, from: trigger.dtstart.slice(0, 10), to: addDays(scope.fromDate, -1), limit: spec.count + 1 }).occurrences.length >= spec.count) notices.push({ key: `rule:${rule.id}`, contextId: context.id, reason: `以後の変更の回数（COUNT）が変更日より前に尽きたため、${scope.fromDate}以後の回はありません` })
      // The original occurrence date is the identity (11.7), so a time-only edit updates the same occurrence; an EXDATE therefore
      // excludes its date even when it still carries an earlier series time. An EXDATE naming an RDATE removes only that RDATE.
      const excludedDates = new Set(trigger.exdates.filter(value => !trigger.rdates.includes(value)).map(value => value.slice(0, 10)))
      const kept = expansion.occurrences.filter(value => !excludedDates.has(value.slice(0, 10)) && !trigger.exdates.includes(value))
      // An RDATE that is not already a rule occurrence keeps its own exact local date-time key.
      const extra = trigger.rdates.filter(value => inRange(value.slice(0, 10), expandedFrom, expandedTo) && !trigger.exdates.includes(value) && !expansion.occurrences.includes(value))
      for (const [local, key] of [...kept.map(value => [value, `anchor:${value.slice(0, 10)}`]), ...extra.map(value => [value, `rdate:${value}`])]) {
        const date = local.slice(0, 10)
        if (!rule.steps.some(step => chosenEdition(base, `calendar:rule:${rule.id}:${key}:${step.key}`, key, date) === editionIndex)) continue
        const wall = resolveZonedLocalTime(date, local.slice(11), context.timezone, { nonexistent: trigger.nonexistentTime, ambiguous: trigger.ambiguousTime })
        if (!wall.at) { notices.push({ key: `rule:${rule.id}:${key}`, contextId: context.id, reason: `${date} ${local.slice(11)}は夏時間の切替で存在しないため、本人の設定どおりこの回を作りません` }); continue }
        if (wall.adjusted === 'shifted') notices.push({ key: `rule:${rule.id}:${key}`, contextId: context.id, reason: `${date} ${local.slice(11)}は夏時間の切替で存在しないため、切替前の時差で${calendarTimeAt(wall.at, context.timezone)}に作ります` })
        else if (wall.kind === 'ambiguous') notices.push({ key: `rule:${rule.id}:${key}`, contextId: context.id, reason: `${date} ${local.slice(11)}は夏時間の切替で二度あるため、本人の設定どおり${wall.adjusted === 'earlier' ? '前' : '後'}の回（${calendarTimeAt(wall.at, context.timezone)}）で作ります` })
        triggers.push({ key, at: wall.at, editionDate: date, sourceRefs: [], activityId: null })
      }
    } else if (rule.trigger.kind === 'completion_relative') {
      if (!chains.has(base.id)) {
        const today = options.today ?? calendarDateAt(evaluatedAt, context.timezone), chain = completionChain(base, today, progress)
        chains.set(base.id, chain)
        for (const item of chain.filter(row => row.superseded)) for (const step of base.steps) cancellations.push({ generationKey: `calendar:rule:${base.id}:${item.key}:${step.key}`, reason: '新しい回が始まったため、未完了・未着手の古い回を取消します（最新の回だけ残す設定）', sourceRefs: [] })
        const prefix = `calendar:rule:${base.id}:chain:`, live = new Set(chain.map(item => item.index))
        for (const key of Object.keys(progress)) {
          const position = key.startsWith(prefix) ? /^(\d+):/.exec(key.slice(prefix.length)) : null
          if (position && !live.has(Number(position[1]))) cancellations.push({ generationKey: key, reason: '前回の完了が取り消された、または周期が止まったため、未着手の次の回を取消します', sourceRefs: [] })
        }
      }
      for (const item of chains.get(base.id)!) {
        // Items outside the window are history; only the window and kept keys need instants and notices.
        if (item.superseded || !inRange(item.date, expandedFrom, expandedTo) && !base.steps.some(step => retainedKeys.includes(`calendar:rule:${base.id}:${item.key}:${step.key}`))) continue
        // Completion-relative times follow RFC 5545 (gap: offset before it; overlap: the first instant) and say so.
        const wall = resolveZonedLocalTime(item.date, item.time, context.timezone, { nonexistent: 'next_valid', ambiguous: 'earlier' })
        if (wall.adjusted !== 'none') notices.push({ key: `rule:${base.id}:${item.key}`, contextId: context.id, reason: `${item.date} ${item.time}は夏時間の切替で${wall.kind === 'nonexistent' ? `存在しないため、切替前の時差で${calendarTimeAt(wall.at!, context.timezone)}` : '二度あるため、前の回'}に作ります` })
        triggers.push({ key: item.key, at: wall.at!, editionDate: item.contentDate, sourceRefs: [], activityId: null })
      }
    } else {
      const monthlyWindow = dates(monthlyFrom, monthlyTo, 1098)
      const months = new Set(monthlyWindow.map(date => date.slice(0, 7)))
      for (const month of months) {
        const first = `${month}-01`, last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10)
        if (!rule.steps.some(step => chosenEdition(base, `calendar:rule:${rule.id}:month:${month}:${step.key}`, `month:${month}`, first) === editionIndex)) continue
        // A month the rule does not cover at all produces nothing; it is not a missing calendar.
        if (last < rule.validFrom || first > rule.validTo) continue
        if (first < calendar.validFrom || last > calendar.validTo) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}:${month}`, context.id, '月全体の本人選択カレンダーが未取得・未設定です'); continue }
        const statuses = dates(first, last).map(date => ({ date, ...businessStatus(calendar, date, facts) }))
        const contradictions = statuses.filter(status => status.conflict)
        if (contradictions.length) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}:${month}`, context.id, '月の営業日カレンダーに矛盾があります', contradictions.flatMap(status => status.facts)); continue }
        const businessDays = statuses.filter(status => status.open), chosen = rule.trigger.from === 'start' ? businessDays[rule.trigger.ordinal - 1] : businessDays[businessDays.length - rule.trigger.ordinal]
        if (!chosen) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}:${month}`, context.id, '指定した営業日順位がこの月にありません'); continue }
        if (!inRange(chosen.date, expandedFrom, expandedTo) && !rule.steps.some(step => retainedKeys.includes(`calendar:rule:${rule.id}:month:${month}:${step.key}`))) continue
        const wall = resolveLocalCalendarTime(chosen.date, rule.trigger.time, context.timezone)
        if (!wall.at) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}:${month}`, context.id, wall.reason!); continue }
        triggers.push({ key: `month:${month}`, at: wall.at, editionDate: first, sourceRefs: refs(statuses.flatMap(status => status.facts)), activityId: null })
      }
    }
    for (const trigger of triggers) {
      const date = calendarDateAt(trigger.at, context.timezone), participation = applicable(state, context.id, rule.bindingId, date)
      if (!participation || !inRange(date, rule.validFrom, rule.validTo)) continue
      for (const step of rule.steps) {
        const planned = addDays(date, step.scheduledOffsetDays)
        if (chosenEdition(base, `calendar:rule:${rule.id}:${trigger.key}:${step.key}`, trigger.key, trigger.editionDate) !== editionIndex) continue
        if (!inRange(planned, from, to) && !retainedKeys.includes(`calendar:rule:${rule.id}:${trigger.key}:${step.key}`)) continue
        if (step.score) { validateScore(step.score); if (step.score.mode === 'allocated') throw new Error('定型ステップに未承認の配分ポイントを指定できません') }
        const shifted = step.kind === 'event' ? shiftCalendarDays(trigger.at, step.scheduledOffsetDays, context.timezone) : null
        if (shifted && !shifted.at) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}:${trigger.key}:${step.key}`, context.id, shifted.reason!); continue }
        const startAt = shifted?.at ?? null, dueDate = step.kind === 'task' && step.dueOffsetDays !== null ? addDays(date, step.dueOffsetDays) : null
        const due = dueDate && step.dueTime ? resolveLocalCalendarTime(dueDate, step.dueTime, context.timezone) : null
        if (due && !due.at) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}:${trigger.key}:${step.key}`, context.id, `締め切り時刻: ${due.reason!}`); continue }
        occurrences.push({ generationKey: `calendar:rule:${rule.id}:${trigger.key}:${step.key}`, triggerKey: trigger.key, stepKey: step.key, contextId: context.id, bindingId: rule.bindingId, activityId: trigger.activityId, ruleId: rule.id, kind: step.kind, title: step.title, scheduledDate: step.kind === 'task' ? planned : null, dueDate, score: step.kind === 'task' ? { ...(step.score ?? emptyScore()) } : null, startAt, endAt: startAt ? new Date(Date.parse(startAt) + step.durationMinutes! * 60000).toISOString() : null, eventKind: step.kind === 'event' ? 'other' : null, timezone: context.timezone, sourceRefs: trigger.sourceRefs, originBasis: rule.originBasis, ...(due?.at ? { dueAt: due.at } : {}) })
      }
    }
  }
  const unique = new Map<string, ResolvedCalendarSpec>(), conflictingKeys = new Set<string>()
  for (const spec of occurrences) {
    const previous = unique.get(spec.generationKey)
    if (previous && canonicalJSON(previous) !== canonicalJSON(spec)) { conflictingKeys.add(spec.generationKey); blocked.add(series(spec)); conflict(spec.generationKey, spec.contextId, '同じ発生回の日時・内容が矛盾しています') }
    else unique.set(spec.generationKey, spec)
  }
  const bySeries = new Map<string, ResolvedCalendarSpec[]>()
  for (const spec of unique.values()) if (!conflictingKeys.has(spec.generationKey) && !blocked.has(series(spec))) bySeries.set(series(spec), [...bySeries.get(series(spec)) ?? [], spec])
  const result: ResolvedCalendarSpec[] = []
  // Design 5.4/11.6: at most 1,000 occurrences per series; the cut is reported, never silent, and later ones are computed when the person browses that range.
  for (const [name, specs] of bySeries) {
    const ordered = specs.sort((a, b) => occurrenceDate(a).localeCompare(occurrenceDate(b)) || sortSpecs(a, b))
    if (ordered.length > rruleSeriesLimit) truncatedSeries.push({ series: name, limit: rruleSeriesLimit, omitted: ordered.length - rruleSeriesLimit, firstOmittedDate: occurrenceDate(ordered[rruleSeriesLimit]), reason: `1系列${rruleSeriesLimit}回の上限を超えたため、${occurrenceDate(ordered[rruleSeriesLimit])}以降は表示期間を移して確認してください` })
    result.push(...ordered.slice(0, rruleSeriesLimit))
  }
  result.sort(sortSpecs)
  if (result.length > 5000) throw new Error('一回の展開上限を超えました。期間を短くしてください')
  return { occurrences: result, cancellations, conflicts, blockedSeries: [...blocked].sort(), coveredSeries: covered.sort(), truncatedSeries, notices: [...new Map(notices.map(item => [`${item.key}|${item.reason}`, item])).values()] }
}

function chosenEdition(base: CalendarRule, key: string, triggerKey: string, date: string) {
  let selected = -1
  for (const [index, edition] of (base.editions ?? []).entries()) {
    const scope = edition.scope, anchorDate = triggerKey.startsWith('anchor:') ? triggerKey.slice(7) : date
    if (scope.kind === 'all_uncompleted' || scope.kind === 'this_instance' && scope.generationKey === key || scope.kind === 'this_and_future' && (triggerKey.startsWith('month:') ? triggerKey.slice(6) >= scope.fromDate.slice(0, 7) : anchorDate >= scope.fromDate)) selected = index
  }
  return selected
}
/** True only when every rule version that can still govern this key no longer produces the step from the same activity. */
function ruleStepDroppedByPerson(state: CalendarRulesState, spec: ResolvedCalendarSpec): boolean {
  if (!spec.ruleId) return false
  const base = state.rules.find(rule => rule.id === spec.ruleId)
  if (!base) return false
  const editions = base.editions ?? []
  // The latest recorded version of this CSV shift decides which "this and future" edition governs the key;
  // older versions' dates no longer describe where the shift is.
  const versions = state.facts.filter((fact): fact is Extract<ScheduleFact, { kind: 'roster_assignment' }> => fact.kind === 'roster_assignment' && fact.activityId === spec.activityId && Boolean(state.sources.find(source => source.id === fact.sourceId)?.csv) && csvRosterTriggerKey(fact.activityId, fact.externalId) === spec.triggerKey)
  const latest = Math.max(0, ...versions.map(fact => fact.revision))
  const shiftDates = [...new Set(versions.filter(fact => fact.revision === latest).map(fact => calendarDateAt(fact.startAt, spec.timezone)))]
  let indexes: number[]
  if (shiftDates.length) indexes = shiftDates.map(date => chosenEdition(base, spec.generationKey, spec.triggerKey, date))
  else {
    let start = -1
    editions.forEach((edition, index) => { if (edition.scope.kind === 'all_uncompleted' || edition.scope.kind === 'this_instance' && edition.scope.generationKey === spec.generationKey) start = index })
    indexes = [start, ...editions.flatMap((edition, index) => index > start && edition.scope.kind === 'this_and_future' ? [index] : [])]
  }
  return [...new Set(indexes)].map(index => index < 0 ? base : { ...base, ...editions[index].definition }).every(rule => !rule.enabled || !rule.steps.some(step => step.key === spec.stepKey) || rule.trigger.kind !== 'activity_relative' || rule.trigger.activityId !== spec.activityId)
}
/** Completion dates are read in each occurrence's own time zone; a completed row without an instant keeps its planned date. */
export function calendarProgress(current: CurrentCalendarEntity[]): CalendarProgress {
  return Object.fromEntries(current.map(item => [item.generationKey, { completedDate: item.completed ? item.completedAt ? calendarDateAt(item.completedAt, item.spec.timezone) : occurrenceDate(item.spec) : null, scheduledDate: item.spec.scheduledDate }]))
}
export function buildCalendarChangePlan(state: CalendarRulesState, current: CurrentCalendarEntity[], from: string, to: string, scope: CalendarChangeScope = { kind: 'all_uncompleted' }, options: { today?: string } = {}): Omit<CalendarChangePlan, 'digest'> {
  if (scope.kind === 'this_and_future') validateDate(scope.fromDate, '以後の変更日')
  const creates: ResolvedCalendarSpec[] = [], updates: CalendarChangePlan['updates'] = [], cancels: CalendarChangePlan['cancels'] = []
  let skippedCompleted = 0, unchanged = 0
  function included(spec: ResolvedCalendarSpec) {
    const date = spec.scheduledDate ?? calendarDateAt(spec.startAt!, spec.timezone)
    return inRange(date, from, to) && (scope.kind === 'all_uncompleted' || scope.kind === 'this_and_future' && date >= scope.fromDate || scope.kind === 'this_instance' && spec.generationKey === scope.generationKey)
  }
  const resolved = resolveCalendarOccurrences(state, from, to, current.filter(item => included(item.spec)).map(item => item.generationKey), { progress: calendarProgress(current), ...(options.today ? { today: options.today } : {}) }), conflicts = [...resolved.conflicts]
  for (const spec of resolved.occurrences) {
    const before = current.find(item => item.generationKey === spec.generationKey)
    if (!included(spec) && (!before || !included(before.spec))) continue
    if (before?.completed) { skippedCompleted++; continue }
    if (!before) { creates.push(spec); continue }
    if (before.status === 'active' && canonicalJSON(before.spec) === canonicalJSON(spec)) { if (before.spec.kind === 'event' && before.edited) conflicts.push({ key: spec.generationKey, contextId: spec.contextId, reason: '本人編集した予定です。変更を個別に確認してください', sourceRefs: spec.sourceRefs }); else unchanged++; continue }
    // A new provenance alone (e.g. the same shift now reported by a replacement CSV feed) does not ask the
    // person to re-confirm an item they edited or started; nothing they see changes.
    if (before.status === 'active' && (before.edited || before.started) && canonicalJSON({ ...before.spec, sourceRefs: [] }) === canonicalJSON({ ...spec, sourceRefs: [] })) { unchanged++; continue }
    if (before.spec.kind !== spec.kind) { conflicts.push({ key: spec.generationKey, contextId: spec.contextId, reason: '既存の発生回をタスクと予定の間で変換するには個別の確認が必要です', sourceRefs: spec.sourceRefs }); continue }
    if (before.edited || before.started) { conflicts.push({ key: spec.generationKey, contextId: spec.contextId, reason: '本人編集または着手済みの回です。変更を個別に確認してください', sourceRefs: spec.sourceRefs }); continue }
    updates.push({ before, after: spec })
  }
  for (const before of current) {
    if (before.completed || before.status === 'cancelled' || !included(before.spec) || !resolved.coveredSeries.includes(series(before.spec)) || resolved.blockedSeries.includes(series(before.spec)) || resolved.occurrences.some(spec => spec.generationKey === before.generationKey)) continue
    // An occurrence past a reported cut is unknown, not removed.
    if (resolved.truncatedSeries.some(cut => cut.series === series(before.spec) && occurrenceDate(before.spec) >= cut.firstOmittedDate)) continue
    const explicit = resolved.cancellations.find(item => item.generationKey === before.generationKey)
    // External CSV rows are partial observations. A missing row, expired quote,
    // or changed participation never establishes a cancellation by itself. Only
    // the person's own rule change (stop, step removal, other trigger) falls through.
    const csvRoster = before.spec.triggerKey.startsWith('roster-csv:') || before.spec.sourceRefs.some(reference => state.sources.some(source => source.id === reference.sourceId && source.csv?.format === 'roster'))
    if (csvRoster && !explicit && !ruleStepDroppedByPerson(state, before.spec)) continue
    if (before.edited || before.started) { conflicts.push({ key: before.generationKey, contextId: before.spec.contextId, reason: '本人編集または着手済みの回を取消す前に確認してください', sourceRefs: explicit?.sourceRefs ?? [] }); continue }
    cancels.push({ before, reason: explicit?.reason ?? '本人設定の系列・適用範囲の変更', sourceRefs: explicit?.sourceRefs ?? [] })
  }
  const unsigned = { stateRevision: state.revision, ownerId: state.ownerId, datasetId: state.datasetId, from, to, scope, creates, updates, cancels, conflicts, skippedCompleted, unchanged, truncatedSeries: resolved.truncatedSeries, notices: resolved.notices }
  return unsigned
}
export async function prepareCalendarChangePlan(state: CalendarRulesState, current: CurrentCalendarEntity[], from: string, to: string, scope: CalendarChangeScope = { kind: 'all_uncompleted' }, options: { today?: string } = {}): Promise<CalendarChangePlan> {
  const unsigned = buildCalendarChangePlan(state, current, from, to, scope, options)
  return { ...unsigned, digest: await contentDigest(unsigned) }
}
