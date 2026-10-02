import Dexie from 'dexie'
import { db } from './db'
import { contentDigest, canonicalJSON } from './canonical'
import { uid } from './domain'
import { calendarRuleEditorDefinition } from './calendar-rule-editor'
import { assertRoutineInstruction, assertRoutineInstructionReferences, clearRoutineInstructionAuthority, confirmSourceRoutineInstructionFromUI, nativeRoutineEvent, revokeRoutineInstruction, type VerifiedRoutineInstruction } from './routine-instruction'
import { applyCalendarProposalFromUI, bindCalendarConfigurationGuard, discardCalendarConfigurationProposal, loadCalendarRulesState, prepareCalendarConfiguration, type CalendarConfigurationProposal, type CalendarRulesConfiguration } from './calendar-rules-save'
import type { RoutineAssistCandidate, RoutineAssistInput } from './routine-assist'
import type { CalendarRule, CalendarRulesState } from './calendar-resolver'

export type RoutineSourceGuard = { assertCurrent: () => Promise<void>; businessKey: string; candidateKey?: string; detail: Record<string, unknown> }
export type PreparedRoutineAssistance = Readonly<{ id: string; instruction: VerifiedRoutineInstruction; configuration: CalendarConfigurationProposal; digest: string }>
const preparedRegistry = new Map<string, PreparedRoutineAssistance>()
const sourceGuards = new Map<string, RoutineSourceGuard>()
export function clearRoutineAssistanceAuthority(options: {coachOnly?: boolean} = {}) { if(options.coachOnly){for(const value of preparedRegistry.values())if(!['manual','external_request'].includes(value.instruction.basis))cancelRoutineAssistance(value)}else{preparedRegistry.clear(); sourceGuards.clear(); clearRoutineInstructionAuthority()} }
export function cancelRoutineAssistance(prepared: PreparedRoutineAssistance) {
  if (preparedRegistry.get(prepared.id) !== prepared) return
  preparedRegistry.delete(prepared.id); sourceGuards.delete(prepared.instruction.id); revokeRoutineInstruction(prepared.instruction); discardCalendarConfigurationProposal(prepared.configuration)
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
function config(state: CalendarRulesState): CalendarRulesConfiguration { const { contexts, bindings, calendars, activities, sources, facts, rules } = state; return structuredClone({ contexts, bindings, calendars, activities, sources, facts, rules }) }
async function prepare(instruction: VerifiedRoutineInstruction): Promise<PreparedRoutineAssistance> {
  const current = await db.settings.get('main'), state = await loadCalendarRulesState()
  if (!current) throw new Error('本人の設定がありません')
  assertRoutineInstruction(instruction, current, state)
  await assertRoutineInstructionReferences(instruction, state, true)
  const sourceGuard = sourceGuards.get(instruction.id)
  if (instruction.basis === 'verified_detection' && !sourceGuard) throw new Error('検出した周期の根拠確認がありません')
  if (sourceGuard) await sourceGuard.assertCurrent()
  const candidate = instruction.candidate, input = candidate.input, selection = input.selection, next = config(state), old = state.rules.find(value => value.id === input.targetRuleId)
  const ruleId = old?.id ?? uid()
  if (old) {
    const target = next.rules.find(value => value.id === old.id)!
    // Retain all earlier editions, step identities, scores and completion facts.
    target.revision++
    target.editions = [...(target.editions ?? []), { id: uid(), revision: target.revision, scope: structuredClone(input.scope), definition: structuredClone(candidate.definition) }]
  } else {
    const rule: CalendarRule = { id: ruleId, contextId: selection.contextId, bindingId: selection.bindingId, calendarId: selection.calendarId, originBasis: sourceGuard ? 'user_approved_rule' : 'user_instruction', validFrom: selection.validFrom, validTo: selection.validTo, revision: 1, ...structuredClone(candidate.definition) }
    next.rules.push(rule)
  }
  const configuration = await prepareCalendarConfiguration(next, state.revision, selection.validFrom, selection.validTo, ruleId)
  const businessPayload = { ownerId: instruction.ownerId, datasetId: instruction.datasetId, selection, definition: candidate.definition, scope: input.scope, targetRuleId: input.targetRuleId }
  const businessHash = await contentDigest(businessPayload), candidateHash = await contentDigest({ businessKey: sourceGuard?.businessKey ?? null, businessHash })
  const detail = { instructionId: instruction.id, instructionDigest: instruction.digest, messageDigest: instruction.messageDigest, model: instruction.model, origin: instruction.basis, ownerId: instruction.ownerId, datasetId: instruction.datasetId, policyEpoch: instruction.policyEpoch, sourcePermissionRevision: instruction.sourcePermissionRevision, fromStateRevision: instruction.stateRevision, scope: input.scope, source: sourceGuard?.detail ?? null, protectedPreviousSteps: old ? calendarRuleEditorDefinition(old).steps.length : 0 }
  bindCalendarConfigurationGuard(configuration, {
    resultId: ruleId, businessKey: sourceGuard?.businessKey ?? null, candidateKey: sourceGuard?.candidateKey ?? null, businessHash, candidateHash, detail,
    assertCurrent: async (settings, latest) => { assertRoutineInstruction(instruction, settings, latest, false); const receipt = await db.commands.get(`calendar:${configuration.id}`); await assertRoutineInstructionReferences(instruction, latest, !receipt); if (sourceGuard) { if (sourceGuards.get(instruction.id) !== sourceGuard) throw new Error('検出周期の根拠確認が失効しました'); await sourceGuard.assertCurrent() } }
  })
  const payload = { id: uid(), instruction, configuration }
  const prepared = freeze({ ...payload, digest: await contentDigest(payload) })
  preparedRegistry.set(prepared.id, prepared); return prepared
}
export async function prepareRoutineAssistConfiguration(instruction: VerifiedRoutineInstruction): Promise<PreparedRoutineAssistance> {
  if (instruction.basis === 'verified_detection' || instruction.basis === 'external_request') throw new Error('検出・外部依頼の周期はそれぞれの確認入口から扱ってください')
  return prepare(instruction)
}
/** External command path: the business key makes a replayed command ID yield one configuration. */
export async function prepareExternalRoutineConfiguration(instruction: VerifiedRoutineInstruction, guard: RoutineSourceGuard): Promise<PreparedRoutineAssistance> {
  if (instruction.basis !== 'external_request' || !guard || typeof guard.assertCurrent !== 'function' || typeof guard.businessKey !== 'string' || !guard.businessKey || guard.businessKey.length > 1000 || canonicalJSON(guard.detail).length > 10000) throw new Error('外部依頼の周期確認が不正です')
  sourceGuards.set(instruction.id, { assertCurrent: guard.assertCurrent, businessKey: guard.businessKey, detail: structuredClone(guard.detail) })
  return prepare(instruction)
}
export async function prepareSourceRoutineConfiguration(input: RoutineAssistInput, candidate: RoutineAssistCandidate, model: string, guard: RoutineSourceGuard, event: Event): Promise<PreparedRoutineAssistance> {
  nativeRoutineEvent(event)
  if (!guard || typeof guard.assertCurrent !== 'function' || typeof guard.businessKey !== 'string' || !guard.businessKey || guard.businessKey.length > 1000 || guard.candidateKey !== undefined && (typeof guard.candidateKey !== 'string' || !guard.candidateKey || guard.candidateKey.length > 1000)) throw new Error('検出した周期の根拠・再採用キーが不正です')
  // Audit hints must be bounded JSON metadata, never full original source text.
  if (canonicalJSON(guard.detail).length > 10000) throw new Error('検出した周期の根拠記録が大きすぎます')
  await guard.assertCurrent()
  const instruction = await confirmSourceRoutineInstructionFromUI(input, candidate, model, event)
  const captured: RoutineSourceGuard = { assertCurrent: guard.assertCurrent, businessKey: guard.businessKey, ...(guard.candidateKey ? { candidateKey: guard.candidateKey } : {}), detail: structuredClone(guard.detail) }
  sourceGuards.set(instruction.id, captured)
  return prepare(instruction)
}
export async function applyRoutineAssistConfigurationFromUI(prepared: PreparedRoutineAssistance, confirmedDigest: string, event: Event): Promise<string> {
  nativeRoutineEvent(event)
  if (!prepared || preparedRegistry.get(prepared.id) !== prepared || prepared.digest !== confirmedDigest) throw new Error('登録済みの周期確認案ではありません。原文と選択内容から確認し直してください')
  const { digest, ...payload } = prepared
  if (digest !== await Dexie.waitFor(contentDigest(payload))) throw new Error('確認後に周期候補が変わりました')
  return applyCalendarProposalFromUI(prepared.configuration, event)
}
