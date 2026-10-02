import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import http from 'node:http'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createLocalAPIService, localAPIReceiptKey } = require('./local-api-service.cjs')
const { createLocalAPIServer, localAPIRequestBoundary } = require('./local-api-server.cjs')
const { createPrivateJSONStore } = require('./private-json-store.cjs')

// AES-GCM fixture exercises encrypted disk recovery; Electron safeStorage is checked in Windows QA.
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'michi-api-'))
  const key = crypto.randomBytes(32)
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(value),cipher.final(),cipher.getAuthTag()]) },
    decryptString(value) { const decipher=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(-16));return Buffer.concat([decipher.update(value.subarray(12,-16)),decipher.final()]).toString('utf8') }
  }
  let now=Date.now()
  const settings={profileId:crypto.randomUUID(),datasetId:crypto.randomUUID(),aiEnabled:true,changePolicy:{epoch:3,sourcePermissionRevision:2,aiChangesEnabled:true,taskUpdate:'require_approval'}}
  const receipts=new Map(),tasks=new Map(),projects=[],proofs=new Map()
  const proof=(kind,reference)=>{const nonce=crypto.randomUUID();proofs.set(nonce,{kind,reference});return nonce}
  const options={directory:root,safeStorage,getContext:async()=>({settings,datasetState:{mode:settings.datasetMode??'active'}}),readDatabase:async(table,id)=>table==='commands'?receipts.get(id)??null:table==='containers'?projects: id===null?[...tasks.values()]:tasks.get(id)??null,verifyNativeProof:(kind,reference,nonce)=>{const p=proofs.get(nonce);proofs.delete(nonce);return p?.kind===kind&&p?.reference===reference},clock:()=>now}
  let service=await createLocalAPIService(options)
  await service.configure({enabled:true,port:0},proof('configure','server'))
  const issue=async(scopes=['tasks:read','tasks:create','commands:read'],project_ids=[])=>service.issue({label:'synthetic test',scopes,project_ids,expiresAt:new Date(now+86400000).toISOString()},proof('configure','token'))
  const server=await createLocalAPIServer({service,port:0}),base='http://127.0.0.1:'+server.port+'/api/v1'
  async function request(token,url='/tasks',init={}) {const r=await fetch(base+url,{...init,headers:{authorization:'Bearer '+token,...init.headers}});return {status:r.status,body:await r.json(),headers:r.headers} }
  const post=(token,command,extra={})=>request(token,'/commands',{method:'POST',body:typeof command==='string'?command:JSON.stringify(command),headers:{'content-type':'application/json','idempotency-key':typeof command==='string'?crypto.randomUUID():command.command_id,...extra}})
  try { await run({root,safeStorage,settings,receipts,tasks,projects,proof,options,service,server,issue,request,post,setNow:value=>now=value,now:()=>now,restart:async()=>{service=await createLocalAPIService(options);return service}}) }
  finally { await server.close();await fs.rm(root,{recursive:true,force:true}) }
}
const command=()=>({command_id:crypto.randomUUID(),type:'task.create',payload:{title:'literal 25pt',notes:'private note',scheduled_date:'2026-10-03'}})

test('real HTTP: readonly creates no journal; replay has one pending and one durable receipt after restart/rename',()=>fixture(async f=>{
  const ro=await f.issue(['tasks:read']),write=await f.issue(),c=command()
  assert.equal((await f.post(ro.token,c)).status,403)
  assert.deepEqual(await fs.readdir(path.join(f.root,'journal')).catch(()=>[]),[])
  for(let i=0;i<2;i++)assert.equal((await f.post(write.token,c)).status,202)
  const [pending]=await f.service.pending();assert.equal((await f.service.pending()).length,1)
  const lease=await f.service.authorize({tokenId:write.record.tokenId,commandId:c.command_id,digest:pending.digest},f.proof('approve',c.command_id))
  await assert.rejects(f.service.applied({leaseId:lease.id}),/RECEIPT_MISSING/)
  const taskId=crypto.randomUUID()
  f.tasks.set(taskId,{id:taskId,generationKey:null,title:'renamed after commit',status:'open',deletedAt:null,notes:'never exposed'})
  f.receipts.set(localAPIReceiptKey(write.record.tokenId,c.command_id),{hash:pending.digest,resultId:taskId,at:new Date().toISOString()})
  const restarted=await f.restart()
  const t=await restarted.authenticate('Bearer '+write.token,'commands:read')
  assert.equal((await restarted.getCommand(t,c.command_id)).task_id,taskId)
  const repeated=await f.post(write.token,c);assert.equal(repeated.status,200);assert.equal(repeated.body.data.task_id,taskId)
  assert.equal((await f.post(write.token,{...c,payload:{title:'changed'}})).status,409)
  const read=await f.request(write.token);assert.equal(read.status,200);assert.equal(Object.hasOwn(read.body.data.items[0],'notes'),false)
  const saved=JSON.parse(f.safeStorage.decryptString(await fs.readFile(path.join(f.root,'config.bin'))))
  // A base64url secret itself may contain underscores. Check all 43 characters,
  // rather than a random short suffix that can coincide with unrelated metadata.
  const tokenSecret=write.token.slice(('michi_'+write.record.tokenId+'_').length)
  assert.equal(tokenSecret.length,43)
  assert.equal(JSON.stringify(saved).includes(write.token),false);assert.equal(JSON.stringify(saved).includes(tokenSecret),false)
  assert.equal((await restarted.pending()).length,0)
}))

test('real HTTP boundary and strict schema: Host, Origin, Sec-Fetch-Site, size, JSON, fields and idempotency',()=>fixture(async f=>{
  const w=await f.issue(),c=command()
  for(const headers of [{Host:'evil.test'}, {Origin:'https://example.org'},{'Sec-Fetch-Site':'same-origin'}]) {
    const status=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:f.server.port,path:'/api/v1/tasks',headers:{authorization:'Bearer '+w.token,...headers}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.end()})
    assert.equal(status,403)
  }
  assert.throws(()=>localAPIRequestBoundary({socket:{remoteAddress:'192.0.2.1'},headers:{host:'127.0.0.1:80'},url:'/api/v1/tasks'},80),/REQUEST_ORIGIN_DENIED/)
  for(const value of [{...c,extra:true},{...c,payload:{title:'x',manual_points:25}},{...c,type:'task.complete'},{...c,payload:{title:'x',scheduled_date:'2026-02-30'}}])assert.equal((await f.post(w.token,value)).status,422)
  assert.equal((await f.post(w.token,c,{'Idempotency-Key':crypto.randomUUID()})).status,400)
  assert.equal((await f.post(w.token,'{broken')).status,400)
  assert.equal((await f.post(w.token,'x'.repeat(65537))).status,413)
  assert.equal((await f.post(w.token,c,{'content-type':'text/plain'})).status,415)
  const valid=await f.request(w.token);assert.equal(valid.headers.has('access-control-allow-origin'),false)
  assert.deepEqual(Object.keys(valid.body.meta).sort(),['request_id','schema_version','server_time'])
  const chunked=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:f.server.port,path:'/api/v1/commands',method:'POST',headers:{authorization:'Bearer '+w.token,'content-type':'application/json','idempotency-key':c.command_id}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.write('x'.repeat(65537));req.end()})
  assert.equal(chunked,413)
}))

test('revocation, epoch, source authority, expiry and freeze fail closed before mutation',()=>fixture(async f=>{
  const w=await f.issue(),c=command();await f.post(w.token,c)
  await assert.rejects(f.service.authorize({tokenId:w.record.tokenId,commandId:c.command_id,digest:'x'},'forged'),/HUMAN_APPROVAL_REQUIRED/)
  f.settings.changePolicy.epoch++;assert.equal((await f.request(w.token)).status,401);f.settings.changePolicy.epoch--
  f.settings.changePolicy.sourcePermissionRevision++;assert.equal((await f.request(w.token)).status,401);f.settings.changePolicy.sourcePermissionRevision--
  f.settings.datasetMode='frozen';assert.equal((await f.request(w.token)).status,401);f.settings.datasetMode='active'
  f.settings.aiEnabled=false;assert.equal((await f.post(w.token,command())).status,403);f.settings.aiEnabled=true
  await f.service.revoke(w.record.tokenId);assert.equal((await f.request(w.token)).status,401);assert.equal((await f.service.pending()).length,0)
  const expired=await f.issue();f.setNow(f.now()+86400001);assert.equal((await f.request(expired.token)).status,401)
}))

test('61st authenticated request in one minute is rate limited',()=>fixture(async f=>{
  const w=await f.issue(['tasks:read'])
  for(let i=0;i<60;i++)assert.equal((await f.request(w.token)).status,200)
  assert.equal((await f.request(w.token)).status,429)
  f.setNow(f.now()+60000);assert.equal((await f.request(w.token)).status,200)
}))

test('project scope is enforced on list and detail, and opaque cursor binds filter',()=>fixture(async f=>{
  const id=crypto.randomUUID();f.projects.push({id,ownerId:f.settings.profileId,kind:'project',deletedAt:null})
  const w=await f.issue(['tasks:read'],[id]),other=crypto.randomUUID()
  for(let i=0;i<4;i++){const taskId=crypto.randomUUID();f.tasks.set(taskId,{id:taskId,title:'safe',containerId:i===3?other:id,status:'open',deletedAt:null,updatedAt:new Date().toISOString()})}
  const result=await f.request(w.token,'/tasks?limit=1');assert.equal(result.body.data.items.length,1)
  const cursor=encodeURIComponent(result.body.data.next_cursor)
  assert.equal((await f.request(w.token,'/tasks?limit=1&cursor='+cursor)).status,200)
  assert.equal((await f.request(w.token,'/tasks?limit=2&cursor='+cursor)).status,422)
  const hidden=[...f.tasks.values()].find(t=>t.containerId===other)
  assert.equal((await f.request(w.token,'/tasks/'+hidden.id)).status,404)
  assert.equal((await f.request(w.token,'/tasks?limit=201')).status,422)
}))

test('durable unindexed claim is recovered and signed files cannot be moved to another command',()=>fixture(async f=>{
  const w=await f.issue(),c=command();await f.post(w.token,c)
  const configPath=path.join(f.root,'config.bin'),saved=JSON.parse(f.safeStorage.decryptString(await fs.readFile(configPath)))
  saved.tokens[0].commandIds=[];await fs.writeFile(configPath,f.safeStorage.encryptString(JSON.stringify(saved)))
  const restarted=await f.restart();assert.equal((await restarted.pending()).length,1)
  const token=await restarted.authenticate('Bearer '+w.token,'tasks:create')
  assert.equal((await restarted.submit(token,c,c.command_id)).state,'awaiting_approval')
  const copy=crypto.randomUUID(),dir=path.join(f.root,'journal',w.record.tokenId)
  await fs.copyFile(path.join(dir,c.command_id+'.claim.bin'),path.join(dir,copy+'.claim.bin'))
  await assert.rejects(restarted.getCommand(token,copy),/JOURNAL_INVALID/)
}))

test('private store refuses unavailable encryption, traversal, hardlinks and malformed config',()=>fixture(async f=>{
  await assert.rejects(createPrivateJSONStore({directory:f.root,safeStorage:{isEncryptionAvailable:()=>false}}),/PRIVATE_STORAGE_UNAVAILABLE/)
  const store=await createPrivateJSONStore({directory:f.root,safeStorage:f.safeStorage})
  await assert.rejects(store.save('..',{x:1}),/PRIVATE_NAME_INVALID/)
  await store.save('plain.bin',{safe:true});await fs.link(path.join(f.root,'plain.bin'),path.join(f.root,'linked.bin'))
  await assert.rejects(store.load('linked.bin'),/PRIVATE_FILE_UNSAFE/)
  const cfg=JSON.parse(f.safeStorage.decryptString(await fs.readFile(path.join(f.root,'config.bin'))));cfg.tokens=[{tokenId:'broken'}]
  await fs.writeFile(path.join(f.root,'config.bin'),f.safeStorage.encryptString(JSON.stringify(cfg)))
  await assert.rejects(f.restart(),/CONFIG_INVALID/)
}))
