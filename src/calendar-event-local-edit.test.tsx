import 'fake-indexeddb/auto'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { db, ensureSettings } from './db'
import { calendarFixture } from './calendar-test-fixtures'
import { prepareCalendarICSImport } from './calendar-import'
import { applyCalendarProposalFromUI, prepareCalendarGeneration, prepareCalendarSourceAcceptance, clearCalendarRulesAuthority } from './calendar-rules-save'
import { updateCalendarEventLocally } from './calendar-event-local-edit'
import { eventOrigin, localCalendarEditNotice, readOnlyCalendarForbiddenClaims } from './calendar-event-origin'
import CalendarEventEditor from './CalendarEventEditor'
import { captureSnapshot, restoreBackup } from './backup'
const click = () => { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
const from = '2026-10-01', to = '2026-10-31'
const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic//EN\r\nBEGIN:VEVENT\r\nUID:local-only\r\nDTSTAMP:20261001T000000Z\r\nSEQUENCE:1\r\nDTSTART:20261003T010000Z\r\nDTEND:20261003T020000Z\r\nSUMMARY:Synthetic meeting\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
beforeEach(async () => {
  clearCalendarRulesAuthority(); await db.delete(); await db.open(); const settings = await ensureSettings(), state = calendarFixture(); state.ownerId = settings.profileId; state.datasetId = settings.datasetId; state.bindings[0].personId = settings.profileId; state.sources = []; state.facts = []; state.activities = []; state.bindings[0].activityIds = []; await db.calendarRules.put(state)
  const prepared = await prepareCalendarICSImport({ contextId: 'company', bindingId: 'self', calendarId: 'business', feedId: 'synthetic-ics', title: '合成ICS読取専用', retentionUntil: '2030-01-01T00:00:00.000Z' }, ics, { fromDate: from, toDate: to })
  await applyCalendarProposalFromUI(prepared.proposal!, click()); await applyCalendarProposalFromUI(await prepareCalendarGeneration(from, to), click())
})
afterEach(() => { vi.restoreAllMocks(); clearCalendarRulesAuthority() })
const first = async () => (await db.calendarEvents.toArray())[0]
const changed = async () => { const event = await first(); await updateCalendarEventLocally(event.id, event.revision ?? 1, { title: '本人の予定名', startAt: '2026-10-03T02:00:00.000Z', endAt: '2026-10-03T03:00:00.000Z' }, click()); return first() }
it('ICS予定のローカル編集はrevision/auditを保存し、通信とbridgeを0回に保つ', async () => {
  const fetch = vi.fn(() => { throw new Error('must not fetch') }); vi.stubGlobal('fetch', fetch)
  const event = await changed(), audit = (await db.audits.toArray()).find(row => row.operation === 'calendar.event.local_edit')!
  expect(event).toMatchObject({ revision: 2, locallyEdited: true, title: '本人の予定名' }); expect(JSON.parse(audit.detail)).toMatchObject({ externalWrite: false, origin: { provider: 'ics_file' } }); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals()
})
it('同じICSの再照合でも本人編集を確認待ちにし、承認前の資料採用は無変更', async () => {
  const event = await changed(), generation = await prepareCalendarGeneration(from, to)
  expect(generation.plan.conflicts.some(row => row.reason.includes('本人編集'))).toBe(true)
  await expect(applyCalendarProposalFromUI(generation, click())).rejects.toThrow('個別')
  const state = (await db.calendarRules.get('main'))!, proposal = await prepareCalendarSourceAcceptance(state.instances[0].generationKey, from, to)
  expect((await first()).title).toBe(event.title); expect(proposal.plan.updates).toHaveLength(1)
  await applyCalendarProposalFromUI(proposal, click()); expect(await first()).toMatchObject({ title: 'Synthetic meeting', startAt: '2026-10-03T01:00:00.000Z', revision: 3, locallyEdited: false })
})
it('資料採用案の後に本人が編集した場合・合成クリックは採用しない', async () => {
  await changed(); const state = (await db.calendarRules.get('main'))!, proposal = await prepareCalendarSourceAcceptance(state.instances[0].generationKey, from, to), event = await first()
  await updateCalendarEventLocally(event.id, event.revision!, { title: 'さらに本人変更', startAt: event.startAt, endAt: event.endAt }, click())
  await expect(applyCalendarProposalFromUI(proposal, click())).rejects.toThrow(); expect((await first()).title).toBe('さらに本人変更')
  await expect(updateCalendarEventLocally(event.id, 3, { title: '偽変更', startAt: event.startAt, endAt: event.endAt }, new Event('click'))).rejects.toThrow('本人確認')
})
it('古い版・不正日時・凍結を拒否し、既存予定を保持する', async () => {
  const event = await first(); await expect(updateCalendarEventLocally(event.id, 8, { title: '古い版', startAt: event.startAt, endAt: event.endAt }, click())).rejects.toThrow('版')
  await expect(updateCalendarEventLocally(event.id, 1, { title: '逆', startAt: event.endAt, endAt: event.startAt }, click())).rejects.toThrow('順序')
  await db.datasetState.put({ id: 'main', mode: 'frozen', moveId: 'qa', updatedAt: new Date().toISOString() }); await expect(changed()).rejects.toThrow('凍結'); expect((await first()).title).toBe(event.title)
})
it('復元が版と外部未反映を保ち、出典・読取・書込を別表示する', async () => {
  await changed(); const snapshot = await captureSnapshot(); await restoreBackup(snapshot); const event = await first(), state = (await db.calendarRules.get('main'))!
  expect(event).toMatchObject({ revision: 2, locallyEdited: true }); expect(eventOrigin(event, state)).toMatchObject({ provider: 'ics_file', kind: 'imported', write: { status: 'unsupported' } })
  const html = renderToStaticMarkup(<CalendarEventEditor event={event} state={state} run={async () => true} />)
  expect(html).toContain('本人変更・外部未反映'); expect(html).toContain('読取：'); expect(html).toContain('書込：'); expect(html).toContain('disabled'); readOnlyCalendarForbiddenClaims.forEach(text => expect(html).not.toContain(text)); expect(localCalendarEditNotice).toBe('この端末の予定だけ変更しました（元のICSは変更されていません）')
})

it('この回の資料採用は別feedの取得失敗に妨げられず、対象feedの失敗は拒否する', async () => {
  const target = (await db.calendarRules.get('main'))!.instances[0]
  const other = await prepareCalendarICSImport({ contextId: 'company', bindingId: 'self', calendarId: 'business', feedId: 'other-feed', title: '別の取得元', retentionUntil: '2030-01-01T00:00:00.000Z' }, ics.replace('local-only', 'other-event'), { fromDate: from, toDate: to })
  await applyCalendarProposalFromUI(other.proposal!, click());await applyCalendarProposalFromUI(await prepareCalendarGeneration(from,to),click())
  const before = (await db.calendarEvents.toArray()).find(row=>row.id!==target.entityId)!
  const state = (await db.calendarRules.get('main'))!;state.sources.find(row=>row.id===other.preview.sourceId)!.status='stale';state.revision++;await db.calendarRules.put(state)
  const event = (await db.calendarEvents.get(target.entityId))!;await updateCalendarEventLocally(event.id,event.revision!,{title:'本人変更',startAt:event.startAt,endAt:event.endAt},click())
  const proposal = await prepareCalendarSourceAcceptance(target.generationKey,from,to)
  expect(proposal.plan.conflicts).toEqual([])
  await applyCalendarProposalFromUI(proposal,click());expect(await db.calendarEvents.get(before.id)).toEqual(before)
  const stale = (await db.calendarRules.get('main'))!;stale.sources.find(row=>row.id!==other.preview.sourceId)!.status='stale';stale.revision++;await db.calendarRules.put(stale)
  const blocked = await prepareCalendarSourceAcceptance(target.generationKey,from,to);expect(blocked.plan.conflicts.length).toBeGreaterThan(0)
  await expect(applyCalendarProposalFromUI(blocked,click())).rejects.toThrow('個別')
})
