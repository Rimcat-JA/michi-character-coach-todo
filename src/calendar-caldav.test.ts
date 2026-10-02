import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { calendarFixture } from './calendar-test-fixtures'
import { prepareCalendarICSImport } from './calendar-import'
import { applyCalendarProposalFromUI, prepareCalendarGeneration, clearCalendarRulesAuthority } from './calendar-rules-save'
import { prepareCalDAVImport, verifyCalDAVOriginalDigests } from './calendar-caldav'
import { receiveScheduleRefresh, scheduleRefreshBytes, clearScheduleRefreshBytes } from './schedule-refresh'
import { updateCalendarEventLocally } from './calendar-event-local-edit'
import { redactExpiredICSRecords } from './calendar-import-redaction'
import type { ScheduleRefreshCandidate, ScheduleRefreshInbox } from './schedule-refresh-types'
const options={timezone:'Asia/Tokyo',fromDate:'2026-10-01',toDate:'2026-10-31'},click=()=>{const event=new Event('click');Object.defineProperty(event,'isTrusted',{value:true});return event}
const stamp=new Date().toISOString(),subscriptionId='419a15ee-e039-4fca-939b-49c7085c3f2e',collection='http://127.0.0.1:12345/calendars/read/',href=collection+'meeting.ics'
const ics=(version=1)=>`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:synthetic\r\nBEGIN:VEVENT\r\nUID:stable-caldav\r\nDTSTAMP:20261001T000000Z\r\nSEQUENCE:${version}\r\nDTSTART:20261003T010000Z\r\nDTEND:20261003T020000Z\r\nSUMMARY:CalDAV meeting ${version}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
let sourceId:string
async function pending(objects:{href:string;etag:string;data:string}[],deleted:{href:string}[]=[]) {
  const settings=(await db.settings.get('main'))!,bytes=new TextEncoder().encode(JSON.stringify({version:1,collection,objects,deleted})),bodySha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('')
  const value={ownerId:settings.profileId,datasetId:settings.datasetId,policyEpoch:settings.changePolicy?.epoch??0,subscriptionId,sourceId,format:'caldav',fetchedAt:stamp,bodySha256,bytes,qaFixture:true} satisfies ScheduleRefreshCandidate
  const id=await receiveScheduleRefresh(value);return (await db.scheduleRefreshInbox.get(id!))!
}
async function importRow(row:ScheduleRefreshInbox){const preview=await prepareCalDAVImport(row,options);await applyCalendarProposalFromUI(preview.proposal,click());return preview}
beforeEach(async()=>{
  clearCalendarRulesAuthority();await db.delete();await db.open();const settings=await ensureSettings(),state=calendarFixture();state.ownerId=settings.profileId;state.datasetId=settings.datasetId;state.bindings[0].personId=settings.profileId;state.sources=[];state.facts=[];state.activities=[];state.bindings[0].activityIds=[];await db.calendarRules.put(state)
  const seed=await prepareCalendarICSImport({contextId:'company',bindingId:'self',calendarId:'business',feedId:'caldav-empty',title:'合成CalDAV',retentionUntil:'2030-01-01T00:00:00.000Z'},'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:empty\r\nEND:VCALENDAR\r\n',options);sourceId=seed.preview.sourceId;await applyCalendarProposalFromUI(seed.proposal!,click())
})
describe('CalDAV acquired data uses the common resolver',()=>{
  it('uses separate trusted data/generation approvals and preserves IDs on updates',async()=>{
    const first=await pending([{href,etag:'"v1"',data:ics()}]);expect(first.body).toBeNull()
    const preview=await prepareCalDAVImport(first,options);await expect(applyCalendarProposalFromUI(preview.proposal,new Event('click'))).rejects.toThrow('本人確認')
    await applyCalendarProposalFromUI(preview.proposal,click());expect(await db.calendarEvents.count()).toBe(0);await applyCalendarProposalFromUI(await prepareCalendarGeneration(options.fromDate,options.toDate),click());const before=(await db.calendarEvents.toArray())[0]
    await importRow(await pending([{href,etag:'"v2"',data:ics(2)}]));const generation=await prepareCalendarGeneration(options.fromDate,options.toDate);expect(generation.plan.updates).toHaveLength(1);await applyCalendarProposalFromUI(generation,click());expect((await db.calendarEvents.toArray())[0].id).toBe(before.id)
    await verifyCalDAVOriginalDigests([(await db.calendarRules.get('main'))!])
  })
  it('does not cancel omissions; only an explicit 404 receipt cancels the known source object',async()=>{
    await importRow(await pending([{href,etag:'"v1"',data:ics()}]));await applyCalendarProposalFromUI(await prepareCalendarGeneration(options.fromDate,options.toDate),click())
    const missing=await importRow(await pending([]));expect(missing.canceled).toBe(0);expect((await prepareCalendarGeneration(options.fromDate,options.toDate)).plan.cancels).toHaveLength(0)
    const deletion=await importRow(await pending([],[{href}]));expect(deletion.canceled).toBe(1);const generation=await prepareCalendarGeneration(options.fromDate,options.toDate);expect(generation.plan.cancels).toHaveLength(1)
    await applyCalendarProposalFromUI(generation,click());expect(await db.calendarEvents.count()).toBe(0)
  })
  it('protects a local edit, sends no network call and redacts retained original JSON at expiry',async()=>{
    await importRow(await pending([{href,etag:'"v1"',data:ics()}]));await applyCalendarProposalFromUI(await prepareCalendarGeneration(options.fromDate,options.toDate),click());const before=(await db.calendarEvents.toArray())[0]
    await updateCalendarEventLocally(before.id,before.revision??1,{title:'本人編集',startAt:before.startAt,endAt:before.endAt},click())
    await importRow(await pending([{href,etag:'"v2"',data:ics(2)}]));const generation=await prepareCalendarGeneration(options.fromDate,options.toDate);expect(generation.plan.conflicts.length).toBeGreaterThan(0);expect(generation.plan.updates).toHaveLength(0)
    const state=(await db.calendarRules.get('main'))!,redacted=redactExpiredICSRecords({calendarRules:[state],calendarEvents:await db.calendarEvents.toArray(),audits:[]},'2031-01-01T00:00:00.000Z')
    expect(redacted.calendarRules[0].sources[0].caldav!.snapshots[0].originalJSON).toBeNull();expect(redacted.calendarRules[0].sources[0].status).toBe('stale')
    await expect(prepareCalendarICSImport({contextId:'company',bindingId:'self',calendarId:'business',feedId:'caldav-empty',title:'Wrong file',retentionUntil:'2030-01-01T00:00:00.000Z'},ics(3),options)).rejects.toThrow('CalDAV')
  })
  it('keeps raw acquisition bytes volatile and rejects altered collection identity',async()=>{
    const row=await pending([{href,etag:'"v1"',data:ics()}]);expect((await scheduleRefreshBytes(row)).length).toBeGreaterThan(0);clearScheduleRefreshBytes()
    await expect(prepareCalDAVImport(row,options)).rejects.toThrow()
    await importRow(await pending([{href,etag:'"v1"',data:ics()}]))
    const invalid=await pending([{href:'http://127.0.0.1:9999/other.ics',etag:'"v1"',data:ics(2)}]);await expect(prepareCalDAVImport(invalid,options)).rejects.toThrow('コレクション')
  })
})
