import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput } from './commands'
import { emptyScore, type Settings } from './domain'
import { applyChangeSet, approveChangeSetFromUI, changePolicyFor, clearChangeSetAuthority, decideChangePolicy, defaultChangePolicy, prepareTaskChanges, setChangePolicyFromUI, validateChangePolicy, type ChangeContext, type ChangePolicy, type ChangePolicyDecision, type PreparedChangeSet, type TaskChange, type TaskChangeField } from './change-set'
import { autoChangeCounts, automationRulesFor, decideOperation, increasedOperations, increasedPolicyItems, legacyRules, matchingPreset, OPERATION_GROUPS, OPERATION_INFO, overriddenOperations, parseCoachAuthorityCommand, presetRules, validateAutomationRules, withinAllowedHours, type AutomationRule, type OperationGroup } from './automation-policy'
import { candidatePolicy, previewAutomationPolicy, setAutomationPolicyFromUI, type AutomationPolicyInput } from './automation-control'
import { dryRunPolicy } from './change-history'

// Node-only fixture: production browsers never let page code set isTrusted.
function humanClick() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
let owner: ChangeContext, coach: ChangeContext
beforeEach(async () => {
  clearChangeSetAuthority(); await db.delete(); await db.open()
  const settings = await ensureSettings(); await db.settings.update('main', { externalAI: {version:1,enabled:true,epoch:0,clients:[]}, aiEnabled: true })
  const shared = { ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: ['notes', 'scheduledDate'] as TaskChangeField[], sourceRevisions: [] }
  owner = { ...shared, principal: { id: settings.profileId, kind: 'human' } }; coach = { ...shared, principal: { id: 'app-coach', kind: 'coach', model: 'model/A' } }
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const settings = async () => (await db.settings.get('main'))!
const input = (rules: AutomationRule[], policy: ChangePolicy, preset: AutomationPolicyInput['preset'] = matchingPreset(rules)): AutomationPolicyInput => ({ preset, rules, allowedHours: {}, titleRule: 'require_approval', bounds: policy.bounds, locks: policy.locks })
async function saveTable(rules: AutomationRule[], preset?: AutomationPolicyInput['preset']) {
  const current = changePolicyFor(await settings()), next = input(rules, current, preset), preview = await previewAutomationPolicy(next)
  return setAutomationPolicyFromUI(owner, humanClick(), next, preview.token)
}

/** Verbatim copy of the pre-N09 engine (taskUpdate + fieldRules) to prove old JSON decides identically. */
function legacyDecide(prepared: PreparedChangeSet, policy: ChangePolicy): Pick<ChangePolicyDecision, 'status' | 'protectedFields'> {
  const changedCharacters = (before: string, after: string) => { let prefix = 0, suffix = 0; while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++; while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++; return Math.max(before.length - prefix - suffix, after.length - prefix - suffix) }
  const requiresInstruction = (changes: TaskChange[]) => changes.some(change => change.fields.some(field => ['title', 'dueDate', 'manualPoints'].includes(field)))
  const agent = prepared.principal.kind !== 'human'
  const protectedFields = [...new Set(prepared.changes.flatMap(change => change.fields.filter(field => field === 'manualPoints' || field === 'dueDate' || policy.locks[field] === 'locked_until_human_approval' || agent && policy.locks[field] === 'protect_from_autonomous')))]
  if (agent && (!policy.aiChangesEnabled || policy.taskUpdate === 'deny')) return { status: 'denied', protectedFields }
  if (agent && prepared.changes.some(change => change.fields.some(field => policy.fieldRules?.[field as 'title' | 'dueDate' | 'manualPoints'] === 'deny'))) return { status: 'denied', protectedFields }
  if (requiresInstruction(prepared.changes)) return { status: 'awaiting_approval', protectedFields }
  if (!agent || policy.taskUpdate !== 'auto_within_bounds' || protectedFields.length) return { status: 'awaiting_approval', protectedFields }
  if (prepared.changes.length > policy.bounds.maxTasks) return { status: 'awaiting_approval', protectedFields }
  for (const change of prepared.changes) {
    if (change.fields.includes('notes') && changedCharacters(change.before.notes, change.after.notes) > policy.bounds.maxNotesCharacters) return { status: 'awaiting_approval', protectedFields }
    if (change.fields.includes('scheduledDate')) { const a = change.before.scheduledDate, b = change.after.scheduledDate; if (!a || !b || Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000 > policy.bounds.maxScheduledDayShift) return { status: 'awaiting_approval', protectedFields } }
  }
  return { status: 'auto', protectedFields }
}
function pseudo(kind: 'human' | 'coach' | 'external-agent', fields: TaskChangeField[], count: number, variant: number): PreparedChangeSet {
  const before = { title: '元', notes: 'abc', scheduledDate: variant === 2 ? null : '2026-10-01', dueDate: '2026-10-09', manualPoints: 25 }
  const after = { ...before, title: '新', notes: variant === 1 ? 'a much longer replacement text' : 'abd', scheduledDate: variant === 1 ? '2026-10-11' : '2026-10-02', dueDate: '2026-10-10', manualPoints: 30 }
  return { principal: { id: kind === 'human' ? 'owner' : 'agent', kind }, changes: Array.from({ length: count }, (_, index) => ({ taskId: `t${index}`, fields, before, after })) } as unknown as PreparedChangeSet
}
function legacyPolicies(): ChangePolicy[] {
  const result: ChangePolicy[] = []
  for (const taskUpdate of ['deny', 'require_approval', 'auto_within_bounds'] as const) for (const aiChangesEnabled of [true, false]) for (const fieldRules of [{}, { title: 'deny' as const }, { dueDate: 'deny' as const, manualPoints: 'deny' as const }]) for (const locks of [{}, { notes: 'protect_from_autonomous' as const }, { scheduledDate: 'locked_until_human_approval' as const }]) for (const bounds of [{ maxTasks: 20, maxScheduledDayShift: 3, maxNotesCharacters: 1000 }, { maxTasks: 1, maxScheduledDayShift: 0, maxNotesCharacters: 3 }])
    result.push(changePolicyFor({ changePolicy: { ...defaultChangePolicy(), taskUpdate, aiChangesEnabled, fieldRules, locks, bounds } } as Settings))
  return result
}
const fieldSets: TaskChangeField[][] = [['notes'], ['scheduledDate'], ['notes', 'scheduledDate'], ['title'], ['dueDate'], ['manualPoints'], ['notes', 'dueDate']]

describe('N09 operation-level policy engine', () => {
  it('migrates old taskUpdate/fieldRules JSON with identical decisions, also when stored as an explicit table', () => {
    let compared = 0
    for (const policy of legacyPolicies()) {
      const explicit = { ...candidatePolicy(policy, { preset: 'custom', rules: legacyRules(policy), allowedHours: {}, titleRule: policy.fieldRules?.title ?? 'require_approval', bounds: policy.bounds, locks: policy.locks }), aiChangesEnabled: policy.aiChangesEnabled }
      for (const kind of ['human', 'coach', 'external-agent'] as const) for (const fields of fieldSets) for (const count of [1, 2]) for (const variant of [0, 1, 2]) {
        const prepared = pseudo(kind, fields, count, variant), expected = legacyDecide(prepared, policy)
        expect({ status: decideChangePolicy(prepared, policy).status, protectedFields: decideChangePolicy(prepared, policy).protectedFields }).toEqual(expected)
        expect(decideChangePolicy(prepared, explicit).status).toBe(expected.status)
        compared++
      }
    }
    expect(compared).toBeGreaterThan(10000)
  })
  it('keeps presets as initial value tables with fixed invariants', () => {
    const modes = (preset: 'A0' | 'A1' | 'A2' | 'A3') => Object.fromEntries(presetRules(preset).map(rule => [rule.operation, rule.mode]))
    for (const preset of ['A0', 'A1', 'A2', 'A3'] as const) { expect(() => validateAutomationRules(presetRules(preset))).not.toThrow(); expect(modes(preset)['authority.expand']).toBe('deny'); expect(modes(preset)['detection.register']).not.toBe('auto_within_bounds'); expect(matchingPreset(presetRules(preset))).toBe(preset) }
    expect(Object.entries(modes('A0')).filter(([, mode]) => mode !== 'deny')).toEqual([['notification.send', 'auto_within_bounds']])
    expect(Object.entries(modes('A1')).filter(([, mode]) => mode !== 'require_approval')).toEqual([['notification.send', 'auto_within_bounds'], ['authority.expand', 'deny']])
    expect(presetRules('A2').filter(rule => rule.mode === 'auto_within_bounds').map(rule => [rule.operation, rule.max_daily_count, rule.max_schedule_days_delta])).toEqual([['task.text', 10, null], ['task.schedule', 10, 3], ['notification.send', 50, null]])
    for (const operation of ['task.deadline', 'task.manual_points', 'task.lifecycle', 'external.write', 'achievement.publish', 'local_action.run'] as OperationGroup[]) expect(modes('A3')[operation]).toBe('require_approval')
    expect(legacyRules(defaultChangePolicy())).toEqual(presetRules('A1'))
    const custom = presetRules('A2').map(rule => rule.operation === 'task.text' ? { ...rule, mode: 'require_approval' as const } : rule)
    expect(matchingPreset(custom)).toBe('custom'); expect(overriddenOperations(custom, 'A2')).toEqual(['task.text'])
  })
  it('rejects non-deny authority.expand, automatic detection and automatic high-impact operations', () => {
    const replace = (operation: OperationGroup, mode: AutomationRule['mode']) => presetRules('A1').map(rule => rule.operation === operation ? { ...rule, mode } : rule)
    expect(() => validateAutomationRules(replace('authority.expand', 'require_approval'))).toThrow('委任できません')
    expect(() => validateAutomationRules(replace('detection.register', 'auto_within_bounds'))).toThrow('N04')
    for (const operation of ['task.deadline', 'task.manual_points', 'task.split', 'routine.change', 'task.lifecycle', 'external.write', 'achievement.publish', 'local_action.run'] as OperationGroup[]) expect(() => validateAutomationRules(replace(operation, 'auto_within_bounds'))).toThrow(OPERATION_INFO[operation].label)
    expect(() => validateAutomationRules(presetRules('A1').map(rule => rule.operation === 'task.manual_points' ? { ...rule, max_points_delta: 5 } : rule))).toThrow()
    expect(() => validateAutomationRules([...presetRules('A1')].reverse())).toThrow()
    expect(() => validateChangePolicy({ ...defaultChangePolicy(), operations: replace('authority.expand', 'auto_within_bounds') })).toThrow()
    expect(() => validateChangePolicy({ ...defaultChangePolicy(), operations: presetRules('A1').map(rule => ({ ...rule, policy_level: 'A3' })) })).toThrow()
    expect(OPERATION_GROUPS).toHaveLength(13)
  })
  it('refuses spaces/sources restrictions and require_user_instruction the engine would ignore (POLICY_INVALID)', () => {
    const patch = (extra: Partial<AutomationRule>) => ({ ...defaultChangePolicy(), operations: presetRules('A2').map(rule => rule.operation === 'task.schedule' ? { ...rule, ...extra } : rule) })
    for (const extra of [{ sources: ['mail'] }, { spaces: ['work'] }, { require_user_instruction: true }]) expect(() => validateChangePolicy(patch(extra))).toThrow(expect.objectContaining({ code: 'POLICY_INVALID' }))
    expect(() => validateChangePolicy(patch({}))).not.toThrow()
  })
  it('refuses coach/external principals and synthetic events as the policy setter (no self-escalation)', async () => {
    const next = input(presetRules('A3'), changePolicyFor(await settings())), preview = await previewAutomationPolicy(next)
    for (const actor of [coach, { ...coach, principal: { id: 'agent', kind: 'external-agent' as const } }]) await expect(setAutomationPolicyFromUI(actor, humanClick(), next, preview.token)).rejects.toMatchObject({ code: 'HUMAN_APPROVAL_REQUIRED' })
    for (const event of [new Event('click'), { isTrusted: true, type: 'click' } as Event, Object.create(Event.prototype, { type: { value: 'click' }, isTrusted: { value: true } })]) await expect(setAutomationPolicyFromUI(owner, event, next, preview.token)).rejects.toMatchObject({ code: 'HUMAN_APPROVAL_REQUIRED' })
    await expect(setAutomationPolicyFromUI(owner, humanClick(), next, null)).rejects.toMatchObject({ code: 'PREVIEW_REQUIRED' })
    expect(changePolicyFor(await settings()).operations).toBeUndefined()
    const saved = await setAutomationPolicyFromUI(owner, humanClick(), next, preview.token)
    expect(saved.epoch).toBe(1); expect((await settings()).automation).toBe('A3')
    await expect(setAutomationPolicyFromUI(owner, humanClick(), next, preview.token)).resolves.toMatchObject({ epoch: 2 })
  })
  it('the legacy single-operation setter cannot drop the N09 table or silently resume a stop', async () => {
    const { reduceAuthority } = await import('./automation-control')
    const legacy = (policy: ChangePolicy) => ({ sourcePermissionRevision: policy.sourcePermissionRevision, aiChangesEnabled: true, taskUpdate: 'auto_within_bounds' as const, bounds: policy.bounds, locks: {} })
    await expect(setChangePolicyFromUI(owner, humanClick(), { ...legacy(changePolicyFor(await settings())), operations: presetRules('A3') })).rejects.toMatchObject({ code: 'PREVIEW_REQUIRED' })
    await reduceAuthority('notifications', 'button')
    await expect(setChangePolicyFromUI(owner, humanClick(), legacy(changePolicyFor(await settings())))).rejects.toMatchObject({ code: 'PREVIEW_REQUIRED' })
    expect(changePolicyFor(await settings()).stops).toEqual({ notifications: true, routines: false })
    await db.settings.update('main', { changePolicy: { ...defaultChangePolicy(), operations: presetRules('A1') } })
    await expect(setChangePolicyFromUI(owner, humanClick(), legacy(changePolicyFor(await settings())))).rejects.toMatchObject({ code: 'PREVIEW_REQUIRED' })
    expect(changePolicyFor(await settings()).operations).toEqual(presetRules('A1'))
  })
  it('invalidates a queued, approved ChangeSet when the preset changes (POLICY_CHANGED)', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '移動', scheduledDate: '2026-10-01', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } })
    const prepared = await prepareTaskChanges([{ taskId, expectedRevision: 1, patch: { scheduledDate: '2026-10-02' } }], coach), grant = await approveChangeSetFromUI(prepared, owner, humanClick())
    await saveTable(presetRules('A2'))
    await expect(applyChangeSet(prepared, grant, coach, 'queued')).rejects.toMatchObject({ code: 'POLICY_CHANGED' })
    expect((await db.tasks.get(taskId))?.scheduledDate).toBe('2026-10-01')
  })
  it('makes notes and schedule automatic under A2 while deadline/points still need instruction and approval', async () => {
    await saveTable(presetRules('A2'))
    const taskId = await createTask({ ...newTaskInput(), title: '自動', scheduledDate: '2026-10-01', dueDate: '2026-10-09', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } })
    const moved = await prepareTaskChanges([{ taskId, expectedRevision: 1, patch: { scheduledDate: '2026-10-03' } }], coach)
    expect(decideChangePolicy(moved, changePolicyFor(await settings())).status).toBe('auto')
    await applyChangeSet(moved, null, coach, 'auto-move')
    const audit = (await db.audits.toArray()).find(item => item.operation === 'changeset.update')!
    expect(JSON.parse(audit.detail)).toMatchObject({ decision: 'auto', operations: ['task.schedule'], approvedBy: null })
    expect(await db.tasks.get(taskId)).toMatchObject({ scheduledDate: '2026-10-03', dueDate: '2026-10-09', effectivePoints: 25, revision: 2 })
    const far = await prepareTaskChanges([{ taskId, expectedRevision: 2, patch: { scheduledDate: '2026-10-09' } }], coach)
    expect(decideChangePolicy(far, changePolicyFor(await settings())).status).toBe('awaiting_approval')
  })
  it('denies an operation set to deny even when other operations are automatic', async () => {
    await saveTable(presetRules('A2').map(rule => rule.operation === 'task.schedule' ? { ...rule, mode: 'deny' as const } : rule))
    const taskId = await createTask({ ...newTaskInput(), title: '停止', scheduledDate: '2026-10-01', notes: 'm' })
    await expect(prepareTaskChanges([{ taskId, expectedRevision: 1, patch: { scheduledDate: '2026-10-02' } }], coach)).rejects.toMatchObject({ code: 'CHANGES_STOPPED' })
    const notes = await prepareTaskChanges([{ taskId, expectedRevision: 1, patch: { notes: 'n' } }], coach)
    expect(decideChangePolicy(notes, changePolicyFor(await settings())).status).toBe('auto')
    expect(decideOperation(changePolicyFor(await settings()), 'task.schedule').status).toBe('denied')
    const manual = await prepareTaskChanges([{ taskId, expectedRevision: 1, patch: { scheduledDate: '2026-10-05' } }], owner)
    await applyChangeSet(manual, await approveChangeSetFromUI(manual, owner, humanClick()), owner, 'owner-still-works')
  })
})

describe('N09 S20 widening beyond the operation table (locks, bounds, title rule)', () => {
  type Draft = Pick<AutomationPolicyInput, 'locks' | 'bounds' | 'titleRule'>
  const draft = (policy: ChangePolicy, patch: Partial<Draft>): AutomationPolicyInput => ({ ...input(automationRulesFor(policy), policy), titleRule: policy.fieldRules?.title ?? 'require_approval', ...patch })
  const tight: Draft = { locks: { notes: 'protect_from_autonomous', scheduledDate: 'locked_until_human_approval', title: 'locked_until_human_approval' }, bounds: { maxTasks: 5, maxScheduledDayShift: 3, maxNotesCharacters: 100 }, titleRule: 'deny' }
  it('tightening locks, bounds and the title rule saves without a dry run', async () => {
    await saveTable(presetRules('A2'))
    const saved = await setAutomationPolicyFromUI(owner, humanClick(), draft(changePolicyFor(await settings()), tight), null)
    expect(saved).toMatchObject({ locks: tight.locks, bounds: tight.bounds, fieldRules: { title: 'deny' } })
    expect(increasedPolicyItems(saved, saved)).toEqual([])
  })
  it.each([
    ['メモの保護', (policy: ChangePolicy): Partial<Draft> => ({ locks: { ...policy.locks, notes: 'unlocked' } })],
    ['予定日の保護', (policy: ChangePolicy): Partial<Draft> => ({ locks: { ...policy.locks, scheduledDate: 'protect_from_autonomous' } })],
    ['タイトルの保護', (policy: ChangePolicy): Partial<Draft> => ({ locks: { ...policy.locks, title: 'unlocked' } })],
    ['メモの自動変更量', (policy: ChangePolicy): Partial<Draft> => ({ bounds: { ...policy.bounds, maxNotesCharacters: 101 } })],
    ['一度に自動変更する件数', (policy: ChangePolicy): Partial<Draft> => ({ bounds: { ...policy.bounds, maxTasks: 6 } })],
    ['タイトルの代理変更', (): Partial<Draft> => ({ titleRule: 'require_approval' })],
  ] as const)('%s widening needs the latest 7-day dry run', async (label, widen) => {
    await saveTable(presetRules('A2'))
    await setAutomationPolicyFromUI(owner, humanClick(), draft(changePolicyFor(await settings()), tight), null)
    const current = changePolicyFor(await settings()), next = draft(current, { ...tight, ...widen(current) })
    expect(increasedPolicyItems(current, candidatePolicy(current, next))).toEqual([label])
    await expect(setAutomationPolicyFromUI(owner, humanClick(), next, null)).rejects.toMatchObject({ code: 'PREVIEW_REQUIRED' })
    const stale = await previewAutomationPolicy(next), preview = await previewAutomationPolicy(next)
    expect(preview.increases).toEqual([label])
    await expect(setAutomationPolicyFromUI(owner, humanClick(), next, stale.token)).rejects.toMatchObject({ code: 'PREVIEW_REQUIRED' })
    expect(changePolicyFor(await settings())).toEqual(current)
    await expect(setAutomationPolicyFromUI(owner, humanClick(), next, preview.token)).resolves.toMatchObject({ epoch: current.epoch + 1 })
    const audit = (await db.audits.toArray()).find(item => item.operation === 'automation.policy' && JSON.parse(item.detail).epoch === current.epoch + 1)!
    expect(JSON.parse(audit.detail).increases).toEqual([label])
  })
})

describe('N09 automatic bounds: daily count across entrances, allowed window and dry run', () => {
  it('keeps counting the day already reached when the clock moves back (fake-timer test, not a real-device clock change)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T03:00:00.000Z'))
    await saveTable(presetRules('A2'))
    const ids: string[] = []
    for (let index = 0; index < 11; index++) ids.push(await createTask({ ...newTaskInput(), title: `c${index}`, scheduledDate: '2026-10-01' }))
    for (const [index, taskId] of ids.slice(0, 10).entries()) await applyChangeSet(await prepareTaskChanges([{ taskId, expectedRevision: 1, patch: { scheduledDate: '2026-10-02' } }], coach), null, coach, `clock-${index}`)
    vi.setSystemTime(new Date('2026-10-01T02:30:00.000Z'))
    const next = await prepareTaskChanges([{ taskId: ids[10], expectedRevision: 1, patch: { scheduledDate: '2026-10-02' } }], coach)
    await expect(applyChangeSet(next, null, coach, 'clock-back')).rejects.toMatchObject({ code: 'HUMAN_APPROVAL_REQUIRED' })
    await applyChangeSet(next, await approveChangeSetFromUI(next, owner, humanClick()), coach, 'clock-back-approved')
    expect((await db.tasks.get(ids[10]))?.scheduledDate).toBe('2026-10-02')
    expect((await db.audits.toArray()).filter(audit => audit.operation === 'changeset.update')).toHaveLength(11)
  })
  it('sends the 11th automatic change of the day to approval when the maximum is 10', async () => {
    await saveTable(presetRules('A2'))
    const ids: string[] = []
    for (let index = 0; index < 11; index++) ids.push(await createTask({ ...newTaskInput(), title: `t${index}`, scheduledDate: '2026-10-01' }))
    const external = { ...coach, principal: { id: 'external-client', kind: 'external-agent' as const } }
    for (const [index, taskId] of ids.slice(0, 10).entries()) { const actor = index % 2 ? external : coach, prepared = await prepareTaskChanges([{ taskId, expectedRevision: 1, patch: { scheduledDate: '2026-10-02' } }], actor); await applyChangeSet(prepared, null, actor, `auto-${index}`) }
    const eleventh = await prepareTaskChanges([{ taskId: ids[10], expectedRevision: 1, patch: { scheduledDate: '2026-10-02' } }], coach)
    expect(decideChangePolicy(eleventh, changePolicyFor(await settings())).status).toBe('auto')
    expect(decideChangePolicy(eleventh, changePolicyFor(await settings()), { autoCountToday: autoChangeCounts(await db.audits.toArray(), new Date().toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone) })).toMatchObject({ status: 'awaiting_approval', reason: expect.stringContaining('10件') })
    await expect(applyChangeSet(eleventh, null, coach, 'auto-11')).rejects.toMatchObject({ code: 'HUMAN_APPROVAL_REQUIRED' })
    await applyChangeSet(eleventh, await approveChangeSetFromUI(eleventh, owner, humanClick()), coach, 'approved-11')
    expect((await db.tasks.get(ids[10]))?.scheduledDate).toBe('2026-10-02')
  })
  it('requires approval outside the allowed time window (owner timezone)', () => {
    const policy = { ...defaultChangePolicy(), operations: presetRules('A2'), allowedHours: { 'task.schedule': { start: '09:00', end: '18:00' } } }, prepared = pseudo('coach', ['scheduledDate'], 1, 0)
    expect(decideChangePolicy(prepared, policy, { at: '2026-10-01T01:00:00.000Z', timezone: 'Asia/Tokyo' }).status).toBe('auto')
    expect(decideChangePolicy(prepared, policy, { at: '2026-10-01T10:00:00.000Z', timezone: 'Asia/Tokyo' })).toMatchObject({ status: 'awaiting_approval', reason: expect.stringContaining('時間帯') })
    expect(withinAllowedHours('2026-10-01T14:30:00.000Z', 'Asia/Tokyo', { start: '22:00', end: '07:00' })).toBe(true)
    expect(increasedOperations(presetRules('A1'), presetRules('A2'))).toEqual(['task.text', 'task.schedule'])
    expect(increasedOperations(presetRules('A2'), presetRules('A1'))).toEqual([])
  })
  it('dry-runs a candidate over the last 7 days of agent changes without writing anything', async () => {
    await saveTable(presetRules('A2'))
    for (let index = 0; index < 3; index++) { const taskId = await createTask({ ...newTaskInput(), title: `d${index}`, scheduledDate: '2026-10-01' }), prepared = await prepareTaskChanges([{ taskId, expectedRevision: 1, patch: { scheduledDate: '2026-10-02' } }], coach); await applyChangeSet(prepared, null, coach, `dry-${index}`) }
    const humanTask = await createTask({ ...newTaskInput(), title: 'human', scheduledDate: '2026-10-01' }), human = await prepareTaskChanges([{ taskId: humanTask, expectedRevision: 1, patch: { scheduledDate: '2026-10-09' } }], owner)
    await applyChangeSet(human, await approveChangeSetFromUI(human, owner, humanClick()), owner, 'human')
    const snapshot = async () => Object.fromEntries(await Promise.all(db.tables.map(async table => [table.name, await table.toArray()])))
    const before = await snapshot(), policy = changePolicyFor(await settings())
    const strict = await previewAutomationPolicy(input(presetRules('A2').map(rule => rule.operation === 'task.schedule' ? { ...rule, max_daily_count: 2 } : rule), policy))
    expect(strict.dryRun).toMatchObject({ total: 3, auto: 2, approval: 1, denied: 0 })
    expect((await previewAutomationPolicy(input(presetRules('A1'), policy))).dryRun).toMatchObject({ total: 3, auto: 0, approval: 3 })
    expect((await previewAutomationPolicy(input(presetRules('A0'), policy))).dryRun).toMatchObject({ total: 3, denied: 3 })
    expect(dryRunPolicy(changePolicyFor(await settings()), await db.audits.toArray(), new Date(Date.now() + 8 * 86400000).toISOString()).total).toBe(0)
    expect(await snapshot()).toEqual(before)
  })
})

describe('deterministic reduce-only coach commands', () => {
  it('parses stop requests without a model and refuses escalation phrases', () => {
    expect(parseCoachAuthorityCommand('通知を止めて')).toEqual({ kind: 'reduce', scope: 'notifications' })
    expect(parseCoachAuthorityCommand('緊急停止して')).toEqual({ kind: 'reduce', scope: 'all' })
    expect(parseCoachAuthorityCommand('AIの自動変更を止めて')).toEqual({ kind: 'reduce', scope: 'aiChanges' })
    expect(parseCoachAuthorityCommand('ルーティンを停止')).toEqual({ kind: 'reduce', scope: 'routines' })
    expect(parseCoachAuthorityCommand('AIを止めて')).toEqual({ kind: 'reduce', scope: 'aiProcessing' })
    expect(parseCoachAuthorityCommand('さっきの自動変更を取り消して')).toEqual({ kind: 'undo-latest' })
    for (const text of ['全部自動にして', '通知を再開して', '権限を増やして', '自動化をONにして']) expect(parseCoachAuthorityCommand(text)).toEqual({ kind: 'escalation' })
    for (const text of ['通知は止めないで', '明日に移して', '']) expect(parseCoachAuthorityCommand(text)).toBeNull()
    expect(parseCoachAuthorityCommand('通知を止めてください。')).toEqual({ kind: 'reduce', scope: 'notifications' })
    // Consultations that merely mention a word are normal coach turns, never commands.
    for (const text of ['来週から筋トレを再開したい', '会議を止めてもらうにはどうしたらいい？', '通知を止めてほしいと上司に言われた件で、明日の予定を一緒に考えてほしい', 'このタスクを戻して', '自動車の点検を予約する']) expect(parseCoachAuthorityCommand(text)).toBeNull()
    // Ordinary requests that merely end in a stop verb or mention a scope word never become global stops.
    for (const text of ['コーチ、明日の会議をやめて', 'Gmailの同期を停止', 'dailyの記録をやめて', '今日のタスクは全部やめて', 'このタスクの通知を止めて', 'コーチ、説教はやめて', 'コーチの長い説明はもうやめて', 'AIっぽい返事はやめて', '定期的に褒めるのやめて', '通知って何？それよりもうやめて', '変更点の説明はストップ', 'コーチ、明日からジョギングを再開する', 'emailの通知を止めて', 'trainを止めて']) expect(parseCoachAuthorityCommand(text)).toBeNull()
    expect(parseCoachAuthorityCommand('全部の自動化を止めて')).toEqual({ kind: 'reduce', scope: 'all' })
    expect(parseCoachAuthorityCommand('リマインドをオフにして')).toEqual({ kind: 'reduce', scope: 'notifications' })
  })
  it('exposes rules only through the owner UI: automationRulesFor never reads model or file fields', () => {
    const policy = { ...defaultChangePolicy(), operations: presetRules('A2') }
    expect(automationRulesFor(policy)).toEqual(presetRules('A2'))
    expect(Object.keys(presetRules('A1')[0]).sort()).toEqual(['allow_protected_fields', 'destinations', 'max_daily_count', 'max_points_delta', 'max_schedule_days_delta', 'mode', 'operation', 'require_user_instruction', 'sources', 'spaces'])
  })
})
