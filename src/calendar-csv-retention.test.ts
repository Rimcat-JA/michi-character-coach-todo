import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { canonicalJSON } from './canonical'
import { changePolicyFor } from './change-set'
import { calendarFixture } from './calendar-test-fixtures'
import { parseCalendarCSVImport, prepareCalendarCSVImport, prepareCSVConfiguration, verifyCSVOriginalDigests, type CSVImportTarget } from './calendar-csv-import'
import { applyCalendarCSVImportFromUI, clearCalendarCSVImportAuthority } from './calendar-csv-import-save'
import { redactExpiredCSVRecords, redactCSVForAudit } from './calendar-csv-redaction'
import { purgeExpiredCSVOriginals } from './calendar-csv-retention'
import { clearCalendarRulesAuthority } from './calendar-rules-save'
import type { CalendarRulesState } from './calendar-resolver'

const now = '2026-10-01T00:00:00.000Z', expiry = '2026-10-02T00:00:00.000Z'
const header = 'shift_id,record_revision,person_ref,published,status,start_date,start_time,end_date,end_time'
const row = (id: string, revision = 1, date = '2026-10-05') => `${id},${revision},staff-001,true,scheduled,${date},22:00,${date.slice(0, 8)}${String(Number(date.slice(8)) + 1).padStart(2, '0')},06:00`
const bytes = (...rows: string[]) => new TextEncoder().encode([header, ...rows, ''].join('\r\n'))
const target = (retentionUntil: string | null = expiry): CSVImportTarget => ({ kind: 'roster', contextId: 'company', bindingId: 'self', calendarId: 'business', activityId: 'work', feedId: 'fixed-roster', title: '本人のCSV', retentionUntil })
const options = { fromDate: '2026-10-01', toDate: '2026-10-31' }
const click = () => { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
async function imported(state: CalendarRulesState, rows = [row('private-self')], retentionUntil: string | null = expiry) {
  const parsed = await parseCalendarCSVImport(bytes(...rows), { ...options, kind: 'roster', timezone: 'Asia/Tokyo', personRef: 'staff-001' })
  const { next } = await prepareCSVConfiguration(state, target(retentionUntil), parsed)
  return { ...state, ...next, revision: state.revision + 1 }
}
beforeEach(async () => {
  clearCalendarRulesAuthority(); clearCalendarCSVImportAuthority()
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now)
  await db.delete(); await db.open(); await ensureSettings()
  const settings = (await db.settings.get('main'))!, state = calendarFixture()
  state.ownerId = settings.profileId; state.datasetId = settings.datasetId; state.bindings[0].personId = settings.profileId
  state.sources = []; state.activities[0].weekdays = []
  await db.calendarRules.put(state)
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); clearCalendarRulesAuthority(); clearCalendarCSVImportAuthority() })

describe('CSV原文の保持期限と保存トランザクション', () => {
  it('期限ちょうどで引用だけを失効し、本人設定・匿名値・既存予定・実績を保持する', async () => {
    const state = await imported((await db.calendarRules.get('main'))!), source = state.sources[0]
    const records = { calendarRules: [state], calendarEvents: [], audits: [], completions: [{ id: 'past', originalPoints: 10 }], ledger: [{ id: 'immutable', delta: 10 }] }
    expect(redactExpiredCSVRecords(records, now).calendarRules[0]).toEqual(state)
    const result = redactExpiredCSVRecords(records, expiry), stale = result.calendarRules[0], csv = stale.sources[0].csv!
    expect(csv.snapshots[0].rows[0].quote).toBeNull(); expect(csv.target.personRef).toBeNull()
    expect(csv.snapshots[0].rows[0].value).toEqual(source.csv!.snapshots[0].rows[0].value)
    expect(csv.snapshots[0].bodyHash).toBe(source.bodyHash)
    expect(csv.heads[0].status).toBe('expired'); expect(stale.facts[0].validity).toBe('withdrawn')
    expect(stale.bindings[0].personRef).toBe('staff-001'); expect(stale.facts[0]).not.toHaveProperty('personRef', 'staff-001')
    expect(result.completions).toEqual(records.completions); expect(result.ledger).toEqual(records.ledger)
    expect(result.expiredSourceIds).toEqual([source.id])
    await verifyCSVOriginalDigests([stale])
    expect(redactExpiredCSVRecords(result, expiry).calendarRules).toEqual(result.calendarRules)
  })

  it('古い版だけ失効し、後の本人選択行の引用と対応を残す', async () => {
    const old = await imported((await db.calendarRules.get('main'))!), fresh = await imported(old, [row('fresh', 1, '2026-10-20')], '2027-01-01T00:00:00.000Z')
    const result = redactExpiredCSVRecords({ calendarRules: [fresh], calendarEvents: [], audits: [] }, expiry), csv = result.calendarRules[0].sources[0].csv!
    expect(csv.snapshots[0].rows[0].quote).toBeNull(); expect(csv.snapshots[1].rows[0].quote).toBe(row('fresh', 1, '2026-10-20'))
    expect(csv.target.personRef).toBe('staff-001'); expect(result.calendarRules[0].sources[0].status).toBe('current')
    expect(csv.heads.filter(head => head.status === 'expired')).toHaveLength(1)
    await verifyCSVOriginalDigests(result.calendarRules)
  })

  it('監査と旧receiptの二重引用を除き、明示ParticipationBindingを削除しない', async () => {
    const state = await imported((await db.calendarRules.get('main'))!), configuration = { sources: state.sources, bindings: state.bindings }
    const redacted = redactCSVForAudit(configuration)
    expect(redacted.sources[0].csv!.target.personRef).toBeNull(); expect(redacted.bindings[0].personRef).toBe('staff-001')
    const records = { calendarRules: [state], calendarEvents: [], audits: [{ id: 'old', taskId: null, operation: 'routine.assistance.approved', at: now, detail: JSON.stringify(configuration) }, { id: 'untouched', taskId: null, operation: 'task.manual', at: now, detail: ' {"personRef":"durable-owner-choice"} ' }], commands: [{ key: 'calendar:old', hash: JSON.stringify(configuration), resultId: 'source', at: now }] }
    const clean = redactExpiredCSVRecords(records, now)
    expect(clean.audits[0].detail).not.toContain('private-self'); expect(clean.audits[0].detail).toContain('staff-001')
    expect(clean.audits[1]).toEqual(records.audits[1])
    expect(clean.commands![0].hash).toBe('redacted:calendar-receipt:source')
    expect(clean.calendarRules[0].sources[0].csv!.snapshots[0].rows[0].quote).toBe(row('private-self'))
  })

  it('起動時purgeは権限版を一度だけ進め、後続の同時呼出でも台帳を変えない', async () => {
    const state = await imported((await db.calendarRules.get('main'))!)
    await db.calendarRules.put(state)
    const settings = (await db.settings.get('main'))!, before = changePolicyFor(settings)
    const events = await db.calendarEvents.toArray(), completions = await db.completions.toArray(), ledger = await db.ledger.toArray()
    await Promise.all([purgeExpiredCSVOriginals(expiry), purgeExpiredCSVOriginals(expiry)])
    const after = changePolicyFor((await db.settings.get('main'))!)
    expect(after).toMatchObject({ epoch: before.epoch + 1, sourcePermissionRevision: before.sourcePermissionRevision + 1 })
    await purgeExpiredCSVOriginals(expiry)
    expect(changePolicyFor((await db.settings.get('main'))!)).toEqual(after)
    expect(await db.calendarEvents.toArray()).toEqual(events); expect(await db.completions.toArray()).toEqual(completions); expect(await db.ledger.toArray()).toEqual(ledger)
    await verifyCSVOriginalDigests(await db.calendarRules.toArray())
  })

  it('purgeの保存失敗は原文・fact・settingsの部分更新を残さず再実行できる', async () => {
    await db.calendarRules.put(await imported((await db.calendarRules.get('main'))!))
    const before = { states: await db.calendarRules.toArray(), settings: await db.settings.toArray() }
    vi.spyOn(db.commands, 'bulkPut').mockRejectedValueOnce(new Error('synthetic write failure'))
    await expect(purgeExpiredCSVOriginals(expiry)).rejects.toThrow('synthetic write failure')
    expect({ states: await db.calendarRules.toArray(), settings: await db.settings.toArray() }).toEqual(before)
    await purgeExpiredCSVOriginals(expiry)
    expect((await db.calendarRules.get('main'))!.sources[0].csv!.snapshots[0].rows[0].quote).toBeNull()
  })

  it('CSV保存の本人承認監査はsource IDを記録し、設定保存だけでは予定を生成しない', async () => {
    const prepared = await prepareCalendarCSVImport(target('2027-01-01T00:00:00.000Z'), bytes(row('private-self')), options)
    const sourceId = await applyCalendarCSVImportFromUI(prepared, prepared.digest, click())
    const approval = (await db.audits.toArray()).find(audit => audit.operation === 'calendar.csv.approved')!
    expect(JSON.parse(approval.detail)).toMatchObject({ origin: 'manual_csv', sourceId })
    expect(JSON.parse(approval.detail)).not.toHaveProperty('ruleId')
    expect(await db.tasks.count()).toBe(0); expect(await db.calendarEvents.count()).toBe(0)
    expect(canonicalJSON(await db.audits.toArray())).not.toContain('private-self')
    expect(canonicalJSON(await db.commands.toArray())).not.toContain('private-self')
  })

  it('最後のreceipt待ち中の取消は設定・監査・receiptを同じtransactionで巻き戻す', async () => {
    const prepared = await prepareCalendarCSVImport(target('2027-01-01T00:00:00.000Z'), bytes(row('private-self')), options)
    const before = { states: await db.calendarRules.toArray(), audits: await db.audits.toArray(), commands: await db.commands.toArray() }
    const add = db.commands.add.bind(db.commands)
    vi.spyOn(db.commands, 'add').mockImplementation((...args: Parameters<typeof db.commands.add>) => add(...args).then(result => { clearCalendarCSVImportAuthority(); return result }))
    await expect(applyCalendarCSVImportFromUI(prepared, prepared.digest, click())).rejects.toThrow()
    expect({ states: await db.calendarRules.toArray(), audits: await db.audits.toArray(), commands: await db.commands.toArray() }).toEqual(before)
  })
})
