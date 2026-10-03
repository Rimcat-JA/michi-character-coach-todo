import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url), { createFileBridgeHub } = require('./file-bridge-hub.cjs'), { createMCPFileClient } = require('./mcp-file-client.cjs')
async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'michi-hub-tests-'))
  t.after(async () => { assert.equal(path.dirname(root), temp); assert.ok(path.basename(root).startsWith('michi-hub-tests-')); assert.equal(await fs.realpath(root), root); await fs.rm(root, {recursive:true,force:true,maxRetries:5,retryDelay:50}) })
  const settings = { profileId: 'synthetic-owner', datasetId: crypto.randomUUID(), aiEnabled: false, externalAI: {version:1,enabled:true,epoch:0,clients:[]}, changePolicy: {epoch:1,sourcePermissionRevision:1,aiChangesEnabled:true} }
  const task = label => ({id:crypto.randomUUID(),revision:1,title:label,notes:'メモ '+label,scheduledDate:'2026-10-03',containerId:null,deletedAt:null,score:{mode:'manual',manualPoints:25}}), a = task('client A only'), b = task('client B only'), receipts = new Map(), proofs = new Map()
  let saved = null, failSave = false
  const native = (kind, reference='') => { const nonce=crypto.randomUUID();proofs.set(nonce,{kind,reference});return nonce }
  const options = { agentDirectory:path.join(root,'agents'),journalDirectory:path.join(root,'private'),signingKey:Buffer.alloc(32,19),getSettings:async()=>settings,getTasks:async ids=>[a,b].filter(task=>ids.includes(task.id)),getReceipt:async key=>receipts.get(key),loadConfiguration:async()=>structuredClone(saved),saveConfiguration:async value=>{if(failSave&&value.connections.length)throw Error('synthetic disk failure');saved=structuredClone(value)},verifyNativeProof:(kind,reference,nonce)=>{const proof=proofs.get(nonce);proofs.delete(nonce);return proof?.kind===kind&&proof?.reference===reference} }
  const hub = await createFileBridgeHub(options)
  const config = task => ({ownerId:settings.profileId,datasetId:settings.datasetId,policyEpoch:1,sourcePermissionRevision:1,intendedHost:'codex',taskIds:[task.id],fields:['title','notes','scheduled_date'],lifetimeHours:1,automation:null})
  async function connect(task) { const status=await hub.configure(config(task),native('configure'));await hub.exportSnapshot({tasks:[{id:task.id}]});return {...status,...await hub.status()} }
  async function propose(status, task, commandId) {
    await hub.selectClient({clientId:status.registration.client.id});const client=await createMCPFileClient(status.root), snapshot=await client.snapshot()
    await client.proposeUpdate({commandId,snapshotId:snapshot.manifest.snapshot_id,targetId:task.id,expectedRevision:1,payload:{notes:task.title+' proposed'}})
    const entry=(await hub.scanInbox()).entries.find(item=>item.prepared?.command.command_id===commandId)
    return {client,entry,binding:{reference:entry.reference,fileDigest:entry.prepared.digest,applicationDigest:crypto.createHash('sha256').update(task.id).digest('hex'),ownerId:settings.profileId,datasetId:settings.datasetId,policyEpoch:1,sourcePermissionRevision:1}}
  }
  function persist(proposal, lease, task) { const commandId=proposal.entry.prepared.command.command_id, receipt={version:1,commandId,fileDigest:proposal.binding.fileDigest,applicationDigest:proposal.binding.applicationDigest,ownerId:settings.profileId,datasetId:settings.datasetId,clientId:lease.clientId,policyEpoch:1,sourcePermissionRevision:1,registrationRevision:1,grantEpoch:1,taskIds:[task.id],appliedAt:new Date().toISOString()};const key=`filebridge:applied:${lease.clientId}:${commandId}`;receipts.set(key,{key,hash:receipt.applicationDigest,resultId:JSON.stringify(receipt),at:receipt.appliedAt});return receipt }
  return {root,settings,a,b,hub,options,native,config,connect,propose,persist,receipts,saved:()=>saved,setFail:value=>failSave=value,setSaved:value=>saved=value}
}
test('two clients read only their own selected copies and retain independent grants across selection and BYOK OFF',async t=>{
  const f=await fixture(t),a=await f.connect(f.a),b=await f.connect(f.b)
  assert.notEqual(a.root,b.root);assert.equal((await f.hub.listConnections()).length,2);assert.equal(f.settings.aiEnabled,false)
  const ca=await createMCPFileClient(a.root),cb=await createMCPFileClient(b.root),sa=await ca.snapshot(),sb=await cb.snapshot()
  assert.deepEqual(sa.tasks.map(task=>task.id),[f.a.id]);assert.deepEqual(sb.tasks.map(task=>task.id),[f.b.id])
  await assert.rejects(ca.proposeUpdate({commandId:crypto.randomUUID(),snapshotId:sa.manifest.snapshot_id,targetId:f.b.id,expectedRevision:1,payload:{notes:'foreign'}}),error=>error.code==='TARGET_OR_REVISION_INVALID')
  await f.hub.selectClient({clientId:a.registration.client.id});assert.equal((await f.hub.status()).root,a.root)
  await f.hub.disconnect({clientId:a.registration.client.id},f.native('disconnect',a.registration.client.id))
  await assert.rejects(ca.snapshot(),error=>error.code==='CONNECTION_REVOKED');assert.equal((await cb.snapshot()).tasks[0].id,f.b.id)
  await f.hub.selectClient({clientId:b.registration.client.id});assert.equal((await f.hub.status()).connected,true)
})
test('same command UUID has distinct durable receipts; revoking A keeps a pending B lease and its result bound',async t=>{
  const f=await fixture(t),a=await f.connect(f.a),b=await f.connect(f.b),id=crypto.randomUUID(),pa=await f.propose(a,f.a,id),pb=await f.propose(b,f.b,id)
  const la=await f.hub.authorizeApplication(pa.binding,f.native('approve',pa.binding.reference)),lb=await f.hub.authorizeApplication(pb.binding,f.native('approve',pb.binding.reference))
  await assert.rejects(f.hub.recordApplied({leaseId:lb.leaseId,reference:pa.binding.reference,receipt:f.persist(pa,la,f.a)}),error=>error.code==='LEASE_INVALID')
  const ar=await f.hub.recordApplied({leaseId:la.leaseId,reference:pa.binding.reference,receipt:f.persist(pa,la,f.a)});assert.equal(ar.client_id,a.registration.client.id)
  await f.hub.disconnect({clientId:a.registration.client.id},f.native('disconnect',a.registration.client.id))
  const br=await f.hub.recordApplied({leaseId:lb.leaseId,reference:pb.binding.reference,receipt:f.persist(pb,lb,f.b)})
  assert.equal(br.client_id,b.registration.client.id);assert.equal(f.receipts.size,2);assert.equal((await pb.client.result({commandId:id})).record.value.client_id,b.registration.client.id)
  await assert.rejects(f.hub.authorizeApplication(pa.binding,f.native('approve',pa.binding.reference)),error=>error.code==='LEASE_INVALID')
})
test('native configuration and disconnect proofs cannot be forged or reused, and unknown selection cannot create authority',async t=>{
  const f=await fixture(t)
  await assert.rejects(f.hub.configure(f.config(f.a),'approved=true'),error=>error.code==='HUMAN_APPROVAL_REQUIRED')
  const proof=f.native('configure'),a=await f.hub.configure(f.config(f.a),proof)
  await assert.rejects(f.hub.configure(f.config(f.b),proof),error=>error.code==='HUMAN_APPROVAL_REQUIRED')
  assert.equal((await f.hub.listConnections()).length,1)
  await assert.rejects(f.hub.selectClient({clientId:crypto.randomUUID()}),error=>error.code==='NOT_CONNECTED')
  await assert.rejects(f.hub.disconnect({clientId:a.registration.client.id},'approved=true'),error=>error.code==='HUMAN_APPROVAL_REQUIRED')
  assert.equal((await f.hub.status()).connected,true)
})
test('restart while external OFF revokes all saved, previously unloaded copies and leaves an empty configuration',async t=>{
  const f=await fixture(t),a=await f.connect(f.a),b=await f.connect(f.b)
  f.settings.externalAI.enabled=false
  const restarted=await createFileBridgeHub(f.options)
  assert.equal((await restarted.status()).connected,false);assert.deepEqual(f.saved().connections,[])
  for(const status of [a,b])await assert.rejects(createMCPFileClient(status.root),error=>error.code==='CONNECTION_REVOKED')
})
test('malformed saved roots, duplicate clients and link redirects cannot be loaded or revoked through another path',async t=>{
  const f=await fixture(t),a=await f.connect(f.a),saved=structuredClone(f.saved())
  f.setSaved({...saved,connections:[...saved.connections,...saved.connections]});await assert.rejects(createFileBridgeHub(f.options),error=>error.code==='CONFIG_INVALID')
  f.setSaved({...saved,connections:[{...saved.connections[0],root:path.join(f.root,'foreign')} ]});await assert.rejects(createFileBridgeHub(f.options),error=>error.code==='CONFIG_INVALID')
  f.setSaved(saved);const moved=path.join(f.root,'moved');await fs.rename(a.root,moved);await fs.symlink(moved,a.root,process.platform==='win32'?'junction':'dir');f.settings.externalAI.enabled=false
  await assert.rejects(createFileBridgeHub(f.options));assert.equal(await fs.access(path.join(moved,'revoked.json')).then(()=>true,()=>false),false)
})
test('failed durable configuration never leaves a usable external copy or an acknowledged grant',async t=>{
  const f=await fixture(t);f.setFail(true)
  await assert.rejects(f.hub.configure(f.config(f.a),f.native('configure')))
  const roots=await fs.readdir(f.options.agentDirectory);assert.equal(roots.length,1)
  await assert.rejects(createMCPFileClient(path.join(f.options.agentDirectory,roots[0])),error=>error.code==='CONNECTION_REVOKED')
  assert.equal((await f.hub.status()).connected,false)
})

test('global revoke during an in-flight configure cannot publish a live copy even after enable resumes',async t=>{
  const f=await fixture(t),getTasks=f.options.getTasks
  let release,entered
  const waiting=new Promise(resolve=>{release=resolve}),started=new Promise(resolve=>{entered=resolve})
  f.options.getTasks=async ids=>{entered();await waiting;return getTasks(ids)}
  const configuring=f.hub.configure(f.config(f.a),f.native('configure'))
  const rejected=assert.rejects(configuring,error=>error.code==='AUTHORITY_CHANGED')
  await started;await f.hub.invalidate();release();await rejected
  assert.equal((await f.hub.status()).connected,false);assert.deepEqual(f.saved().connections,[])
  for(const id of await fs.readdir(f.options.agentDirectory))await assert.rejects(createMCPFileClient(path.join(f.options.agentDirectory,id)),error=>['CONNECTION_REVOKED','ENOENT'].includes(error.code)) // Never activated copies have no registration to read.
})
test('revising A leaves B selected, its signed snapshot and its pending lease untouched',async t=>{
 const f=await fixture(t),a=await f.connect(f.a),b=await f.connect(f.b),pending=await f.propose(b,f.b,crypto.randomUUID()),lease=await f.hub.authorizeApplication(pending.binding,f.native('approve',pending.binding.reference)),reg=a.registration
 const next=await f.hub.revise({clientId:reg.client.id,expectedRevision:1,taskIds:reg.task_ids,fields:['notes'],expiresAt:reg.client.grant.expires_at,automation:null,maxScheduleShiftDays:3,maxOperationsPerDay:5,allowSplit:false,ruleIds:[],allowHistory:false,allowRoutinePreview:false,allowContextRead:false,allowExternalContext:false,allowDetection:false,allowHandoffPrepare:false,allowHandoffs:false,allowRoutineChange:false},null)
 assert.equal(next.registration.client.revision,2);assert.equal((await f.hub.status()).registration.client.id,b.registration.client.id)
 assert.equal((await(await createMCPFileClient(b.root)).snapshot()).tasks[0].id,f.b.id)
 const result=await f.hub.recordApplied({leaseId:lease.leaseId,reference:pending.binding.reference,receipt:f.persist(pending,lease,f.b)});assert.equal(result.client_id,b.registration.client.id)
 await f.hub.invalidateClient({clientId:reg.client.id});assert.equal((await f.hub.status()).registration.client.id,b.registration.client.id)
})
