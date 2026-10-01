import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { db, ensureSettings } from './db'
import { deleteSource } from './source-library'
import { emptyCalendarRulesState } from './calendar-rules-validation'
import type { ScheduleSource } from './calendar-resolver'
import { calendarCoverage, conversationCoverage, mergeCoverage, providerCapabilities } from './coverage'
import { ConnectionStatusPanel } from './ConnectionStatusView'
import { importWorkSlack } from './source-quote-fixtures'

beforeEach(async () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T03:00:00.000Z')); await db.delete(); await db.open(); await ensureSettings() })
afterEach(() => { vi.useRealTimers() })

describe('K11 会話ごとの取得範囲とproviderの能力表示', () => {
  it('取込範囲の和集合と欠落を日単位で計算し、隣接した日はつなげる', () => {
    expect(mergeCoverage([{ fromDate: '2026-10-01', toDate: '2026-10-05' }, { fromDate: '2026-09-05', toDate: '2026-09-15' }, { fromDate: '2026-09-01', toDate: '2026-09-10' }, { fromDate: '2026-09-16', toDate: '2026-09-20' }])).toEqual({
      segments: [{ fromDate: '2026-09-01', toDate: '2026-09-20' }, { fromDate: '2026-10-01', toDate: '2026-10-05' }], gaps: [{ fromDate: '2026-09-21', toDate: '2026-09-30' }]
    })
    expect(mergeCoverage([])).toEqual({ segments: [], gaps: [] })
  })
  it('2回の手動取込で欠落を作ると会話ごとに欠落・方式・最終確認・保持期限を示し、削除・期限切れ・ローカル文書は数えない', async () => {
    const first = await importWorkSlack({ fromDate: '2026-09-01', toDate: '2026-09-10', retentionUntil: '2026-12-30T00:00:00.000Z' })
    vi.setSystemTime(new Date('2026-10-01T05:00:00.000Z'))
    await importWorkSlack({ fromDate: '2026-09-20', toDate: '2026-10-01', retentionUntil: null })
    const removed = await importWorkSlack({ conversation: '削除した会話', fromDate: '2026-08-01', toDate: '2026-08-31' })
    await deleteSource(removed, (await db.contextSources.get(removed))!.revision)
    await importWorkSlack({ conversation: '期限切れの会話', retentionUntil: '2026-10-01T06:00:00.000Z' })
    vi.setSystemTime(new Date('2026-10-01T07:00:00.000Z'))
    const owner = (await db.settings.get('main'))!.profileId, coverage = conversationCoverage(await db.contextSources.toArray(), owner)
    expect(coverage).toEqual([{ key: JSON.stringify(['slack', '仕事チャンネル']), kind: 'conversation', provider: 'slack', label: '仕事チャンネル', method: 'manual-import', sources: 2, segments: [{ fromDate: '2026-09-01', toDate: '2026-09-10' }, { fromDate: '2026-09-20', toDate: '2026-10-01' }], gaps: [{ fromDate: '2026-09-11', toDate: '2026-09-19' }], lastCheckedAt: '2026-10-01T05:00:00.000Z', earliestRetention: '2026-12-30T00:00:00.000Z', unlimitedRetention: 1, complete: false }])
    expect((await db.contextSources.get(first))!.coverage.complete).toBe(false)
    const markup = renderToStaticMarkup(<ConnectionStatusPanel coverage={coverage} capabilities={providerCapabilities(coverage)} />)
    expect(markup).toContain('欠落期間：2026-09-11〜2026-09-19'); expect(markup).toContain('新着同期: 未接続'); expect(markup).toContain('取得済み（和集合）：2026-09-01〜2026-09-10、2026-09-20〜2026-10-01')
    expect(markup).not.toContain('接続済み'); expect(markup).not.toContain('全履歴を取得済み')
  })
  it('単独版では外部providerの同期・送信・認証をすべて未対応と表示し、手動取込だけを利用可にする', () => {
    const state = emptyCalendarRulesState('owner', 'dataset')
    state.sources.push({ id: 'csv-source', contextId: 'context', title: '勤務表CSV', authorityScope: 'roster', coverageFrom: '2026-10-01', coverageTo: '2026-10-31', status: 'current', revision: 2, importedAt: '2026-10-01T00:00:00.000Z', bodyHash: 'b'.repeat(64), csv: { format: 'roster', feedId: 'feed', readOnly: true, retentionUntil: null, retiredAt: null, target: { bindingId: 'self', bindingRevision: 1, calendarId: 'calendar', activityId: 'work', timezone: 'Asia/Tokyo', personRef: null, personRefHash: null }, heads: [], snapshots: [{ revision: 1, fingerprint: 'f', bodyHash: 'b', importedAt: '2026-09-01T00:00:00.000Z', fromDate: '2026-09-01', toDate: '2026-09-30', retentionUntil: null, rows: [] }, { revision: 2, fingerprint: 'g', bodyHash: 'c', importedAt: '2026-10-01T00:00:00.000Z', fromDate: '2026-10-05', toDate: '2026-10-31', retentionUntil: null, rows: [] }] } } as ScheduleSource)
    const calendar = calendarCoverage(state)
    expect(calendar).toMatchObject([{ provider: 'calendar', method: 'csv-file', segments: [{ fromDate: '2026-09-01', toDate: '2026-09-30' }, { fromDate: '2026-10-05', toDate: '2026-10-31' }], gaps: [{ fromDate: '2026-10-01', toDate: '2026-10-04' }], lastCheckedAt: '2026-10-01T00:00:00.000Z' }])
    const capabilities = providerCapabilities(calendar)
    expect(capabilities.map(row => row.provider)).toEqual(['line', 'discord', 'slack', 'teams', 'other', 'calendar'])
    for (const row of capabilities) {
      expect(row.capabilities.manual_import.state).toBe('available')
      for (const key of ['history_backfill', 'incoming_events', 'edits', 'deletions', 'send', 'user_auth', 'policy_status'] as const) expect(row.capabilities[key].state, `${row.provider}:${key}`).toBe('unsupported')
      expect(row.capabilities.incoming_events.reason).toContain('unsupported_on_this_runtime')
    }
    expect(capabilities.find(row => row.provider === 'calendar')!.maxKnownCoverage).toEqual({ fromDate: '2026-09-01', toDate: '2026-10-31' })
  })
})
