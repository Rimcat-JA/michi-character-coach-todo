import Dexie from 'dexie'
import { db } from './db'
import { contentDigest, canonicalJSON } from './canonical'
import { changePolicyFor } from './change-set'
import { operationMode } from './automation-policy'
import { uid, type Settings } from './domain'
import { emptyCalendarRulesState, validateCalendarRulesState } from './calendar-rules-validation'
import { validateOwnerRoutineAssistCandidate, validateRoutineAssistCandidate, type RoutineAssistCandidate, type RoutineAssistInput } from './routine-assist'
import type { CalendarRulesState } from './calendar-resolver'

export type VerifiedRoutineInstruction = Readonly<{
  version: 1; id: string; nonce: string; ownerId: string; datasetId: string
  basis: 'manual' | 'owner_instruction' | 'verified_detection'; model: string | null
  stateRevision: number; policyEpoch: number; sourcePermissionRevision: number
  issuedAt: string; expiresAt: string; messageDigest: string; referencesDigest: string; targetDigest: string; configurationDigest: string
  candidate: RoutineAssistCandidate; digest: string
}>
const issued = new Map<string, VerifiedRoutineInstruction>()
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
export function clearRoutineInstructionAuthority() { issued.clear() }
export function revokeRoutineInstruction(instruction: VerifiedRoutineInstruction) { if (issued.get(instruction.id) === instruction) issued.delete(instruction.id) }
function references(input: RoutineAssistInput, state: CalendarRulesState) {
  const selected = input.selection
  return { context: state.contexts.find(value => value.id === selected.contextId) ?? null, binding: state.bindings.find(value => value.id === selected.bindingId) ?? null, calendar: state.calendars.find(value => value.id === selected.calendarId) ?? null, activity: selected.activityId === null ? null : state.activities.find(value => value.id === selected.activityId) ?? null, sources: state.sources.filter(value => value.contextId === selected.contextId), facts: state.facts.filter(value => value.contextId === selected.contextId) }
}
function configuration(state: CalendarRulesState) { const { contexts, bindings, calendars, activities, sources, facts, rules } = state; return { contexts, bindings, calendars, activities, sources, facts, rules } }
export async function assertRoutineInstructionReferences(instruction: VerifiedRoutineInstruction, state: CalendarRulesState, checkTarget: boolean) {
  const actual = await Dexie.waitFor(contentDigest(references(instruction.candidate.input, state)))
  if (actual !== instruction.referencesDigest) throw new Error('本人の参加条件・選択暦・活動または予定の根拠が変わりました。もう一度確認してください')
  if (checkTarget && await Dexie.waitFor(contentDigest(state.rules.find(value => value.id === instruction.candidate.input.targetRuleId) ?? null)) !== instruction.targetDigest) throw new Error('編集対象ルールの内容が変わりました。もう一度確認してください')
  if (checkTarget && await Dexie.waitFor(contentDigest(configuration(state))) !== instruction.configurationDigest) throw new Error('設定全体の内容が変わりました。古い案で別のルールを上書きしません')
}
export function nativeRoutineEvent(event: Event) {
  if (!(event instanceof Event) || !event.isTrusted || !['click', 'submit'].includes(event.type)) throw new Error('本人が周期補助の確認ボタンから操作してください')
  const getter = Object.getOwnPropertyDescriptor(Event.prototype, 'type')?.get
  try { if (!getter || !['click', 'submit'].includes(getter.call(event))) throw new Error() } catch { throw new Error('本人が周期補助の確認ボタンから操作してください') }
}
async function confirm(input: RoutineAssistInput, candidate: RoutineAssistCandidate, model: string | null, basis: VerifiedRoutineInstruction['basis'], event: Event): Promise<VerifiedRoutineInstruction> {
  nativeRoutineEvent(event)
  if (canonicalJSON(input) !== canonicalJSON(candidate.input)) throw new Error('確認する周期候補と本人選択が一致しません')
  if (model !== null && (typeof model !== 'string' || !/^[\w~./:-]{3,120}$/.test(model)) || (basis === 'manual') !== (model === null)) throw new Error('周期補助のモデルIDと入力元を確認してください')
  for (const [id, previous] of issued) if (Date.parse(previous.expiresAt) <= Date.now()) issued.delete(id)
  if (issued.size >= 100) throw new Error('未適用の周期確認が多すぎます。案を整理してから再確認してください')
  const payload = await db.transaction('r', [db.settings, db.calendarRules], async () => {
    const settings = await db.settings.get('main')
    if (!settings || basis !== 'manual' && (!settings.aiEnabled || settings.aiModel !== model)) throw new Error('選択したモデルのAI利用が停止または変更されています')
    const state = await db.calendarRules.get('main') ?? emptyCalendarRulesState(settings.profileId, settings.datasetId)
    validateCalendarRulesState(state, settings.profileId, settings.datasetId); validateRoutineAssistCandidate(candidate, state)
    if (basis !== 'verified_detection') validateOwnerRoutineAssistCandidate(candidate, state)
    const policy = changePolicyFor(settings), issuedAt = new Date().toISOString()
    if (basis !== 'manual' && !policy.aiChangesEnabled) throw new Error('AIによる変更案の受付は停止中です。手動設定を利用してください')
    if (basis !== 'manual' && operationMode(policy, 'routine.change') === 'deny') throw new Error('AIによるルーティン・系列の変更は停止しています（自動化設定）。手動設定を利用してください')
    return { version: 1 as const, id: uid(), nonce: uid(), ownerId: settings.profileId, datasetId: settings.datasetId, basis, model, stateRevision: state.revision, policyEpoch: policy.epoch, sourcePermissionRevision: policy.sourcePermissionRevision, issuedAt, expiresAt: new Date(Date.now() + 86400000).toISOString(), messageDigest: await Dexie.waitFor(contentDigest(input.message)), referencesDigest: await Dexie.waitFor(contentDigest(references(input, state))), targetDigest: await Dexie.waitFor(contentDigest(state.rules.find(value => value.id === input.targetRuleId) ?? null)), configurationDigest: await Dexie.waitFor(contentDigest(configuration(state))), candidate: structuredClone(candidate) }
  })
  const instruction = freeze({ ...payload, digest: await contentDigest(payload) })
  issued.set(instruction.id, instruction); return instruction
}
/** Confirms exact current input and fields; saved or model-issued metadata has no authority. */
export async function confirmRoutineInstructionFromUI(input: RoutineAssistInput, candidate: RoutineAssistCandidate, model: string | null, event: Event) {
  return confirm(input, candidate, model, model === null ? 'manual' : 'owner_instruction', event)
}
/** Original text remains external evidence; this confirmation adopts an explicit owner rule. */
export async function confirmSourceRoutineInstructionFromUI(input: RoutineAssistInput, candidate: RoutineAssistCandidate, model: string, event: Event) {
  return confirm(input, candidate, model, 'verified_detection', event)
}
export function assertRoutineInstruction(instruction: VerifiedRoutineInstruction, settings: Settings, state: CalendarRulesState, checkRevision = true) {
  const policy = changePolicyFor(settings)
  if (!instruction || issued.get(instruction.id) !== instruction || settings.profileId !== instruction.ownerId || settings.datasetId !== instruction.datasetId || instruction.basis !== 'manual' && (!settings.aiEnabled || !policy.aiChangesEnabled || operationMode(policy, 'routine.change') === 'deny' || settings.aiModel !== instruction.model) || policy.epoch !== instruction.policyEpoch || policy.sourcePermissionRevision !== instruction.sourcePermissionRevision || Date.parse(instruction.expiresAt) <= Date.now()) throw new Error('周期の本人確認・AI設定・権限または期限が変わりました。案を作り直してください')
  if (checkRevision && state.revision !== instruction.stateRevision) throw new Error('周期の設定版が変わりました。案を作り直してください')
  if (checkRevision) validateRoutineAssistCandidate(instruction.candidate, state)
}
