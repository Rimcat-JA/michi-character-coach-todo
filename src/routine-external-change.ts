import { db } from './db'
import { canonicalJSON } from './canonical'
import { today, type Settings } from './domain'
import { ChangeSetError, changePolicyFor } from './change-set'
import { operationMode } from './automation-policy'
import { calendarRuleEditorDefinition } from './calendar-rule-editor'
import { loadCalendarRulesState } from './calendar-rules-save'
import { validateRoutineAssistCandidate, type RoutineAssistCandidate } from './routine-assist'
import { confirmExternalRoutineInstructionFromUI, nativeRoutineEvent } from './routine-instruction'
import { applyRoutineAssistConfigurationFromUI, cancelRoutineAssistance, prepareExternalRoutineConfiguration, type PreparedRoutineAssistance } from './routine-assist-save'
import { assertPendingCommand, commandOutcome, registerCommandType, reprepareCommand, type CommandEnvelope, type CommandPreparation, type PreparedCommand } from './command-bus'
import type { CalendarChangeScope, CalendarRule, CalendarRulesState } from './calendar-resolver'
import type { FileBridgeScope, FileBridgeTrigger } from './file-bridge-types'

/** N03-G2 / N05-G4: an external series change reaches the common routine engine only after owner review. */
export type RoutineCommandBody = { stage: 'owner_values'; candidate: RoutineAssistCandidate; ruleTitle: string; ruleRevision: number } | { stage: 'review'; assistance: PreparedRoutineAssistance; ruleTitle: string }
export const routineBody = (prepared: PreparedCommand) => prepared.body as RoutineCommandBody
function fail(code: string, message: string): never { throw new ChangeSetError(code, message) }
export function triggerFromCommand(trigger: FileBridgeTrigger): CalendarRule['trigger'] {
  if (trigger.kind === 'weekly') return { kind: 'weekly', weekdays: [...trigger.weekdays], time: trigger.time }
  if (trigger.kind === 'monthly_business') return { kind: 'monthly_business', ordinal: trigger.ordinal, from: trigger.from, time: trigger.time }
  return { kind: 'activity_relative', activityId: trigger.activity_id, edge: trigger.edge, offsetDays: trigger.offset_days, offsetMinutes: trigger.offset_minutes }
}
/** RRULE and completion-relative series (N05) are not offered to external agents in this version. */
export const externallyEditableTrigger = (trigger: CalendarRule['trigger']) => trigger.kind === 'weekly' || trigger.kind === 'monthly_business' || trigger.kind === 'activity_relative'
export function triggerForCommand(trigger: CalendarRule['trigger']): FileBridgeTrigger | null {
  if (trigger.kind === 'activity_relative') return { kind: 'activity_relative', activity_id: trigger.activityId, edge: trigger.edge, offset_days: trigger.offsetDays, offset_minutes: trigger.offsetMinutes }
  if (trigger.kind === 'weekly') return { kind: 'weekly', weekdays: [...trigger.weekdays], time: trigger.time }
  if (trigger.kind === 'monthly_business') return { kind: 'monthly_business', ordinal: trigger.ordinal, from: trigger.from, time: trigger.time }
  return null
}
function scopeFromCommand(scope: FileBridgeScope): CalendarChangeScope {
  return scope.kind === 'this_and_future' ? { kind: 'this_and_future', fromDate: scope.from_date } : scope.kind === 'this_instance' ? { kind: 'this_instance', generationKey: scope.generation_key } : { kind: 'all_uncompleted' }
}
function stopped(settings: Settings) { const policy = changePolicyFor(settings); return !settings.aiEnabled || !policy.aiChangesEnabled || operationMode(policy, 'routine.change') === 'deny' }
/** Builds a candidate that keeps the rule's title, steps, points and period; only the recurrence and scope come from the agent. */
export function externalRoutineCandidate(envelope: CommandEnvelope, state: CalendarRulesState, actorId: string): RoutineAssistCandidate {
  const rule = state.rules.find(value => value.id === envelope.target_id)
  if (!rule) fail('UNAUTHORIZED', '選択していない系列は変更できません')
  if (rule.revision !== envelope.expected_revision) fail('CONFLICT', '系列が更新されています。新しい版で依頼し直してください')
  const payload = envelope.payload as { scope: FileBridgeScope; definition: { trigger: FileBridgeTrigger } }, previous = calendarRuleEditorDefinition(rule), trigger = triggerFromCommand(payload.definition.trigger)
  const context = state.contexts.find(value => value.id === rule.contextId), step = previous.steps[0]
  if (!context || !step) fail('ROUTINE_INVALID', '系列の対象を確認できません')
  if (!externallyEditableTrigger(previous.trigger)) fail('ROUTINE_INVALID', 'RRULE・完了起点の系列は外部からは変更できません。アプリの繰り返し画面で本人が変更してください')
  const time = trigger.kind === 'weekly' || trigger.kind === 'monthly_business' ? trigger.time : 'time' in previous.trigger ? previous.trigger.time : '00:00'
  const candidate: RoutineAssistCandidate = {
    input: { message: `外部エージェント ${actorId} からの周期変更依頼（コマンド ${envelope.command_id}）`, referenceDate: today(), targetRuleId: rule.id, expectedRuleRevision: rule.revision, selection: { contextId: rule.contextId, bindingId: rule.bindingId, calendarId: rule.calendarId, activityId: trigger.kind === 'activity_relative' ? trigger.activityId : null, timezone: context.timezone, validFrom: rule.validFrom, validTo: rule.validTo, time, stepKind: step.kind, durationMinutes: step.durationMinutes, scheduledOffsetDays: step.scheduledOffsetDays, dueOffsetDays: step.dueOffsetDays }, scope: scopeFromCommand(payload.scope) },
    definition: { title: previous.title, enabled: previous.enabled, trigger, steps: structuredClone(previous.steps) },
    notices: ['外部エージェントの依頼です。名称・点数・手順・有効期間は変更しません。次の回を確認して設定を承認し、発生回の反映は別に承認します。'],
  }
  if (canonicalJSON(trigger) === canonicalJSON(previous.trigger)) fail('NO_CHANGE', '周期は現在の設定と同じです')
  try { validateRoutineAssistCandidate(candidate, state) } catch (error) { fail('ROUTINE_INVALID', error instanceof Error ? error.message : '周期の変更案を確認できません') }
  return candidate
}
const nativeApprovals = new WeakMap<object, { event: Event; commandId: string }>()
registerCommandType({
  type: 'routine.change',
  validate(envelope) {
    const payload = envelope.payload as Record<string, unknown>
    if (typeof envelope.target_id !== 'string' || !envelope.target_id || !Number.isSafeInteger(envelope.expected_revision) || envelope.expected_revision! < 1) fail('INVALID_TARGET', '変更する系列と版を指定してください')
    if (Object.keys(payload).length !== 2 || !payload.scope || !payload.definition || typeof payload.definition !== 'object' || Object.keys(payload.definition).length !== 1 || !(payload.definition as Record<string, unknown>).trigger) fail('UNSUPPORTED_FIELD', '周期の変更は変更範囲と周期だけを指定できます')
  },
  async prepare(envelope, actor, options) {
    const settings = await db.settings.get('main')
    if (!settings || settings.profileId !== actor.ownerId || settings.datasetId !== actor.datasetId) fail('UNAUTHORIZED', 'この領域の変更は許可されていません')
    if (actor.principal.kind !== 'human' && stopped(settings)) fail('CHANGES_STOPPED', 'AIによる変更は停止しています')
    const state = await loadCalendarRulesState(), candidate = externalRoutineCandidate(envelope, state, actor.principal.id), rule = state.rules.find(value => value.id === envelope.target_id)!
    if (!options.instruction) return { stage: 'owner_values', body: { stage: 'owner_values', candidate, ruleTitle: calendarRuleEditorDefinition(rule).title, ruleRevision: rule.revision }, expiresAt: new Date(Date.now() + 86400000).toISOString(), reason: options.reason ?? '外部エージェントからの周期変更案' }
    const assistance = options.instruction as PreparedRoutineAssistance
    return { stage: 'review', body: { stage: 'review', assistance, ruleTitle: calendarRuleEditorDefinition(rule).title }, expiresAt: assistance.configuration.expiresAt, reason: options.reason ?? '外部エージェントからの周期変更案（本人が次の回を確認済み）' }
  },
  decide(prepared, settings) { return prepared.actor.principal.kind !== 'human' && stopped(settings) ? { status: 'denied', reason: 'AIによる変更は停止しています', protectedFields: [] } : { status: 'awaiting_approval', reason: '周期の設定は毎回本人が確認し、発生回の反映は別に承認します', protectedFields: [] } },
  async approve(prepared, event) {
    if (routineBody(prepared).stage !== 'review') fail('USER_INSTRUCTION_REQUIRED', '依頼内容を本人が確認して設定差分を作ってください')
    try { nativeRoutineEvent(event) } catch { fail('HUMAN_APPROVAL_REQUIRED', 'アプリの本人確認ボタンから承認してください') }
    const token = Object.freeze({ commandId: prepared.envelope.command_id }); nativeApprovals.set(token, { event, commandId: prepared.envelope.command_id }); return token
  },
  async apply(prepared, approval) {
    const body = routineBody(prepared), grant = approval && typeof approval === 'object' ? nativeApprovals.get(approval) : undefined
    if (body.stage !== 'review') fail('USER_INSTRUCTION_REQUIRED', '依頼内容を本人が確認して設定差分を作ってください')
    if (!grant || grant.commandId !== prepared.envelope.command_id) fail('HUMAN_APPROVAL_REQUIRED', '周期の設定は本人が承認してください')
    nativeApprovals.delete(approval as object)
    const settings = (await db.settings.get('main'))!, policy = changePolicyFor(settings), instruction = body.assistance.instruction
    if (prepared.actor.principal.kind !== 'human' && stopped(settings)) fail('CHANGES_STOPPED', 'AIによる変更は停止しています')
    if (policy.epoch !== instruction.policyEpoch || policy.sourcePermissionRevision !== instruction.sourcePermissionRevision) fail('POLICY_CHANGED', '確認後に権限設定が変わりました。依頼を確認し直してください')
    if ((await loadCalendarRulesState()).revision !== body.assistance.configuration.stateRevision) fail('CONFLICT', '周期の設定版が変わりました。依頼を確認し直してください')
    let ruleId: string
    try { ruleId = await applyRoutineAssistConfigurationFromUI(body.assistance, body.assistance.digest, grant.event) } catch (error) { fail('ROUTINE_INVALID', error instanceof Error ? error.message : '周期の設定を保存できません') }
    return { changeSetId: body.assistance.configuration.id, digest: body.assistance.digest, taskIds: [ruleId], appliedAt: new Date().toISOString() }
  },
  async cancel(prepared) { const body = routineBody(prepared); if (body.stage === 'review') cancelRoutineAssistance(body.assistance) },
})
/** Owner reviewed the agent's structured request: issue the external_request instruction and build the next-10 preview. */
export async function confirmRoutineCommandFromUI(prepared: PreparedCommand, event: Event): Promise<CommandPreparation> {
  try {
    const saved = assertPendingCommand(prepared), body = routineBody(saved)
    if (saved.envelope.type !== 'routine.change' || body.stage !== 'owner_values') fail('NO_CHANGE', '本人が確認する周期の依頼はありません')
    let instruction
    try { instruction = await confirmExternalRoutineInstructionFromUI(body.candidate.input, body.candidate, saved.actor.principal.id, event) } catch (error) { fail(error instanceof Error && /本人が周期補助の確認ボタン/.test(error.message) ? 'HUMAN_APPROVAL_REQUIRED' : 'ROUTINE_INVALID', error instanceof Error ? error.message : '周期の依頼を確認できません') }
    const actor = saved.actor, envelope = saved.envelope
    const assistance = await prepareExternalRoutineConfiguration(instruction, { businessKey: `routine-external:${actor.principal.id}:${envelope.command_id}`, detail: { entrance: actor.entrance, basis: 'external_request', commandId: envelope.command_id, actorId: actor.principal.id, host: actor.label }, assertCurrent: async () => { const current = await db.settings.get('main'); if (!current || stopped(current)) throw new Error('AIによる変更は停止しています') } })
    return reprepareCommand(saved, assistance, `${saved.reason}（本人が依頼内容と次の回を確認済み）`)
  } catch (error) { return { outcome: commandOutcome(error, { commandId: prepared?.envelope?.command_id ?? null, entrance: prepared?.actor?.entrance ?? null }), prepared: null } }
}
