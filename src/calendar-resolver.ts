import { canonicalJSON, contentDigest } from './canonical'
import { addDays, emptyScore, validateDate, validateScore, type ScoreInput } from './domain'

export type CalendarContext = { id: string; name: string; domain: 'education' | 'work' | 'other'; timezone: string; validFrom: string; validTo: string; revision: number }
export type ParticipationBinding = { id: string; contextId: string; personId: string; personRef: string | null; activityIds: string[]; weekdays: number[]; validFrom: string; validTo: string; confirmed: boolean; revision: number }
export type BusinessCalendar = { id: string; contextId: string; name: string; weekdays: number[]; validFrom: string; validTo: string; revision: number }
export type CalendarActivity = { id: string; contextId: string; bindingId: string; calendarId: string; title: string; eventKind: 'class' | 'meeting' | 'other'; weekdays: number[]; startTime: string; endTime: string; endDayOffset: number; validFrom: string; validTo: string; revision: number }
export type ICSComponentVersion = { uid: string; recurrenceId: string | null; sequence: number; dtstamp: string; lastModified: string | null; digest: string }
export type ICSImportMetadata = { feedId: string; readOnly: true; retentionUntil: string | null; snapshots: { revision: number; sha256: string; originalText: string | null; importedAt: string; fromDate: string; toDate: string }[]; components: ICSComponentVersion[] }
export type ScheduleSource = { id: string; contextId: string; title: string; authorityScope: 'calendar' | 'activity' | 'roster'; coverageFrom: string; coverageTo: string; status: 'current' | 'stale'; revision: number; importedAt: string; bodyHash: string; ics?: ICSImportMetadata }
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
export type CalendarRuleStep = { key: string; title: string; kind: 'task' | 'event'; scheduledOffsetDays: number; dueOffsetDays: number | null; score: ScoreInput | null; durationMinutes: number | null }
export type CalendarRule = { id: string; contextId: string; bindingId: string; calendarId: string; title: string; originBasis: 'user_instruction' | 'user_approved_rule'; enabled: boolean; validFrom: string; validTo: string; revision: number; steps: CalendarRuleStep[]; trigger:
  { kind: 'weekly'; weekdays: number[]; time: string } |
  { kind: 'monthly_business'; ordinal: number; from: 'start' | 'end'; time: string } |
  { kind: 'activity_relative'; activityId: string; edge: 'start' | 'end'; offsetDays: number; offsetMinutes: number }
; editions?: CalendarRuleEdition[] }
export type CalendarRuleEdition = { id: string; revision: number; scope: CalendarChangeScope; definition: Pick<CalendarRule, 'title' | 'enabled' | 'steps' | 'trigger'> }
export type FactRef = { sourceId: string; factId: string; revision: number }
export type ResolvedCalendarSpec = { generationKey: string; triggerKey: string; stepKey: string; contextId: string; bindingId: string; activityId: string | null; ruleId: string | null; kind: 'task' | 'event'; title: string; scheduledDate: string | null; dueDate: string | null; score: ScoreInput | null; startAt: string | null; endAt: string | null; eventKind: 'class' | 'meeting' | 'other' | null; timezone: string; sourceRefs: FactRef[]; originBasis: 'activity' | CalendarRule['originBasis'] }
export type CalendarInstance = { generationKey: string; entityId: string; entityRevision: number; status: 'active' | 'cancelled'; spec: ResolvedCalendarSpec }
export type CalendarRulesState = { id: 'main'; ownerId: string; datasetId: string; revision: number; contexts: CalendarContext[]; bindings: ParticipationBinding[]; calendars: BusinessCalendar[]; activities: CalendarActivity[]; sources: ScheduleSource[]; facts: ScheduleFact[]; rules: CalendarRule[]; instances: CalendarInstance[] }
export type ResolverConflict = { key: string; contextId: string; reason: string; sourceRefs: FactRef[] }
export type ResolverResult = { occurrences: ResolvedCalendarSpec[]; cancellations: { generationKey: string; reason: string; sourceRefs: FactRef[] }[]; conflicts: ResolverConflict[]; blockedSeries: string[]; coveredSeries: string[] }
export type CurrentCalendarEntity = { generationKey: string; entityId: string; revision: number; status: 'active' | 'cancelled'; completed: boolean; edited: boolean; started: boolean; spec: ResolvedCalendarSpec }
export type CalendarChangeScope = { kind: 'all_uncompleted' } | { kind: 'this_and_future'; fromDate: string } | { kind: 'this_instance'; generationKey: string }
export type CalendarChangePlan = { stateRevision: number; ownerId: string; datasetId: string; from: string; to: string; scope: CalendarChangeScope; creates: ResolvedCalendarSpec[]; updates: { before: CurrentCalendarEntity; after: ResolvedCalendarSpec }[]; cancels: { before: CurrentCalendarEntity; reason: string; sourceRefs: FactRef[] }[]; conflicts: ResolverConflict[]; skippedCompleted: number; unchanged: number; digest: string }

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
  return state.facts.filter(fact => fact.contextId === contextId && fact.validity === 'active' && state.sources.some(source => source.id === fact.sourceId && source.contextId === contextId && source.status === 'current'))
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

export function resolveCalendarOccurrences(state: CalendarRulesState, from: string, to: string, retainedKeys: string[] = []): ResolverResult {
  const evaluatedAt = new Date().toISOString()
  dates(from, to)
  const versions = state.rules.flatMap(base => [{ base, editionIndex: -1, rule: base }, ...(base.editions ?? []).map((edition, editionIndex) => ({ base, editionIndex, rule: { ...base, ...edition.definition } }))])
  const offsets = versions.flatMap(({ rule }) => rule.steps.map(step => step.scheduledOffsetDays + (rule.trigger.kind === 'activity_relative' ? rule.trigger.offsetDays + Math.ceil(Math.abs(rule.trigger.offsetMinutes) / 1440) * Math.sign(rule.trigger.offsetMinutes) : 0)))
  const expandedFrom = addDays(from, -Math.max(0, ...offsets) - 1), expandedTo = addDays(to, -Math.min(0, ...offsets) + 1)
  const window = dates(expandedFrom, expandedTo, 1830), occurrences: ResolvedCalendarSpec[] = [], cancellations: ResolverResult['cancellations'] = [], conflicts: ResolverConflict[] = [], blocked = new Set<string>()
  const covered = [...state.activities.map(activity => `activity:${activity.id}`), ...state.rules.map(rule => `rule:${rule.id}`)]
  const activityOccurrences: ResolvedCalendarSpec[] = [], activityCancels: { activityId: string; triggerKey: string; sourceRefs: FactRef[]; reason: string }[] = []
  function conflict(key: string, contextId: string, reason: string, facts: ScheduleFact[] = []) { conflicts.push({ key, contextId, reason, sourceRefs: refs(facts) }) }
  for (const activity of state.activities) {
    const context = state.contexts.find(item => item.id === activity.contextId), calendar = state.calendars.find(item => item.id === activity.calendarId && item.contextId === activity.contextId)
    if (!context || !calendar) { blocked.add(`activity:${activity.id}`); conflict(`activity:${activity.id}`, activity.contextId, '名前付きカレンダーまたは対象が未設定です'); continue }
    const ownBinding = state.bindings.find(item => item.id === activity.bindingId && item.contextId === context.id)
    if (!ownBinding?.confirmed || ownBinding.personId !== state.ownerId || !ownBinding.activityIds.includes(activity.id)) { blocked.add(`activity:${activity.id}`); conflict(`activity:${activity.id}`, activity.contextId, '活動と本人の適用条件を確認してください'); continue }
    const facts = activeFacts(state, activity.contextId)
    if (state.sources.some(source => source.contextId === activity.contextId && source.status === 'stale' && !source.ics)) { blocked.add(`activity:${activity.id}`); conflict(`activity:${activity.id}`, activity.contextId, '資料の取得状態が古いため、休業・取消と判断しません'); continue }
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
    const rosterFacts = facts.filter((fact): fact is Extract<ScheduleFact, { kind: 'roster_assignment' }> => fact.kind === 'roster_assignment' && fact.activityId === activity.id && fact.published && Boolean(binding?.confirmed && binding.personId === state.ownerId && binding.personRef !== null && fact.personRef === binding.personRef))
    for (const identity of new Set(rosterFacts.map(fact => `${fact.sourceId}:${fact.externalId}`))) {
      const candidates = unsuperseded(rosterFacts.filter(fact => `${fact.sourceId}:${fact.externalId}` === identity)), fact = candidates[0]
      if (!fact) continue
      if (new Set(candidates.map(candidate => `${candidate.status}:${candidate.startAt}:${candidate.endAt}`)).size > 1) { blocked.add(`activity:${activity.id}`); conflict(`roster:${identity}`, context.id, '同じ本人シフトの日時・取消状態が矛盾しています', candidates); continue }
      const date = calendarDateAt(fact.startAt, context.timezone), triggerKey = `roster:${identity}`
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

  function chosenEdition(base: CalendarRule, key: string, triggerKey: string, date: string) {
    let selected = -1
    for (const [index, edition] of (base.editions ?? []).entries()) {
      const scope = edition.scope, anchorDate = triggerKey.startsWith('anchor:') ? triggerKey.slice(7) : date
      if (scope.kind === 'all_uncompleted' || scope.kind === 'this_instance' && scope.generationKey === key || scope.kind === 'this_and_future' && (triggerKey.startsWith('month:') ? triggerKey.slice(6) >= scope.fromDate.slice(0, 7) : anchorDate >= scope.fromDate)) selected = index
    }
    return selected
  }
  for (const { base, editionIndex, rule } of versions) {
    if (!rule.enabled) continue
    const context = state.contexts.find(item => item.id === rule.contextId), calendar = state.calendars.find(item => item.id === rule.calendarId && item.contextId === rule.contextId)
    if (!context || !calendar) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}`, rule.contextId, '本人のカレンダーを選択してください'); continue }
    const binding = state.bindings.find(item => item.id === rule.bindingId && item.contextId === context.id)
    if (!binding?.confirmed || binding.personId !== state.ownerId) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}`, context.id, 'ルールの本人適用を確認してください'); continue }
    const facts = activeFacts(state, context.id)
    if (rule.trigger.kind !== 'weekly' && state.sources.some(source => source.contextId === context.id && source.status === 'stale')) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}`, rule.contextId, '資料取得が古いため、新しい回・取消を確定しません'); continue }
    const triggers: { key: string; at: string; sourceRefs: FactRef[]; activityId: string | null }[] = []
    if (rule.trigger.kind === 'activity_relative') {
      const trigger = rule.trigger
      if (blocked.has(`activity:${trigger.activityId}`)) { blocked.add(`rule:${rule.id}`); continue }
      for (const event of activityOccurrences.filter(item => item.activityId === trigger.activityId)) {
        if (!rule.steps.some(step => chosenEdition(base, `calendar:rule:${rule.id}:${event.triggerKey}:${step.key}`, event.triggerKey, calendarDateAt(event.startAt!, context.timezone)) === editionIndex)) continue
        const edge = trigger.edge === 'start' ? event.startAt! : event.endAt!
        const shifted = shiftCalendarDays(edge, trigger.offsetDays, context.timezone)
        if (!shifted.at) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}:${event.triggerKey}`, context.id, shifted.reason!); continue }
        const at = new Date(Date.parse(shifted.at) + trigger.offsetMinutes * 60000).toISOString()
        triggers.push({ key: event.triggerKey, at, sourceRefs: event.sourceRefs, activityId: trigger.activityId })
      }
      for (const cancelled of activityCancels.filter(item => item.activityId === trigger.activityId)) for (const step of rule.steps) cancellations.push({ generationKey: `calendar:rule:${rule.id}:${cancelled.triggerKey}:${step.key}`, reason: cancelled.reason, sourceRefs: cancelled.sourceRefs })
    } else if (rule.trigger.kind === 'weekly') {
      for (const date of window) if (rule.trigger.weekdays.includes(dayOfWeek(date))) {
        if (!rule.steps.some(step => chosenEdition(base, `calendar:rule:${rule.id}:anchor:${date}:${step.key}`, `anchor:${date}`, date) === editionIndex)) continue
        const wall = resolveLocalCalendarTime(date, rule.trigger.time, context.timezone)
        if (!wall.at) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}:${date}`, context.id, wall.reason!); continue }
        triggers.push({ key: `anchor:${date}`, at: wall.at, sourceRefs: [], activityId: null })
      }
    } else {
      const stepOffsets = rule.steps.map(step => step.scheduledOffsetDays)
      const monthlyWindow = dates(addDays(from, -Math.max(0, ...stepOffsets)), addDays(to, -Math.min(0, ...stepOffsets)), 1098)
      const months = new Set(monthlyWindow.map(date => date.slice(0, 7)))
      for (const month of months) {
        const first = `${month}-01`, last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10)
        if (!rule.steps.some(step => chosenEdition(base, `calendar:rule:${rule.id}:month:${month}:${step.key}`, `month:${month}`, first) === editionIndex)) continue
        if (first < calendar.validFrom || last > calendar.validTo) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}:${month}`, context.id, '月全体の本人選択カレンダーが未取得・未設定です'); continue }
        const statuses = dates(first, last).map(date => ({ date, ...businessStatus(calendar, date, facts) }))
        const contradictions = statuses.filter(status => status.conflict)
        if (contradictions.length) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}:${month}`, context.id, '月の営業日カレンダーに矛盾があります', contradictions.flatMap(status => status.facts)); continue }
        const businessDays = statuses.filter(status => status.open), chosen = rule.trigger.from === 'start' ? businessDays[rule.trigger.ordinal - 1] : businessDays[businessDays.length - rule.trigger.ordinal]
        if (!chosen) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}:${month}`, context.id, '指定した営業日順位がこの月にありません'); continue }
        if (!inRange(chosen.date, expandedFrom, expandedTo) && !rule.steps.some(step => retainedKeys.includes(`calendar:rule:${rule.id}:month:${month}:${step.key}`))) continue
        const wall = resolveLocalCalendarTime(chosen.date, rule.trigger.time, context.timezone)
        if (!wall.at) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}:${month}`, context.id, wall.reason!); continue }
        triggers.push({ key: `month:${month}`, at: wall.at, sourceRefs: refs(statuses.flatMap(status => status.facts)), activityId: null })
      }
    }
    for (const trigger of triggers) {
      const date = calendarDateAt(trigger.at, context.timezone), participation = applicable(state, context.id, rule.bindingId, date)
      if (!participation || !inRange(date, rule.validFrom, rule.validTo)) continue
      for (const step of rule.steps) {
        const planned = addDays(date, step.scheduledOffsetDays)
        if (chosenEdition(base, `calendar:rule:${rule.id}:${trigger.key}:${step.key}`, trigger.key, date) !== editionIndex) continue
        if (!inRange(planned, from, to) && !retainedKeys.includes(`calendar:rule:${rule.id}:${trigger.key}:${step.key}`)) continue
        if (step.score) { validateScore(step.score); if (step.score.mode === 'allocated') throw new Error('定型ステップに未承認の配分ポイントを指定できません') }
        const shifted = step.kind === 'event' ? shiftCalendarDays(trigger.at, step.scheduledOffsetDays, context.timezone) : null
        if (shifted && !shifted.at) { blocked.add(`rule:${rule.id}`); conflict(`rule:${rule.id}:${trigger.key}:${step.key}`, context.id, shifted.reason!); continue }
        const startAt = shifted?.at ?? null
        occurrences.push({ generationKey: `calendar:rule:${rule.id}:${trigger.key}:${step.key}`, triggerKey: trigger.key, stepKey: step.key, contextId: context.id, bindingId: rule.bindingId, activityId: trigger.activityId, ruleId: rule.id, kind: step.kind, title: step.title, scheduledDate: step.kind === 'task' ? planned : null, dueDate: step.kind === 'task' && step.dueOffsetDays !== null ? addDays(date, step.dueOffsetDays) : null, score: step.kind === 'task' ? { ...(step.score ?? emptyScore()) } : null, startAt, endAt: startAt ? new Date(Date.parse(startAt) + step.durationMinutes! * 60000).toISOString() : null, eventKind: step.kind === 'event' ? 'other' : null, timezone: context.timezone, sourceRefs: trigger.sourceRefs, originBasis: rule.originBasis })
      }
    }
  }
  const unique = new Map<string, ResolvedCalendarSpec>(), conflictingKeys = new Set<string>()
  for (const spec of occurrences) {
    const previous = unique.get(spec.generationKey)
    if (previous && canonicalJSON(previous) !== canonicalJSON(spec)) { conflictingKeys.add(spec.generationKey); blocked.add(series(spec)); conflict(spec.generationKey, spec.contextId, '同じ発生回の日時・内容が矛盾しています') }
    else unique.set(spec.generationKey, spec)
  }
  const result = [...unique.values()].filter(spec => !conflictingKeys.has(spec.generationKey) && !blocked.has(series(spec))).sort(sortSpecs)
  if (result.length > 5000 || state.rules.some(rule => result.filter(spec => spec.ruleId === rule.id).length > 1000) || state.activities.some(activity => result.filter(spec => !spec.ruleId && spec.activityId === activity.id).length > 1000)) throw new Error('一回の展開上限を超えました。期間を短くしてください')
  return { occurrences: result, cancellations, conflicts, blockedSeries: [...blocked].sort(), coveredSeries: covered.sort() }
}

export function buildCalendarChangePlan(state: CalendarRulesState, current: CurrentCalendarEntity[], from: string, to: string, scope: CalendarChangeScope = { kind: 'all_uncompleted' }): Omit<CalendarChangePlan, 'digest'> {
  if (scope.kind === 'this_and_future') validateDate(scope.fromDate, '以後の変更日')
  const creates: ResolvedCalendarSpec[] = [], updates: CalendarChangePlan['updates'] = [], cancels: CalendarChangePlan['cancels'] = []
  let skippedCompleted = 0, unchanged = 0
  function included(spec: ResolvedCalendarSpec) {
    const date = spec.scheduledDate ?? calendarDateAt(spec.startAt!, spec.timezone)
    return inRange(date, from, to) && (scope.kind === 'all_uncompleted' || scope.kind === 'this_and_future' && date >= scope.fromDate || scope.kind === 'this_instance' && spec.generationKey === scope.generationKey)
  }
  const resolved = resolveCalendarOccurrences(state, from, to, current.filter(item => included(item.spec)).map(item => item.generationKey)), conflicts = [...resolved.conflicts]
  for (const spec of resolved.occurrences) {
    const before = current.find(item => item.generationKey === spec.generationKey)
    if (!included(spec) && (!before || !included(before.spec))) continue
    if (before?.completed) { skippedCompleted++; continue }
    if (!before) { creates.push(spec); continue }
    if (before.status === 'active' && canonicalJSON(before.spec) === canonicalJSON(spec)) { unchanged++; continue }
    if (before.spec.kind !== spec.kind) { conflicts.push({ key: spec.generationKey, contextId: spec.contextId, reason: '既存の発生回をタスクと予定の間で変換するには個別の確認が必要です', sourceRefs: spec.sourceRefs }); continue }
    if (before.edited || before.started) { conflicts.push({ key: spec.generationKey, contextId: spec.contextId, reason: '本人編集または着手済みの回です。変更を個別に確認してください', sourceRefs: spec.sourceRefs }); continue }
    updates.push({ before, after: spec })
  }
  for (const before of current) {
    if (before.completed || before.status === 'cancelled' || !included(before.spec) || !resolved.coveredSeries.includes(series(before.spec)) || resolved.blockedSeries.includes(series(before.spec)) || resolved.occurrences.some(spec => spec.generationKey === before.generationKey)) continue
    const explicit = resolved.cancellations.find(item => item.generationKey === before.generationKey)
    if (before.edited || before.started) { conflicts.push({ key: before.generationKey, contextId: before.spec.contextId, reason: '本人編集または着手済みの回を取消す前に確認してください', sourceRefs: explicit?.sourceRefs ?? [] }); continue }
    cancels.push({ before, reason: explicit?.reason ?? '本人設定の系列・適用範囲の変更', sourceRefs: explicit?.sourceRefs ?? [] })
  }
  const unsigned = { stateRevision: state.revision, ownerId: state.ownerId, datasetId: state.datasetId, from, to, scope, creates, updates, cancels, conflicts, skippedCompleted, unchanged }
  return unsigned
}
export async function prepareCalendarChangePlan(state: CalendarRulesState, current: CurrentCalendarEntity[], from: string, to: string, scope: CalendarChangeScope = { kind: 'all_uncompleted' }): Promise<CalendarChangePlan> {
  const unsigned = buildCalendarChangePlan(state, current, from, to, scope)
  return { ...unsigned, digest: await contentDigest(unsigned) }
}
