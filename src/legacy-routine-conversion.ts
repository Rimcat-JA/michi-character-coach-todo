import { db } from './db'
import { canonicalJSON, contentDigest } from './canonical'
import { changePolicyFor } from './change-set'
import { addDays, today, uid, validateDate, validateScore, type Routine, type Task } from './domain'
import { buildCalendarChangePlan, resolveCalendarOccurrences, calendarProgress, type CalendarInstance, type CalendarRule, type CalendarRuleTrigger, type CalendarRulesState, type CurrentCalendarEntity, type ResolvedCalendarSpec } from './calendar-resolver'
import { emptyCalendarRulesState, validateCalendarRulesState } from './calendar-rules-validation'
import { canonicalRRule, serializeRRule, type RRuleSpec } from './rrule'
import { nativeRoutineEvent } from './routine-instruction'
import { validClock } from './zoned-time'

/** Owner choices for moving one legacy Routine row into the common resolver (design 11.11 analogue). */
export type LegacyConversionSelection = { contextId: string; bindingId: string; calendarId: string; time: string }
export type LegacyIdMapping = { taskId: string; taskRevision: number; from: string; to: string; anchorDate: string; status: Task['status']; trashed: boolean }
export type LegacyRoutineConversionProposal = Readonly<{
  id: string; ownerId: string; datasetId: string; stateRevision: number; policyEpoch: number; sourcePermissionRevision: number
  routineId: string; routineRevision: number; createdAt: string; expiresAt: string
  rule: CalendarRule; mappings: LegacyIdMapping[]; instances: CalendarInstance[]; preview: ResolvedCalendarSpec[]
  totals: { tasks: number; completed: number; netPoints: number }; notices: string[]; digest: string
}>
const registry = new Map<string, LegacyRoutineConversionProposal>()
export function clearLegacyRoutineConversionAuthority() { registry.clear() }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }

/** Same dates as the legacy generator: weeks start on the start date, monthly days clamp to the month end. */
export function legacyRoutineTrigger(routine: Routine, time: string): CalendarRuleTrigger {
  if (!validClock(time)) throw new Error('移行後の予定時刻をHH:mmで選んでください')
  if (!Number.isInteger(routine.interval) || routine.interval < 1 || routine.interval > 365) throw new Error('旧ルーティンの間隔が不正です')
  const exdates = [...new Set(routine.excludedDates ?? [])].sort().map(date => `${date}T${time}`)
  const base: RRuleSpec = { freq: 'DAILY', interval: routine.interval, count: null, until: routine.endDate ? routine.endDate.replaceAll('-', '') : null, byDay: [], byMonthDay: [], byMonth: [], bySetPos: [], wkst: 1 }
  const rrule = (spec: Partial<RRuleSpec>): CalendarRuleTrigger => ({ kind: 'rrule', dtstart: `${routine.startDate}T${time}`, rrule: canonicalRRule(serializeRRule({ ...base, ...spec })), rdates: [], exdates, nonexistentTime: 'skip', ambiguousTime: 'earlier' })
  if (routine.cadence === 'daily') return rrule({ freq: 'DAILY' })
  if (routine.cadence === 'weekly') {
    if (!routine.weekdays.length || routine.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('曜日のない毎週ルーティンは移行できません')
    return rrule({ freq: 'WEEKLY', byDay: [...new Set(routine.weekdays)].map(weekday => ({ weekday, ordinal: null })), wkst: routine.interval === 1 ? 1 : new Date(`${routine.startDate}T12:00:00Z`).getUTCDay() })
  }
  if (routine.cadence === 'monthly') {
    const day = routine.monthDay
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('旧ルーティンの月の日が不正です')
    return rrule({ freq: 'MONTHLY', ...(day <= 28 ? { byMonthDay: [day] } : day === 31 ? { byMonthDay: [-1] } : { byMonthDay: Array.from({ length: day - 27 }, (_, index) => 28 + index), bySetPos: [-1] }) })
  }
  if (routine.excludedDates?.length) throw new Error('除外日付きの完了後ルーティンは、共通ルーティンで除外を確認しながら作り直してください')
  return { kind: 'completion_relative', firstDate: routine.startDate, time, afterDays: routine.interval, unfinishedPolicy: 'generate_after_completion' }
}
function legacyAnchor(routine: Routine, task: Task) {
  const prefix = `${routine.id}:`, date = task.generationKey.startsWith(prefix) ? task.generationKey.slice(prefix.length) : ''
  try { validateDate(date || 'invalid', '旧発生回') } catch { throw new Error(`旧ルーティンの発生回「${task.title}」の識別を読めません。移行しません`) }
  return date
}
function taskMatches(task: Task, spec: ResolvedCalendarSpec) { return task.title === spec.title && task.scheduledDate === spec.scheduledDate && task.dueDate === spec.dueDate && !task.dueAt && canonicalJSON(task.score) === canonicalJSON(spec.score) }

/** Read-only: builds the rule, the legacy_id_map and a resolver check that every open occurrence keeps its identity. */
export async function prepareLegacyRoutineConversion(routineId: string, selection: LegacyConversionSelection): Promise<LegacyRoutineConversionProposal> {
  const settings = await db.settings.get('main'), routine = await db.routines.get(routineId)
  if (!settings) throw new Error('設定がありません')
  if (!routine || !routine.active) throw new Error('移行できる有効な旧ルーティンがありません')
  const state = await db.calendarRules.get('main') ?? emptyCalendarRulesState(settings.profileId, settings.datasetId)
  validateCalendarRulesState(state, settings.profileId, settings.datasetId)
  const context = state.contexts.find(row => row.id === selection.contextId), binding = state.bindings.find(row => row.id === selection.bindingId), calendar = state.calendars.find(row => row.id === selection.calendarId)
  if (!context || !binding || !calendar || binding.contextId !== context.id || calendar.contextId !== context.id || !binding.confirmed || binding.personId !== state.ownerId) throw new Error('移行先の対象・確認済みの本人適用・カレンダーを選んでください')
  validateScore(routine.score)
  if (routine.score.mode === 'allocated') throw new Error('配分ポイントの旧ルーティンは移行できません')
  const trigger = legacyRoutineTrigger(routine, selection.time), validTo = routine.endDate ?? context.validTo
  if (validTo < routine.startDate) throw new Error('移行先の対象の有効期間が旧ルーティンの開始日より前に終わっています')
  const rule: CalendarRule = { id: uid(), contextId: context.id, bindingId: binding.id, calendarId: calendar.id, title: routine.title, originBasis: 'user_approved_rule', enabled: true, validFrom: routine.startDate, validTo, revision: 1, trigger, steps: [{ key: 'main', title: routine.title, kind: 'task', scheduledOffsetDays: 0, dueOffsetDays: null, score: structuredClone(routine.score), durationMinutes: null }] }
  const tasks = (await db.tasks.where('routineId').equals(routine.id).toArray()).map(task => ({ task, anchor: legacyAnchor(routine, task) })).sort((a, b) => a.anchor.localeCompare(b.anchor) || a.task.id.localeCompare(b.task.id))
  if (new Set(tasks.map(row => row.anchor)).size !== tasks.length) throw new Error('同じ日の旧発生回が重複しています。移行しません')
  const completions = await db.completions.toArray(), sessions = await db.sessions.toArray()
  const key = (index: number, anchor: string) => trigger.kind === 'completion_relative' ? `chain:${index}` : `anchor:${anchor}`
  const mappings: LegacyIdMapping[] = [], instances: CalendarInstance[] = [], entities: CurrentCalendarEntity[] = []
  for (const [index, { task, anchor }] of tasks.entries()) {
    const triggerKey = key(index, anchor), to = `calendar:rule:${rule.id}:${triggerKey}:main`
    const spec: ResolvedCalendarSpec = { generationKey: to, triggerKey, stepKey: 'main', contextId: context.id, bindingId: binding.id, activityId: null, ruleId: rule.id, kind: 'task', title: rule.title, scheduledDate: anchor, dueDate: null, score: structuredClone(routine.score), startAt: null, endAt: null, eventKind: null, timezone: context.timezone, sourceRefs: [], originBasis: 'user_approved_rule' }
    mappings.push({ taskId: task.id, taskRevision: task.revision, from: task.generationKey, to, anchorDate: anchor, status: task.status, trashed: Boolean(task.deletedAt) })
    // A trashed occurrence stays an owner-edited active instance, so it is neither revived nor regenerated.
    instances.push({ generationKey: to, entityId: task.id, entityRevision: task.revision + 1, status: 'active', spec })
    entities.push({ generationKey: to, entityId: task.id, revision: task.revision + 1, status: 'active', completed: task.status === 'completed', edited: Boolean(task.deletedAt) || !taskMatches(task, spec), started: sessions.some(session => session.taskId === task.id), spec, completedAt: task.status === 'completed' ? completions.find(row => row.taskId === task.id)?.currentAt ?? null : null })
  }
  const proposed: CalendarRulesState = { ...structuredClone(state), revision: state.revision + 1, rules: [...state.rules, rule], instances: [...state.instances, ...instances] }
  validateCalendarRulesState(proposed, settings.profileId, settings.datasetId)
  const progress = calendarProgress(entities)
  for (const entity of entities) {
    if (entity.completed) continue
    const date = entity.spec.scheduledDate!, produced = resolveCalendarOccurrences(proposed, date, date, [entity.generationKey], { progress }).occurrences.find(spec => spec.generationKey === entity.generationKey)
    if (!produced || canonicalJSON(produced) !== canonicalJSON(entity.spec)) throw new Error(`${date}の未完了の回「${entity.spec.title}」は、移行後の規則・本人適用・有効期間では同じ回として作られません。完了の取消や期間を確認してから移行してください`)
  }
  const from = today(), plan = buildCalendarChangePlan(proposed, entities, from, addDays(from, 90))
  const owned = completions.filter(row => mappings.some(mapping => mapping.taskId === row.taskId))
  const policy = changePolicyFor(settings), createdAt = new Date().toISOString()
  const unsigned = { id: uid(), ownerId: settings.profileId, datasetId: settings.datasetId, stateRevision: state.revision, policyEpoch: policy.epoch, sourcePermissionRevision: policy.sourcePermissionRevision, routineId: routine.id, routineRevision: routine.revision, createdAt, expiresAt: new Date(Date.now() + 86400000).toISOString(), rule, mappings, instances, preview: plan.creates.filter(spec => spec.ruleId === rule.id).slice(0, 10),
    totals: { tasks: mappings.length, completed: mappings.filter(row => row.status === 'completed').length, netPoints: owned.reduce((sum, row) => sum + (row.currentAt ? row.netPoints ?? 0 : 0), 0) },
    notices: ['既存のタスクID・完了記録・台帳・評価履歴は変えず、旧発生回の識別キーだけを新しい系列の回へ付け替えます。', '旧ルーティンは停止し、以後の発生回は共通ルーティンの別の生成確認で作ります。', ...(routine.project ? [`新しく作る回には旧ルーティンのプロジェクト「${routine.project}」を付けません。`] : []), ...plan.conflicts.map(row => `確認待ち：${row.reason}`)] }
  const proposal = freeze({ ...structuredClone(unsigned), digest: await contentDigest(unsigned) })
  registry.set(proposal.id, proposal)
  return proposal
}

/** Applies one confirmed conversion atomically; repeating the same click returns the same rule. */
export async function applyLegacyRoutineConversionFromUI(proposal: LegacyRoutineConversionProposal, confirmedDigest: string, event: Event): Promise<string> {
  nativeRoutineEvent(event)
  if (!proposal || registry.get(proposal.id) !== proposal || proposal.digest !== confirmedDigest) throw new Error('登録済みの移行確認案ではありません。内容を確認し直してください')
  const { digest, ...unsigned } = proposal
  if (await contentDigest(unsigned) !== digest) throw new Error('確認後に移行内容が変わりました')
  const receiptKey = `legacy-routine:${proposal.routineId}`
  return db.transaction('rw', [db.calendarRules, db.tasks, db.routines, db.settings, db.audits, db.commands], async () => {
    const settings = await db.settings.get('main'), prior = await db.commands.get(receiptKey)
    if (!settings || settings.profileId !== proposal.ownerId || settings.datasetId !== proposal.datasetId) throw new Error('本人・データセットが変わりました')
    if (prior) { if (prior.hash !== digest) throw new Error('この旧ルーティンは別の内容で移行済みです'); return prior.resultId }
    const policy = changePolicyFor(settings), state = await db.calendarRules.get('main') ?? emptyCalendarRulesState(settings.profileId, settings.datasetId), routine = await db.routines.get(proposal.routineId)
    if (policy.epoch !== proposal.policyEpoch || policy.sourcePermissionRevision !== proposal.sourcePermissionRevision || state.revision !== proposal.stateRevision || !routine?.active || routine.revision !== proposal.routineRevision || Date.parse(proposal.expiresAt) <= Date.now()) throw new Error('設定・ルーティン・共通カレンダーの版または期限が変わりました。移行内容を確認し直してください')
    const current = await db.tasks.where('routineId').equals(routine.id).toArray()
    if (current.length !== proposal.mappings.length) throw new Error('旧ルーティンの発生回が変わりました。移行内容を確認し直してください')
    const at = new Date().toISOString()
    for (const mapping of proposal.mappings) {
      const task = current.find(row => row.id === mapping.taskId)
      if (!task || task.revision !== mapping.taskRevision || task.generationKey !== mapping.from || task.status !== mapping.status || Boolean(task.deletedAt) !== mapping.trashed) throw new Error('旧発生回のタスクが変わりました。移行内容を確認し直してください')
      await db.tasks.put({ ...task, generationKey: mapping.to, revision: task.revision + 1, updatedAt: at })
    }
    const next: CalendarRulesState = { ...state, revision: state.revision + 1, rules: [...state.rules, structuredClone(proposal.rule)], instances: [...state.instances, ...structuredClone(proposal.instances)] }
    validateCalendarRulesState(next, settings.profileId, settings.datasetId)
    await db.calendarRules.put(next)
    await db.routines.put({ ...routine, active: false, revision: routine.revision + 1 })
    await db.audits.add({ id: uid(), taskId: null, operation: 'routine.legacy_conversion', at, detail: JSON.stringify({ proposalId: proposal.id, digest, approvedBy: settings.profileId, routineId: routine.id, ruleId: proposal.rule.id, trigger: proposal.rule.trigger, legacy_id_map: proposal.mappings.map(row => ({ taskId: row.taskId, from: row.from, to: row.to })), totals: proposal.totals }) })
    await db.commands.add({ key: receiptKey, hash: digest, resultId: proposal.rule.id, at })
    return proposal.rule.id
  })
}
