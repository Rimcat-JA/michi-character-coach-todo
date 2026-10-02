import { db } from './db'
import { contentDigest } from './canonical'
import { parseCalendarImport, prepareICSConfiguration, type ICSComponent, type CalendarImportOptions } from './calendar-import'
import { loadCalendarRulesState, prepareCalendarConfiguration, type CalendarConfigurationProposal } from './calendar-rules-save'
import { bindScheduleRefreshPreview, scheduleRefreshBytes } from './schedule-refresh'
import type { ScheduleRefreshInbox, ScheduleRefreshStatus } from './schedule-refresh-types'
export type CalDAVConnectionStatus = ScheduleRefreshStatus & { readTitle: string; writeTitle: string | null; writeEnabled: boolean }
export type CalDAVDiscovery = { id: string; qaFixture: boolean; collections: { href: string; title: string; syncToken: string | null; components: string[] }[] }
export type CalDAVWritePreview = { token: string; id: string; operation: 'put'|'delete'; before: string | null; after: string | null; etag: string | null; afterSummary: {title:string;startAt:string;endAt:string} }
declare global { interface Window { michiCalDAV?: { request: (value: Record<string, unknown>) => Promise<unknown> } } }
type CalDAVPayload = { version: 1; collection: string; objects: {href:string;etag:string;data:string}[]; deleted: {href:string}[] }
const record = (value: unknown): value is Record<string,unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
function exact(value: unknown,keys: string[]) { if (!record(value) || Object.keys(value).length!==keys.length || keys.some(key=>!Object.hasOwn(value,key))) throw new Error('CalDAVの取得結果の項目が不正です');return value }
async function rawSHA(text: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,'0')).join('') }
function calendarPayload(text: string,qaFixture: boolean): CalDAVPayload {
  const value=exact(JSON.parse(text),['version','collection','objects','deleted'])
  if(value.version!==1||typeof value.collection!=='string'||!Array.isArray(value.objects)||!Array.isArray(value.deleted)||value.objects.length>1000||value.deleted.length>1000)throw new Error('CalDAVの取得結果が上限・形式を外れています')
  const collection=new URL(value.collection)
  if(collection.protocol!=='https:'&&!(qaFixture&&collection.protocol==='http:'&&collection.hostname==='127.0.0.1'&&collection.port)||collection.username||collection.password||collection.search||collection.hash||!collection.pathname.endsWith('/'))throw new Error('CalDAVの取得先が不正です')
  const checked = (input: unknown, deleted: boolean) => {
    const row=exact(input,deleted?['href']:['href','etag','data']);if(typeof row.href!=='string'||row.href.length>2048)throw new Error('CalDAVのオブジェクト参照が不正です')
    const url=new URL(row.href)
    if(url.origin!==collection.origin||!url.pathname.startsWith(collection.pathname)||url.pathname===collection.pathname||url.search||url.hash||url.username||url.password||decodeURIComponent(url.pathname.slice(collection.pathname.length)).includes('/'))throw new Error('CalDAVの対象コレクションが一致しません')
    if(!deleted&&(typeof row.etag!=='string'||(!/^"[^"]+"$/.test(row.etag)||[...row.etag].some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127))||row.etag.length>1000||typeof row.data!=='string'||new TextEncoder().encode(row.data).length>1048576))throw new Error('CalDAVの予定本文・ETagが不正です')
    return row.href
  }
  const hrefs=value.objects.map(row=>checked(row,false)),deleted=value.deleted.map(row=>checked(row,true))
  if(new Set(hrefs).size!==hrefs.length||new Set(deleted).size!==deleted.length||deleted.some(href=>hrefs.includes(href)))throw new Error('CalDAVの重複・明示削除が矛盾しています')
  return value as CalDAVPayload
}
function renderComponent(component: ICSComponent) {
  const properties=component.properties.filter(row=>row.name!=='STATUS')
  return ['BEGIN:VEVENT',...properties.map(row=>row.name+Object.entries(row.params).map(([key,value])=>`;${key}="${value}"`).join('')+':'+row.value),`STATUS:${component.status==='cancelled'?'CANCELLED':component.status==='tentative'?'TENTATIVE':'CONFIRMED'}`,'END:VEVENT'].join('\r\n')
}
export async function prepareCalDAVImport(row: ScheduleRefreshInbox, options: CalendarImportOptions): Promise<{proposal:CalendarConfigurationProposal;added:number;updated:number;canceled:number;warnings:string[]}> {
  const current=await db.scheduleRefreshInbox.get(row.id)
  if(!current||current.state!=='pending'||current.format!=='caldav'||current.bodySha256!==row.bodySha256)throw new Error('CalDAVの取得資料が失効しました')
  const raw=new TextDecoder('utf-8',{fatal:true}).decode(await scheduleRefreshBytes(current));if(await rawSHA(raw)!==current.bodySha256)throw new Error('CalDAVの取得資料hashが一致しません')
  const payload=calendarPayload(raw,current.qaFixture),state=await loadCalendarRulesState(),source=state.sources.find(source=>source.id===current.sourceId)
  if(!source?.ics||source.csv||!source.caldav&&source.ics.components.length||source.caldav&&source.caldav.collectionHash!==await rawSHA(payload.collection))throw new Error('CalDAVには空の読取元か同じコレクションの固定取込元を選んでください')
  const context=state.contexts.find(context=>context.id===source.contextId),binding=state.bindings.find(binding=>binding.contextId===source.contextId&&binding.personId===state.ownerId&&binding.confirmed),calendar=state.calendars.find(calendar=>calendar.contextId===source.contextId)
  if(!context||!binding||!calendar||!source.ics.retentionUntil||source.ics.retentionUntil<=new Date().toISOString())throw new Error('本人対象・資料の保持期限を確認してください')
  const blocks:string[]=[],objects:{hrefHash:string;etag:string;uidHashes:string[]}[]=[],uids=new Set<string>(),warnings:string[]=[]
  for(const object of payload.objects){const parsed=parseCalendarImport(object.data,{...options,timezone:context.timezone}),objectUIDs=[...new Set(parsed.components.map(component=>component.uid))];if(objectUIDs.length!==1||objectUIDs.some(uid=>uids.has(uid)))throw new Error('CalDAVの同じUIDは一つのオブジェクトにまとめてください');for(const uid of objectUIDs)uids.add(uid);blocks.push(...parsed.components.map(renderComponent));objects.push({hrefHash:await rawSHA(object.href),etag:object.etag,uidHashes:await Promise.all(objectUIDs.map(async uid=>`sha256:${await contentDigest(uid)}`))});warnings.push(...parsed.warnings)}
  const aggregate=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//michi verified CalDAV text//JP',...blocks,'END:VCALENDAR',''].join('\r\n'),preview=await prepareICSConfiguration(state,{contextId:context.id,bindingId:binding.id,calendarId:calendar.id,feedId:source.ics.feedId,title:source.title,retentionUntil:source.ics.retentionUntil},parseCalendarImport(aggregate,{...options,timezone:context.timezone}))
  if(preview.duplicates.length)throw new Error('他の取込元に同じUIDがあります。重複を解決してから取込元を確認してください')
  // Source identity is the selected collection's fixed feed, not a new event per fetch.
  const selected=preview.next.sources.find(item=>item.id===source.id)!
  if(preview.noOp){selected.revision++;selected.importedAt=current.fetchedAt;selected.status='current';selected.ics!.snapshots.push({...selected.ics!.snapshots.at(-1)!,revision:selected.revision,importedAt:current.fetchedAt})}
  let canceled=preview.canceled
  const activeUIDs=new Set(objects.flatMap(object=>object.uidHashes))
  for(const deletion of payload.deleted){const hrefHash=await rawSHA(deletion.href),prior=source.caldav?.objects.find(object=>object.hrefHash===hrefHash)
    if(!prior)continue
    for(const uid of prior.uidHashes.filter(uid=>!activeUIDs.has(uid))){const activityId=`ics-activity:${(await contentDigest([source.id,uid])).slice(0,32)}`;for(const fact of preview.next.facts)if(fact.sourceId===source.id&&fact.kind==='external_event'&&fact.activityId===activityId&&fact.status==='scheduled'){fact.status='cancelled';fact.revision++;canceled++}}
  }
  const deletedHashes=new Set(await Promise.all(payload.deleted.map(row=>rawSHA(row.href))))
  const knownObjects=[...objects,...(source.caldav?.objects??[]).filter(old=>!objects.some(row=>row.hrefHash===old.hrefHash)&&!deletedHashes.has(old.hrefHash))]
  selected.caldav={accountId:current.subscriptionId,collectionHash:await rawSHA(payload.collection),readOnly:true,objects:knownObjects,snapshots:[...(source.caldav?.snapshots??[]),{revision:selected.revision,sha256:current.bodySha256,originalJSON:raw,fetchedAt:current.fetchedAt}]};selected.acquisition={provider:'caldav',qaFixture:current.qaFixture,staleByFetch:false}
  const proposal=await prepareCalendarConfiguration(preview.next,state.revision,options.fromDate,options.toDate)
  await bindScheduleRefreshPreview(proposal,current.id,current.bodySha256)
  return {proposal,added:preview.added,updated:preview.updated,canceled,warnings:[...new Set(warnings.concat('CalDAVのXML予定本文から日時を検証しました。欠落では取消せず、404で確認できたオブジェクトの明示削除だけを採録します。'))]}
}
export async function verifyCalDAVOriginalDigests(states: {sources: import('./calendar-resolver').ScheduleSource[]}[]) { for(const state of states)for(const source of state.sources)for(const snapshot of source.caldav?.snapshots??[])if(snapshot.originalJSON!==null&&await rawSHA(snapshot.originalJSON)!==snapshot.sha256)throw new Error('CalDAVの取得原本hashが一致しません') }
