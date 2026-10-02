import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {createCalDAVFixtureServer,syntheticCalDAVEvent} from './fixtures/caldav-fixture-server.mjs'
const require=createRequire(import.meta.url),{createCalDAVClient,safeXML}=require('./caldav-client.cjs'),{createNetworkGateway}=require('./network-gateway.cjs'),{createScheduleTransport}=require('./schedule-network.cjs')
async function fixture(t){const server=await createCalDAVFixtureServer();t.after(()=>server.close());const gateway=createNetworkGateway({getPolicy:async()=>({policy:'explicit_online'}),scheduleTransport:createScheduleTransport({qaLoopback:true}),qaScheduleLoopback:true});gateway.authorizeScheduleOrigin('caldav',server.origin);const client=createCalDAVClient({url:server.url,username:'fixture-user',password:'fixture-app-password',qaLoopback:true,fetchImpl:(url,init)=>gateway.fetch('caldav',url,init)});return {server,client,gateway}}
test('discovery, initial and incremental add/modify/delete; invalid-token rebuild only changes mirror',async t=>{
  const {client,server}=await fixture(t),collections=await client.discover();assert.equal(collections.length,2);client.selectCollections(collections[0].href)
  const first=await client.sync();assert.equal(first.objects.length,1);assert.equal(first.objects[0].data,syntheticCalDAVEvent().replaceAll('\r\n','\n'));const before=server.requests.length
  const unchanged=await client.sync({token:first.token,objects:first.objects.map(({href,etag})=>({href,etag}))});assert.equal(server.requests.length,before+1);assert.deepEqual(unchanged.objects,first.objects)
  server.put('/calendars/read/meeting.ics',syntheticCalDAVEvent(2));server.put('/calendars/read/second.ics',syntheticCalDAVEvent(1,'second'))
  const second=await client.sync({token:first.token,objects:first.objects});assert.equal(second.objects.length,2);assert.ok(second.objects.some(row=>row.data.includes('SEQUENCE:2')))
  server.remove('/calendars/read/second.ics');const third=await client.sync({token:second.token,objects:second.objects});assert.equal(third.deleted.length,1);assert.equal(third.objects.length,1)
  server.setMode('invalid_token');const rebuilt=await client.sync({token:third.token,objects:third.objects});assert.equal(rebuilt.fullResync,true);assert.equal(rebuilt.method,'calendar-query');assert.equal(rebuilt.objects.length,1)
  assert.ok(server.requests.every(row=>!JSON.stringify(row).includes('fixture-app-password')))
})
test('fallback query + ETags and a fresh client rehydrate the mirror after restart',async t=>{
  const {client,server,gateway}=await fixture(t);client.selectCollections(server.origin+'/calendars/read/');server.setMode('no_sync');const first=await client.sync();assert.equal(first.method,'calendar-query')
  const fresh=createCalDAVClient({url:server.url,username:'fixture-user',password:'fixture-app-password',qaLoopback:true,fetchImpl:(url,init)=>gateway.fetch('caldav',url,init)});fresh.selectCollections(server.origin+'/calendars/read/');const result=await fresh.sync({token:null,objects:first.objects.map(({href,etag})=>({href,etag}))});assert.equal(result.objects[0].data,syntheticCalDAVEvent().replaceAll('\r\n','\n'))
})
test('dedicated writes require a separate native approval and If-Match; 412 stops and needs a new approval',async t=>{
  const {client,server}=await fixture(t);client.selectCollections(server.origin+'/calendars/read/');const id='150c5c96-9f02-4bb9-88ae-6553b9716efe',data=syntheticCalDAVEvent(1,'owned')
  const initial=server.requests.length;await assert.rejects(client.prepareWrite({id,operation:'put',data}),/WRITE_COLLECTION_BLOCKED/);assert.equal(server.requests.length,initial)
  assert.throws(()=>client.selectCollections(server.origin+'/calendars/read/',server.origin+'/calendars/read/',true),/DEDICATED/)
  client.selectCollections(server.origin+'/calendars/read/',server.origin+'/calendars/michi/',true)
  const create=await client.prepareWrite({id,operation:'put',data});await assert.rejects(client.applyWrite(create.token,async()=>false),/NATIVE_APPROVAL/);assert.equal(server.requests.filter(row=>row.method==='PUT').length,0)
  assert.equal((await client.applyWrite(create.token,async()=>true)).state,'written');assert.equal(server.requests.at(-1).ifNoneMatch,'*')
  const update=await client.prepareWrite({id,operation:'put',data:syntheticCalDAVEvent(2,'owned')});server.raceNextWrite(syntheticCalDAVEvent(3,'owned'));const conflict=await client.applyWrite(update.token,async()=>true);assert.equal(conflict.state,'conflict');assert.equal(conflict.newApprovalRequired,true);assert.ok(server.requests.findLast(row=>row.method==='PUT').ifMatch)
  await assert.rejects(client.applyWrite(update.token,async()=>true),/EXPIRED/)
  const retry=await client.prepareWrite({id,operation:'put',data:syntheticCalDAVEvent(4,'owned')});assert.equal((await client.applyWrite(retry.token,async()=>true)).state,'written')
  const remove=await client.prepareWrite({id,operation:'delete'});assert.equal((await client.applyWrite(remove.token,async()=>true)).state,'deleted');assert.ok(server.requests.at(-1).ifMatch)
})
test('duplicate If-None-Match reconciles by GET without another write',async t=>{
  const {client,server}=await fixture(t);client.selectCollections(server.origin+'/calendars/read/',server.origin+'/calendars/michi/',true);const data=syntheticCalDAVEvent(),preview=await client.prepareWrite({id:'750c5c96-9f02-4bb9-88ae-6553b9716efe',operation:'put',data});server.raceNextWrite(data);assert.equal((await client.applyWrite(preview.token,async()=>true)).state,'reconciled');assert.equal(server.requests.filter(row=>row.method==='PUT').length,1)
})
test('XXE, namespace, depth, capacity and non-approved origin fail closed; errors contain no credentials',async t=>{
  const {client,server}=await fixture(t)
  assert.throws(()=>safeXML('<!DOCTYPE x [<!ENTITY e SYSTEM "http://localhost">]><x>&e;</x>'),/XML_INVALID/)
  assert.throws(()=>safeXML('<x xmlns:d="https://malicious.example/"/>'),/NAMESPACE/)
  assert.throws(()=>safeXML('<x>'.repeat(30)+'</x>'.repeat(30)),/DEPTH/)
  assert.throws(()=>client.selectCollections('http://127.0.0.1:1/other/'),/ORIGIN/)
  server.setMode('xxe');await assert.rejects(client.discover(),/XML_INVALID/)
  server.setMode('capacity');await assert.rejects(client.discover(),error=>error.message==='CALDAV_HTTP_507'&&!error.message.includes('fixture-app-password'))
})

test('CalDAV server Retry-After and offline policy remain structured acquisition failures',async t=>{
 const server=await createCalDAVFixtureServer();t.after(()=>server.close());const client=createCalDAVClient({url:server.url,username:'fixture-user',password:'fixture-app-password',qaLoopback:true,fetchImpl:fetch});server.setMode('busy');await assert.rejects(client.discover(),error=>error.message==='CALDAV_HTTP_503'&&error.retryAfter===120000)
 const offline=createCalDAVClient({url:server.url,username:'fixture-user',password:'fixture-app-password',qaLoopback:true,fetchImpl:async()=>{const error=new Error('no network');error.code='NETWORK_POLICY_OFFLINE';throw error}});await assert.rejects(offline.discover(),/NETWORK_POLICY_OFFLINE/)
})
