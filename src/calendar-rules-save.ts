import type { EntityTable } from 'dexie'
import { db } from './db'
import { addTask, ConflictError, newTaskInput } from './commands'
import { canonicalJSON, contentDigest } from './canonical'
import { changePolicyFor } from './change-set'
import { addDays, calculateScore, uid, type CalendarEvent, type Settings, type Task } from './domain'
import { assertTripTaskScoreChangeAllowed } from './trip-bundles'
import { buildCalendarChangePlan, prepareCalendarChangePlan, type CalendarChangePlan, type CalendarChangeScope, type CalendarRulesState, type CalendarTruncation, type CurrentCalendarEntity, type ResolvedCalendarSpec, type ResolverConflict, type ResolverNotice } from './calendar-resolver'
import { emptyCalendarRulesState, mergeScheduleImport, prepareScheduleImport, validateCalendarRulesState, type ScheduleImportPreview } from './calendar-rules-validation'
import { redactICSForAudit } from './calendar-import-redaction'
import { redactCSVForAudit } from './calendar-csv-redaction'
import { csvHeadHasRetainedEvidence } from './calendar-resolver'

const calendarDB = db as typeof db & { calendarRules: EntityTable<CalendarRulesState, 'id'> }
const table = () => { if (!calendarDB.calendarRules) throw new Error('共通カレンダーの保存先がありません。アプリを更新してください'); return calendarDB.calendarRules }
export type CalendarRulesConfiguration = Pick<CalendarRulesState, 'contexts' | 'bindings' | 'calendars' | 'activities' | 'sources' | 'facts' | 'rules'>
type ProposalBase = { id: string; ownerId: string; datasetId: string; stateRevision: number; policyEpoch: number; sourcePermissionRevision: number; createdAt: string; expiresAt: string; digest: string }
export type CalendarConfigurationProposal = ProposalBase & { kind: 'configuration'; next: CalendarRulesConfiguration; preview: ResolvedCalendarSpec[]; conflicts: ResolverConflict[]; truncatedSeries?: CalendarTruncation[]; notices?: ResolverNotice[]; importPreview: ScheduleImportPreview | null }
export type CalendarGenerationProposal = ProposalBase & { kind: 'generation'; plan: CalendarChangePlan }
type Proposal = CalendarConfigurationProposal | CalendarGenerationProposal
const authority = new Map<string, Proposal>()
export type CalendarConfigurationGuard = {
  assertCurrent: (settings: Settings, state: CalendarRulesState) => Promise<void>
  assertLive?: () => void
  resultId: string; businessKey: string | null; candidateKey: string | null
  businessHash: string; candidateHash: string; detail: Record<string, unknown>
}
const configurationGuards = new Map<string, CalendarConfigurationGuard>()
export function clearCalendarRulesAuthority() { authority.clear(); configurationGuards.clear() }
export function discardCalendarConfigurationProposal(proposal: CalendarConfigurationProposal) { if (authority.get(proposal.id) === proposal) { authority.delete(proposal.id); configurationGuards.delete(proposal.id) } }
/** Guards are process-owned callbacks and cannot be recovered from a JSON proposal. */
export function bindCalendarConfigurationGuard(proposal: CalendarConfigurationProposal, guard: CalendarConfigurationGuard) {
  if (authority.get(proposal.id) !== proposal || configurationGuards.has(proposal.id) || typeof guard.assertCurrent !== 'function') throw new Error('登録済みの周期確認案へ一度だけ根拠確認を結び付けてください')
  configurationGuards.set(proposal.id, guard)
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze) }; return value }
function humanEvent(event: Event) {
  if (!(event instanceof Event) || !event.isTrusted || !['click', 'submit'].includes(event.type)) throw new Error('アプリの本人確認ボタンから適用してください')
  try { const getType = Object.getOwnPropertyDescriptor(Event.prototype, 'type')?.get; if (!getType || !['click', 'submit'].includes(getType.call(event))) throw new Error() } catch { throw new Error('アプリの本人確認ボタンから適用してください') }
}
async function settings(): Promise<Settings> { const current = await db.settings.get('main'); if (!current) throw new Error('設定がありません'); return current }
export async function loadCalendarRulesState(): Promise<CalendarRulesState> {
  const current = await settings(), state = await table().get('main') ?? emptyCalendarRulesState(current.profileId, current.datasetId)
  validateCalendarRulesState(state, current.profileId, current.datasetId); return state
}
function config(state: CalendarRulesState): CalendarRulesConfiguration { const { contexts, bindings, calendars, activities, sources, facts, rules } = state; return structuredClone({ contexts, bindings, calendars, activities, sources, facts, rules }) }
/** Date-only occurrences keep the task shape unchanged; a clock deadline adds dueAt with the context time zone. */
const specDue = (spec: ResolvedCalendarSpec, task?: Task): Partial<Pick<Task, 'dueAt' | 'dueTimezone'>> => spec.dueAt ? { dueAt: spec.dueAt, dueTimezone: spec.timezone } : task?.dueAt ? { dueAt: null, dueTimezone: null } : {}
function taskMatches(task: Task, spec: ResolvedCalendarSpec) { return task.title === spec.title && task.scheduledDate === spec.scheduledDate && task.dueDate === spec.dueDate && (task.dueAt ?? null) === (spec.dueAt ?? null) && (!task.dueAt || task.dueTimezone === spec.timezone) && canonicalJSON(task.score) === canonicalJSON(spec.score) }
function eventMatches(event: CalendarEvent, spec: ResolvedCalendarSpec, ownerId: string) { return event.ownerId === ownerId && event.title === spec.title && event.kind === spec.eventKind && event.startAt === spec.startAt && event.endAt === spec.endAt && event.timezone === spec.timezone && event.linkedTaskId === null }
export async function currentCalendarEntities(state: CalendarRulesState): Promise<CurrentCalendarEntity[]> {
  const tasks = await db.tasks.toArray(), events = await db.calendarEvents.toArray(), sessions = await db.sessions.toArray(), completions = await db.completions.toArray()
  return state.instances.map(instance => {
    const spec = instance.spec
    if (spec.kind === 'task') {
      const task = tasks.find(item => item.id === instance.entityId)
      if (!task || task.generationKey !== spec.generationKey) throw new Error('発生回とタスクの対応が変わりました。確認してください')
      const completedAt = task.status === 'completed' ? completions.find(item => item.taskId === task.id)?.currentAt ?? null : null
      return { generationKey: instance.generationKey, entityId: task.id, revision: task.revision, status: instance.status, completed: task.status === 'completed', edited: task.revision !== instance.entityRevision || !taskMatches(task, spec) || Boolean(task.deletedAt) !== (instance.status === 'cancelled'), started: sessions.some(session => session.taskId === task.id), spec: structuredClone(spec), completedAt }
    }
    const event = events.find(item => item.id === instance.entityId)
    return { generationKey: instance.generationKey, entityId: instance.entityId, revision: instance.entityRevision, status: instance.status, completed: false, edited: instance.status === 'active' ? !event || !eventMatches(event, spec, state.ownerId) : Boolean(event), started: false, spec: structuredClone(spec), completedAt: null }
  })
}
async function captureBase(state: CalendarRulesState): Promise<Omit<ProposalBase, 'digest'>> {
  const current = await settings(), policy = changePolicyFor(current)
  if (current.profileId !== state.ownerId || current.datasetId !== state.datasetId) throw new ConflictError()
  const createdAt = new Date().toISOString()
  return { id: uid(), ownerId: state.ownerId, datasetId: state.datasetId, stateRevision: state.revision, policyEpoch: policy.epoch, sourcePermissionRevision: policy.sourcePermissionRevision, createdAt, expiresAt: new Date(Date.now() + 86400000).toISOString() }
}
async function register<T extends Proposal>(unsigned: Omit<T, 'digest'>): Promise<T> {
  const candidate = freeze({ ...structuredClone(unsigned), digest: await contentDigest(unsigned) } as T)
  authority.set(candidate.id, candidate)
  for (const [id, value] of authority) if (Date.parse(value.expiresAt) <= Date.now()) authority.delete(id)
  return candidate
}
export async function prepareCalendarConfiguration(next: CalendarRulesConfiguration, expectedRevision: number, from: string, to: string, previewRuleId?: string): Promise<CalendarConfigurationProposal> {
  const keys = ['contexts', 'bindings', 'calendars', 'activities', 'sources', 'facts', 'rules']
  if (!next || typeof next !== 'object' || Object.keys(next).length !== keys.length || keys.some(key => !Object.hasOwn(next, key))) throw new Error('本人設定には対象・適用条件・カレンダー・活動・資料・事実・ルールだけを指定してください')
  const state = await loadCalendarRulesState()
  if (state.revision !== expectedRevision) throw new ConflictError()
  const proposed: CalendarRulesState = { ...state, ...structuredClone(next), revision: state.revision + 1 }
  validateCalendarRulesState(proposed, state.ownerId, state.datasetId)
  if (previewRuleId !== undefined && (typeof previewRuleId !== 'string' || !proposed.rules.some(rule => rule.id === previewRuleId))) throw new Error('次の10回を確認するルールがありません')
  const plan = buildCalendarChangePlan(proposed, [], from, to), order = (a: ResolvedCalendarSpec, b: ResolvedCalendarSpec) => (a.scheduledDate ?? a.startAt!).localeCompare(b.scheduledDate ?? b.startAt!)
  const preview = plan.creates.filter(spec => previewRuleId === undefined || spec.ruleId === previewRuleId).sort(order)
  // Sparse series (yearly, Feb 29) still show their next occurrences: later yearly windows are read for the preview only.
  for (let window = 0; previewRuleId !== undefined && preview.length < 10 && window < 10; window++) {
    const start = addDays(to, 1 + window * 366)
    preview.push(...buildCalendarChangePlan(proposed, [], start, addDays(start, 365)).creates.filter(spec => spec.ruleId === previewRuleId).sort(order))
  }
  return register<CalendarConfigurationProposal>({ ...await captureBase(state), kind: 'configuration', next: config(proposed), preview: preview.slice(0, 10), conflicts: plan.conflicts, truncatedSeries: plan.truncatedSeries, notices: plan.notices, importPreview: null })
}
export async function prepareCalendarScheduleImport(contextId: string, input: unknown, from: string, to: string): Promise<CalendarConfigurationProposal> {
  const state = await loadCalendarRulesState(), importPreview = await prepareScheduleImport(state, contextId, input), proposed = mergeScheduleImport(state, importPreview)
  const plan = buildCalendarChangePlan(proposed, [], from, to)
  return register<CalendarConfigurationProposal>({ ...await captureBase(state), kind: 'configuration', next: config(proposed), preview: plan.creates.sort((a, b) => (a.scheduledDate ?? a.startAt!).localeCompare(b.scheduledDate ?? b.startAt!)).slice(0, 10), conflicts: plan.conflicts, truncatedSeries: plan.truncatedSeries, notices: plan.notices, importPreview })
}
export async function prepareCalendarGeneration(from: string, to: string, scope: CalendarChangeScope = { kind: 'all_uncompleted' }): Promise<CalendarGenerationProposal> {
  const current = await db.settings.get('main')
  if (current && changePolicyFor(current).stops?.routines) throw new Error(ROUTINES_STOPPED)
  const state = await loadCalendarRulesState(), entities = await currentCalendarEntities(state)
  return register<CalendarGenerationProposal>({ ...await captureBase(state), kind: 'generation', plan: await prepareCalendarChangePlan(state, entities, from, to, scope) })
}
const ROUTINES_STOPPED = 'ルーティン・繰り返しの生成は停止中です。設定 > 自動化 から本人が再開してください'
function checkContext(proposal: Proposal, current: Settings, state: CalendarRulesState) {
  const policy = changePolicyFor(current)
  if (proposal.kind === 'generation' && policy.stops?.routines) throw new Error(ROUTINES_STOPPED)
  if (current.profileId !== proposal.ownerId || current.datasetId !== proposal.datasetId || state.ownerId !== proposal.ownerId || state.datasetId !== proposal.datasetId || state.revision !== proposal.stateRevision || policy.epoch !== proposal.policyEpoch || policy.sourcePermissionRevision !== proposal.sourcePermissionRevision || Date.parse(proposal.expiresAt) <= Date.now()) throw new Error('本人・データセット・設定・版または期限が変わりました。差分を作り直してください')
}
function assertProposal(proposal: Proposal) {
  const registered = authority.get(proposal.id)
  if (!registered || canonicalJSON(registered) !== canonicalJSON(proposal)) throw new Error('登録済みの確認案ではありません。差分を作り直してください')
}
function eventFrom(spec: ResolvedCalendarSpec, id: string, ownerId: string, at: string): CalendarEvent { return { id, ownerId, title: spec.title, kind: spec.eventKind!, startAt: spec.startAt!, endAt: spec.endAt!, timezone: spec.timezone, linkedTaskId: null, createdAt: at } }
export async function applyCalendarProposalFromUI(input: Proposal, event: Event): Promise<string> {
  humanEvent(event)
  const proposal = structuredClone(input), key = `calendar:${proposal.id}`, hash = await contentDigest(proposal)
  assertProposal(proposal)
  const { digest, ...unsigned } = proposal
  if (await contentDigest(unsigned) !== digest) throw new Error('確認後に案が変わりました')
  const calendarTable = table()
  return db.transaction('rw', [calendarTable, db.settings, db.tasks, db.calendarEvents, db.assessments, db.completions, db.sessions, db.tripBundles, db.audits, db.commands, db.containers, db.labelGroups, db.labelDefinitions, db.contextSources, db.contextSnapshots, db.sourceArtifacts], async () => {
    const current = await settings(), state = await calendarTable.get('main') ?? emptyCalendarRulesState(current.profileId, current.datasetId)
    validateCalendarRulesState(state, current.profileId, current.datasetId)
    const guard = configurationGuards.get(proposal.id)
    const registeredProposal = authority.get(proposal.id)
    const assertLive = () => { if (!registeredProposal || authority.get(proposal.id) !== registeredProposal) throw new Error('登録済みの確認案ではありません。差分を作り直してください'); if (guard && configurationGuards.get(proposal.id) !== guard) throw new Error('確認案の根拠が失効しました'); guard?.assertLive?.() }
    assertLive()
    if (guard) await guard.assertCurrent(current, state)
    assertLive()
    const receipt = await db.commands.get(key)
    assertLive()
    if (receipt) { if (receipt.hash !== hash || current.profileId !== proposal.ownerId || current.datasetId !== proposal.datasetId) throw new Error('IDEMPOTENCY_MISMATCH'); return receipt.resultId }
    if (guard?.candidateKey) {
      const prior = await db.commands.get(guard.candidateKey)
      assertLive()
      if (prior) { if (prior.hash !== guard.candidateHash) throw new Error('同じ検出候補を別の系列として再採用できません'); await db.commands.add({ key, hash, resultId: prior.resultId, at: new Date().toISOString() }); assertLive(); return prior.resultId }
    }
    if (guard?.businessKey) {
      const prior = await db.commands.get(guard.businessKey)
      assertLive()
      if (prior) {
        if (prior.hash !== guard.businessHash) throw new Error('同じ根拠の系列を変更して再採用できません')
        const at = new Date().toISOString()
        if (guard.candidateKey) { await db.commands.add({ key: guard.candidateKey, hash: guard.candidateHash, resultId: prior.resultId, at }); assertLive() }
        await db.commands.add({ key, hash, resultId: prior.resultId, at }); assertLive(); return prior.resultId
      }
    }
    checkContext(proposal, current, state)
    const at = new Date().toISOString()
    if (proposal.kind === 'configuration') {
      if (proposal.next.sources.some(source => source.ics?.retentionUntil && source.ics.retentionUntil <= at && source.ics.snapshots.some(snapshot => snapshot.originalText !== null))) throw new Error('ICS原本の保持期限に達しました。差分を確認し直してください')
      if (proposal.next.sources.some(source => source.csv && source.csv.heads.some(head => head.status !== 'expired' && !csvHeadHasRetainedEvidence(source.csv!, head, at)))) throw new Error('CSV選択行の保持期限に達しました。差分を確認し直してください')
      if (proposal.importPreview?.noOp && canonicalJSON(proposal.next) === canonicalJSON(config(state))) { await db.commands.add({ key, hash, resultId: proposal.id, at }); assertLive(); return proposal.id }
      const next = { ...state, ...structuredClone(proposal.next), revision: state.revision + 1 }
      validateCalendarRulesState(next, current.profileId, current.datasetId)
      await calendarTable.put(next); assertLive()
      await db.audits.add({ id: uid(), taskId: null, operation: 'calendar.configuration', at, detail: JSON.stringify({ proposalId: proposal.id, digest: proposal.digest, approvedBy: current.profileId, policyEpoch: proposal.policyEpoch, fromRevision: state.revision, toRevision: next.revision, before: redactCSVForAudit(redactICSForAudit(config(state))), after: redactCSVForAudit(redactICSForAudit(proposal.next)), import: proposal.importPreview ? { sourceId: proposal.importPreview.source.id, revision: proposal.importPreview.source.revision, coverageFrom: proposal.importPreview.source.coverageFrom, coverageTo: proposal.importPreview.source.coverageTo, bodyHash: proposal.importPreview.source.bodyHash } : null }) })
      assertLive()
    } else {
      const entities = await currentCalendarEntities(state), rebuilt = buildCalendarChangePlan(state, entities, proposal.plan.from, proposal.plan.to, proposal.plan.scope), { digest: _planDigest, ...expected } = proposal.plan
      if (canonicalJSON(rebuilt) !== canonicalJSON(expected)) throw new ConflictError()
      if (rebuilt.conflicts.length) throw new Error('矛盾・本人編集・着手済みの回を個別に確認してください')
      const next = structuredClone(state), trips = await db.tripBundles.toArray()
      for (const spec of rebuilt.creates) {
        if (await db.tasks.where('generationKey').equals(spec.generationKey).first() || next.instances.some(instance => instance.generationKey === spec.generationKey)) throw new ConflictError()
        const id = spec.kind === 'task' ? await addTask({ ...newTaskInput(), title: spec.title, scheduledDate: spec.scheduledDate, dueDate: spec.dueDate, ...specDue(spec), score: spec.score! }, spec.generationKey, null, 'routine') : uid()
        assertLive()
        if (spec.kind === 'event') { await db.calendarEvents.add(eventFrom(spec, id, current.profileId, at)); assertLive() }
        next.instances.push({ generationKey: spec.generationKey, entityId: id, entityRevision: 1, status: 'active', spec: structuredClone(spec) })
      }
      for (const update of rebuilt.updates) {
        const instance = next.instances.find(row => row.generationKey === update.before.generationKey)!
        if (update.after.kind === 'task') {
          const task = (await db.tasks.get(instance.entityId))!
          const scoreChanged = canonicalJSON(task.score) !== canonicalJSON(update.after.score), score = structuredClone(update.after.score!), result = calculateScore(score)
          assertTripTaskScoreChangeAllowed(task.id, task.score, score, trips)
          let assessmentId = task.assessmentId
          if (scoreChanged) { assessmentId = uid(); await db.assessments.add({ id: assessmentId, taskId: task.id, score, result, createdAt: at, origin: 'routine', ruleVersion: 'v1' }); const completion = await db.completions.where('taskId').equals(task.id).first(); if (completion?.currentAt) throw new ConflictError(); if (completion) await db.completions.put({ ...completion, lastConfirmedPoints: result.effective }) }
          await db.tasks.put({ ...task, title: update.after.title, scheduledDate: update.after.scheduledDate, dueDate: update.after.dueDate, ...specDue(update.after, task), score, effectivePoints: result.effective, assessmentId, deletedAt: null, revision: task.revision + 1, updatedAt: at })
          instance.entityRevision = task.revision + 1
        } else {
          const old = await db.calendarEvents.get(instance.entityId)
          await db.calendarEvents.put(eventFrom(update.after, instance.entityId, current.profileId, old?.createdAt ?? at)); instance.entityRevision++
        }
        instance.status = 'active'; instance.spec = structuredClone(update.after)
        assertLive()
      }
      for (const cancel of rebuilt.cancels) {
        const instance = next.instances.find(row => row.generationKey === cancel.before.generationKey)!
        if (instance.spec.kind === 'task') { const task = (await db.tasks.get(instance.entityId))!; if (task.status === 'completed') throw new ConflictError(); await db.tasks.put({ ...task, deletedAt: at, revision: task.revision + 1, updatedAt: at }); instance.entityRevision = task.revision + 1 }
        else { await db.calendarEvents.delete(instance.entityId); instance.entityRevision++ }
        instance.status = 'cancelled'
        assertLive()
      }
      next.revision++
      validateCalendarRulesState(next, current.profileId, current.datasetId); await calendarTable.put(next); assertLive()
      await db.audits.add({ id: uid(), taskId: null, operation: 'calendar.apply', at, detail: JSON.stringify({ proposalId: proposal.id, digest: proposal.digest, approvedBy: current.profileId, policyEpoch: proposal.policyEpoch, scope: rebuilt.scope, creates: rebuilt.creates, updates: rebuilt.updates, cancels: rebuilt.cancels, completedUnchanged: rebuilt.skippedCompleted }) })
      assertLive()
    }
    const resultId = guard?.resultId ?? proposal.id
    if (guard) {
      if (guard.businessKey) { await db.commands.add({ key: guard.businessKey, hash: guard.businessHash, resultId, at }); assertLive() }
      if (guard.candidateKey) { await db.commands.add({ key: guard.candidateKey, hash: guard.candidateHash, resultId, at }); assertLive() }
      const csvApproval = guard.detail.origin === 'manual_csv'
      await db.audits.add({ id: uid(), taskId: null, operation: csvApproval ? 'calendar.csv.approved' : 'routine.assistance.approved', at, detail: JSON.stringify({ ...guard.detail, configurationId: proposal.id, digest: proposal.digest, ...(csvApproval ? { sourceId: resultId } : { ruleId: resultId }), approvedBy: current.profileId }) })
      assertLive()
    }
    await db.commands.add({ key, hash, resultId, at }); assertLive(); return resultId
  })
}
