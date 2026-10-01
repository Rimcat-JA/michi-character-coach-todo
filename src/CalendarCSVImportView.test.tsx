import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Settings } from './domain'
import { emptyCalendarRulesState } from './calendar-rules-validation'
import CalendarCSVImportView, { CalendarCSVPreview } from './CalendarCSVImportView'

type Prepared = Parameters<typeof CalendarCSVPreview>[0]['prepared']
type Selection = Parameters<typeof CalendarCSVPreview>[0]['selection']
const selection: Selection = { kind: 'calendar', contextName: '本人の職場', bindingId: 'self', personRef: null, calendarName: '会社の営業日', activityName: null, timezone: 'Asia/Tokyo', feedId: 'fixed-calendar', title: '営業日原本', fromDate: '2026-10-01', toDate: '2026-10-31', retentionUntil: '2030-10-01T03:00:00.000Z' }
const prepared = (): Prepared => ({
  id: 'proposal', digest: 'd'.repeat(64), configuration: null,
  target: { kind: 'calendar', contextId: 'context', bindingId: 'self', calendarId: 'calendar', activityId: null, feedId: 'fixed-calendar', title: '営業日原本', retentionUntil: selection.retentionUntil }, ownerId: 'owner', datasetId: 'dataset', policyEpoch: 1, sourcePermissionRevision: 1, baseDigest: 'a'.repeat(64), referencesDigest: 'r'.repeat(64), createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-02T00:00:00.000Z',
  preview: { sourceId: 'source', noOp: false, retentionShortened: null, added: 1, updated: 0, canceled: 0, unchanged: 0, excludedDraft: 2, excludedOtherPerson: 3, excludedOutsidePeriod: 1, selectedCount: 1, warnings: [], changes: [],
    parsed: { kind: 'calendar', fileSha256: 'f'.repeat(64), bodyHash: 'b'.repeat(64), normalizedBody: 'Other-person-private-raw-sentinel', outsidePeriodRecords: [], fromDate: '2026-10-01', toDate: '2026-10-31', excludedDraft: 2, excludedOtherPerson: 3, excludedOutsidePeriod: 1, warnings: [],
      rows: [{ kind: 'calendar', externalId: 'own-day', recordId: 'record', revision: 2, status: 'closed', date: '2026-10-05', personRef: null, startDate: null, startTime: null, endDate: null, endTime: null, startAt: null, endAt: null, digest: 'a'.repeat(64), quote: 'own-day,2,2026-10-05,closed', quoteHash: 'q'.repeat(64), recordNumber: 2, lineStart: 2, lineEnd: 2, byteStart: 38, byteEnd: 69 }],
    },
  },
})
const settings: Settings = { id: 'main', profileId: 'owner', datasetId: 'dataset', createdAt: '2026-10-01T00:00:00.000Z', coachName: 'コーチ', dailyMinutes: 480, dailyPoints: 100, notifications: false, aiEnabled: false, automation: 'A0', lastBackupAt: null }

describe('営業日・勤務表CSV画面', () => {
  it('先頭の対象やカレンダーを自動選択せず、全選択と本人入力を空欄から開始する', () => {
    const state = emptyCalendarRulesState('owner', 'dataset')
    state.contexts.push({ id: 'context', name: '先頭の職場', domain: 'work', timezone: 'Asia/Tokyo', validFrom: '2026-10-01', validTo: '2026-10-31', revision: 1 })
    state.bindings.push({ id: 'self', contextId: 'context', personId: 'owner', personRef: 'owner-ref', activityIds: [], weekdays: [], validFrom: '2026-10-01', validTo: '2026-10-31', confirmed: true, revision: 1 })
    state.calendars.push({ id: 'calendar', contextId: 'context', name: '先頭の暦', weekdays: [1, 2, 3, 4, 5], validFrom: '2026-10-01', validTo: '2026-10-31', revision: 1 })
    const html = renderToStaticMarkup(<CalendarCSVImportView state={state} settings={settings} />)
    expect((html.match(/<option value="" selected="">選んでください<\/option>/g) ?? [])).toHaveLength(7)
    expect(html).toMatch(/aria-label="CSV資料名"[^>]*value=""/)
    expect(html).toMatch(/aria-label="CSV取込開始"[^>]*value=""/)
    expect(html).toMatch(/aria-label="CSV原文保持期限"[^>]*value=""/)
    expect(html).not.toContain('確認したCSV資料を保存')
    expect(html).toContain('外部AIへ送信しません')
  })
  it('終了済みの取込元は終了・更新の候補に出さず、終了の影響と保持する記録を説明する', () => {
    const state = emptyCalendarRulesState('owner', 'dataset')
    const csv = (retiredAt: string | null) => ({ format: 'roster' as const, feedId: 'feed', readOnly: true as const, retentionUntil: null, retiredAt, target: { bindingId: 'self', bindingRevision: 1, calendarId: 'calendar', activityId: 'work', timezone: 'Asia/Tokyo', personRef: 'owner-ref', personRefHash: `sha256:${'a'.repeat(64)}` }, heads: [], snapshots: [] })
    const base = { contextId: 'context', authorityScope: 'roster' as const, coverageFrom: '2026-10-01', coverageTo: '2026-10-31', status: 'current' as const, revision: 1, importedAt: '2026-10-01T00:00:00.000Z', bodyHash: 'b'.repeat(64) }
    state.sources.push({ ...base, id: 'live', title: '現在の勤務表', csv: csv(null) }, { ...base, id: 'old', title: '終了した勤務表', csv: csv('2026-10-01T00:00:00.000Z') })
    const html = renderToStaticMarkup(<CalendarCSVImportView state={state} settings={settings} />)
    expect(html).toContain('<option value="live">現在の勤務表 / 勤務表 / 取込元ID feed / v1 / 最終取込 2026-10-01 / 取込済み</option>'); expect(html).not.toContain('終了した勤務表')
    expect(html).toContain('反映済みの予定・完了・台帳は残し、勤務の取消とは扱いません')
    expect(html).toMatch(/<p role="status" aria-live="polite" class="csv-notice"><\/p>/)
  })
  it('固定header・夜勤の終了日明示・公開済み本人行の条件を説明する', () => {
    const html = renderToStaticMarkup(<CalendarCSVImportView state={emptyCalendarRulesState('owner', 'dataset')} settings={settings} />)
    expect(html).toContain('record_id,record_revision,date,status')
    expect(html).toContain('shift_id,record_revision,person_ref,published,status,start_date,start_time,end_date,end_time')
    expect(html).toContain('夜勤は終了日を明示')
    expect(html).toContain('本人に一致する公開済みの行だけ')
  })
  it('他者・下書き・期間外は件数だけ表示し、normalizedBodyや全原本を表示しない', () => {
    const html = renderToStaticMarkup(<CalendarCSVPreview prepared={prepared()} selection={selection} />)
    expect(html).toContain('選択 1行 / 除外：下書き 2・他者 3・期間外 1行')
    expect(html).not.toContain('Other-person-private-raw-sentinel')
    expect(html).toContain('元ファイル全体は保存しません')
  })
  it('fingerprint・選択原文・版・行位置・byte位置・保持期限を示す', () => {
    const html = renderToStaticMarkup(<CalendarCSVPreview prepared={prepared()} selection={selection} />)
    expect(html).toContain('f'.repeat(64))
    expect(html).toContain('q'.repeat(64))
    expect(html).toContain('own-day / 記録の版 2 / closed')
    expect(html).toContain('レコード 2 / 原文 2〜2行 / バイト 38〜69')
    expect(html).toContain('<pre>own-day,2,2026-10-05,closed</pre>')
    expect(html).toContain('UTC：2030-10-01T03:00:00.000Z')
    expect(html).toContain('新しいファイルにない記録は取消と判断しません')
    expect(html).toContain('別の承認で予定へ反映')
  })
  it('勤務表の本人識別子と明示終了日による日跨ぎを表示する', () => {
    const value = prepared(); value.preview.parsed.kind = 'roster'; const row = value.preview.parsed.rows[0]
    Object.assign(row, { kind: 'roster', status: 'scheduled', date: null, personRef: 'owner-ref', startAt: '2026-10-05T13:00:00.000Z', endAt: '2026-10-05T22:00:00.000Z', startDate: '2026-10-05', startTime: '22:00', endDate: '2026-10-06', endTime: '07:00', quote: 'night,1,owner-ref,true,scheduled,2026-10-05,22:00,2026-10-06,07:00' })
    const html = renderToStaticMarkup(<CalendarCSVPreview prepared={value} selection={{ ...selection, kind: 'roster', personRef: 'owner-ref', activityName: '本人の夜勤' }} />)
    expect(html).toContain('本人識別子：owner-ref')
    expect(html).toContain('2026/10/5 22:00:00')
    expect(html).toContain('2026/10/6 7:00:00')
    expect(html).toContain('本人の夜勤')
  })
  it('移動前後・明示取り下げを説明し、原文内HTMLは実行しない', () => {
    const value = prepared()
    const before = { id: 'fact', sourceId: 'source', contextId: 'context', revision: 1, validity: 'active' as const, supersedes: [], kind: 'closed' as const, calendarId: 'calendar', date: '2026-10-01' }
    value.preview.changes = [{ recordId: 'record', status: 'updated', before, after: { ...before, revision: 2, kind: 'open', date: '2026-10-05' } }, { recordId: 'withdrawn', status: 'withdrawn', before, after: null }]
    value.preview.parsed.rows[0].quote = '<script>raw</script>'
    const html = renderToStaticMarkup(<CalendarCSVPreview prepared={value} selection={selection} />)
    expect(html).toContain('2026-10-01 休業日 → 2026-10-05 営業日')
    expect(html).toContain('2026-10-01 休業日 → 事実なし／明示取り下げ')
    expect(html).toContain('&lt;script&gt;raw&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })
  it('選択なしや同じ原本では保存できる確認案がないことを表示する', () => {
    const value = prepared(); value.preview.parsed.rows = []; value.preview.selectedCount = 0
    expect(renderToStaticMarkup(<CalendarCSVPreview prepared={value} selection={selection} />)).toContain('保存できる選択行がありません')
    value.preview.noOp = true
    const empty = renderToStaticMarkup(<CalendarCSVPreview prepared={value} selection={selection} />)
    expect(empty).toContain('保存できる選択行がありません')
    expect(empty).not.toContain('同じ原本')
    value.preview.selectedCount = 1
    const html = renderToStaticMarkup(<CalendarCSVPreview prepared={value} selection={selection} />)
    expect(html).toContain('再保存する必要はありません')
    expect(html).not.toContain('確認したCSV資料を保存')
  })
  it('有効な資料の矛盾は根拠保存と発生回反映の確認待ちを分けて説明する', () => {
    const value = prepared(), state = emptyCalendarRulesState('owner', 'dataset')
    const { contexts, bindings, calendars, activities, sources, facts, rules } = state
    const configuration: NonNullable<Prepared['configuration']> = { id: 'cfg', ownerId: value.ownerId, datasetId: value.datasetId, policyEpoch: 1, sourcePermissionRevision: 1, stateRevision: 1, createdAt: value.createdAt, expiresAt: value.expiresAt, digest: value.digest, kind: 'configuration', next: { contexts, bindings, calendars, activities, sources, facts, rules }, preview: [], conflicts: [{ key: 'conflict', contextId: 'context', reason: '営業日と休業日の根拠が矛盾しています', sourceRefs: [] }], importPreview: null }
    const html = renderToStaticMarkup(<CalendarCSVPreview prepared={{ ...value, configuration }} selection={selection} />)
    expect(html).toContain('発生回への反映は確認待ち：営業日と休業日の根拠が矛盾しています')
    expect(html).toContain('資料の根拠は保存できます')
    expect(html).toContain('この矛盾が残る系列のタスク・予定は反映しません')
  })
})
