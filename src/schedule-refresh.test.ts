import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { calendarFixture } from './calendar-test-fixtures'
import { prepareCalendarICSImport } from './calendar-import'
import { applyCalendarProposalFromUI, clearCalendarRulesAuthority, prepareCalendarGeneration } from './calendar-rules-save'
import { bindScheduleRefreshPreview, dismissScheduleRefresh, receiveScheduleRefresh, scheduleRefreshBytes, recordScheduleAcquisitionStatus } from './schedule-refresh'
import { captureSnapshot, restoreBackup } from './backup'
import type { ScheduleRefreshCandidate, ScheduleRefreshStatus } from './schedule-refresh-types'
const click = () => { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
const options = { fromDate: '2026-10-01', toDate: '2026-10-31' }
const target = { contextId: 'company', bindingId: 'self', calendarId: 'business', feedId: 'fixture-refresh', title: '合成予定資料', retentionUntil: '2030-01-01T00:00:00.000Z' }
const ics = (version: number) => `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:synthetic\nBEGIN:VEVENT\nUID:stable-event\nDTSTAMP:20261001T000000Z\nSEQUENCE:${version}\nDTSTART:20261003T010000Z\nDTEND:20261003T020000Z\nSUMMARY:Meeting ${version}\nEND:VEVENT\nEND:VCALENDAR\n`
let sourceId: string
async function candidate(version: number) {
  const settings = (await db.settings.get('main'))!; const bytes = new TextEncoder().encode(ics(version)), bodySha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return { ownerId: settings.profileId, datasetId: settings.datasetId, policyEpoch: settings.changePolicy?.epoch ?? 0, subscriptionId: 'b168ff49-e0f7-4398-81a9-96327092f79f', sourceId, format: 'ics', fetchedAt: `2026-10-02T0${version}:00:00.000Z`, bytes, bodySha256, qaFixture: true } satisfies ScheduleRefreshCandidate
}
beforeEach(async () => {
  vi.stubGlobal('window', {});clearCalendarRulesAuthority();await db.delete();await db.open();const settings = await ensureSettings(), state = calendarFixture()
  state.ownerId = settings.profileId;state.datasetId = settings.datasetId;state.bindings[0].personId = settings.profileId;state.activities = [];state.bindings[0].activityIds = [];state.sources = [];state.facts = [];await db.calendarRules.put(state)
  const first = await prepareCalendarICSImport(target, ics(1), options);sourceId = first.preview.sourceId;await applyCalendarProposalFromUI(first.proposal!, click());await applyCalendarProposalFromUI(await prepareCalendarGeneration(options.fromDate, options.toDate), click())
})
afterEach(() => vi.unstubAllGlobals())
describe('acquisition inbox and approvals', () => {
  it('does not change facts/events on acquisition; uses the common ICS preview and a trusted separate approval', async () => {
    const before = await db.calendarEvents.toArray(), input = await candidate(2), id = await receiveScheduleRefresh(input)
    expect(await db.calendarEvents.toArray()).toEqual(before)
    const prepared = await prepareCalendarICSImport(target, ics(2), options)
    await bindScheduleRefreshPreview(prepared.proposal!, id!, input.bodySha256)
    await expect(applyCalendarProposalFromUI(prepared.proposal!, new Event('click'))).rejects.toThrow('本人確認')
    await applyCalendarProposalFromUI(prepared.proposal!, click());expect((await db.scheduleRefreshInbox.get(id!))?.state).toBe('applied')
    expect(await db.calendarEvents.toArray()).toEqual(before)
    await applyCalendarProposalFromUI(await prepareCalendarGeneration(options.fromDate, options.toDate), click())
    const after = await db.calendarEvents.toArray();expect(after[0].id).toBe(before[0].id);expect(after[0].title).toBe('Meeting 2')
  })
  it('requires a trusted decline, clears volatile bytes, keeps facts/events and rejects expired authority', async () => {
    const input = await candidate(2), id = (await receiveScheduleRefresh(input))!, row = (await db.scheduleRefreshInbox.get(id))!
    const state = await db.calendarRules.get('main'), events = await db.calendarEvents.toArray()
    await expect(dismissScheduleRefresh(row, new Event('click'))).rejects.toThrow('本人確認')
    await dismissScheduleRefresh(row, click())
    expect((await db.scheduleRefreshInbox.get(id))?.state).toBe('dismissed')
    expect(await db.calendarRules.get('main')).toEqual(state);expect(await db.calendarEvents.toArray()).toEqual(events)
    await expect(scheduleRefreshBytes(row)).rejects.toThrow('再確認')
    expect(await receiveScheduleRefresh(input)).toBe(id)
    await expect(dismissScheduleRefresh(row, click())).rejects.toThrow('変更')
    const next = (await db.scheduleRefreshInbox.get((await receiveScheduleRefresh(await candidate(3)))!))!
    await db.datasetState.put({id:'main',mode:'frozen',moveId:'fixture',updatedAt:new Date().toISOString()})
    await expect(dismissScheduleRefresh(next, click())).rejects.toThrow()
    expect((await db.scheduleRefreshInbox.get(next.id))?.state).toBe('pending')
  })
  it('supersedes older pending bytes and invalidates their registered approval before any fact write', async () => {
    const second = await candidate(2), id = await receiveScheduleRefresh(second), prepared = await prepareCalendarICSImport(target, ics(2), options)
    await bindScheduleRefreshPreview(prepared.proposal!, id!, second.bodySha256)
    const facts = (await db.calendarRules.get('main'))!.facts
    const thirdId = await receiveScheduleRefresh(await candidate(3));expect(thirdId).not.toBe(id)
    expect((await db.scheduleRefreshInbox.get(id!))?.body).toBeNull()
    await expect(applyCalendarProposalFromUI(prepared.proposal!, click())).rejects.toThrow('失効')
    expect((await db.calendarRules.get('main'))!.facts).toEqual(facts)
    expect(await receiveScheduleRefresh(await candidate(3))).toBe(thirdId)
  })
  it('blocks stale cancellations, retains event IDs, and does not restore a pending approval', async () => {
    const input = await candidate(2), id = await receiveScheduleRefresh(input), prepared = await prepareCalendarICSImport(target, ics(2), options)
    await bindScheduleRefreshPreview(prepared.proposal!, id!, input.bodySha256)
    const snapshot = await captureSnapshot()
    expect(snapshot).not.toHaveProperty('scheduleRefreshInbox')
    await restoreBackup(snapshot)
    expect(await db.scheduleRefreshInbox.count()).toBe(0)
    await expect(applyCalendarProposalFromUI(prepared.proposal!, click())).rejects.toThrow('登録済み')
    const status = { id: input.subscriptionId, sourceId, format: 'ics', kind: 'url', displayName: 'http://127.0.0.1:1', refreshPolicy: 'daily', lastCheckedAt: input.fetchedAt, lastChangedAt: input.fetchedAt, nextDueAt: null, lastError: 'Failed', status: 'stale', bodySha256: input.bodySha256, qaFixture: true } satisfies ScheduleRefreshStatus
    await recordScheduleAcquisitionStatus([status]);const plan = await prepareCalendarGeneration(options.fromDate, options.toDate)
    expect(plan.plan.cancels).toEqual([]);expect(plan.plan.conflicts.length).toBeGreaterThan(0);expect(await db.calendarEvents.count()).toBe(1)
  })
  it('rejects altered hashes, frozen acquisition and authority changes', async () => {
    const input = await candidate(2);await expect(receiveScheduleRefresh({...input, bodySha256:'a'.repeat(64)})).rejects.toThrow('hash')
    const id = await receiveScheduleRefresh(input), prepared = await prepareCalendarICSImport(target, ics(2), options)
    await bindScheduleRefreshPreview(prepared.proposal!, id!, input.bodySha256)
    const row = await db.scheduleRefreshInbox.get(id!);await db.scheduleRefreshInbox.update(id!, {policyEpoch:row!.policyEpoch+1})
    await expect(applyCalendarProposalFromUI(prepared.proposal!, click())).rejects.toThrow('失効')
    await db.datasetState.put({id:'main',mode:'frozen',moveId:'fixture',updatedAt:new Date().toISOString()})
    expect(await receiveScheduleRefresh(await candidate(3))).toBeNull()
  })
})
