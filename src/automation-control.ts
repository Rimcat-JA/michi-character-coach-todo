import { revokedExternalAI } from './external-authority'
import { db } from './db'
import { contentDigest } from './canonical'
import { uid, type Settings } from './domain'
import { assertTrustedOwnerEvent, changePolicyFor, ChangeSetError, validateChangePolicy, type ChangeContext, type ChangePolicy } from './change-set'
import { automationStopsFor, increasedPolicyItems, matchingPreset, STOP_LABELS, validateAutomationRules, type AllowedHours, type AutomationPreset, type AutomationRule, type AutomationStops, type CoachAuthorityCommand, type OperationGroup, type StopScope } from './automation-policy'
import { dryRunPolicy, recentChangeAudits, type DryRunSummary } from './change-history'
import { clearVolatileAuthorities, updateAIConnection } from './ai-connection'
import { invalidateExternalConnection, stopConnection } from './external-connection'
import { cancelPendingCoachNotifications } from './coach-notifications'
import { clearCalendarRulesAuthority } from './calendar-rules-save'
import { clearRoutineAssistanceAuthority } from './routine-assist-save'
import { coachNotificationStateFor } from './coach-notification-save'

export type AutomationPolicyInput = { preset: AutomationPreset; rules: AutomationRule[]; allowedHours: Partial<Record<OperationGroup, AllowedHours>>; titleRule: 'deny' | 'require_approval'; bounds: ChangePolicy['bounds']; locks: ChangePolicy['locks'] }
/** increases: widened operation groups plus labels for widened locks, bounds and the title rule (increasedPolicyItems). */
export type AutomationPolicyPreview = Readonly<{ token: string; preset: AutomationPreset; increases: string[]; dryRun: DryRunSummary }>
export type ResumePreview = Readonly<{ token: string; scope: StopScope; effects: string[] }>
const policyPreviews = new Map<string, string>(), resumePreviews = new Map<string, { scope: StopScope; epoch: number; expiresAt: number }>()
function fail(code: string, message: string): never { throw new ChangeSetError(code, message) }
async function ownerSettings(context?: ChangeContext): Promise<Settings> {
  const settings = await db.settings.get('main')
  if (!settings || context && (settings.profileId !== context.ownerId || settings.datasetId !== context.datasetId)) fail('UNAUTHORIZED', '本人の設定を確認できません')
  return settings
}
/** Builds the stored policy; legacy mirrors keep older readers on the same (or stricter) decision. */
export function candidatePolicy(previous: ChangePolicy, input: AutomationPolicyInput): ChangePolicy {
  const rules = structuredClone(input.rules); validateAutomationRules(rules)
  const mode = (operation: OperationGroup) => rules.find(rule => rule.operation === operation)!.mode
  const text = mode('task.text'), schedule = mode('task.schedule'), shift = rules.find(rule => rule.operation === 'task.schedule')!.max_schedule_days_delta
  const next: ChangePolicy = { epoch: previous.epoch, sourcePermissionRevision: previous.sourcePermissionRevision, aiChangesEnabled: previous.aiChangesEnabled, taskUpdate: text === 'deny' && schedule === 'deny' ? 'deny' : text === 'auto_within_bounds' || schedule === 'auto_within_bounds' ? 'auto_within_bounds' : 'require_approval', bounds: { ...structuredClone(input.bounds), maxScheduledDayShift: shift ?? input.bounds.maxScheduledDayShift }, locks: structuredClone(input.locks), fieldRules: { title: input.titleRule, dueDate: mode('task.deadline') as 'deny' | 'require_approval', manualPoints: mode('task.manual_points') as 'deny' | 'require_approval' }, operations: rules, allowedHours: structuredClone(input.allowedHours), ...(previous.stops ? { stops: structuredClone(previous.stops) } : {}) }
  validateChangePolicy(next)
  return next
}
const previewKey = (previous: ChangePolicy, next: ChangePolicy) => contentDigest({ epoch: previous.epoch, next: { ...next, epoch: 0 } })
/** Dry run over the last 7 days of agent changes. Read-only: it writes nothing to the database. */
export async function previewAutomationPolicy(input: AutomationPolicyInput, now = new Date().toISOString()): Promise<AutomationPolicyPreview> {
  const previous = changePolicyFor(await ownerSettings()), next = candidatePolicy(previous, input)
  const dryRun = dryRunPolicy(next, await recentChangeAudits(8), now)
  // Only the latest dry run can authorize a save.
  const token = uid(), key = await previewKey(previous, next); policyPreviews.clear(); policyPreviews.set(token, key)
  return Object.freeze({ token, preset: matchingPreset(next.operations!), increases: increasedPolicyItems(previous, next), dryRun })
}
/** Owner-only native save. Any increase (operation table, locks, bounds, title rule) must follow a dry-run preview of this exact candidate; the epoch always advances. */
export async function setAutomationPolicyFromUI(context: ChangeContext, event: Event, input: AutomationPolicyInput, previewToken: string | null): Promise<ChangePolicy> {
  context = structuredClone(context); input = structuredClone(input)
  assertTrustedOwnerEvent(context, event)
  const at = new Date().toISOString(), previous = changePolicyFor(await ownerSettings(context)), expected = await previewKey(previous, candidatePolicy(previous, input))
  const result = await db.transaction('rw', db.settings, db.audits, async () => {
    const settings = await ownerSettings(context), current = changePolicyFor(settings), next = candidatePolicy(current, input)
    const increases = increasedPolicyItems(current, next)
    if (increases.length && (!previewToken || policyPreviews.get(previewToken) !== expected || current.epoch !== previous.epoch)) fail('PREVIEW_REQUIRED', '権限を増やす設定は、保存前に過去7日の試算を確認してください')
    const saved = { ...next, epoch: current.epoch + 1 }, preset = matchingPreset(saved.operations!), stopAI = input.preset === 'A0' && preset === 'A0'
    validateChangePolicy(saved)
    await db.settings.put({ ...settings, automation: preset, changePolicy: saved, ...(stopAI ? { aiEnabled: false, externalAI: revokedExternalAI(settings) } : {}) })
    await db.audits.add({ id: uid(), taskId: null, operation: 'automation.policy', at, detail: JSON.stringify({ preset, epoch: saved.epoch, increases, modes: Object.fromEntries(saved.operations!.map(rule => [rule.operation, rule.mode])), allowedHours: saved.allowedHours, stopAI }) })
    return { saved, stopAI }
  })
  if (previewToken) policyPreviews.delete(previewToken)
  if (result.stopAI) { clearVolatileAuthorities({ keepChangeSets: true }); await invalidateExternalConnection() }
  return result.saved
}
export type ReduceResult = { stops: AutomationStops; errors: unknown[] }
/** Reduce-only: fixed buttons and the deterministic coach command may call it without an LLM or approval. */
export async function reduceAuthority(scope: StopScope | 'all', origin: 'button' | 'coach-command' | 'connections' | 'tray'): Promise<ReduceResult> {
  if (!['aiProcessing', 'aiChanges', 'notifications', 'routines', 'all'].includes(scope)) throw new Error('停止する範囲を確認してください')
  const all = scope === 'all', authority = all || scope === 'aiProcessing' || scope === 'aiChanges', at = new Date().toISOString()
  const settings = await db.transaction('rw', db.settings, db.audits, async () => {
    const current = await ownerSettings(), policy = changePolicyFor(current)
    const next: ChangePolicy = { ...policy, aiChangesEnabled: policy.aiChangesEnabled && !(all || scope === 'aiChanges'), stops: { notifications: Boolean(policy.stops?.notifications) || all || scope === 'notifications', routines: Boolean(policy.stops?.routines) || all || scope === 'routines' }, epoch: policy.epoch + (authority ? 1 : 0) }
    validateChangePolicy(next)
    const cancel = (all || scope === 'notifications') && current.notificationState
    const saved: Settings = { ...current, aiEnabled: current.aiEnabled && !(all || scope === 'aiProcessing'), ...((all || scope === 'aiProcessing') ? { externalAI: revokedExternalAI(current) } : {}), changePolicy: next, ...(cancel ? { notificationState: cancelPendingCoachNotifications(coachNotificationStateFor(current), all ? '緊急停止で取り消しました' : '通知を停止しました', at) } : {}) }
    await db.settings.put(saved)
    await db.audits.add({ id: uid(), taskId: null, operation: 'automation.stop', at, detail: JSON.stringify({ scope, origin, epoch: next.epoch }) })
    return saved
  })
  const errors: unknown[] = []
  if (authority) clearVolatileAuthorities({ keepChangeSets: true })
  else if (scope === 'routines') { clearCalendarRulesAuthority(); clearRoutineAssistanceAuthority() }
  try {
    if (all || scope === 'aiProcessing') await invalidateExternalConnection()
    else if (scope === 'aiChanges') for (const result of await Promise.allSettled([stopConnection('fileBridge'), stopConnection('localActions')])) if (result.status === 'rejected') errors.push(result.reason)
  } catch (error) { errors.push(error) }
  return { stops: automationStopsFor(settings, changePolicyFor(settings)), errors }
}
export const emergencyStop = (origin: 'button' | 'coach-command' = 'button') => reduceAuthority('all', origin)
const RESUME_EFFECTS: Record<StopScope, string[]> = {
  aiProcessing: ['選択したモデルへの新しいAI呼び出しを再開します（モデル未設定ならAIは呼びません）。', '外部AIは接続画面で別に許可し、PC操作・GitHubの接続は再設定が必要です。', '停止前に作った変更案は再作成が必要です。'],
  aiChanges: ['AIの変更案の受付を再開します。操作別の設定（S20）に従って承認または範囲内自動になります。', '停止前の変更案・承認は使えません。'],
  notifications: ['通知の送信を再開します。停止中に取り消した通知は再送しません。'],
  routines: ['ルーティン・繰り返しの発生回の作成を再開します。停止中の分は次回の展開で作成されます。'],
}
/** Re-preview required before any resume (increase). */
export async function previewResume(scope: StopScope): Promise<ResumePreview> {
  if (!Object.hasOwn(RESUME_EFFECTS, scope)) throw new Error('再開する範囲を確認してください')
  const policy = changePolicyFor(await ownerSettings()), token = uid()
  for (const [key, value] of resumePreviews) if (value.expiresAt <= Date.now()) resumePreviews.delete(key)
  resumePreviews.set(token, { scope, epoch: policy.epoch, expiresAt: Date.now() + 5 * 60000 })
  return Object.freeze({ token, scope, effects: [...RESUME_EFFECTS[scope]] })
}
export async function resumeAuthorityFromUI(context: ChangeContext, event: Event, scope: StopScope, token: string): Promise<void> {
  context = structuredClone(context)
  assertTrustedOwnerEvent(context, event)
  const preview = resumePreviews.get(token); resumePreviews.delete(token)
  const settings = await ownerSettings(context), policy = changePolicyFor(settings)
  if (!preview || preview.scope !== scope || preview.epoch !== policy.epoch || preview.expiresAt <= Date.now()) fail('PREVIEW_REQUIRED', '再開する内容を確認し直してください')
  if (scope === 'aiProcessing') {
    // Without a model nothing is sent to OpenRouter; the file bridge and PC operations work without a key.
    await updateAIConnection(true)
  } else {
    await db.transaction('rw', db.settings, async () => {
      const current = await ownerSettings(context), latest = changePolicyFor(current)
      const next: ChangePolicy = scope === 'aiChanges' ? { ...latest, aiChangesEnabled: true, epoch: latest.epoch + 1 } : { ...latest, stops: { notifications: scope === 'notifications' ? false : Boolean(latest.stops?.notifications), routines: scope === 'routines' ? false : Boolean(latest.stops?.routines) } }
      validateChangePolicy(next)
      await db.settings.put({ ...current, changePolicy: next })
    })
    if (scope === 'aiChanges') clearVolatileAuthorities({ keepChangeSets: true })
  }
  await db.audits.add({ id: uid(), taskId: null, operation: 'automation.resume', at: new Date().toISOString(), detail: JSON.stringify({ scope, approvedBy: context.ownerId }) })
}
/** The coach command path never calls a model and can only reduce authority. */
export async function runCoachAuthorityCommand(command: CoachAuthorityCommand): Promise<string> {
  if (command.kind === 'escalation') return '権限を増やす・再開する操作はコーチからは実行しません。設定 > 自動化（S20）で本人が内容を確認して保存してください。'
  if (command.kind === 'undo-latest') return '直前のコーチ経由・代理の変更の取り消し案を表示します。本人の確認ボタンで適用するまでタスクは変わりません。'
  const result = await reduceAuthority(command.scope, 'coach-command')
  const label = command.scope === 'all' ? 'AI処理・AIによる変更・通知・ルーティン生成（緊急停止）' : STOP_LABELS[command.scope]
  return `${label}を停止しました。再開は 設定 > 自動化 で本人が確認して行います。外部へ送信済みの依頼は取り消せない場合があります。${result.errors.length ? ' 一部の接続の停止を確認できませんでした。接続状態を確認してください。' : ''}`
}
