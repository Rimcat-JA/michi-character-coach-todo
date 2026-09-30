import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
const require=createRequire(import.meta.url)
const {createLocalActionCoordinator}=require('./local-action-service.cjs')

async function fixture(callback,{actual=false}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'michi-local-action-service-')),journalDirectory=path.join(root,'journal')
  await fs.mkdir(journalDirectory)
  const signingKey=crypto.randomBytes(32),deviceId=crypto.randomUUID(),settings={profileId:crypto.randomUUID(),datasetId:crypto.randomUUID(),aiEnabled:true,changePolicy:{epoch:3,sourcePermissionRevision:2,aiChangesEnabled:true,taskUpdate:'require_approval'}}
  let configuration=null,history=[],spawns=0,stamp=Date.now()
  const receipts=new Map(),proofs=new Map()
  const proof=(kind,reference)=>{const nonce=crypto.randomUUID();proofs.set(nonce,{kind,reference});return nonce}
  const options={signingKey,journalDirectory,deviceId,getSettings:async()=>settings,getReceipt:async key=>receipts.get(key)??null,loadConfiguration:async()=>configuration,saveConfiguration:async value=>{configuration=structuredClone(value)},loadResults:async()=>structuredClone(history),saveResults:async value=>{history=structuredClone(value)},verifyNativeProof:async(kind,reference,nonce)=>{const value=proofs.get(nonce);proofs.delete(nonce);return value?.kind===kind&&value?.reference===reference},now:()=>stamp,...(!actual?{spawn:(file,args,flags)=>{spawns++;assert.equal(file,process.execPath);assert.deepEqual(args,['--version']);assert.equal(flags.shell,false);assert.equal(flags.windowsHide,true);assert.equal(flags.env.PATH,undefined);assert.equal(flags.env.NODE_OPTIONS,undefined);const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;queueMicrotask(()=>{child.stdout.write('vSynthetic\n');child.emit('close',0,null)});return child}}:{})}
  const service=await createLocalActionCoordinator(options),input={title:'読み取り専用のバージョン確認',executable:process.execPath,cwd:root,argv:['--version'],schema:{}}
  async function register(){const inspection=await service.inspectDefinition(input,proof('configure','inspect'));await service.configure({reference:inspection.reference,digest:inspection.digest},proof('configure',inspection.reference));return inspection}
  try{await callback({root,journalDirectory,service,options,settings,input,register,proof,receipts,spawns:()=>spawns,advance:ms=>{stamp+=ms},configuration:()=>configuration,history:()=>history})}
  finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('michi-local-action-service-'));assert.equal(await fs.realpath(root),path.resolve(root));await fs.rm(root,{recursive:true,force:true})}
}
test('host inspection computes identity and only fresh native exact-digest registration permits an action',async()=>fixture(async f=>{
  assert.equal((await f.service.status()).enabled,false)
  await assert.rejects(f.service.inspectDefinition(f.input,{approved:true}),{code:'HUMAN_APPROVAL_REQUIRED'})
  const inspected=await f.service.inspectDefinition(f.input,f.proof('configure','inspect'))
  assert.match(inspected.definition.sha256,/^[a-f0-9]{64}$/);assert.equal(f.spawns(),0)
  await assert.rejects(f.service.configure({reference:inspected.reference,digest:'0'.repeat(64)},f.proof('configure',inspected.reference)),{code:'AUTHORITY_CHANGED'})
  const nonce=f.proof('configure',inspected.reference),status=await f.service.configure({reference:inspected.reference,digest:inspected.digest},nonce)
  assert.equal(status.definitions.length,1);assert.equal(status.enabled,true)
  await assert.rejects(f.service.configure({reference:inspected.reference,digest:inspected.digest},nonce),{code:'HUMAN_APPROVAL_REQUIRED'})
}))
test('signed host request and native approval execute exactly once and persist real output and receipt',async()=>fixture(async f=>{
  const inspected=await f.register(),prepared=await f.service.prepare({actionId:inspected.definition.id,event:'owner-click',params:{}})
  assert.equal(prepared.review.approvalRequired,true);assert.equal('signature'in prepared,false)
  await assert.rejects(f.service.execute({reference:prepared.reference,digest:prepared.review.digest},{approved:true}),{code:'HUMAN_APPROVAL_REQUIRED'})
  const result=await f.service.execute({reference:prepared.reference,digest:prepared.review.digest},f.proof('approve',prepared.reference))
  assert.equal(result.status,'succeeded');assert.equal(result.output,'vSynthetic\n');assert.equal(f.spawns(),1)
  const key=`localaction:result:${result.requestId}`
  await assert.rejects(f.service.recordReceipt({requestId:result.requestId,digest:result.digest}),{code:'RECEIPT_MISSING'})
  f.receipts.set(key,{key,hash:result.digest,resultId:JSON.stringify(result),at:new Date(result.completedAt).toISOString()})
  await f.service.recordReceipt({requestId:result.requestId,digest:result.digest})
  assert.deepEqual(await f.service.execute({reference:prepared.reference,digest:prepared.review.digest},f.proof('approve',prepared.reference)),result);assert.equal(f.spawns(),1)
  const restarted=await createLocalActionCoordinator(f.options)
  assert.deepEqual((await restarted.status()).results,[result])
}))
test('no supplied executable, signature, scope, event, free command or injection can create an executable request',async()=>fixture(async f=>{
  for(const input of [{...f.input,approved:true},{...f.input,env:{SECRET:'synthetic'}},{...f.input,argv:['-e','console.log(1)']},{...f.input,argv:['--version'],schema:{unbounded:{type:'string',maxLength:100}}},{...f.input,schema:{value:{type:'path',roots:[f.root]}}}])await assert.rejects(f.service.inspectDefinition(input,f.proof('configure','inspect')))
  const inspected=await f.register()
  for(const input of [{actionId:'not-registered',event:'owner-click',params:{}},{actionId:inspected.definition.id,event:'forged-autonomous-event',params:{}},{actionId:inspected.definition.id,event:'owner-click',params:{injection:'$(id)'}},{actionId:inspected.definition.id,event:'owner-click',params:{},executable:process.execPath}])await assert.rejects(f.service.prepare(input))
  assert.equal(f.spawns(),0)
}))
test('scope, policy, source epoch, AI OFF, TTL and owner changes stop execution before spawn',async()=>{
  for(const kind of ['policy','source','ai','owner','dataset','ttl'])await fixture(async f=>{
    const inspected=await f.register(),prepared=await f.service.prepare({actionId:inspected.definition.id,event:'owner-click',params:{}})
    if(kind==='policy')f.settings.changePolicy.epoch++
    if(kind==='source')f.settings.changePolicy.sourcePermissionRevision++
    if(kind==='ai')f.settings.aiEnabled=false
    if(kind==='owner')f.settings.profileId=crypto.randomUUID()
    if(kind==='dataset')f.settings.datasetId=crypto.randomUUID()
    if(kind==='ttl')f.advance(60000)
    await assert.rejects(f.service.execute({reference:prepared.reference,digest:prepared.review.digest},f.proof('approve',prepared.reference)))
    assert.equal(f.spawns(),0)
  })
})
test('remove and invalidate discard pending authority and persistent definitions; serialized definitions cannot approve',async()=>fixture(async f=>{
  const inspected=await f.register(),prepared=await f.service.prepare({actionId:inspected.definition.id,event:'owner-click',params:{}})
  await assert.rejects(f.service.remove({actionId:inspected.definition.id},{approved:true}),{code:'HUMAN_APPROVAL_REQUIRED'})
  await f.service.remove({actionId:inspected.definition.id},f.proof('configure',`remove:${inspected.definition.id}`))
  await assert.rejects(f.service.execute({reference:prepared.reference,digest:prepared.review.digest},f.proof('approve',prepared.reference)))
  await f.register();await f.service.invalidate()
  assert.equal(f.configuration(),null);assert.deepEqual((await f.service.status()).definitions,[]);assert.equal(f.spawns(),0)
}))
test('tampered saved result signatures fail closed and caller receipt substitutions do not acknowledge output',async()=>fixture(async f=>{
  const inspected=await f.register(),prepared=await f.service.prepare({actionId:inspected.definition.id,event:'owner-click',params:{}}),result=await f.service.execute({reference:prepared.reference,digest:prepared.review.digest},f.proof('approve',prepared.reference)),key=`localaction:result:${result.requestId}`
  f.receipts.set(key,{key,hash:result.digest,resultId:JSON.stringify({...result,output:'invented success'}),at:new Date(result.completedAt).toISOString()})
  await assert.rejects(f.service.recordReceipt({requestId:result.requestId,digest:result.digest}),{code:'RECEIPT_INVALID'})
  const restarted=await createLocalActionCoordinator({...f.options,loadResults:async()=>[{...result,output:'tampered'}]})
  await assert.rejects(restarted.status(),{code:'HISTORY_INVALID'})
}))
test('native-approved fixed node --version runs locally with no shell and reports the actual version',async()=>fixture(async f=>{
  const inspected=await f.register(),prepared=await f.service.prepare({actionId:inspected.definition.id,event:'owner-click',params:{}}),result=await f.service.execute({reference:prepared.reference,digest:prepared.review.digest},f.proof('approve',prepared.reference))
  assert.equal(result.status,'succeeded');assert.equal(result.output.trim(),process.version);assert.equal(result.outputTruncated,false)
},{actual:true}))

test('failure to cache history still reports the signed OS result and never repeats the process',async()=>fixture(async f=>{
  const service=await createLocalActionCoordinator({...f.options,saveResults:async()=>{throw new Error('synthetic optional history cache failure')}})
  const inspected=await service.inspectDefinition(f.input,f.proof('configure','inspect'))
  await service.configure({reference:inspected.reference,digest:inspected.digest},f.proof('configure',inspected.reference))
  const prepared=await service.prepare({actionId:inspected.definition.id,event:'owner-click',params:{}}),first=await service.execute({reference:prepared.reference,digest:prepared.review.digest},f.proof('approve',prepared.reference))
  assert.equal(first.status,'succeeded');assert.match(first.signature,/^[a-f0-9]{64}$/)
  assert.deepEqual(await service.execute({reference:prepared.reference,digest:prepared.review.digest},f.proof('approve',prepared.reference)),first);assert.equal(f.spawns(),1)
  const records=(await fs.readdir(f.journalDirectory)).filter(name=>!name.startsWith('nonce-')&&name.endsWith('.json'))
  assert.equal(records.length,1);assert.equal(JSON.parse(await fs.readFile(path.join(f.journalDirectory,records[0]),'utf8')).status,'succeeded')
}))

test('new native registration after an owner change never carries definitions from the prior owner',async()=>fixture(async f=>{
  const first=await f.register(),oldOwner=f.settings.profileId
  f.settings.profileId=crypto.randomUUID();f.settings.datasetId=crypto.randomUUID()
  const second=await f.register(),status=await f.service.status()
  assert.equal(status.definitions.length,1);assert.equal(status.definitions[0].id,second.definition.id)
  assert.equal(status.definitions[0].ownerId,f.settings.profileId);assert.notEqual(status.definitions[0].ownerId,oldOwner)
  await assert.rejects(f.service.prepare({actionId:first.definition.id,event:'owner-click',params:{}}),{code:'UNREGISTERED_ACTION'})
  assert.equal(f.spawns(),0)
}))
