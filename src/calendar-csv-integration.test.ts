import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { calendarFixture, monthlyRule } from './calendar-test-fixtures'
import { parseCalendarCSVImport, prepareCSVConfiguration, verifyCSVOriginalDigests, type CSVImportTarget } from './calendar-csv-import'
import { buildCalendarChangePlan, calendarDateAt, resolveCalendarOccurrences, type CalendarRulesState, type CurrentCalendarEntity } from './calendar-resolver'
import { validateCalendarRulesState } from './calendar-rules-validation'
import { redactExpiredCSVRecords } from './calendar-csv-redaction'

const now = '2026-10-01T00:00:00.000Z', expiry = '2026-10-02T00:00:00.000Z'
const header = { calendar: 'record_id,record_revision,date,status', roster: 'shift_id,record_revision,person_ref,published,status,start_date,start_time,end_date,end_time' }
const shift = (id: string, revision = 1, date = '2026-10-05', status = 'scheduled', person = 'staff-001', published = 'true') => `${id},${revision},${person},${published},${status},${date},09:00,${date},17:00`
function fixture(roster = false) { const state = calendarFixture(); state.sources = []; if (roster) state.activities[0].weekdays = []; return state }
function target(kind: 'calendar' | 'roster', retentionUntil: string | null = '2027-01-01T00:00:00.000Z'): CSVImportTarget { return { kind, contextId: 'company', bindingId: 'self', calendarId: 'business', activityId: kind === 'roster' ? 'work' : null, feedId: `fixed-${kind}`, title: '本人選択CSV', retentionUntil } }
async function ingest(state: CalendarRulesState, kind: 'calendar' | 'roster', rows: string[], retentionUntil: string | null = '2027-01-01T00:00:00.000Z') {
  const parsed = await parseCalendarCSVImport(new TextEncoder().encode([header[kind], ...rows, ''].join('\r\n')), { kind, timezone: 'Asia/Tokyo', personRef: kind === 'roster' ? 'staff-001' : null, fromDate: '2026-10-01', toDate: '2026-10-31' })
  const result = await prepareCSVConfiguration(state, target(kind, retentionUntil), parsed)
  return { state: { ...state, ...result.next, revision: state.revision + (result.preview.noOp ? 0 : 1) }, preview: result.preview }
}
function entities(state: CalendarRulesState, from = '2026-10-01', to = '2026-10-31'): CurrentCalendarEntity[] { return resolveCalendarOccurrences(state, from, to).occurrences.map((spec, index) => ({ generationKey: spec.generationKey, entityId: `entity-${index}`, revision: 1, status: 'active', completed: false, edited: false, started: false, spec })) }
function expire(state: CalendarRulesState, at = expiry) { return redactExpiredCSVRecords({ calendarRules: [state], calendarEvents: [], audits: [] }, at).calendarRules[0] }
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now) })
afterEach(() => vi.useRealTimers())

describe('CSVと共通発生・版・期限の統合', () => {
  it('同一休業レコードが別日に移った後、撤回しても古い日の休業を復活させない', async () => {
    const base = fixture(); base.rules = [monthlyRule()]
    const first = (await ingest(base, 'calendar', ['closure,1,2026-10-02,closed'])).state
    expect(resolveCalendarOccurrences(first, '2026-10-01', '2026-10-31').occurrences.find(row => row.kind === 'task')?.scheduledDate).toBe('2026-10-05')
    const second = (await ingest(first, 'calendar', ['closure,2,2026-10-05,closed'])).state
    expect(second.facts.find(row => row.revision === 1)?.validity).toBe('withdrawn')
    expect(resolveCalendarOccurrences(second, '2026-10-01', '2026-10-31').occurrences.find(row => row.kind === 'task')?.scheduledDate).toBe('2026-10-02')
    const third = (await ingest(second, 'calendar', ['closure,3,2026-10-05,withdrawn'])).state
    expect(third.sources[0].csv!.heads[0]).toMatchObject({ factId: null, status: 'withdrawn', recordRevision: 3 })
    expect(third.facts.every(row => row.validity === 'withdrawn')).toBe(true)
    expect(resolveCalendarOccurrences(third, '2026-10-01', '2026-10-31').occurrences.find(row => row.kind === 'task')?.scheduledDate).toBe('2026-10-02')
    await verifyCSVOriginalDigests([third])
  })

  it('本人シフトの日時・版変更はイベントと相対タスクの同じ発生キーを更新する', async () => {
    const base = fixture(true); base.rules = [monthlyRule({ trigger: { kind: 'activity_relative', activityId: 'work', edge: 'start', offsetDays: -1, offsetMinutes: 0 } })]
    const first = (await ingest(base, 'roster', [shift('stable-shift')])).state, current = entities(first)
    const second = (await ingest(first, 'roster', [shift('stable-shift', 2, '2026-10-06')])).state
    const plan = buildCalendarChangePlan(second, current, '2026-10-01', '2026-10-31')
    expect(plan.creates).toHaveLength(0); expect(plan.cancels).toHaveLength(0); expect(plan.updates).toHaveLength(2)
    expect(plan.updates.map(row => row.after.generationKey).sort()).toEqual(current.map(row => row.generationKey).sort())
    expect(calendarDateAt(plan.updates.find(row => row.after.kind === 'event')!.after.startAt!, 'Asia/Tokyo')).toBe('2026-10-06')
    current.forEach(row => { row.completed = row.spec.kind === 'task' })
    expect(buildCalendarChangePlan(second, current, '2026-10-01', '2026-10-31')).toMatchObject({ skippedCompleted: 1, cancels: [], creates: [] })
  })

  it('欠落・他人・下書きは既存シフトを取消さず、明示cancelledだけが取消を作る', async () => {
    const first = (await ingest(fixture(true), 'roster', [shift('kept')])).state, current = entities(first)
    const omitted = await ingest(first, 'roster', [shift('other', 1, '2026-10-05', 'scheduled', 'staff-002'), shift('draft', 1, '2026-10-05', 'scheduled', 'staff-001', 'false')])
    expect(omitted.preview).toMatchObject({ noOp: true, selectedCount: 0, excludedOtherPerson: 1, excludedDraft: 1 })
    expect(buildCalendarChangePlan(omitted.state, current, '2026-10-01', '2026-10-31').cancels).toEqual([])
    const removed = structuredClone(first); removed.sources = []; removed.facts = []
    expect(buildCalendarChangePlan(removed, current, '2026-10-01', '2026-10-31').cancels).toEqual([])
    const cancelled = (await ingest(first, 'roster', [shift('kept', 2, '2026-10-05', 'cancelled')])).state
    expect(buildCalendarChangePlan(cancelled, current, '2026-10-01', '2026-10-31').cancels).toHaveLength(1)
  })

  it('CSV以外の本人週次設定の変更は従来のscopeで取消できる', () => {
    const state = calendarFixture(), current = entities(state, '2026-10-05', '2026-10-05'); state.activities[0].weekdays = []
    expect(buildCalendarChangePlan(state, current, '2026-10-05', '2026-10-05').cancels).toHaveLength(1)
  })

  it.each(['weekly', 'monthly_business'] as const)('期限切れ会社暦は%sの新規発生と暗黙取消を止める', async kind => {
    const base = fixture(); base.rules = [monthlyRule(kind === 'weekly' ? { trigger: { kind: 'weekly', weekdays: [1], time: '09:00' } } : {})]
    const live = (await ingest(base, 'calendar', ['closure,1,2026-10-02,closed'], expiry)).state, current = entities(live)
    vi.setSystemTime(expiry)
    const stale = expire(live), resolved = resolveCalendarOccurrences(stale, '2026-10-01', '2026-10-31')
    expect(resolved.blockedSeries).toContain('rule:payroll')
    expect(buildCalendarChangePlan(stale, current, '2026-10-01', '2026-10-31')).toMatchObject({ creates: [], updates: [], cancels: [] })
  })

  it('期限切れシフトとその相対準備タスクを勝手に取消・生成しない', async () => {
    const base = fixture(true); base.rules = [monthlyRule({ trigger: { kind: 'activity_relative', activityId: 'work', edge: 'start', offsetDays: -2, offsetMinutes: 0 } })]
    const live = (await ingest(base, 'roster', [shift('expired')], expiry)).state, current = entities(live)
    vi.setSystemTime(expiry)
    expect(buildCalendarChangePlan(expire(live), current, '2026-10-01', '2026-10-31')).toMatchObject({ creates: [], updates: [], cancels: [] })
    expect(resolveCalendarOccurrences(expire(live), '2026-10-03', '2026-10-03').blockedSeries).toContain('rule:payroll')
  })

  it('部分再取込で失効行を復活させず、範囲外の旧キーは新しい窓を塞がない', async () => {
    const old = (await ingest(fixture(true), 'roster', [shift('old', 1, '2026-10-05')], expiry)).state, current = entities(old)
    vi.setSystemTime(expiry)
    const fresh = (await ingest(expire(old), 'roster', [shift('new', 1, '2026-10-20')])).state
    expect(fresh.sources[0].csv!.heads.filter(row => row.status === 'expired')).toHaveLength(1)
    expect(fresh.facts.find(row => row.revision === 1 && row.id === old.facts[0].id)?.validity).toBe('withdrawn')
    const resolved = resolveCalendarOccurrences(fresh, '2026-10-20', '2026-10-20', current.map(row => row.generationKey))
    expect(resolved.blockedSeries).toEqual([]); expect(resolved.occurrences).toHaveLength(1)
    expect(buildCalendarChangePlan(fresh, current, '2026-10-20', '2026-10-20')).toMatchObject({ cancels: [], updates: [] })
    expect(resolveCalendarOccurrences(fresh, '2026-10-05', '2026-10-05').blockedSeries).toContain('activity:work')
    await verifyCSVOriginalDigests([fresh])
  })

  it('factIdがない撤回行も匿名日付で期限範囲を絞り、後日の無関係な週次を塞がない', async () => {
    const base = fixture(); base.rules = [monthlyRule({ trigger: { kind: 'weekly', weekdays: [2], time: '09:00' } })]
    const old = (await ingest(base, 'calendar', ['withdrawal,1,2026-10-05,withdrawn'], expiry)).state
    vi.setSystemTime(expiry)
    const fresh = (await ingest(expire(old), 'calendar', ['fresh,1,2026-10-20,open'])).state
    expect(resolveCalendarOccurrences(fresh, '2026-10-05', '2026-10-05').blockedSeries).toContain('rule:payroll')
    expect(resolveCalendarOccurrences(fresh, '2026-10-20', '2026-10-20').blockedSeries).not.toContain('rule:payroll')
  })

  it.each(['binding', 'timezone'] as const)('%s実値変更は古い本人対応を採用せず新規を止める', async changed => {
    const state = (await ingest(fixture(true), 'roster', [shift('owner-bound')])).state, current = entities(state)
    if (changed === 'binding') { state.bindings[0].revision++; state.bindings[0].personRef = 'staff-002' }
    else state.contexts[0].timezone = 'UTC'
    expect(buildCalendarChangePlan(state, current, '2026-10-01', '2026-10-31')).toMatchObject({ creates: [], cancels: [] })
    expect(resolveCalendarOccurrences(state, '2026-10-01', '2026-10-31').blockedSeries).toContain('activity:work')
  })

  it.each(['value-extra', 'value-time', 'head-revision', 'byte-span', 'active-old'] as const)('%sの不整合を厳密schemaで拒否する', async corrupted => {
    const state = (await ingest(fixture(true), 'roster', [shift('guarded')])).state, csv = state.sources[0].csv!, evidence = csv.snapshots[0].rows[0]
    if (corrupted === 'value-extra') Object.assign(evidence.value, { personRef: 'other-secret' })
    if (corrupted === 'value-time' && evidence.value.kind === 'roster') evidence.value.startAt = '2026-10-05T01:00:00.000Z'
    if (corrupted === 'head-revision') csv.heads[0].recordRevision++
    if (corrupted === 'byte-span') evidence.byteEnd++
    if (corrupted === 'active-old') csv.heads[0].status = 'expired'
    expect(() => validateCalendarRulesState(state)).toThrow()
  })
})
