import {test} from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url),{createScheduleRefresh}=require('./schedule-refresh.cjs'),{createNetworkGateway}=require('./network-gateway.cjs'),{createScheduleTransport,scheduleURL,publicAddress}=require('./schedule-network.cjs')
async function fixture(t,{timeoutMs=1000}={}) {
  const requests=[],changed=[],notifications=[];let body='BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR',etag='"v1"',modified='Fri, 02 Oct 2026 00:00:00 GMT',mode='normal',now=Date.parse('2026-10-02T00:00:00Z'),online=true
  const server=http.createServer((req,res)=>{requests.push({url:req.url,headers:req.headers});if(mode==='timeout'){return}if(mode==='redirect'){res.writeHead(302,{Location:'http://127.0.0.1:1/other'}).end();return}if(mode==='error'){res.writeHead(503,{'Retry-After':'120'}).end('failed');return}if(mode==='oversize'){res.writeHead(200,{'Content-Type':'text/calendar','Content-Length':1048577}).end();return}if(mode==='wrong_type'){res.writeHead(200,{'Content-Type':'text/html'}).end('<html>');return}if(req.headers['if-none-match']===etag||!etag&&req.headers['if-modified-since']===modified){res.writeHead(304,{ETag:etag??''}).end();return}res.writeHead(200,{'Content-Type':'text/calendar',...(etag?{ETag:etag}:{}),'Last-Modified':modified}).end(body)})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()});const url=`http://127.0.0.1:${server.address().port}/feed`
  let state={version:1,subscriptions:[],caldav:[]};const store={load:async()=>structuredClone(state),save:async next=>{state=structuredClone(next)}}
  const context={settings:{profileId:'owner',datasetId:'dataset',changePolicy:{epoch:1}},datasetState:{mode:'active'}}
  const gateway=createNetworkGateway({getPolicy:async()=>({policy:online?'explicit_online':'offline_only'}),qaScheduleLoopback:true,scheduleTransport:createScheduleTransport({qaLoopback:true,timeoutMs})})
  const options={store,gateway,getContext:async()=>context,onChanged:async item=>changed.push(item),notify:async item=>notifications.push(item),qaLoopback:true,clock:()=>now,timeoutMs}
  const service=createScheduleRefresh(options);t.after(()=>service.close())
  const configure=(patch={})=>service.configure({sourceId:'source',kind:'url',format:'ics',url,filePath:null,refreshPolicy:'daily',validFrom:'2026-10-02',...patch})
  return {service,configure,requests,changed,notifications,context,gateway,options,advance:ms=>now+=ms,get now(){return now},set(patch){({body=body,etag=etag,modified=modified,mode=mode,online=online}=patch)}}
}
test('200/304, same SHA with new ETag, Last-Modified and one changed notification; zero parsing/autoapply',async t=>{
  const f=await fixture(t),record=await f.configure();await f.service.tick();assert.equal(f.changed.length,1);assert.equal(f.notifications.length,1);assert.equal(f.changed[0].sourceId,'source');await f.service.acknowledge(record.id,f.changed[0].bodySha256)
  await f.service.refresh(record.id);assert.equal(f.requests.at(-1).headers['if-none-match'],'"v1"');assert.equal(f.changed.length,1)
  f.set({etag:'"v2"'});await f.service.refresh(record.id);assert.equal(f.changed.length,1)
  f.set({etag:null})
  // A separate source without ETag takes the Last-Modified conditional path.
  const next=await f.configure();await f.service.refresh(next.id);await f.service.acknowledge(next.id,f.changed.at(-1).bodySha256);await f.service.refresh(next.id);assert.equal(f.requests.at(-1).headers['if-modified-since'],'Fri, 02 Oct 2026 00:00:00 GMT')
  f.set({body:'changed calendar',modified:'Fri, 02 Oct 2026 01:00:00 GMT'});await f.service.refresh(next.id);assert.equal(f.changed.at(-1).bytes.length,16)
})
test('failure, timeout, oversize, content type and cross-origin redirect remain stale and honour Retry-After',async t=>{
  const f=await fixture(t,{timeoutMs:50}),record=await f.configure()
  for(const mode of ['error','timeout','oversize','wrong_type','redirect']){f.set({mode});const result=await f.service.refresh(record.id);assert.equal(result.status,'stale');assert.equal(f.changed.length,0);if(mode==='error')assert.ok(Date.parse(result.nextDueAt)>=f.now+120000)}
  assert.ok(f.requests.every(row=>row.url==='/feed'));assert.equal(f.requests.filter(row=>row.url==='/other').length,0)
})
test('offline, frozen, stops and owner/epoch changes block before request; restored pending bytes require no old approval',async t=>{
  const f=await fixture(t),record=await f.configure();await f.service.refresh(record.id)
  const restarted=createScheduleRefresh(f.options);t.after(()=>restarted.close());await restarted.refresh(record.id);assert.equal((await restarted.candidate(record.id)).bodySha256,f.changed[0].bodySha256);assert.equal(f.requests.at(-1).headers['if-none-match'],undefined)
  const count=f.requests.length;f.set({online:false});assert.equal((await f.service.refresh(record.id)).status,'paused');assert.equal(f.requests.length,count)
  f.set({online:true});f.context.datasetState.mode='frozen';await f.service.refresh(record.id);assert.equal(f.requests.length,count)
  f.context.datasetState.mode='active';f.context.settings.changePolicy.stops={routines:true};await f.service.refresh(record.id);assert.equal(f.requests.length,count)
  f.context.settings.changePolicy.stops={};f.context.settings.changePolicy.epoch++;await f.service.refresh(record.id);assert.equal(f.requests.length,count)
})
test('native-selected file change, replacement and watch fallback detect SHA; symlinks are rejected',async t=>{
  const f=await fixture(t),root=await fs.mkdtemp(path.join(os.tmpdir(),'michi-schedule-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const filePath=await fs.realpath(root).then(root=>path.join(root,'calendar.ics'));await fs.writeFile(filePath,'one')
  const record=await f.configure({kind:'file',url:null,filePath});await f.service.tick();assert.equal(f.changed.length,1);await f.service.acknowledge(record.id,f.changed[0].bodySha256)
  await fs.writeFile(filePath,'two');await f.service.tick();assert.equal(f.changed.length,2);await f.service.acknowledge(record.id,f.changed[1].bodySha256)
  await fs.rename(filePath,filePath+'.old');await fs.writeFile(filePath,'three');await f.service.tick();assert.equal(f.changed.length,3);assert.equal(f.requests.length,0)
})
test('HTTPS, private IPs, IPv6 aliases, DNS rebinding and an unapproved origin are rejected',async()=>{
  for(const value of ['http://example.com','https://127.0.0.1','https://10.0.0.1','https://[::ffff:127.0.0.1]','https://localhost','https://user:secret@example.com'])assert.throws(()=>scheduleURL(value))
  for(const value of ['127.0.0.1','169.254.169.254','10.0.0.1','100.64.0.1','2001:0db8::1','2002:7f00:1::1','fe80::1','::ffff:8.8.8.8'])assert.equal(publicAddress(value),false)
  assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true)
  const transport=createScheduleTransport({lookup:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]});await assert.rejects(transport('https://example.com'),/PRIVATE_ADDRESS/)
  const gateway=createNetworkGateway({getPolicy:async()=>({policy:'explicit_online'}),scheduleTransport:transport});await assert.rejects(gateway.fetch('schedule','https://example.com'),/許可/)
})
