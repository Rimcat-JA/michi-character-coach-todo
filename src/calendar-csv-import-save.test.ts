import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { calendarFixture, monthlyRule } from './calendar-test-fixtures'
import { calendarCSVHeaders, prepareCalendarCSVImport, prepareCalendarCSVRetirement, verifyCSVOriginalDigests, type CSVImportTarget } from './calendar-csv-import'
import { applyCalendarCSVImportFromUI, cancelCalendarCSVImport, clearCalendarCSVImportAuthority } from './calendar-csv-import-save'
import { applyCalendarProposalFromUI, clearCalendarRulesAuthority, prepareCalendarGeneration } from './calendar-rules-save'
import { completeTask } from './commands'
import { changePolicyFor } from './change-set'

beforeEach(async () => { clearCalendarCSVImportAuthority(); clearCalendarRulesAuthority(); await db.delete(); await db.open(); await ensureSettings(); const settings = (await db.settings.get('main'))!, state = calendarFixture(); state.ownerId = settings.profileId; state.datasetId = settings.datasetId; state.bindings[0].personId = settings.profileId; state.activities[0].weekdays = []; state.sources = []; state.facts = []; await db.calendarRules.put(state) })
afterEach(() => { clearCalendarCSVImportAuthority(); clearCalendarRulesAuthority(); vi.restoreAllMocks(); vi.useRealTimers() })
const click = () => { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
const period = { fromDate: '2026-10-01', toDate: '2026-10-31' }
const target = (kind: 'calendar' | 'roster' = 'roster'): CSVImportTarget => ({ kind, contextId: 'company', bindingId: 'self', calendarId: 'business', activityId: kind === 'roster' ? 'work' : null, feedId: 'fixed-feed', title: '本人が選択した会社CSV', retentionUntil: '2027-01-01T00:00:00.000Z' })
const raw = (revision = 1, date = '2026-10-02', status = 'scheduled') => calendarCSVHeaders.roster.join(',') + `\nshift-stable,${revision},staff-001,true,${status},${date},22:00,${date === '2026-10-02' ? '2026-10-03' : '2026-10-04'},06:00\n`
const calendar = (revision = 1, date = '2026-10-02', status = 'closed') => calendarCSVHeaders.calendar.join(',') + `\nrecord-stable,${revision},${date},${status}\n`
async function prepare(text = raw(), kind: 'calendar' | 'roster' = 'roster', selected = target(kind)) { return prepareCalendarCSVImport(selected, new TextEncoder().encode(text), period) }
async function save(text = raw(), kind: 'calendar' | 'roster' = 'roster') { const value = await prepare(text, kind); if (value.configuration) await applyCalendarCSVImportFromUI(value, value.digest, click()); return value }
async function generate() { const value = await prepareCalendarGeneration(period.fromDate, period.toDate); await applyCalendarProposalFromUI(value, click()); return value }
const withoutBindingPersonRef = (item: unknown, parent = ''): unknown => Array.isArray(item) ? item.map(row => withoutBindingPersonRef(row, parent)) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).filter(([key]) => parent !== 'bindings' || key !== 'personRef').map(([key, child]) => [key, withoutBindingPersonRef(child, key)])) : item
const snapshot = async () => ({ state: await db.calendarRules.toArray(), tasks: await db.tasks.toArray(), events: await db.calendarEvents.toArray(), assessments: await db.assessments.toArray(), completions: await db.completions.toArray(), ledger: await db.ledger.toArray(), audits: await db.audits.toArray(), commands: await db.commands.toArray(), settings: await db.settings.toArray() })

describe('CSV資料保存・別の共通生成確認', () => {
  it('source preview/saveで実体0、別native generationで夜勤1回だけ生成し再送で増えない', async () => {
    const before = await snapshot(), value = await prepare(); expect(await snapshot()).toEqual(before)
    await expect(applyCalendarCSVImportFromUI(value, value.digest, new Event('click'))).rejects.toThrow('本人')
    await applyCalendarCSVImportFromUI(value, value.digest, click()); expect(await db.tasks.count()).toBe(0); expect(await db.calendarEvents.count()).toBe(0); expect(await db.ledger.count()).toBe(0)
    const saved = await snapshot(); expect(await applyCalendarCSVImportFromUI(value, value.digest, click())).toBe(value.preview.sourceId); expect(await snapshot()).toEqual(saved)
    const generated = await generate(); expect(generated.plan.creates).toHaveLength(1); expect((await db.calendarEvents.toArray())[0]).toMatchObject({ startAt: '2026-10-02T13:00:00.000Z', endAt: '2026-10-02T21:00:00.000Z' }); expect(await db.tasks.count()).toBe(0)
    expect((await prepare()).configuration).toBeNull(); expect((await prepareCalendarGeneration(period.fromDate, period.toDate)).plan.creates).toHaveLength(0)
  })
  it('同じ勤務IDの日時変更は同じeventを更新し、明示取消だけがそのeventを取消す', async () => {
    await save(); await generate(); const initial = (await db.calendarEvents.toArray())[0]
    await save(raw(2, '2026-10-03')); const moved = await generate(); expect(moved.plan.updates).toHaveLength(1); expect((await db.calendarEvents.toArray())[0].id).toBe(initial.id)
    await save(raw(3, '2026-10-03', 'cancelled')); const canceled = await generate(); expect(canceled.plan.cancels).toHaveLength(1); expect(await db.calendarEvents.count()).toBe(0)
    const state = (await db.calendarRules.get('main'))!; expect(state.instances[0].generationKey).toBe(`calendar:activity:work:roster-csv:work:${state.sources[0].csv!.heads[0].recordId.slice(7, 47)}`); expect(state.facts.filter(row => row.validity === 'active')).toHaveLength(1)
  })
  it('営業日の更新は旧日付をwithdrawnへ、明示withdrawnは営業/休業を捏造せずheadのみ保存', async () => {
    await save(calendar(1), 'calendar'); const first = (await db.calendarRules.get('main'))!.facts[0]
    await save(calendar(2, '2026-10-03', 'open'), 'calendar'); let state = (await db.calendarRules.get('main'))!
    expect(state.facts.find(row => row.id === first.id)?.validity).toBe('withdrawn'); expect(state.sources[0].csv!.heads[0].factId).not.toBe(first.id)
    await save(calendar(3, '2026-10-03', 'withdrawn'), 'calendar'); state = (await db.calendarRules.get('main'))!
    expect(state.sources[0].csv!.heads[0]).toMatchObject({ status: 'withdrawn', factId: null }); expect(state.facts.every(row => row.validity === 'withdrawn')).toBe(true); await verifyCSVOriginalDigests([state])
  })
  it('会社休日も共通monthly営業日ルールに反映し、完了済みstepの旧実績を更新・取消しない', async () => {
    const state = (await db.calendarRules.get('main'))!; state.rules = [monthlyRule()]; await db.calendarRules.put(state)
    await save(calendar(1), 'calendar'); await generate(); const task = (await db.tasks.toArray())[0]; expect(task.scheduledDate).toBe('2026-10-05'); await completeTask(task.id, task.revision)
    const oldTask = await db.tasks.get(task.id), ledger = await db.ledger.toArray(), completions = await db.completions.toArray()
    await save(calendar(2, '2026-10-02', 'open'), 'calendar'); const changed = await generate(); expect(changed.plan.skippedCompleted).toBe(1); expect(await db.tasks.get(task.id)).toEqual(oldTask); expect(await db.ledger.toArray()).toEqual(ledger); expect(await db.completions.toArray()).toEqual(completions)
  })
  it.each(['header', 'draft', 'other', 'outside'] as const)('%s のファイルは既存源を置換せず取消0', async kind => {
    await save(); await generate(); const before = await snapshot()
    const text = kind === 'header' ? calendarCSVHeaders.roster.join(',') + '\n' : kind === 'draft' ? raw().replace(',true,', ',false,') : kind === 'other' ? raw().replace('staff-001', 'private-other-person') : raw().replaceAll('2026-10-02', '2026-09-02').replaceAll('2026-10-03', '2026-09-03')
    // The same version moved outside the period contradicts the stored record: refused, never treated as a cancellation.
    if (kind === 'outside') await expect(prepare(text)).rejects.toThrow('取込期間を広げて')
    else { const value = await prepare(text); expect(value.configuration).toBeNull(); expect(value.preview.selectedCount).toBe(0) }
    expect(await snapshot()).toEqual(before); expect((await prepareCalendarGeneration(period.fromDate, period.toDate)).plan.cancels).toHaveLength(0)
  })
  it('他人や下書きは保存quotes・audit・receiptへ入れずpersonRefの複製も監査しない', async () => {
    const value = await save(raw() + 'other,1,PRIVATE-OTHER,true,scheduled,,,,\ndraft,1,staff-001,false,scheduled,,,,\n'), state = (await db.calendarRules.get('main'))!
    expect(value.preview).toMatchObject({ selectedCount: 1, excludedDraft: 1, excludedOtherPerson: 1 }); expect(JSON.stringify(state)).not.toContain('PRIVATE-OTHER'); expect(JSON.stringify(state)).not.toContain('draft,1')
    // 本人が明示設定したbinding.personRefは設定値として残す。CSV側の本人列・引用原文・除外行だけを監査へ複製しない
    const audits = (await db.audits.toArray()).map(row => JSON.parse(row.detail)), configured = audits.find(row => row.after?.sources), csv = configured.after.sources[0].csv
    expect(state.bindings[0].personRef).toBe('staff-001'); expect(configured.after.bindings[0].personRef).toBe('staff-001'); expect(state.sources[0].csv!.snapshots[0].rows[0].quote).toContain('shift-stable')
    expect(csv.target.personRef).toBeNull(); expect(csv.snapshots).toEqual([expect.objectContaining({ rowCount: 1 })]); expect(csv.snapshots[0]).not.toHaveProperty('rows')
    expect(JSON.stringify(withoutBindingPersonRef(audits))).not.toContain('staff-001'); for (const text of ['shift-stable', 'PRIVATE-OTHER', 'draft,1']) expect(JSON.stringify(audits)).not.toContain(text)
    expect((await db.commands.toArray()).every(row => !row.hash.includes('staff-001'))).toBe(true); expect(state.facts[0].kind === 'roster_assignment' && state.facts[0].personRef).toMatch(/^sha256:/); await verifyCSVOriginalDigests([state])
  })
  it('同じ版の内容変更・旧版・既存feed対象変更は全変更なしで拒否', async () => {
    await save(raw(2)); const before = await snapshot()
    await expect(prepare(raw(2, '2026-10-03'))).rejects.toThrow('同じ版'); await expect(prepare(raw(1))).rejects.toThrow('古い版')
    const state = (await db.calendarRules.get('main'))!; state.activities.push({ ...state.activities[0], id: 'another' }); state.bindings[0].activityIds.push('another'); await db.calendarRules.put(state)
    await expect(prepare(raw(3), 'roster', { ...target(), activityId: 'another' })).rejects.toThrow('取込元の終了'); expect((await db.calendarRules.get('main'))!.sources).toEqual(before.state[0].sources)
  })
  it('通常曜日つき活動や未確認本人を自動修正してロスター活動にしない', async () => {
    const state = (await db.calendarRules.get('main'))!; state.activities[0].weekdays = [1]; await db.calendarRules.put(state); const before = await snapshot(); await expect(prepare()).rejects.toThrow('通常曜日'); expect(await snapshot()).toEqual(before)
    state.activities[0].weekdays = []; state.bindings[0].confirmed = false; await db.calendarRules.put(state); await expect(prepare()).rejects.toThrow('確認済み本人')
  })
})

describe('CSV承認の現在性と取り消し', () => {
  it('copiedJSON・digest差替え・target cancelはouter/innerとも保存しない', async () => {
    const value = await prepare(), before = await snapshot()
    await expect(applyCalendarCSVImportFromUI(structuredClone(value), value.digest, click())).rejects.toThrow('登録済み'); await expect(applyCalendarCSVImportFromUI(value, 'changed', click())).rejects.toThrow('登録済み')
    cancelCalendarCSVImport(value); await expect(applyCalendarCSVImportFromUI(value, value.digest, click())).rejects.toThrow('登録済み'); await expect(applyCalendarProposalFromUI(value.configuration!, click())).rejects.toThrow('登録済み'); expect(await snapshot()).toEqual(before)
  })
  it.each(['actual-config', 'binding', 'policy', 'clear'] as const)('%s 変更をsame revisionでも低層apply前に拒否する', async kind => {
    const value = await prepare(), state = (await db.calendarRules.get('main'))!, settings = (await db.settings.get('main'))!
    if (kind === 'actual-config') { state.rules = [monthlyRule()]; await db.calendarRules.put(state) }
    if (kind === 'binding') { state.bindings[0].personRef = 'changed-owner-ref'; await db.calendarRules.put(state) }
    if (kind === 'policy') await db.settings.put({ ...settings, changePolicy: { ...changePolicyFor(settings), sourcePermissionRevision: changePolicyFor(settings).sourcePermissionRevision + 1 } })
    if (kind === 'clear') clearCalendarCSVImportAuthority()
    const before = await snapshot(); await expect(applyCalendarProposalFromUI(value.configuration!, click())).rejects.toThrow(); expect(await snapshot()).toEqual(before)
  })
  it('末尾command失敗と途中cancelは全DB変更を戻し、失敗した承認の正常再試行は使える', async () => {
    const value = await prepare(), before = await snapshot(), failure = vi.spyOn(db.commands, 'add').mockRejectedValueOnce(new Error('末尾保存失敗'))
    await expect(applyCalendarCSVImportFromUI(value, value.digest, click())).rejects.toThrow('末尾保存失敗'); expect(await snapshot()).toEqual(before); failure.mockRestore()
    await applyCalendarCSVImportFromUI(value, value.digest, click()); expect((await db.calendarRules.get('main'))!.sources).toHaveLength(1)
    const later = await prepare(raw(2)), saved = await snapshot(), add = db.commands.add.bind(db.commands)
    vi.spyOn(db.commands, 'add').mockImplementationOnce((row, key) => add(row, key).then(result => { cancelCalendarCSVImport(later); return result }))
    await expect(applyCalendarCSVImportFromUI(later, later.digest, click())).rejects.toThrow('登録済み'); expect(await snapshot()).toEqual(saved)
  })
  it('通知などの無関係なSettings書込では、確認済みCSV案を失効させない', async () => {
    const value = await prepare(), settings = (await db.settings.get('main'))!
    await db.settings.put({ ...settings, lastBackupAt: '2026-10-01T01:00:00.000Z' })
    expect(await applyCalendarCSVImportFromUI(value, value.digest, click())).toBe(value.preview.sourceId); expect((await db.calendarRules.get('main'))!.sources).toHaveLength(1)
  })
  it('取込元の終了は本人のnative承認だけで保存し、既存予定を取消さず新しい取込元へ二重作成なしで移れる', async () => {
    await save(); await generate(); const event = (await db.calendarEvents.toArray())[0], sourceId = (await db.calendarRules.get('main'))!.sources[0].id
    await expect(prepare(raw(1), 'roster', { ...target(), feedId: 'replacement-feed' })).rejects.toThrow('取込元の終了')
    const retirement = await prepareCalendarCSVRetirement(sourceId, period.fromDate, period.toDate), before = await snapshot()
    await expect(applyCalendarProposalFromUI(retirement, new Event('click'))).rejects.toThrow('本人'); expect(await snapshot()).toEqual(before)
    await applyCalendarProposalFromUI(retirement, click())
    const retired = (await db.calendarRules.get('main'))!; expect(retired.sources[0].csv!.retiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); expect(retired.facts.filter(row => row.validity === 'active')).toHaveLength(1)
    expect((await prepareCalendarGeneration(period.fromDate, period.toDate)).plan).toMatchObject({ creates: [], cancels: [], conflicts: [] })
    await expect(prepareCalendarCSVRetirement(sourceId, period.fromDate, period.toDate)).rejects.toThrow('既に終了')
    const replacement = await prepare(raw(1), 'roster', { ...target(), feedId: 'replacement-feed' }); await applyCalendarCSVImportFromUI(replacement, replacement.digest, click())
    const moved = await prepareCalendarGeneration(period.fromDate, period.toDate); expect(moved.plan.creates).toHaveLength(0); expect(moved.plan.cancels).toHaveLength(0)
    await applyCalendarProposalFromUI(moved, click()); expect(await db.calendarEvents.toArray()).toEqual([expect.objectContaining({ id: event.id, startAt: event.startAt, endAt: event.endAt })])
  })
  it('終了時に原文の消去を選ぶと保持期限を待たずに原文とCSV本人識別子を消し、予定・台帳は残す', async () => {
    await save(); await generate(); const events = await db.calendarEvents.toArray(), sourceId = (await db.calendarRules.get('main'))!.sources[0].id
    await applyCalendarProposalFromUI(await prepareCalendarCSVRetirement(sourceId, period.fromDate, period.toDate, true), click())
    const state = (await db.calendarRules.get('main'))!, csv = state.sources[0].csv!
    expect(csv.snapshots.every(row => row.rows.every(item => item.quote === null))).toBe(true); expect(csv.target.personRef).toBeNull(); expect(csv.heads.every(head => head.status === 'expired')).toBe(true)
    expect(JSON.stringify(state.sources)).not.toContain('shift-stable'); expect(await db.calendarEvents.toArray()).toEqual(events); await verifyCSVOriginalDigests([state])
    expect((await prepareCalendarGeneration(period.fromDate, period.toDate)).plan).toMatchObject({ creates: [], cancels: [], conflicts: [] })
  })
  it('引用またはexpired元factの実値をhashと違う値へ改変してから新しいnative案にしない', async () => {
    await save(); const state = (await db.calendarRules.get('main'))!, source = state.sources[0]
    source.csv!.snapshots[0].rows[0].quote = null; source.csv!.heads[0].status = 'expired'; source.csv!.target.personRef = null; source.status = 'stale'; state.facts[0].validity = 'withdrawn'
    const changed = state.facts[0]; if (changed.kind === 'roster_assignment') changed.endAt = '2026-10-02T22:00:00.000Z'
    await db.calendarRules.put(state); const before = await snapshot(); await expect(prepare(raw(2))).rejects.toThrow('事実が一致'); expect(await snapshot()).toEqual(before)
  })
})
