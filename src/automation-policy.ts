import type { Audit, Settings } from './domain'
import type { ChangePolicy, TaskChangeField } from './change-set'

/** N09 operation groups (design 29.2). Internal authority is per operation, never a numeric level. */
export const OPERATION_GROUPS = ['detection.register', 'task.text', 'task.schedule', 'task.deadline', 'task.manual_points', 'task.split', 'routine.change', 'task.lifecycle', 'notification.send', 'external.write', 'achievement.publish', 'local_action.run', 'authority.expand'] as const
export type OperationGroup = typeof OPERATION_GROUPS[number]
export type OperationMode = 'deny' | 'require_approval' | 'auto_within_bounds'
export type AutomationPreset = 'A0' | 'A1' | 'A2' | 'A3' | 'custom'
export const AUTOMATION_PRESETS = ['A0', 'A1', 'A2', 'A3'] as const
/** Exactly the rule shape of contracts/automation-policy.schema.json. */
export type AutomationRule = { operation: OperationGroup; mode: OperationMode; spaces: string[]; sources: string[]; max_daily_count: number; max_points_delta: number | null; max_schedule_days_delta: number | null; allow_protected_fields: boolean; require_user_instruction: boolean; destinations: string[] }
export type AllowedHours = { start: string; end: string }
export type AutomationStopFlags = { notifications: boolean; routines: boolean }
export type StopScope = 'aiProcessing' | 'aiChanges' | 'notifications' | 'routines'
export type AutomationStops = Record<StopScope, boolean>
export type OperationDecision = { status: 'denied' | 'awaiting_approval' | 'auto'; reason: string }
/** Detection may become automatic only after the independent N04 evaluation passes; it has not. */
export const DETECTION_AUTO_GATE_PASSED = false
export const MAX_DAILY_COUNT = 1000
const RULE_KEYS = ['operation', 'mode', 'spaces', 'sources', 'max_daily_count', 'max_points_delta', 'max_schedule_days_delta', 'allow_protected_fields', 'require_user_instruction', 'destinations'] as const
const approvalOnly: OperationMode[] = ['deny', 'require_approval'], all: OperationMode[] = ['deny', 'require_approval', 'auto_within_bounds']
export const OPERATION_INFO: Record<OperationGroup, { label: string; allowed: OperationMode[]; fixed: string | null }> = {
  'detection.register': { label: '検出した必要タスクの登録', allowed: DETECTION_AUTO_GATE_PASSED ? all : approvalOnly, fixed: '独立評価（N04）を通過するまで、検出は毎回本人が確認します。' },
  'task.text': { label: 'タイトル・メモの修正', allowed: all, fixed: null },
  'task.schedule': { label: '予定日の変更', allowed: all, fixed: null },
  'task.deadline': { label: '本当の締め切りの変更', allowed: approvalOnly, fixed: '本人の明示指示と毎回の確認が必要です。' },
  'task.manual_points': { label: '本人指定ポイントの変更', allowed: approvalOnly, fixed: '本人の明示指示と毎回の確認が必要です。点数は自動変更しません。' },
  'task.split': { label: 'タスクの分割', allowed: approvalOnly, fixed: 'この版には範囲内で自動適用する経路がありません。' },
  'routine.change': { label: '新規ルーティン・系列の変更', allowed: approvalOnly, fixed: 'この版には範囲内で自動適用する経路がありません。' },
  'task.lifecycle': { label: '完了・取消・削除・実績訂正', allowed: approvalOnly, fixed: '完了・取消・削除・実績訂正は自動適用しません。' },
  'notification.send': { label: '通知', allowed: ['deny', 'auto_within_bounds'], fixed: '通知ごとの承認画面はありません。静かな時間・1日上限の範囲で送るか、停止するかを選びます。' },
  'external.write': { label: '外部送信・カレンダー書込', allowed: approvalOnly, fixed: 'この版では外部への書込みを自動実行しません。' },
  'achievement.publish': { label: 'GitHub実績の公開', allowed: approvalOnly, fixed: '公開は毎回本人が確認します。' },
  'local_action.run': { label: 'PCの許可済み操作', allowed: approvalOnly, fixed: 'PC操作は本人が確認します。別途確認した低リスクのイベント条件・固定引数・期限・回数だけを委任できます。' },
  'authority.expand': { label: '権限拡張・秘密取得・任意SQL/shell', allowed: ['deny'], fixed: 'エージェントには委任できません。本人の設定画面だけで管理します。' },
}
const MODE_RANK: Record<OperationMode, number> = { deny: 0, require_approval: 1, auto_within_bounds: 2 }
function fail(message: string): never { throw Object.assign(new Error(message), { code: 'POLICY_INVALID' }) }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype)
const integer = (value: unknown, min: number, max: number) => Number.isInteger(value) && Number(value) >= min && Number(value) <= max
const strings = (value: unknown) => Array.isArray(value) && value.length <= 50 && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 200) && new Set(value).size === value.length
const time = (value: unknown): value is string => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)

function rule(operation: OperationGroup, mode: OperationMode, preset: Exclude<AutomationPreset, 'custom'> | 'legacy'): AutomationRule {
  const auto = operation === 'task.text' || operation === 'task.schedule'
  return { operation, mode, spaces: [], sources: [], max_daily_count: operation === 'notification.send' ? 50 : auto ? preset === 'A3' ? 20 : 10 : 0, max_points_delta: null, max_schedule_days_delta: operation === 'task.schedule' ? preset === 'A3' ? 7 : 3 : null, allow_protected_fields: false, require_user_instruction: operation === 'task.deadline' || operation === 'task.manual_points', destinations: [] }
}
/** Presets are only initial values; the stored operation table is what decides. */
export function presetRules(preset: Exclude<AutomationPreset, 'custom'>): AutomationRule[] {
  return OPERATION_GROUPS.map(operation => {
    // A0 keeps owner-configured factual notifications like other deterministic routines.
    const mode: OperationMode = operation === 'authority.expand' ? 'deny' : operation === 'notification.send' ? 'auto_within_bounds' : preset === 'A0' ? 'deny' : preset !== 'A1' && (operation === 'task.text' || operation === 'task.schedule') ? 'auto_within_bounds' : 'require_approval'
    return rule(operation, mode, preset)
  })
}
/** Older settings keep exactly their previous decisions (taskUpdate + fieldRules). */
export function legacyRules(policy: Pick<ChangePolicy, 'taskUpdate' | 'bounds' | 'fieldRules'>): AutomationRule[] {
  const stopped = policy.taskUpdate === 'deny'
  return presetRules('A1').map(item => {
    // The old automatic mode had no daily count, so it keeps the maximum.
    if (item.operation === 'task.text' || item.operation === 'task.schedule') return { ...item, mode: policy.taskUpdate, max_daily_count: policy.taskUpdate === 'auto_within_bounds' ? MAX_DAILY_COUNT : item.max_daily_count, max_schedule_days_delta: item.operation === 'task.schedule' ? policy.bounds.maxScheduledDayShift : null }
    if (item.operation === 'task.deadline') return { ...item, mode: stopped ? 'deny' : policy.fieldRules?.dueDate ?? 'require_approval' }
    if (item.operation === 'task.manual_points') return { ...item, mode: stopped ? 'deny' : policy.fieldRules?.manualPoints ?? 'require_approval' }
    if (item.operation === 'local_action.run') return { ...item, mode: stopped ? 'deny' : 'require_approval' }
    return item
  })
}
export function automationRulesFor(policy: ChangePolicy): AutomationRule[] { return structuredClone(policy.operations ?? legacyRules(policy)) }
export function ruleFor(policy: ChangePolicy, operation: OperationGroup): AutomationRule { return automationRulesFor(policy).find(item => item.operation === operation)! }
export function operationMode(policy: ChangePolicy, operation: OperationGroup): OperationMode { return ruleFor(policy, operation).mode }
export function validateAutomationRules(value: unknown): asserts value is AutomationRule[] {
  if (!Array.isArray(value) || value.length !== OPERATION_GROUPS.length) fail('操作別の設定が不正です')
  value.forEach((item, index) => {
    if (!record(item) || Object.keys(item).length !== RULE_KEYS.length || RULE_KEYS.some(key => !Object.hasOwn(item, key)) || item.operation !== OPERATION_GROUPS[index]) fail('操作別の設定が不正です')
    const operation = item.operation as OperationGroup, info = OPERATION_INFO[operation]
    if (!all.includes(item.mode as OperationMode)) fail('操作別の設定が不正です')
    if (!info.allowed.includes(item.mode as OperationMode)) fail(`${info.label}: ${info.fixed ?? 'この扱いは選べません'}`)
    // spaces/sources/destinations restrictions are not enforced by the engine, so they are refused instead of silently widened.
    if (!strings(item.spaces) || !strings(item.sources) || !strings(item.destinations) || (item.spaces as string[]).length || (item.sources as string[]).length || (item.destinations as string[]).length || !integer(item.max_daily_count, 0, MAX_DAILY_COUNT) || item.max_points_delta !== null || item.allow_protected_fields !== false || typeof item.require_user_instruction !== 'boolean') fail(`${info.label}の上限が不正です`)
    if (item.max_schedule_days_delta !== null && (operation !== 'task.schedule' || !integer(item.max_schedule_days_delta, 0, 3650))) fail(`${info.label}の移動日数が不正です`)
    if ((operation === 'task.deadline' || operation === 'task.manual_points') && item.require_user_instruction !== true) fail(`${info.label}には本人の指示が必要です`)
    if (item.require_user_instruction === true && operation !== 'task.deadline' && operation !== 'task.manual_points') fail(`${info.label}の上限が不正です`)
    if (operation === 'task.schedule' && item.max_schedule_days_delta === null) fail('予定日の自動移動日数を指定してください')
  })
}
export function validateAllowedHours(value: unknown): asserts value is Partial<Record<OperationGroup, AllowedHours>> {
  if (!record(value) || Object.entries(value).some(([operation, hours]) => !OPERATION_GROUPS.includes(operation as OperationGroup) || !record(hours) || Object.keys(hours).length !== 2 || !time(hours.start) || !time(hours.end) || hours.start === hours.end)) fail('自動変更の時間帯が不正です')
}
export function validateStopFlags(value: unknown): asserts value is AutomationStopFlags {
  if (!record(value) || Object.keys(value).length !== 2 || typeof value.notifications !== 'boolean' || typeof value.routines !== 'boolean') fail('停止スイッチの設定が不正です')
}
export function matchingPreset(rules: AutomationRule[]): AutomationPreset {
  const text = JSON.stringify(rules)
  return AUTOMATION_PRESETS.find(preset => JSON.stringify(presetRules(preset)) === text) ?? 'custom'
}
/** Rows that differ from the chosen preset (A1 for custom), shown highlighted in S20. */
export function overriddenOperations(rules: AutomationRule[], preset: AutomationPreset): OperationGroup[] {
  const base = presetRules(preset === 'custom' ? 'A1' : preset)
  return rules.filter((item, index) => JSON.stringify(item) !== JSON.stringify(base[index])).map(item => item.operation)
}
/** True when the candidate grants anything the current table does not. Reductions need no preview. */
export function increasedOperations(previous: AutomationRule[], next: AutomationRule[], previousHours: Partial<Record<OperationGroup, AllowedHours>> = {}, nextHours: Partial<Record<OperationGroup, AllowedHours>> = {}): OperationGroup[] {
  return next.filter((item, index) => {
    const before = previous[index]
    if (MODE_RANK[item.mode] > MODE_RANK[before.mode]) return true
    if (item.mode !== 'auto_within_bounds') return false
    return item.max_daily_count > before.max_daily_count || (item.max_schedule_days_delta ?? 0) > (before.max_schedule_days_delta ?? 0) || Boolean(previousHours[item.operation]) && JSON.stringify(previousHours[item.operation]) !== JSON.stringify(nextHours[item.operation])
  }).map(item => item.operation)
}
const LOCK_RANK = { unlocked: 0, protect_from_autonomous: 1, locked_until_human_approval: 2 } as const
const LOCK_LABELS = { title: 'タイトルの保護', notes: 'メモの保護', scheduledDate: '予定日の保護' } as const
/** Everything S20 can widen: the operation table plus field locks, amount bounds and the title rule. Reductions return nothing. */
export function increasedPolicyItems(previous: ChangePolicy, next: ChangePolicy): string[] {
  const items: string[] = increasedOperations(automationRulesFor(previous), next.operations ?? automationRulesFor(next), previous.allowedHours ?? {}, next.allowedHours ?? {})
  for (const field of ['title', 'notes', 'scheduledDate'] as const) if (LOCK_RANK[next.locks[field] ?? 'unlocked'] < LOCK_RANK[previous.locks[field] ?? 'unlocked']) items.push(LOCK_LABELS[field])
  if (next.bounds.maxTasks > previous.bounds.maxTasks) items.push('一度に自動変更する件数')
  if (next.bounds.maxNotesCharacters > previous.bounds.maxNotesCharacters) items.push('メモの自動変更量')
  // Mirrored from the task.schedule row today; a guard only while that row is automatic.
  if (next.bounds.maxScheduledDayShift > previous.bounds.maxScheduledDayShift && operationMode(next, 'task.schedule') === 'auto_within_bounds' && !items.includes('task.schedule')) items.push('予定日を動かせる日数')
  if ((previous.fieldRules?.title ?? 'require_approval') === 'deny' && (next.fieldRules?.title ?? 'require_approval') === 'require_approval') items.push('タイトルの代理変更')
  return items
}
/** Display label for an increasedPolicyItems entry. */
export const increaseLabel = (item: string) => Object.hasOwn(OPERATION_INFO, item) ? OPERATION_INFO[item as OperationGroup].label : item
/** A clock deadline (dueAt) is the same real-deadline operation as dueDate: approval only, never automatic. */
export function operationsForFields(fields: readonly TaskChangeField[]): OperationGroup[] {
  const map: Record<TaskChangeField, OperationGroup> = { title: 'task.text', notes: 'task.text', scheduledDate: 'task.schedule', dueDate: 'task.deadline', dueAt: 'task.deadline', manualPoints: 'task.manual_points' }
  return [...new Set(fields.map(field => map[field]))]
}
/** Single-operation gate used by non-ChangeSet entrances (routine, detection, PC operations, notifications, publish). */
export function decideOperation(policy: ChangePolicy, operation: OperationGroup): OperationDecision {
  const mode = operationMode(policy, operation), label = OPERATION_INFO[operation].label
  if (mode === 'deny') return { status: 'denied', reason: `${label}は停止しています（自動化設定）` }
  return mode === 'auto_within_bounds' ? { status: 'auto', reason: `${label}は設定した範囲内で自動です` } : { status: 'awaiting_approval', reason: `${label}は毎回本人が確認します` }
}
export function assertOperationAllowed(policy: ChangePolicy, operation: OperationGroup) {
  const decision = decideOperation(policy, operation)
  if (decision.status === 'denied') throw Object.assign(new Error(decision.reason), { code: 'CHANGES_STOPPED' })
}
export function automationStopsFor(settings: Pick<Settings, 'aiEnabled'>, policy: ChangePolicy): AutomationStops {
  return { aiProcessing: !settings.aiEnabled, aiChanges: !policy.aiChangesEnabled, notifications: Boolean(policy.stops?.notifications), routines: Boolean(policy.stops?.routines) }
}
export function localClock(at: string, timezone: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))
  const part = (key: string) => parts.find(value => value.type === key)!.value
  return { day: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` }
}
export function withinAllowedHours(at: string, timezone: string, hours: AllowedHours | undefined): boolean {
  if (!hours) return true
  const now = localClock(at, timezone).time
  return hours.start < hours.end ? now >= hours.start && now < hours.end : now >= hours.start || now < hours.end
}
export const ownerTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
export type ChangeAuditFact = { auditId: string; changeSetId: string; taskId: string | null; at: string; principal: { id: string; kind: 'human' | 'coach' | 'external-agent'; model?: string | null }; decision: 'auto' | 'approved'; fields: TaskChangeField[]; operations: OperationGroup[]; before: Record<string, unknown>; after: Record<string, unknown>; undo: { expectedRevision: number; patch: Record<string, unknown>; score?: unknown; requiresNewInstruction?: boolean } | null; undoOf: string | null; reason: string }
/** Display/count facts parsed from changeset.update audits. Older audits lacked the decision field. */
export function changeAuditFact(audit: Audit): ChangeAuditFact | null {
  if (audit.operation !== 'changeset.update') return null
  try {
    const detail = JSON.parse(audit.detail) as Record<string, unknown>, principal = detail.principal as ChangeAuditFact['principal'], undo = record(detail.undo) ? detail.undo as ChangeAuditFact['undo'] : null
    const fields = Object.keys(undo?.patch ?? detail.fieldOrigins ?? {}).filter((field): field is TaskChangeField => ['title', 'notes', 'scheduledDate', 'dueDate', 'dueAt', 'manualPoints'].includes(field))
    if (!record(principal) || !['human', 'coach', 'external-agent'].includes(principal.kind)) return null
    const decision = detail.decision === 'auto' || detail.decision === 'approved' ? detail.decision : detail.approvedBy === null && principal.kind !== 'human' ? 'auto' : 'approved'
    return { auditId: audit.id, changeSetId: String(detail.changeSetId ?? ''), taskId: audit.taskId, at: audit.at, principal, decision, fields, operations: operationsForFields(fields), before: record(detail.before) ? detail.before : {}, after: record(detail.after) ? detail.after : {}, undo, undoOf: typeof detail.undoOf === 'string' ? detail.undoOf : null, reason: typeof detail.reason === 'string' ? detail.reason : '' }
  } catch { return null }
}
/** Owner-approved ChangeSets made through the coach screens (replan candidates, consult). Only these human changes can be undone from the coach. */
export const COACH_MEDIATED_REASONS = ['アプリの再計画候補（本人選択）', '本人が指定した対象と値の変更（まだ適用していません）'] as const
export const coachMediatedChange = (fact: Pick<ChangeAuditFact, 'principal' | 'reason'>) => fact.principal.kind !== 'human' || (COACH_MEDIATED_REASONS as readonly string[]).includes(fact.reason)
/** Automatic agent changes already applied today (owner timezone), counted across all entrances. */
export function autoChangeCounts(audits: Audit[], at: string, timezone: string): Partial<Record<OperationGroup, number>> {
  const day = localClock(at, timezone).day, counts: Partial<Record<OperationGroup, number>> = {}
  for (const audit of audits) {
    const fact = changeAuditFact(audit)
    if (!fact || fact.decision !== 'auto' || fact.principal.kind === 'human' || localClock(fact.at, timezone).day !== day) continue
    for (const operation of fact.operations) counts[operation] = (counts[operation] ?? 0) + 1
  }
  return counts
}
export type CoachAuthorityCommand = { kind: 'reduce'; scope: StopScope | 'all' } | { kind: 'escalation' } | { kind: 'undo-latest' }
const STOP_VERB = '(を|は)?(止めて|とめて|止めます|停止して|停止する|停止|オフにして|offにして|ストップして|ストップ)'
const STOP_COMMANDS: [RegExp, CoachAuthorityCommand][] = [
  [/^(緊急停止(して|する)?|(全部|すべて|全て|ぜんぶ)の(自動化|自動処理|ai)を(止めて|停止して))$/, { kind: 'reduce', scope: 'all' }],
  [new RegExp(`^(通知|リマインド|催促)${STOP_VERB}$`), { kind: 'reduce', scope: 'notifications' }],
  [new RegExp(`^(ルーティン|繰り返し|くりかえし|定期(生成)?)(の生成)?${STOP_VERB}$`), { kind: 'reduce', scope: 'routines' }],
  [new RegExp(`^(aiの|aiによる)?(自動変更|変更|変更案|自動適用|自動化|編集)${STOP_VERB}$`), { kind: 'reduce', scope: 'aiChanges' }],
  [new RegExp(`^(ai|ai処理|aiの処理|エーアイ|コーチのai)${STOP_VERB}$`), { kind: 'reduce', scope: 'aiProcessing' }],
]
const ESCALATION = /^(aiの|aiによる)?(通知|リマインド|ルーティン|繰り返し|定期(生成)?|自動変更|自動適用|自動化|自動|変更|権限|ai処理|aiの処理|ai|全部|すべて|全て|ぜんぶ|接続|pc操作|mcp)(を|は)?(自動(に|化)(して|する)|再開(して|する)?|許可(して|する)|(増や|広げ|上げ)して|(on|オン)に(して|する)|有効に(して|する)|解除(して|する))$/
/** Deterministic and reduce-only: it never needs an LLM, and never grants authority. */
export function parseCoachAuthorityCommand(input: string): CoachAuthorityCommand | null {
  const text = input.normalize('NFKC').replace(/\s+/g, '').toLowerCase().replace(/(ください|下さい|お願いします|お願い)?[。.!?！？]*$/, '')
  // Only short imperative messages are commands; consultations ("筋トレを再開したい") go to the normal coach turn.
  if (!text || text.length > 30) return null
  if (/(止め|停止し|やめ)ないで|止めなくて/.test(text)) return null
  // The scope noun must open the message and sit directly before the verb, so 'コーチ、…を再開する' or '…のgmail' never match.
  if (ESCALATION.test(text)) return { kind: 'escalation' }
  if (/(さっき|直前|最後|最新)の?(自動|代理)?(の)?(変更|移動|修正)?を?(取り消して|取消して|元に戻して|戻して)$/.test(text)) return { kind: 'undo-latest' }
  // Whole-message command forms only; anything else (per-task wording, vocatives, 'やめて') is a normal coach turn.
  const found = STOP_COMMANDS.find(([pattern]) => pattern.test(text))
  return found ? { ...found[1] } : null
}
export const STOP_LABELS: Record<StopScope, string> = { aiProcessing: 'AI処理', aiChanges: 'AIによる変更', notifications: '通知', routines: 'ルーティン・繰り返し生成' }
