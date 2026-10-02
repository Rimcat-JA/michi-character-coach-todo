import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { contentDigest } from './canonical'
import { calendarFixture } from './calendar-test-fixtures'
import { db, ensureSettings } from './db'
import { captureSnapshot, restoreBackup } from './backup'
import { parseCalendarCSVImport, prepareCSVConfiguration, prepareCalendarCSVImport, verifyCSVOriginalDigests, type CSVImportTarget } from './calendar-csv-import'
import { applyCalendarCSVImportFromUI, clearCalendarCSVImportAuthority } from './calendar-csv-import-save'
import { parseMappedCalendarCSV, readCSVRawRecords, validateCSVMappingProfile, type CSVMappingProfile } from './calendar-csv-mapping'
import { buildCalendarChangePlan, type CalendarRulesState } from './calendar-resolver'
import { redactExpiredCSVRecords } from './calendar-csv-redaction'
import { tableCSVBytes, tableEvidence, type ScheduleDocumentExtraction } from './calendar-document-import'
const extractScheduleDocument: (input: { name: string; bytes: Uint8Array; yTolerance: number; xGap: number }) => Promise<ScheduleDocumentExtraction> = createRequire(import.meta.url)('../electron/document-extract.cjs').extractScheduleDocument

const enc = (text: string) => new TextEncoder().encode(text)
const headers = ['勤務ID', '版', '氏名', '公開', '状態', '勤務日', '開始', '終了', '注記']
const fields = ['shift_id', 'record_revision', 'person_ref', 'published', 'status', 'start_date', 'start_time', 'end_time']
export const mappedRosterProfile = (): CSVMappingProfile => ({ version: 1, name: '本人が確認した勤務表', revision: 1, kind: 'roster', encoding: 'utf-8', delimiter: ',', headerRow: 1, dataStartRow: 2, columns: Object.fromEntries(fields.map((field, index) => [field, { index, headerText: headers[index] }])), dateFormat: 'YYYY/M/D', explicitYear: null, timeFormat: 'HH:MM', endDayRule: 'next_day_when_end<=start', statusMap: { 勤務: 'scheduled', 取消: 'cancelled' }, publishedMap: { 公表: true, 下書き: false }, recordIdStrategy: 'column', revisionStrategy: 'column' })
const options = { kind: 'roster' as const, timezone: 'Asia/Tokyo', personRef: 'staff-001', fromDate: '2026-10-01', toDate: '2026-10-31' }
const text = (date = '2026/10/3', revision = 1, status = '勤務') => headers.join(',') + `\nnight,${revision},staff-001,公表,${status},${date},22:00,06:00,本人の夜勤\n`
const parse = async (input = enc(text()), profile = mappedRosterProfile(), sequence = 1) => parseMappedCalendarCSV(input, options, { profile, digest: await contentDigest(profile), sequence })
const target: CSVImportTarget = { kind: 'roster', contextId: 'company', bindingId: 'self', calendarId: 'business', activityId: 'work', feedId: 'mapped', title: '公表済み本人勤務表', retentionUntil: '2027-01-01T00:00:00.000Z' }
function fixture() { const state = calendarFixture(); state.activities[0].weekdays = []; state.sources = []; state.facts = []; return state }
async function ingest(state: CalendarRulesState, input = enc(text()), profile = mappedRosterProfile()) { const result = await prepareCSVConfiguration(state, target, await parse(input, profile)); return { ...state, ...result.next, revision: state.revision + 1 } }
const click = () => { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-02T00:00:00.000Z') })
afterEach(() => { vi.useRealTimers(); clearCalendarCSVImportAuthority() })

describe('原本bytesと任意列の対応', () => {
  it('SJISの本人公開行だけを固定CSVと同じ日時へ変換し原bytes・位置を検証する', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('../docs/examples/roster-sjis-mapped.csv', import.meta.url))), profile = { ...mappedRosterProfile(), encoding: 'shift_jis' as const }, parsed = await parse(bytes, profile)
    const fixed = await parseCalendarCSVImport(enc('shift_id,record_revision,person_ref,published,status,start_date,start_time,end_date,end_time\nnight,1,staff-001,true,scheduled,2026-10-03,22:00,2026-10-04,06:00\n'), options)
    expect(parsed.rows[0].startAt).toBe(fixed.rows[0].startAt); expect(parsed.rows[0].endAt).toBe(fixed.rows[0].endAt)
    const row = parsed.rows[0]; expect(new TextDecoder('shift_jis', { fatal: true }).decode(bytes.slice(row.byteStart, row.byteEnd))).toBe(row.quote)
    expect(row.byteEnd - row.byteStart).not.toBe(enc(row.quote).length); expect(parsed).toMatchObject({ excludedOtherPerson: 1, excludedDraft: 1 }); expect(JSON.stringify(parsed)).not.toMatch(/他人の秘密|未公表の秘密|other-person/)
    await verifyCSVOriginalDigests([await ingest(fixture(), bytes, profile)])
  })
  it('TSV・セミコロン・引用改行のraw範囲を維持する', async () => {
    for (const delimiter of ['\t', ';'] as const) { const profile = { ...mappedRosterProfile(), delimiter }, input = enc(text().replaceAll(',', delimiter)); expect((await parse(input, profile)).rows[0].startDate).toBe('2026-10-03') }
    const records = readCSVRawRecords(enc('a,b\r\n"日本語\r\n続き",x\r\n'), 'utf-8', ','); expect(records[1]).toMatchObject({ lineStart: 2, lineEnd: 3, cells: ['日本語\r\n続き', 'x'] })
  })
  it('日本語日付と本人指定の年を使い、年なしを推測しない', async () => {
    expect((await parse(enc(text('2026年10月3日')), { ...mappedRosterProfile(), dateFormat: 'YYYY年M月D日' })).rows[0].startDate).toBe('2026-10-03')
    const profile = { ...mappedRosterProfile(), dateFormat: 'M/D' as const }; await expect(parse(enc(text('10/3')), profile)).rejects.toThrow('年')
    expect((await parse(enc(text('10/3')), { ...profile, explicitYear: 2026 })).rows[0].startDate).toBe('2026-10-03')
  })
  it('翌日規則なし・未知の状態・改名した見出し・壊れたSJISを拒否する', async () => {
    await expect(parse(enc(text()), { ...mappedRosterProfile(), endDayRule: 'explicit_end_date' })).rejects.toThrow('列')
    await expect(parse(enc(text(undefined, 1, '保留')))).rejects.toThrow('保留')
    await expect(parse(enc(text().replace('勤務日', '変更した見出し')))).rejects.toThrow('一致')
    expect(() => readCSVRawRecords(new Uint8Array([0x82]), 'shift_jis', ',')).toThrow('読めません')
  })
  it('選択行・設定・rawbytesの改変をバックアップ根拠検証で拒否する', async () => {
    const state = await ingest(fixture()); await verifyCSVOriginalDigests([state])
    const profile = structuredClone(state); profile.sources[0].csv!.snapshots[0].mapping!.profile.statusMap.勤務 = 'cancelled'; await expect(verifyCSVOriginalDigests([profile])).rejects.toThrow('hash')
    const raw = structuredClone(state); raw.sources[0].csv!.snapshots[0].rows[0].mapped!.rawBase64 = btoa('altered'); await expect(verifyCSVOriginalDigests([raw])).rejects.toThrow()
    const value = structuredClone(state); value.sources[0].csv!.snapshots[0].rows[0].mapped!.normalizedQuote += '\nother,1'; await expect(verifyCSVOriginalDigests([value])).rejects.toThrow()
  })
  it('IDを日付から作る方式で日付移動を新記録・旧記録保持・取消0とする', async () => {
    const profile = { ...mappedRosterProfile(), recordIdStrategy: 'derived' as const }, first = await ingest(fixture(), enc(text()), profile), second = await ingest(first, enc(text('2026/10/4', 2)), profile)
    expect(second.sources[0].csv!.heads).toHaveLength(2); expect(second.sources[0].csv!.identityReview).toBe(true)
    const plan = buildCalendarChangePlan(second, [], '2026-10-01', '2026-10-31'); expect(plan.cancels).toEqual([]); expect(plan.conflicts.length).toBeGreaterThan(0)
  })
  it('期限にrawbytesと正規化原文も消去し、古いバックアップから復活させない', async () => {
    const state = await ingest(fixture()); const result = redactExpiredCSVRecords({ calendarRules: [state], calendarEvents: [], audits: [] }, '2027-01-02T00:00:00.000Z').calendarRules[0]
    expect(result.sources[0].csv!.snapshots[0].rows[0]).toMatchObject({ quote: null, mapped: { rawBase64: '', normalizedQuote: '' } }); await verifyCSVOriginalDigests([result])
  })
  it('設定の未知キー・非boolean・巨大位置・不正な語彙を拒否する', () => {
    for (const patch of [{ unexpected: true }, { publishedMap: { 公表: 'yes' } }, { columns: { status: { index: 100, headerText: '状態' } } }, { statusMap: { 勤務: 'unknown' } }]) expect(() => validateCSVMappingProfile({ ...mappedRosterProfile(), ...patch })).toThrow()
  })
})

describe('列対応の保存承認・版と復元', () => {
  beforeEach(async () => { await db.delete(); await db.open(); const settings = await ensureSettings(), state = fixture(); state.ownerId = settings.profileId; state.datasetId = settings.datasetId; state.bindings[0].personId = settings.profileId; await db.calendarRules.put(state) })
  const save = async (input: Uint8Array, profile: CSVMappingProfile, extras = {}) => { const prepared = await prepareCalendarCSVImport(target, input, { fromDate: options.fromDate, toDate: options.toDate, mappingProfile: profile, ...extras }); await applyCalendarCSVImportFromUI(prepared, prepared.digest, click()); return prepared }
  it('取込順には本人確認が必要で、過去fingerprintと未確認の列変更を拒否する', async () => {
    const profile = { ...mappedRosterProfile(), revisionStrategy: 'import_order' as const }
    await expect(save(enc(text()), profile)).rejects.toThrow('新しい'); await save(enc(text()), profile, { newerFileConfirmed: true })
    await save(enc(text('2026/10/4')), profile, { newerFileConfirmed: true }); await expect(save(enc(text()), profile, { newerFileConfirmed: true })).rejects.toThrow('古い')
    const changed = { ...profile, revision: 2, name: '列変更' }; await expect(save(enc(text('2026/10/4')), changed)).rejects.toThrow('明示確認')
    await save(enc(text('2026/10/4')), changed, { profileChangeConfirmed: true })
    expect((await db.calendarRules.get('main'))!.sources[0].csv!.mapping!.profile.name).toBe('列変更')
  })
  it('ID/版方式の変更は拒否し、backup/restoreで設定と根拠を保持する', async () => {
    await save(enc(text()), mappedRosterProfile())
    await expect(save(enc(text()), { ...mappedRosterProfile(), revision: 2, recordIdStrategy: 'derived' }, { profileChangeConfirmed: true })).rejects.toThrow('方式変更')
    const snapshot = await captureSnapshot(); await restoreBackup(snapshot); const state = (await db.calendarRules.get('main'))!
    expect(state.sources[0].csv!.mapping!.profile).toEqual(mappedRosterProfile()); await verifyCSVOriginalDigests([state])
  })
  it.each(['pdf', 'xlsx'])('文書%sは同じ本人勤務を作り、ページ/セルを根拠hashへ束縛する', async extension => {
    const filename = extension === 'pdf' ? 'roster-pdf-table.pdf' : 'roster-xlsx-table.xlsx', extraction = await extractScheduleDocument({ name: filename, bytes: new Uint8Array(readFileSync(new URL('../docs/examples/' + filename, import.meta.url))), yTolerance: 2, xGap: 12 }), table = extraction.tables[0]
    const profile = { ...mappedRosterProfile(), columns: Object.fromEntries(table.rows[0].cells.map((field, index) => [field, { index, headerText: field }])), dateFormat: 'YYYY-MM-DD' as const, statusMap: { scheduled: 'scheduled', cancelled: 'cancelled' }, publishedMap: { true: true, false: false }, endDayRule: 'explicit_end_date' as const }
    const prepared = await prepareCalendarCSVImport(target, tableCSVBytes(table), { fromDate: options.fromDate, toDate: options.toDate, mappingProfile: profile, documentEvidence: tableEvidence(extraction, table) })
    expect(prepared.preview.selectedCount).toBe(1); expect(prepared.preview.parsed.rows[0]).toMatchObject({ startAt: '2026-10-03T13:00:00.000Z', endAt: '2026-10-03T21:00:00.000Z' }); expect(prepared.preview.parsed.rows[0].mapped!.document!.cells[0]).toHaveProperty(extension === 'pdf' ? 'page' : 'address')
    await applyCalendarCSVImportFromUI(prepared, prepared.digest, click()); const state = (await db.calendarRules.get('main'))!; await verifyCSVOriginalDigests([state])
    expect(JSON.stringify(state.sources[0].csv)).not.toContain('staff-002'); const changed = structuredClone(state); changed.sources[0].csv!.snapshots[0].rows[0].mapped!.document!.table = '改変'; await expect(verifyCSVOriginalDigests([changed])).rejects.toThrow('出典位置')
  })
  it('凍結中は資料の解析準備を始めない', async () => {
    await db.datasetState.put({ id: 'main', mode: 'frozen', moveId: 'qa', updatedAt: new Date().toISOString() })
    await expect(save(enc(text()), mappedRosterProfile())).rejects.toThrow('再解析を停止')
  })
})
