import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {createRequire} from 'node:module'
import {createWebhookVerifier,startReceiver} from '../scripts/michi-webhook-receiver.mjs'
const require=createRequire(import.meta.url),{createWebhookService,signature,webhookURL,retryDelay}=require('./webhook-delivery.cjs'),{createNetworkGateway}=require('./network-gateway.cjs'),{createScheduleTransport}=require('./schedule-network.cjs')
const secret='11'.repeat(32),id=crypto.randomUUID(),body=JSON.stringify({id,type:'task.completed'}),stamp='1790938800'
test('reference signature vector, tampering, stale timestamp and exact event replay',()=>{
  assert.equal(signature(Buffer.from(secret,'hex'),stamp,'{}'),'t=1790938800,v1=5b8ebd9658015bfdd8612c6dd1a9b2a5f18785a223b7e7c9a0167fe9e2b80dd3')
  const verify=createWebhookVerifier({secret,now:()=>Number(stamp)*1000}),signed=signature(Buffer.from(secret,'hex'),stamp,body)
  assert.equal(verify({rawBody:body+' ',signature:signed,eventId:id}).status,401)
  assert.equal(verify({rawBody:body,signature:signature(Buffer.from('22'.repeat(32),'hex'),stamp,body),eventId:id}).status,401)
  assert.equal(verify({rawBody:body,signature:signature(Buffer.from(secret,'hex'),String(Number(stamp)-301),body),eventId:id}).status,401)
  assert.equal(verify({rawBody:body,signature:signed,eventId:crypto.randomUUID()}).status,400)
  assert.equal(verify({rawBody:body,signature:signed,eventId:id}).ok,true)
  assert.equal(verify({rawBody:body,signature:signed,eventId:id}).status,409)
})
async function fixture(t,{transport,policy='explicit_online'}={}){
  // Windows CI may expose TEMP through an 8.3 alias; the private store deliberately
  // requires the canonical directory. Do not loosen its path/link checks for fixtures.
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'michi-webhook-test-')),key=crypto.randomBytes(32)
  t.after(async()=>{const resolved=await fs.realpath(root);assert.equal(path.dirname(resolved).toLowerCase(),(await fs.realpath(os.tmpdir())).toLowerCase());assert.ok(path.basename(resolved).startsWith('michi-webhook-test-'));await fs.rm(resolved,{recursive:true,force:true})})
  const safeStorage={isEncryptionAvailable:()=>true,encryptString:value=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(value),c.final(),c.getAuthTag()])},decryptString:bytes=>{const c=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));c.setAuthTag(bytes.subarray(-16));return Buffer.concat([c.update(bytes.subarray(12,-16)),c.final()]).toString()}}
  let clock=Number(stamp)*1000,mode=policy;const context={settings:{profileId:crypto.randomUUID(),datasetId:crypto.randomUUID(),aiEnabled:true,changePolicy:{epoch:0,sourcePermissionRevision:0,aiChangesEnabled:true}},datasetState:{mode:'active'}},outbox=[]
  const calls=[],gateway=createNetworkGateway({getPolicy:async()=>({policy:mode,source:'test'}),webhookTransport:transport??(async(url,init)=>{calls.push({url,...init});return new Response(null,{status:204})})})
  const options={directory:root,safeStorage,gateway,getContext:async()=>context,readDatabase:async()=>outbox,verifyNativeProof:async(ref,proof)=>proof===ref,now:()=>clock}
  const service=await createWebhookService(options)
  async function add(extra={}){return service.add({url:'http://127.0.0.1:8766/webhook',events:['task.created','task.completed','task.reopened'],includeTitle:false,loopback:true,...extra},'add')}
  const event=(sub,type='task.completed',extra={})=>{const id=crypto.randomUUID(),at=new Date(clock).toISOString();const row={id,at,state:'pending',ownerId:context.settings.profileId,datasetId:context.settings.datasetId,policyEpoch:0,sourcePermissionRevision:0,subscriptionIds:[sub.id],payload:{id,type,occurred_at:at,task_id:crypto.randomUUID(),dataset_id:context.settings.datasetId,points:25,...extra}};outbox.push(row);return row}
  return {service,options,root,calls,context,outbox,add,event,gateway,clock:()=>clock,advance:ms=>{clock+=ms},mode:value=>{mode=value}}
}
test('private encrypted grant, native confirmation, minimal payload, replay and cancellation',async t=>{
  const f=await fixture(t)
  await assert.rejects(f.service.add({url:'https://example.com/hook',events:['task.created'],includeTitle:false,loopback:false},null),/HUMAN/)
  const {subscription:s,secret}=await f.add();assert.equal(secret.length,64)
  assert.ok(!(await fs.readFile(path.join(f.root,'config.bin'))).includes(secret));assert.ok(!JSON.stringify(await f.service.status()).includes(secret))
  const row=f.event(s,'task.completed',{title:'private title'})
  assert.equal((await f.service.dispatch())[0].state,'delivered');assert.equal(f.calls.length,1)
  assert.equal(JSON.parse(f.calls[0].body).title,undefined)
  const verify=createWebhookVerifier({secret,now:f.clock});assert.equal(verify({rawBody:f.calls[0].body,signature:f.calls[0].headers['Michi-Signature'],eventId:row.id}).ok,true)
  await f.service.dispatch();assert.equal(f.calls.length,1)
  f.event(s);await f.service.revoke(s.id);assert.equal((await f.service.dispatch()).at(-1).state,'cancelled');assert.equal(f.calls.length,1)
})
test('offline policy is checked before DNS/fetch, epoch/freeze/AI stop never dispatch',async t=>{
  const f=await fixture(t,{policy:'offline_only'}),{subscription:s}=await f.add();f.event(s)
  assert.equal((await f.service.dispatch())[0].state,'blocked_by_policy');assert.equal(f.calls.length,0);assert.equal(f.gateway.status().counters.webhook.attempts,0)
  f.mode('explicit_online');f.advance(60001);f.context.datasetState.mode='frozen';assert.equal((await f.service.dispatch())[0].state,'cancelled');assert.equal(f.calls.length,0)
  f.context.datasetState.mode='active';f.event(s);f.context.settings.changePolicy.epoch++;await f.service.dispatch();assert.equal(f.calls.length,0)
  f.context.settings.changePolicy.epoch=0;f.context.settings.aiEnabled=false;f.event(s);await f.service.dispatch();assert.equal(f.calls.length,0)
})
test('bounded retries, Retry-After, no 4xx retry, redirects and lost response remain honest',async t=>{
  assert.deepEqual([1,2,3,4,5,6].map(n=>retryDelay(n,null,0)),[1,2,4,8,16,30].map(n=>n*60000));assert.equal(retryDelay(1,'120',0),120000)
  let calls=0;const f=await fixture(t,{transport:async()=>{calls++;return new Response(null,{status:503,headers:{'Retry-After':'120'}})}}),{subscription:s}=await f.add();f.event(s)
  let result=(await f.service.dispatch())[0];assert.equal(result.nextAt,f.clock()+120000);await f.service.dispatch();assert.equal(calls,1)
  for(let n=0;n<6;n++){f.advance(86400000);result=(await f.service.dispatch())[0]}assert.equal(calls,7);assert.equal(result.state,'exhausted');f.advance(86400000);await f.service.dispatch();assert.equal(calls,7)
  for(const status of [400,401,409,302]){const g=await fixture(t,{transport:async()=>new Response(null,{status})}),{subscription:s2}=await g.add();g.event(s2);assert.equal((await g.service.dispatch())[0].state,'rejected')}
  const g=await fixture(t,{transport:async()=>{throw Error('lost response')}}),{subscription:s2}=await g.add();g.event(s2);assert.equal((await g.service.dispatch())[0].state,'unknown');assert.equal((await g.service.status()).deliveries[0].state,'unknown')
})
test('loopback is explicit, private literal/DNS are refused and real HTTP receives a verified event',async t=>{
  for(const url of ['http://127.0.0.1:8766/webhook','https://127.0.0.1/a','https://10.0.0.1/a','https://169.254.169.254/a','https://[::1]/a','https://example.com/a#private','https://user:pass@example.com/a'])assert.throws(()=>webhookURL(url,false))
  assert.equal(webhookURL('http://localhost:8766/webhook',true).hostname,'127.0.0.1')
  let dnsCalls=0;const pinned=createScheduleTransport({lookup:async()=>{dnsCalls++;return [{address:'10.0.0.1',family:4}]}})
  const f=await fixture(t,{transport:pinned}),{subscription:s}=await f.add({url:'https://example.com/hook',loopback:false});f.event(s);assert.equal((await f.service.dispatch())[0].error,'SCHEDULE_PRIVATE_ADDRESS');assert.equal(dnsCalls,1)
  const seen=[],g=await fixture(t,{transport:createScheduleTransport({qaLoopback:true})}),initial=await g.add()
  let receiver=await startReceiver({secret:initial.secret,now:g.clock,onEvent:e=>seen.push(e)})
  t.after(()=>receiver.close());await g.service.revoke(initial.subscription.id)
  // New subscription uses the receiver URL, with its own one-time secret.
  const next=await g.add({url:receiver.url});await receiver.close()
  receiver=await startReceiver({secret:next.secret,port:Number(new URL(receiver.url).port),now:g.clock,onEvent:e=>seen.push(e)})
  g.event(next.subscription);assert.equal((await g.service.dispatch()).at(-1).state,'delivered');assert.equal(seen.length,1)
})

test('restart after durable dispatch claim stays unknown, changed event is rejected and retry stays idempotent',async t=>{
  const f=await fixture(t),{subscription:s}=await f.add(),row=f.event(s)
  const {createPrivateJSONStore}=require('./private-json-store.cjs'),store=await createPrivateJSONStore({directory:f.root,safeStorage:f.options.safeStorage,maxBytes:1024*1024})
  const name='d-'+s.id+'-'+row.id+'.bin',raw=JSON.stringify(row.payload)
  await store.save(name,{id:crypto.randomUUID(),subscriptionId:s.id,eventId:row.id,event:row.payload.type,state:'in_flight',attempts:1,nextAt:null,updatedAt:row.at,digest:crypto.createHash('sha256').update(raw).digest('hex')})
  const restarted=await createWebhookService(f.options)
  assert.equal((await restarted.dispatch())[0].state,'unknown');assert.equal(f.calls.length,0)
  f.advance(60001);row.payload.points=26
  await assert.rejects(restarted.dispatch(),/WEBHOOK_EVENT_CHANGED/);assert.equal(f.calls.length,0)
  row.payload.points=25;assert.equal((await restarted.dispatch())[0].state,'delivered');assert.equal(f.calls[0].headers['Michi-Delivery-Attempt'],'2')
  assert.equal(f.calls[0].headers['Michi-Event-Id'],row.id);await restarted.dispatch();assert.equal(f.calls.length,1)
})

test('future retries and settled batches cannot starve new events; revoke cancels before retry is due',async t=>{
  let retry=true,calls=0;const f=await fixture(t,{transport:async()=>{calls++;return new Response(null,{status:retry?503:204})}}),{subscription:s}=await f.add({includeTitle:true})
  for(let n=0;n<101;n++)f.event(s)
  assert.equal((await f.service.dispatch()).length,100);assert.equal(calls,100)
  assert.equal((await f.service.dispatch()).length,1);assert.equal(calls,101)
  retry=false;f.event(s,'task.created',{title:'owner approved title'})
  const result=await f.service.dispatch();assert.equal(result.length,1);assert.equal(result[0].state,'delivered');assert.equal(calls,102)
  await f.service.revoke(s.id)
  assert.equal((await f.service.dispatch()).length,100);assert.equal((await f.service.dispatch()).length,1);assert.equal(calls,102)
  const g=await fixture(t),{subscription:s2}=await g.add({includeTitle:true})
  for(let n=0;n<102;n++)g.event(s2,'task.created',{title:'owner approved title'})
  await g.service.dispatch();await g.service.dispatch();assert.equal(g.calls.length,102)
  assert.equal(JSON.parse(g.calls[0].body).title,'owner approved title')
  assert.equal((await g.service.dispatch()).length,0)
})

test('invalid external operation table fails closed and trial ping has no advertised automatic retry',async t=>{
  const f=await fixture(t),{subscription:s}=await f.add();f.event(s)
  for(const operations of [[],{},[{operation:'external.write',mode:'auto_within_bounds'}],[{operation:'external.write',mode:'require_approval'},{operation:'external.write',mode:'require_approval'}]]){
    f.context.settings.changePolicy.operations=operations
    await assert.rejects(f.add(),/AUTHORITY_CHANGED/)
  }
  assert.equal((await f.service.dispatch())[0].state,'cancelled');assert.equal(f.calls.length,0)
  delete f.context.settings.changePolicy.operations
  const g=await fixture(t,{transport:async()=>new Response(null,{status:503})}),{subscription:s2}=await g.add()
  const ping=await g.service.test({id:s2.id},'test:'+s2.id)
  assert.equal(ping.state,'rejected');assert.equal(ping.error,'PING_TEST_FAILED');assert.equal(ping.nextAt,null)
  g.advance(86400000);assert.deepEqual(await g.service.dispatch(),[])
  const h=await fixture(t,{transport:async()=>{throw Error('response lost')}}),{subscription:s3}=await h.add()
  const unknown=await h.service.test({id:s3.id},'test:'+s3.id);assert.equal(unknown.state,'unknown');assert.equal(unknown.nextAt,null)
})

test('stop immediately prevents the rest of an outstanding batch before durable revoke can acquire the queue',async t=>{
  for(const all of [false,true]){
    let release,started,calls=0;const entered=new Promise(resolve=>{started=resolve})
    const f=await fixture(t,{transport:async()=>{calls++;started();return new Promise(resolve=>{release=()=>resolve(new Response(null,{status:204}))})}}),{subscription:s}=await f.add()
    for(let n=0;n<3;n++)f.event(s)
    const dispatch=f.service.dispatch();await entered
    const revoke=f.service.revoke(all?null:s.id);release()
    const results=await dispatch;await revoke
    assert.equal(calls,1);assert.deepEqual(results.map(row=>row.state),['delivered','cancelled','cancelled'])
    const next=await f.add();assert.equal(next.subscription.revokedAt,null)
  }
})
