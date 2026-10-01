import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { calendarFixture, monthlyRule } from './calendar-test-fixtures'
import { contentDigest } from './canonical'
import { csvEvidenceBodyProjection, csvUTF8Digest, parseCalendarCSVImport, prepareCSVConfiguration, verifyCSVOriginalDigests, type CSVImportTarget } from './calendar-csv-import'
import { buildCalendarChangePlan, resolveCalendarOccurrences, type CalendarRule, type CalendarRulesState, type CurrentCalendarEntity } from './calendar-resolver'
import { prepareScheduleImport, validateCalendarRulesState } from './calendar-rules-validation'
import { applyCurrentCSVRetention, redactCSVForAudit, redactExpiredCSVRecords } from './calendar-csv-redaction'

const now = '2026-10-01T00:00:00.000Z', from = '2026-10-01', to = '2026-10-31'
const header = { calendar: 'record_id,record_revision,date,status', roster: 'shift_id,record_revision,person_ref,published,status,start_date,start_time,end_date,end_time' }
const shift = (id: string, revision = 1, date = '2026-10-05', status = 'scheduled', person = 'staff-001') => `${id},${revision},${person},true,${status},${date},09:00,${date},17:00`
const relative = (patch: Partial<CalendarRule> = {}) => monthlyRule({ id: 'prep', trigger: { kind: 'activity_relative', activityId: 'work', edge: 'start', offsetDays: -1, offsetMinutes: 0 }, ...patch })
function fixture(roster = false) { const state = calendarFixture(); state.sources = []; state.facts = []; if (roster) state.activities[0].weekdays = []; return state }
type Options = { feedId?: string; title?: string; retentionUntil?: string | null; fromDate?: string; toDate?: string; bom?: boolean; eol?: string; activityId?: string }
async function ingest(state: CalendarRulesState, kind: 'calendar' | 'roster', rows: string[], options: Options = {}) {
  const text = (options.bom ? '﻿' : '') + [header[kind], ...rows, ''].join(options.eol ?? '\r\n')
  const parsed = await parseCalendarCSVImport(new TextEncoder().encode(text), { kind, timezone: state.contexts[0].timezone, personRef: kind === 'roster' ? state.bindings[0].personRef : null, fromDate: options.fromDate ?? from, toDate: options.toDate ?? to })
  const target: CSVImportTarget = { kind, contextId: 'company', bindingId: 'self', calendarId: 'business', activityId: kind === 'roster' ? options.activityId ?? 'work' : null, feedId: options.feedId ?? `fixed-${kind}${options.activityId ? `-${options.activityId}` : ''}`, title: options.title ?? '本人選択CSV', retentionUntil: options.retentionUntil === undefined ? '2027-01-01T00:00:00.000Z' : options.retentionUntil }
  const result = await prepareCSVConfiguration(state, target, parsed)
  const next = { ...state, ...result.next, revision: state.revision + (result.preview.noOp ? 0 : 1) }
  validateCalendarRulesState(next)
  return { state: next, preview: result.preview }
}
function entities(state: CalendarRulesState): CurrentCalendarEntity[] { return resolveCalendarOccurrences(state, from, to).occurrences.map((spec, index) => ({ generationKey: spec.generationKey, entityId: `entity-${index}`, revision: 1, status: 'active', completed: false, edited: false, started: false, spec })) }
function retire(state: CalendarRulesState, sourceId: string) { const next = structuredClone(state); next.sources.find(row => row.id === sourceId)!.csv!.retiredAt = now; next.revision++; validateCalendarRulesState(next); return next }
const expireAt = (state: CalendarRulesState, at: string) => redactExpiredCSVRecords({ calendarRules: [state], calendarEvents: [], audits: [] }, at).calendarRules[0]
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('ファイル全体hashと保存した選択行hashの区別', () => {
  it('他人の行・BOM・改行・行順だけの変更は保存案を作らず版を増やさない', async () => {
    const first = (await ingest(fixture(true), 'roster', [shift('s1'), shift('s2', 1, '2026-10-06'), shift('o1', 1, '2026-10-05', 'scheduled', 'staff-002')])).state
    for (const variant of [
      { rows: [shift('s1'), shift('s2', 1, '2026-10-06'), shift('o1', 2, '2026-10-07', 'scheduled', 'staff-002')] },
      { rows: [shift('s1'), shift('s2', 1, '2026-10-06')], bom: true },
      { rows: [shift('s1'), shift('s2', 1, '2026-10-06')], eol: '\n' },
      { rows: [shift('s2', 1, '2026-10-06'), shift('o9', 1, '2026-10-05', 'scheduled', 'staff-009'), shift('s1')] },
    ]) {
      const result = await ingest(first, 'roster', variant.rows, variant)
      expect(result.preview).toMatchObject({ noOp: true, added: 0, updated: 0, canceled: 0, unchanged: 2 }); expect(result.state).toEqual(first)
    }
  })
  it('重複した旧記録は整理し、実際の版変更は旧20版の上限を超えて保存できる', async () => {
    let state = (await ingest(fixture(true), 'roster', [shift('s1')])).state
    for (let n = 2; n <= 30; n++) state = (await ingest(state, 'roster', [shift('s1')], { title: `本人選択CSV ${n}` })).state
    expect(state.sources[0].revision).toBe(30); expect(state.sources[0].csv!.snapshots).toHaveLength(1)
    for (let revision = 2; revision <= 25; revision++) state = (await ingest(state, 'roster', [shift('s1', revision, `2026-10-${String(revision).padStart(2, '0')}`)])).state
    expect(state.sources[0].csv!.snapshots).toHaveLength(25); expect(state.facts.filter(row => row.validity === 'active')).toHaveLength(1)
    await verifyCSVOriginalDigests([state])
  })
})

describe('同じ対象の取込元・終了・移行', () => {
  it('同じ活動へ別feedを作らず、終了後の新feedは同じ発生キーへ対応して二重作成しない', async () => {
    const base = fixture(true); base.rules = [relative()]
    const first = (await ingest(base, 'roster', [shift('s1'), shift('s2', 1, '2026-10-12')])).state, current = entities(first), keys = current.map(row => row.generationKey).sort()
    expect(keys).toHaveLength(4)
    await expect(ingest(first, 'roster', [shift('s1')], { feedId: 'second-feed' })).rejects.toThrow('取込元の終了')
    const retired = retire(first, first.sources[0].id), retiredPlan = buildCalendarChangePlan(retired, current, from, to)
    expect(retiredPlan).toMatchObject({ creates: [], cancels: [], conflicts: [] })
    const migrated = (await ingest(retired, 'roster', [shift('s1'), shift('s2', 1, '2026-10-12')], { feedId: 'second-feed' })).state
    expect(resolveCalendarOccurrences(migrated, from, to).occurrences.map(row => row.generationKey).sort()).toEqual(keys)
    const plan = buildCalendarChangePlan(migrated, current, from, to); expect(plan.creates).toHaveLength(0); expect(plan.cancels).toHaveLength(0); expect(plan.conflicts).toHaveLength(0)
    await expect(ingest(migrated, 'roster', [shift('s1')], { feedId: 'fixed-roster' })).rejects.toThrow('終了済み')
  })
  it('復元等で二つの有効な取込元が同じシフトを別日時で示すと、二件作らず確認待ちにする', async () => {
    const first = (await ingest(fixture(true), 'roster', [shift('s1')])).state
    const second = (await ingest(retire(first, first.sources[0].id), 'roster', [shift('s1', 2, '2026-10-06')], { feedId: 'second-feed' })).state
    const both = structuredClone(second); both.sources[0].csv!.retiredAt = null
    const resolved = resolveCalendarOccurrences(both, from, to)
    expect(resolved.occurrences).toHaveLength(0); expect(resolved.blockedSeries).toContain('activity:work'); expect(resolved.conflicts.some(row => row.reason.includes('同じ本人シフト'))).toBe(true)
  })
  it('本人識別子の変更は終了で解除し、無関係なbinding版の更新だけでは保留しない', async () => {
    const first = (await ingest(fixture(true), 'roster', [shift('s1')])).state
    const bumped = structuredClone(first); bumped.bindings[0].revision++
    expect(resolveCalendarOccurrences(bumped, from, to).blockedSeries).toEqual([])
    const drifted = structuredClone(first); drifted.bindings[0].personRef = 'staff-009'; drifted.bindings[0].revision++
    expect(resolveCalendarOccurrences(drifted, from, to).blockedSeries).toContain('activity:work')
    await expect(ingest(drifted, 'roster', [shift('s1', 1, '2026-10-05', 'scheduled', 'staff-009')])).rejects.toThrow('取込元の終了')
    const retired = retire(drifted, drifted.sources[0].id)
    expect(resolveCalendarOccurrences(retired, from, to).blockedSeries).toEqual([])
    const fresh = (await ingest(retired, 'roster', [shift('s1', 1, '2026-10-05', 'scheduled', 'staff-009')], { feedId: 'renewed-person' })).state
    expect(resolveCalendarOccurrences(fresh, from, to).occurrences.map(row => row.generationKey)).toEqual(resolveCalendarOccurrences(first, from, to).occurrences.map(row => row.generationKey))
  })
})

describe('期間外の新しい版・重複ID', () => {
  it('既存レコードの新しい版が期間外へ移った場合は古い日時を最新にせず拒否する', async () => {
    const roster = (await ingest(fixture(true), 'roster', [shift('s1', 1, '2026-10-30')])).state
    await expect(ingest(roster, 'roster', [shift('s1', 2, '2026-11-02')])).rejects.toThrow('取込期間を広げて')
    await expect(ingest(roster, 'roster', [shift('s1', 2, '2026-11-02'), shift('s2')])).rejects.toThrow('取込期間を広げて')
    const moved = (await ingest(roster, 'roster', [shift('s1', 2, '2026-11-02')], { toDate: '2026-11-30' })).state
    expect(moved.facts.find(row => row.validity === 'active')).toMatchObject({ kind: 'roster_assignment', revision: 2, startAt: '2026-11-02T00:00:00.000Z' })
    await expect(ingest(moved, 'roster', [shift('s1', 1, '2026-12-01')], { toDate: '2026-11-30' })).rejects.toThrow('古い版')
    const calendar = (await ingest(fixture(), 'calendar', ['h1,1,2026-10-05,closed'])).state
    await expect(ingest(calendar, 'calendar', ['h1,2,2026-11-02,closed'])).rejects.toThrow('取込期間を広げて')
    await expect(ingest(calendar, 'calendar', ['h1,2,2026-11-02,closed', 'h1,1,2026-10-05,closed'], { toDate: '2026-11-30' })).rejects.toThrow('重複')
    await expect(ingest(calendar, 'calendar', ['h1,1,2026-10-05,closed', 'h1,2,2026-11-02,closed'])).rejects.toThrow('重複')
  })
  it('外部の版番号は永続化できる範囲だけ受け付け、本人識別子はUnicode正規化だけで照合する', async () => {
    await expect(ingest(fixture(true), 'roster', [shift('s1', 2147483648)])).rejects.toThrow('2147483647')
    const state = fixture(true); state.bindings[0].personRef = 'café'
    const result = await ingest(state, 'roster', [shift('s1', 1, '2026-10-05', 'scheduled', 'café'), shift('s2', 1, '2026-10-06', 'scheduled', ' café')])
    expect(result.preview).toMatchObject({ selectedCount: 1, excludedOtherPerson: 1 }); await verifyCSVOriginalDigests([result.state])
  })
})

describe('保持期限の短縮・時刻規則の更新・監査', () => {
  it('短い保持期限で再取込すると旧版の原文も同じ期限で消去し、長くしても延長しない', async () => {
    let state = (await ingest(fixture(true), 'roster', [shift('s1'), shift('s2', 1, '2026-10-06')])).state
    state = (await ingest(state, 'roster', [shift('s1', 2, '2026-10-07'), shift('s2', 1, '2026-10-06')], { retentionUntil: '2026-10-03T00:00:00.000Z' })).state
    expect(state.sources[0].csv!.snapshots.map(row => row.retentionUntil)).toEqual(['2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z'])
    state = (await ingest(state, 'roster', [shift('s1', 3, '2026-10-08'), shift('s2', 1, '2026-10-06')], { retentionUntil: '2027-06-01T00:00:00.000Z' })).state
    expect(state.sources[0].csv!.snapshots.map(row => row.retentionUntil)).toEqual(['2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z', '2027-06-01T00:00:00.000Z'])
    const expired = expireAt(state, '2026-10-03T00:00:00.000Z'), csv = expired.sources[0].csv!
    expect(csv.snapshots.slice(0, 2).every(row => row.rows.every(item => item.quote === null))).toBe(true); expect(csv.snapshots[2].rows.every(row => row.quote !== null)).toBe(true)
    await verifyCSVOriginalDigests([expired])
    const shortened = (await ingest(state, 'roster', [shift('s1', 4, '2026-10-09'), shift('s2', 1, '2026-10-06')], { retentionUntil: '2026-10-02T00:00:00.000Z' })).state
    const purged = expireAt(shortened, '2026-10-02T00:00:00.000Z').sources[0]
    expect(purged.csv!.snapshots.every(row => row.rows.every(item => item.quote === null))).toBe(true); expect(purged.csv!.target.personRef).toBeNull(); expect(purged.status).toBe('stale')
  })
  it('保持した勤務表の原文はタイムゾーン規則が更新されても照合でき、改変した現地時刻は拒否する', async () => {
    const base = fixture(true); base.contexts[0].timezone = 'America/New_York'
    const state = (await ingest(base, 'roster', [shift('s1', 1, '2026-12-05')], { fromDate: '2026-12-01', toDate: '2026-12-31' })).state
    const Original = Intl.DateTimeFormat
    // Simulated tz-data update: the same zone name now resolves with another zone's offsets.
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locale?: string | string[], options?: Intl.DateTimeFormatOptions) { return new Original(locale, options?.timeZone === 'America/New_York' ? { ...options, timeZone: 'America/Halifax' } : options) } as unknown as typeof Intl.DateTimeFormat)
    await expect(verifyCSVOriginalDigests([state])).resolves.toBeUndefined()
    vi.restoreAllMocks()
    const tampered = structuredClone(state), source = tampered.sources[0], snapshot = source.csv!.snapshots[0], row = snapshot.rows[0]
    row.quote = row.quote!.replace('09:00', '10:00'); row.quoteSha256 = await csvUTF8Digest(row.quote)
    snapshot.bodyHash = source.bodyHash = await contentDigest(csvEvidenceBodyProjection('roster', snapshot.rows))
    await expect(verifyCSVOriginalDigests([tampered])).rejects.toThrow('保持した選択行とレコードの根拠')
    // A retained quote that smuggles in another record (here another person's row) is not the selected row.
    const smuggled = structuredClone(state), csv = smuggled.sources[0].csv!, extra = csv.snapshots[0], first = extra.rows[0]
    first.quote = `${first.quote}\nother,1,staff-002,true,scheduled,2026-12-05,09:00,2026-12-05,17:00`; first.quoteSha256 = await csvUTF8Digest(first.quote); first.byteEnd = first.byteStart + new TextEncoder().encode(first.quote).length; first.lineEnd++
    extra.bodyHash = smuggled.sources[0].bodyHash = await contentDigest(csvEvidenceBodyProjection('roster', extra.rows))
    await expect(verifyCSVOriginalDigests([smuggled])).rejects.toThrow('保持した選択行とレコードの根拠')
  })
  it('監査用の写しは原文・CSV本人識別子・原文hashを持たない', async () => {
    const state = (await ingest(fixture(true), 'roster', [shift('s1')])).state, audit = redactCSVForAudit(structuredClone(state)) as unknown as { sources: { csv: Record<string, unknown> & { target: { personRef: unknown }; snapshots: Record<string, unknown>[] } }[] }, csv = audit.sources[0].csv
    expect(csv.target.personRef).toBeNull(); expect(csv.snapshots).toEqual([expect.objectContaining({ revision: 1, rowCount: 1, bodyHash: state.sources[0].bodyHash })]); expect(csv.snapshots[0]).not.toHaveProperty('rows')
    const row = state.sources[0].csv!.snapshots[0].rows[0], text = JSON.stringify(audit)
    for (const secret of [row.quote!, row.quoteSha256]) expect(text).not.toContain(secret)
    expect(redactCSVForAudit(audit)).toEqual(audit)
  })
})

describe('本人の系列変更と欠落の区別・検証', () => {
  it('欠落行では取消さず、本人がルールを停止・以後停止したときは未完了の準備タスクを取消す', async () => {
    const base = fixture(true); base.rules = [relative()]
    const first = (await ingest(base, 'roster', [shift('s1'), shift('s2', 1, '2026-10-12')])).state, current = entities(first)
    const partial = (await ingest(first, 'roster', [shift('s1')])).state
    expect(buildCalendarChangePlan(partial, current, from, to).cancels).toHaveLength(0)
    const stopped = structuredClone(first); stopped.rules[0].enabled = false; stopped.revision++
    expect(buildCalendarChangePlan(stopped, current, from, to).cancels.map(row => `${row.before.spec.ruleId}:${row.before.spec.scheduledDate}`).sort()).toEqual(['prep:2026-10-04', 'prep:2026-10-11'])
    const later = structuredClone(first), rule = later.rules[0]; rule.revision = 2
    rule.editions = [{ id: 'stop-later', revision: 2, scope: { kind: 'this_and_future', fromDate: '2026-10-10' }, definition: { title: rule.title, enabled: false, steps: rule.steps, trigger: rule.trigger } }]
    validateCalendarRulesState(later)
    expect(buildCalendarChangePlan(later, current, from, to).cancels.map(row => row.before.spec.scheduledDate)).toEqual(['2026-10-11'])
    const retargeted = structuredClone(first); retargeted.rules[0].trigger = { kind: 'weekly', weekdays: [1], time: '09:00' }
    expect(buildCalendarChangePlan(retargeted, current, from, to).cancels.filter(row => row.before.spec.triggerKey.startsWith('roster-csv:'))).toHaveLength(2)
  })
  it('現在のCSV記録が有効な同じ版の事実を指さない状態と、手動JSONによるCSV資料IDの使用を拒否する', async () => {
    const state = (await ingest(fixture(true), 'roster', [shift('s1')])).state
    const broken = structuredClone(state); broken.facts[0].validity = 'withdrawn'
    expect(() => validateCalendarRulesState(broken)).toThrow('CSVの最新版の事実が有効ではありません')
    const input = (id: string) => ({ format: 'coach-schedule-facts', version: 1, source: { id, title: '手動', authorityScope: 'roster', coverageFrom: from, coverageTo: to, revision: 1 }, facts: [] })
    await expect(prepareScheduleImport(state, 'company', input('csv-source:forged'))).rejects.toThrow('CSV取込専用')
    await expect(prepareScheduleImport(state, 'company', input(state.sources[0].id))).rejects.toThrow('CSV取込専用')
  })
  it('手動JSONの資料IDがcsvで始まっても従来どおり撤回で取消できる', async () => {
    const state = fixture(true)
    state.sources = [{ id: 'csv-roster-json', contextId: 'company', title: '手動勤務表', authorityScope: 'roster', coverageFrom: from, coverageTo: to, status: 'current', revision: 1, importedAt: now, bodyHash: 'a'.repeat(64) }]
    state.facts = [{ id: 'f1', sourceId: 'csv-roster-json', contextId: 'company', revision: 1, validity: 'active', supersedes: [], kind: 'roster_assignment', activityId: 'work', externalId: 'manual-1', personRef: 'staff-001', published: true, status: 'scheduled', startAt: '2026-10-05T00:00:00.000Z', endAt: '2026-10-05T08:00:00.000Z' }]
    validateCalendarRulesState(state); const current = entities(state); expect(current[0].generationKey).toContain('roster:csv-roster-json:manual-1')
    const withdrawn = structuredClone(state); withdrawn.facts[0].validity = 'withdrawn'
    expect(buildCalendarChangePlan(withdrawn, current, from, to).cancels).toHaveLength(1)
  })
  it('月次営業日ルールは評価する月だけを確認し、隣の月の期限切れ行で止めない', async () => {
    const base = fixture(); base.rules = [monthlyRule()]
    let state = (await ingest(base, 'calendar', ['sep-closure,1,2026-09-15,closed'], { fromDate: '2026-09-01', toDate: '2026-09-30', retentionUntil: '2026-10-02T00:00:00.000Z' })).state
    state = (await ingest(state, 'calendar', ['oct-closure,1,2026-10-20,closed'], { title: '本人選択CSV 10月' })).state
    const expired = expireAt(state, '2026-10-02T00:00:00.000Z'); vi.setSystemTime('2026-10-02T00:00:00.000Z')
    const october = resolveCalendarOccurrences(expired, from, to)
    expect(october.blockedSeries).toEqual([]); expect(october.occurrences.find(row => row.ruleId === 'payroll')?.scheduledDate).toBe('2026-10-02')
    expect(resolveCalendarOccurrences(expired, '2026-09-01', '2026-09-30').blockedSeries).toContain('rule:payroll')
  })
})

describe('取込元の移行・活動の区別・復元（3回目の確認）', () => {
  const warehouse = (state: CalendarRulesState) => { state.activities.push({ ...state.activities[0], id: 'warehouse', title: '倉庫勤務' }); state.bindings[0].activityIds.push('warehouse'); return state }
  it('別の勤務活動の同じシフトIDは別の発生回として扱い、ルールの対象変更で別の勤務へ付け替えない', async () => {
    const base = warehouse(fixture(true)); base.rules = [relative()]
    const work = (await ingest(base, 'roster', [shift('1001', 1, '2026-10-05')])).state
    const both = (await ingest(work, 'roster', [shift('1001', 1, '2026-10-20')], { activityId: 'warehouse' })).state
    const current = entities(both), keys = current.map(row => row.generationKey)
    expect(new Set(keys).size).toBe(keys.length); expect(keys.filter(key => key.includes(':roster-csv:'))).toHaveLength(3)
    const moved = structuredClone(both), rule = moved.rules[0]; rule.revision = 2
    rule.editions = [{ id: 'to-warehouse', revision: 2, scope: { kind: 'all_uncompleted' }, definition: { title: rule.title, enabled: true, steps: rule.steps, trigger: { kind: 'activity_relative', activityId: 'warehouse', edge: 'start', offsetDays: -1, offsetMinutes: 0 } } }]
    const plan = buildCalendarChangePlan(moved, current, from, to)
    expect(plan.updates).toHaveLength(0); expect(plan.creates.map(row => row.scheduledDate)).toEqual(['2026-10-19']); expect(plan.cancels.map(row => row.before.spec.scheduledDate)).toEqual(['2026-10-04'])
  })
  it('同じ本人の別活動で時間が重なる同じシフトIDは二重に取り込まない', async () => {
    const work = (await ingest(warehouse(fixture(true)), 'roster', [shift('1001', 1, '2026-10-05')])).state
    await expect(ingest(work, 'roster', [shift('1001', 1, '2026-10-05')], { activityId: 'warehouse' })).rejects.toThrow('時間の重なる勤務')
  })
  it('終了した取込元より古い版・同じ版の異なる内容は新しい取込元でも最新にしない', async () => {
    let state = (await ingest(fixture(true), 'roster', [shift('s1', 1, '2026-10-05')])).state
    state = (await ingest(state, 'roster', [shift('s1', 5, '2026-10-20')])).state
    state = retire(state, state.sources[0].id)
    await expect(ingest(state, 'roster', [shift('s1', 1, '2026-10-05')], { feedId: 'stale-export' })).rejects.toThrow('終了した取込元')
    await expect(ingest(state, 'roster', [shift('s1', 5, '2026-10-07')], { feedId: 'stale-export' })).rejects.toThrow('同じ版の異なる内容')
    const migrated = (await ingest(state, 'roster', [shift('s1', 5, '2026-10-20')], { feedId: 'renewed' })).state
    expect(resolveCalendarOccurrences(migrated, from, to).occurrences.map(row => row.startAt)).toEqual(['2026-10-20T00:00:00.000Z'])
  })
  it('取込元の移行で出典だけが変わった本人編集・着手済みの回は確認待ちにしない', async () => {
    const base = fixture(true); base.rules = [relative()]
    const first = (await ingest(base, 'roster', [shift('s1')])).state, current = entities(first).map(row => ({ ...row, edited: true, started: true }))
    const migrated = (await ingest(retire(first, first.sources[0].id), 'roster', [shift('s1'), shift('s3', 1, '2026-10-19')], { feedId: 'renewed' })).state
    const plan = buildCalendarChangePlan(migrated, current, from, to)
    expect(plan.conflicts).toHaveLength(0); expect(plan.unchanged).toBe(2); expect(plan.creates).toHaveLength(2)
  })
  it('以後の変更の境界日に始まる勤務にも、その日の版の準備タスクを作る', async () => {
    const base = fixture(true); base.rules = [relative()]
    const state = (await ingest(base, 'roster', [shift('s1', 1, '2026-10-10'), shift('s2', 1, '2026-10-12')])).state, rule = state.rules[0]; rule.revision = 2
    rule.editions = [{ id: 'more-points', revision: 2, scope: { kind: 'this_and_future', fromDate: '2026-10-10' }, definition: { title: rule.title, enabled: true, steps: [{ ...rule.steps[0], score: { ...rule.steps[0].score!, manualPoints: 20 } }], trigger: rule.trigger } }]
    const tasks = resolveCalendarOccurrences(state, from, to).occurrences.filter(row => row.kind === 'task')
    expect(tasks.map(row => `${row.scheduledDate}:${row.score?.manualPoints}`).sort()).toEqual(['2026-10-09:20', '2026-10-11:20'])
  })
  it('停止範囲へ移ったシフトは最新の日付で判断し、古い準備タスクを取消す', async () => {
    const base = fixture(true); base.rules = [relative()]
    const first = (await ingest(base, 'roster', [shift('s1', 1, '2026-10-05')])).state, current = entities(first)
    const moved = (await ingest(first, 'roster', [shift('s1', 2, '2026-10-20')])).state, rule = moved.rules[0]; rule.revision = 2
    rule.editions = [{ id: 'stop-later', revision: 2, scope: { kind: 'this_and_future', fromDate: '2026-10-10' }, definition: { title: rule.title, enabled: false, steps: rule.steps, trigger: rule.trigger } }]
    const plan = buildCalendarChangePlan(moved, current, from, to)
    expect(plan.cancels.map(row => row.before.spec.scheduledDate)).toEqual(['2026-10-04']); expect(plan.updates.map(row => row.after.kind)).toEqual(['event'])
  })
  it('正規化形式の違うシフトIDは同じ記録として扱う', async () => {
    const first = (await ingest(fixture(true), 'roster', [shift('café-1')])).state
    expect((await ingest(first, 'roster', [shift('café-1')])).preview).toMatchObject({ added: 0, updated: 0, canceled: 0, unchanged: 1 })
  })
  it('時刻規則の更新で同じ版のUTCだけが変わった場合は資料の矛盾と言わず、規則更新として案内する', async () => {
    const base = fixture(true); base.contexts[0].timezone = 'America/New_York'
    const state = (await ingest(base, 'roster', [shift('s1', 1, '2026-12-05')], { fromDate: '2026-12-01', toDate: '2026-12-31' })).state, Original = Intl.DateTimeFormat
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locale?: string | string[], options?: Intl.DateTimeFormatOptions) { return new Original(locale, options?.timeZone === 'America/New_York' ? { ...options, timeZone: 'America/Halifax' } : options) } as unknown as typeof Intl.DateTimeFormat)
    await expect(ingest(state, 'roster', [shift('s1', 1, '2026-12-05')], { fromDate: '2026-12-01', toDate: '2026-12-31' })).rejects.toThrow('タイムゾーン規則の更新')
  })
  it('短い保持期限が以前の記録にも及ぶ場合は確認案で件数を示す', async () => {
    const first = (await ingest(fixture(true), 'roster', [shift('s1'), shift('s2', 1, '2026-10-06')])).state
    const result = await ingest(first, 'roster', [shift('s3', 1, '2026-10-07')], { retentionUntil: '2026-10-05T00:00:00.000Z' })
    expect(result.preview.retentionShortened).toEqual({ snapshots: 1, otherRecords: 2, until: '2026-10-05T00:00:00.000Z' })
    expect((await ingest(first, 'roster', [shift('s3', 1, '2026-10-07')])).preview.retentionShortened).toBeNull()
  })
  it('復元しても、現在までに消去・短縮した原文の保持を元に戻さない', async () => {
    const backup = (await ingest(fixture(true), 'roster', [shift('s1'), shift('s2', 1, '2026-10-06')])).state
    const shortened = (await ingest(backup, 'roster', [shift('s1'), shift('s2', 1, '2026-10-06')], { retentionUntil: '2026-10-01T01:00:00.000Z' })).state
    const purged = expireAt(shortened, '2026-10-01T02:00:00.000Z')
    const restored = applyCurrentCSVRetention([backup], [purged])[0], csv = restored.sources[0].csv!
    expect(csv.retentionUntil).toBe('2026-10-01T01:00:00.000Z'); expect(csv.snapshots.every(row => row.rows.every(item => item.quote === null))).toBe(true)
    expect(csv.target.personRef).toBeNull(); expect(csv.heads.every(head => head.status === 'expired')).toBe(true); expect(restored.facts.every(row => row.validity === 'withdrawn')).toBe(true)
    validateCalendarRulesState(restored); await verifyCSVOriginalDigests([restored])
    expect(applyCurrentCSVRetention([backup], [])[0]).toEqual(backup)
  })
})
