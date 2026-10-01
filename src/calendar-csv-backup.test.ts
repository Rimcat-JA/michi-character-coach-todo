import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { captureSnapshot, restoreBackup } from './backup'
import { validateSnapshot } from './backup-validation'
import { canonicalJSON } from './canonical'
import { changePolicyFor } from './change-set'
import { calendarFixture, monthlyRule } from './calendar-test-fixtures'
import { completeTask } from './commands'
import { applyCalendarProposalFromUI, clearCalendarRulesAuthority, loadCalendarRulesState, prepareCalendarConfiguration, prepareCalendarGeneration } from './calendar-rules-save'
import { prepareCalendarCSVImport, verifyCSVOriginalDigests, type CSVImportTarget } from './calendar-csv-import'
import { applyCalendarCSVImportFromUI, clearCalendarCSVImportAuthority } from './calendar-csv-import-save'
import { purgeExpiredCSVOriginals } from './calendar-csv-retention'

const fromDate = '2026-10-01', toDate = '2026-10-31'
const header = 'shift_id,record_revision,person_ref,published,status,start_date,start_time,end_date,end_time'
const row = (id = 'private-self-shift', revision = 1, date = '2026-10-05', person = 'staff-001', published = 'true') => `${id},${revision},${person},${published},scheduled,${date},22:00,2026-10-${String(Number(date.slice(-2)) + 1).padStart(2, '0')},06:00`
const input = (...rows: string[]) => new TextEncoder().encode([header, ...rows, ''].join('\r\n'))
const click = () => { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
let target: CSVImportTarget
beforeEach(async () => {
  clearCalendarRulesAuthority(); clearCalendarCSVImportAuthority()
  await db.delete(); await db.open(); await ensureSettings()
  const settings = (await db.settings.get('main'))!, state = calendarFixture()
  state.ownerId = settings.profileId; state.datasetId = settings.datasetId; state.bindings[0].personId = settings.profileId
  state.activities[0].weekdays = []; state.sources = []; state.rules = [monthlyRule({ trigger: { kind: 'activity_relative', activityId: 'work', edge: 'start', offsetDays: -1, offsetMinutes: 0 } })]
  target = { kind: 'roster', contextId: 'company', bindingId: 'self', calendarId: 'business', activityId: 'work', feedId: 'fixed-roster', title: '本人の公開勤務', retentionUntil: '2027-01-01T00:00:00.000Z' }
  const { contexts, bindings, calendars, activities, sources, facts, rules } = state
  await applyCalendarProposalFromUI(await prepareCalendarConfiguration({ contexts, bindings, calendars, activities, sources, facts, rules }, 1, fromDate, toDate), click())
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); clearCalendarRulesAuthority(); clearCalendarCSVImportAuthority() })
async function save(bytes = input(row())) {
  const prepared = await prepareCalendarCSVImport(target, bytes, { fromDate, toDate })
  await applyCalendarCSVImportFromUI(prepared, prepared.digest, click())
  return prepared
}
async function generate() {
  const prepared = await prepareCalendarGeneration(fromDate, toDate)
  await applyCalendarProposalFromUI(prepared, click())
  return prepared
}

describe('CSVの原文・復元・既存実績の整合性', () => {
  it('他人と下書きの行を保存せず、本人の引用だけを往復復元する', async () => {
    const prepared = await save(input(row(), row('other-secret-shift', 1, '2026-10-06', 'other-person-secret'), row('draft-secret-shift', 1, '2026-10-07', 'staff-001', 'false')))
    expect(prepared.preview).toMatchObject({ selectedCount: 1, excludedOtherPerson: 1, excludedDraft: 1 })
    expect(await db.calendarEvents.count()).toBe(0); expect(await db.tasks.count()).toBe(0)
    await generate()
    const snapshot = await captureSnapshot(), csv = snapshot.calendarRules![0].sources[0].csv!
    expect(csv.snapshots[0].rows[0].quote).toBe(row())
    expect(JSON.stringify(snapshot)).not.toMatch(/other-person-secret|other-secret-shift|draft-secret-shift/)
    expect(JSON.stringify(snapshot.audits)).not.toContain('private-self-shift')
    expect(JSON.stringify(snapshot.commands)).not.toContain('private-self-shift')
    await restoreBackup(snapshot)
    const restored = await captureSnapshot()
    expect(restored.calendarRules).toEqual(snapshot.calendarRules)
    expect(restored.calendarEvents).toEqual(snapshot.calendarEvents)
    expect(restored.tasks).toEqual(snapshot.tasks)
    await verifyCSVOriginalDigests(restored.calendarRules!)
  })

  it.each(['quote', 'body', 'fact-time', 'person-hash', 'head-reference'] as const)('%s 改変をDB変更前に拒否する', async invalid => {
    await save(); await generate()
    const before = await captureSnapshot(), corrupted = structuredClone(before), state = corrupted.calendarRules![0], csv = state.sources[0].csv!
    if (invalid === 'quote') csv.snapshots[0].rows[0].quote = csv.snapshots[0].rows[0].quote!.replace('22:00', '23:00')
    if (invalid === 'body') { csv.snapshots[0].bodyHash = 'b'.repeat(64); state.sources[0].bodyHash = 'b'.repeat(64) }
    if (invalid === 'fact-time') { const fact = state.facts[0]; if (fact.kind !== 'roster_assignment') throw new Error('fixture'); fact.startAt = '2026-10-05T14:00:00.000Z' }
    if (invalid === 'person-hash') csv.target.personRefHash = `sha256:${'b'.repeat(64)}`
    if (invalid === 'head-reference') csv.heads[0].rowIndex++
    await expect(restoreBackup(corrupted)).rejects.toThrow()
    const after = await captureSnapshot()
    expect({ ...after, exportedAt: before.exportedAt }).toEqual(before)
  })

  it('移動後の同一予定・タスクと完了実績を復元しても再生成で書き換えない', async () => {
    await save(); await generate()
    const firstEvent = (await db.calendarEvents.toArray())[0], firstTask = (await db.tasks.toArray())[0]
    await save(input(row('private-self-shift', 2, '2026-10-06'))); await generate()
    expect((await db.calendarEvents.toArray())[0].id).toBe(firstEvent.id)
    expect((await db.tasks.toArray())[0].id).toBe(firstTask.id)
    const task = (await db.tasks.get(firstTask.id))!; await completeTask(task.id, task.revision)
    const before = await captureSnapshot(); await restoreBackup(before)
    await save(input(row('private-self-shift', 3, '2026-10-07')))
    const plan = await generate()
    expect(plan.plan.skippedCompleted).toBe(1)
    expect(await db.tasks.get(task.id)).toEqual(before.tasks.find(item => item.id === task.id))
    expect(await db.completions.toArray()).toEqual(before.completions)
    expect(await db.ledger.toArray()).toEqual(before.ledger)
  })

  it('期限後の復元は原文とaudit/receiptの複製だけを消し、本人設定・日時・実績を保つ', async () => {
    await save(); await generate()
    const task = (await db.tasks.toArray())[0]; await completeTask(task.id, task.revision)
    const saved = await captureSnapshot(), source = saved.calendarRules![0].sources[0], expiry = new Date(Date.now() - 1000).toISOString()
    source.csv!.retentionUntil = expiry; source.csv!.snapshots[0].retentionUntil = expiry
    saved.audits.push({ id: 'legacy-csv', taskId: null, operation: 'calendar.configuration', at: saved.exportedAt, detail: JSON.stringify({ wrapper: { before: saved.calendarRules![0] } }) })
    saved.commands.push({ key: 'calendar:legacy-csv', hash: canonicalJSON({ nested: { next: saved.calendarRules![0] } }), resultId: 'legacy-csv', at: saved.exportedAt })
    const beforePolicy = changePolicyFor(saved.settings[0])
    await restoreBackup(saved)
    const restored = await captureSnapshot(), csv = restored.calendarRules![0].sources[0].csv!
    expect(csv.target.personRef).toBeNull(); expect(csv.snapshots[0].rows[0].quote).toBeNull(); expect(csv.heads[0].status).toBe('expired')
    expect(restored.calendarRules![0].bindings[0].personRef).toBe('staff-001')
    expect(JSON.stringify(restored)).not.toContain('private-self-shift')
    expect((await db.commands.get('calendar:legacy-csv'))!.hash).toBe('redacted:calendar-receipt:legacy-csv')
    expect(restored.calendarEvents).toEqual(saved.calendarEvents); expect(restored.tasks).toEqual(saved.tasks)
    expect(restored.completions).toEqual(saved.completions); expect(restored.ledger).toEqual(saved.ledger)
    expect(changePolicyFor(restored.settings[0]).sourcePermissionRevision).toBe(beforePolicy.sourcePermissionRevision + 1)
    expect(() => validateSnapshot(restored)).not.toThrow(); await verifyCSVOriginalDigests(restored.calendarRules!)
  })

  it('restoreと期限purgeは未適用CSV案を失効させる', async () => {
    const pending = await prepareCalendarCSVImport(target, input(row()), { fromDate, toDate }), saved = await captureSnapshot()
    await restoreBackup(saved)
    await expect(applyCalendarCSVImportFromUI(pending, pending.digest, click())).rejects.toThrow('登録済み')
    await save()
    const second = await prepareCalendarCSVImport(target, input(row('private-self-shift', 2)), { fromDate, toDate })
    await purgeExpiredCSVOriginals('2027-01-01T00:00:01.000Z')
    await expect(applyCalendarCSVImportFromUI(second, second.digest, click())).rejects.toThrow('登録済み')
    expect(await db.calendarEvents.count()).toBe(0); expect(await db.ledger.count()).toBe(0)
  })

  it('原文消去後も匿名根拠と日時の不一致を復元前に拒否する', async () => {
    await save(); await generate()
    await purgeExpiredCSVOriginals('2027-01-01T00:00:01.000Z')
    const before = await captureSnapshot(), corrupted = structuredClone(before), state = corrupted.calendarRules![0]
    expect(state.sources[0].csv!.snapshots[0].rows[0].quote).toBeNull()
    const fact = state.facts[0]
    if (fact.kind !== 'roster_assignment') throw new Error('fixture')
    fact.startAt = '2026-10-05T14:00:00.000Z'
    await expect(restoreBackup(corrupted)).rejects.toThrow()
    const after = await captureSnapshot()
    expect({ ...after, exportedAt: before.exportedAt }).toEqual(before)
  })

  it('期限後に一部だけ再取込しても、欠落した旧行を復活・暗黙取消しない', async () => {
    target.retentionUntil = new Date(Date.now() + 60_000).toISOString()
    await save(input(row('shift-a'), row('shift-b', 1, '2026-10-06'))); await generate()
    const events = await db.calendarEvents.toArray(), tasks = await db.tasks.toArray()
    await purgeExpiredCSVOriginals(new Date(Date.now() + 120_000).toISOString())
    target.retentionUntil = '2027-01-01T00:00:00.000Z'; await save(input(row('shift-a')))
    const state = await loadCalendarRulesState()
    expect(state.sources[0].csv!.heads.filter(head => head.status === 'expired')).toHaveLength(1)
    const plan = await prepareCalendarGeneration(fromDate, toDate)
    expect(plan.plan.cancels).toHaveLength(0); expect(plan.plan.conflicts.length).toBeGreaterThan(0)
    expect(await db.calendarEvents.toArray()).toEqual(events); expect(await db.tasks.toArray()).toEqual(tasks)
  })

  it('CSV情報のない旧形式1バックアップも復元できる', async () => {
    const saved = await captureSnapshot()
    delete saved.calendarRules
    await restoreBackup(saved)
    expect((await captureSnapshot()).calendarRules).toEqual([])
  })
})
