import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
const require=createRequire(import.meta.url)
const {createLocalActionService,signLocalActionRequest,verifyLocalActionResult,MAX_OUTPUT_BYTES,MAX_RUN_MS}=require('./local-actions.cjs')
const KEY=Buffer.alloc(32,19)
const STAMP=Date.parse('2026-10-01T00:00:00Z')
const genuineTicket=Object.freeze({})

async function fixture(t,options={}) {
  const root=await mkdtemp(path.join(await realpath(tmpdir()),'coach-local-actions-test-'))
  const journal=path.join(root,'journal');await mkdir(journal)
  t.after(async()=>{const resolved=path.resolve(root);assert.equal(path.dirname(resolved),await realpath(tmpdir()));assert.ok(path.basename(resolved).startsWith('coach-local-actions-test-'));assert.equal(await realpath(resolved),resolved);await rm(resolved,{recursive:true,force:true})})
  const sha256=crypto.createHash('sha256').update(await readFile(process.execPath)).digest('hex')
  const context={ownerId:'owner-test',datasetId:'dataset-test',deviceId:'device-test',policyEpoch:3,sourcePermissionRevision:2,enabled:true}
  const definition={id:'fixed-test',revision:1,ownerId:context.ownerId,datasetId:context.datasetId,deviceId:context.deviceId,executable:process.execPath,executableRoot:path.dirname(process.execPath),sha256,cwd:root,schema:{},argv:['-e','process.stdout.write("harmless local test")'],lowRisk:true,...options.definition}
  const calls=[]
  let stamp=STAMP
  const spawn=options.spawn??((file,args,flags)=>{
    calls.push({file,args,flags})
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough()
    child.kill=()=>{queueMicrotask(()=>child.emit('close',null,'SIGKILL'));return true}
    queueMicrotask(()=>{child.stdout.write(options.output??'harmless stub');child.emit('close',0,null)})
    return child
  })
  const config={signingKey:KEY,registrations:[definition],journalDirectory:journal,getCurrentContext:()=>context,verifyHumanApproval:(_review,proof)=>proof===genuineTicket,now:()=>stamp,spawn}
  const service=await createLocalActionService(config)
  const unsigned={version:1,requestId:'request-one',nonce:'nonce-one',issuedAt:STAMP,expiresAt:STAMP+60000,ownerId:context.ownerId,datasetId:context.datasetId,deviceId:context.deviceId,policyEpoch:3,sourcePermissionRevision:2,definitionRevision:1,actionId:definition.id,event:'owner-click',params:{}}
  const request=(patch={})=>signLocalActionRequest({...unsigned,...patch},KEY)
  return {root,journal,definition,context,calls,config,service,request,advance:ms=>{stamp+=ms}}
}
async function allowed(f,request=f.request()) {const grant=await f.service.approve(request,genuineTicket);return f.service.execute(request,grant)}
async function rejects(promise,code) {await assert.rejects(promise,error=>error.code===code)}

test('default denied execution; only app-verifier opaque approval permits a fixed launch',async t=>{
  const f=await fixture(t),req=f.request(),review=await f.service.prepare(req)
  assert.equal(review.approvalRequired,true)
  await rejects(f.service.execute(req,{approved:true,ownerId:'owner-test'}),'HUMAN_APPROVAL_REQUIRED')
  await rejects(f.service.approve(req,{approved:true}),'HUMAN_APPROVAL_REQUIRED')
  const grant=await f.service.approve(req,genuineTicket)
  await rejects(f.service.execute(req,structuredClone(grant)),'HUMAN_APPROVAL_REQUIRED')
  const receipt=await f.service.execute(req,grant)
  assert.equal(receipt.status,'succeeded');assert.equal(receipt.output,'harmless stub');assert(verifyLocalActionResult(receipt,KEY))
  assert.equal(f.calls.length,1)
  const launch=f.calls[0]
  assert.equal(launch.file,process.execPath);assert.deepEqual(launch.args,f.definition.argv)
  assert.equal(launch.flags.shell,false);assert.equal(launch.flags.cwd,f.root);assert.equal(launch.flags.windowsHide,true)
  assert.equal(launch.flags.timeout,MAX_RUN_MS);assert.deepEqual(launch.flags.stdio,['ignore','pipe','pipe'])
  assert.equal(launch.flags.env.PATH,undefined);assert.equal(launch.flags.env.NODE_OPTIONS,undefined);assert.equal(launch.flags.env.HOME,undefined)
})

test('signature tampering and extra executable/cwd/environment/approved fields are rejected',async t=>{
  const f=await fixture(t),req=f.request()
  await rejects(f.service.prepare({...req,params:{x:'injection'}}),'INVALID_SIGNATURE')
  for(const field of ['approved','executable','cwd','env','principal']) await rejects(f.service.prepare(f.request({[field]:'forged'})),'INVALID_INPUT')
  await rejects(f.service.prepare(f.request({actionId:'unregistered'})),'UNREGISTERED_ACTION')
  assert.equal(f.calls.length,0)
})

test('untrusted parameter graphs, nonfinite numbers and excessive strings are bounded before hashing',async t=>{
  const f=await fixture(t),req=f.request(),cyclic={};cyclic.self=cyclic
  for(const params of [cyclic,{value:Infinity},{value:'x'.repeat(4097)},{value:['nested']}])await rejects(f.service.prepare({...req,params}),'INVALID_ARGUMENT')
  assert.equal(f.calls.length,0)
})

test('all owner/dataset/device/policy/source/definition bindings are revalidated',async t=>{
  const f=await fixture(t)
  for(const field of ['ownerId','datasetId','deviceId']) await rejects(f.service.prepare(f.request({[field]:'other'})),'AUTHORITY_CHANGED')
  for(const field of ['policyEpoch','sourcePermissionRevision']) await rejects(f.service.prepare(f.request({[field]:99})),'AUTHORITY_CHANGED')
  await rejects(f.service.prepare(f.request({definitionRevision:2})),'DEFINITION_CHANGED')
  const req=f.request(),approval=await f.service.approve(req,genuineTicket)
  f.context.policyEpoch++
  await rejects(f.service.execute(req,approval),'AUTHORITY_CHANGED')
  assert.equal(f.calls.length,0)
})

test('60 second TTL, resumed expired requests, AI/action off and cleared approvals never execute',async t=>{
  const f=await fixture(t),req=f.request(),grant=await f.service.approve(req,genuineTicket)
  await rejects(f.service.prepare(f.request({expiresAt:STAMP+60001})),'REQUEST_EXPIRED')
  await rejects(f.service.prepare(f.request({issuedAt:STAMP+1})),'REQUEST_EXPIRED')
  f.service.clearAuthorities();await rejects(f.service.execute(req,grant),'HUMAN_APPROVAL_REQUIRED')
  f.context.enabled=false;await rejects(f.service.execute(req,grant),'LOCAL_ACTIONS_DISABLED');f.context.enabled=true
  f.advance(60000);await rejects(f.service.execute(req,grant),'REQUEST_EXPIRED')
  assert.equal(f.calls.length,0)
})

test('typed scalar arguments reject command/option injection, nonfinite range and extra parameters',async t=>{
  const f=await fixture(t,{definition:{schema:{label:{type:'string',maxLength:30},count:{type:'number',min:1,max:3},choice:{type:'string',maxLength:10,enum:['safe','quiet']},flag:{type:'boolean'}},argv:['-e','console.log("fixed")',{param:'label'},{param:'count'},{param:'choice'},{param:'flag'}]}})
  const params={label:'reading',count:2,choice:'safe',flag:true}
  for(const label of ['--eval',';rm','read & exit','x\ny','$(id)','x|calc']) await rejects(f.service.prepare(f.request({params:{...params,label}})),'INVALID_ARGUMENT')
  for(const count of [0,4,'2']) await rejects(f.service.prepare(f.request({params:{...params,count}})),'INVALID_ARGUMENT')
  await rejects(f.service.prepare(f.request({params:{...params,choice:'unknown'}})),'INVALID_ARGUMENT')
  await rejects(f.service.prepare(f.request({params:{...params,extra:true}})),'INVALID_INPUT')
  const result=await allowed(f,f.request({params}));assert.equal(result.status,'succeeded')
  assert.deepEqual(f.calls[0].args.slice(-4),['reading','2','safe','true'])
})

test('owner registered low risk delegation is limited by event, expiry and policy',async t=>{
  const delegation={ownerId:'owner-test',policyEpoch:3,sourcePermissionRevision:2,events:['daily-test'],expiresAt:STAMP+120000}
  const f=await fixture(t,{definition:{delegation}})
  await rejects(f.service.execute(f.request()),'HUMAN_APPROVAL_REQUIRED')
  const req=f.request({event:'daily-test'});assert.equal((await f.service.prepare(req)).approvalRequired,false)
  assert.equal((await f.service.execute(req)).status,'succeeded')
  f.advance(120000)
  const expired=f.request({requestId:'next',nonce:'next',event:'daily-test',issuedAt:STAMP+120000,expiresAt:STAMP+180000})
  await rejects(f.service.execute(expired),'HUMAN_APPROVAL_REQUIRED')
})

test('same signed request replays one signed result, including service recreation; mismatched body and nonce rejected',async t=>{
  const f=await fixture(t),req=f.request(),first=await allowed(f,req)
  assert.deepEqual(await f.service.execute(req),first)
  const secondService=await createLocalActionService(f.config)
  assert.deepEqual(await secondService.execute(req),first)
  await rejects(f.service.execute(f.request({event:'other-event'})),'REPLAY_MISMATCH')
  await rejects(allowed(f,f.request({requestId:'new-request'})),'NONCE_REPLAY')
  assert.equal(f.calls.length,1)
  assert.equal(verifyLocalActionResult({...first,exitCode:9},KEY),false)
})

test('concurrent identical executions share a single launch',async t=>{
  const f=await fixture(t),req=f.request(),grant=await f.service.approve(req,genuineTicket)
  const results=await Promise.all([f.service.execute(req,grant),f.service.execute(req,grant)])
  assert.deepEqual(results[0],results[1]);assert.equal(f.calls.length,1)
})

test('only allowed directory paths survive and symlink/hardlink arguments are rejected',async t=>{
  const f=await fixture(t)
  const selected=path.join(f.root,'selected');await mkdir(selected)
  const allowedFile=path.join(selected,'read.txt');await writeFile(allowedFile,'synthetic')
  const defs={...f.definition,schema:{file:{type:'path',roots:[selected]}},argv:['-e','console.log("fixed")',{param:'file'}]}
  const service=await createLocalActionService({...f.config,registrations:[defs]})
  const req=f.request({params:{file:allowedFile}});assert.deepEqual((await service.prepare(req)).argv.slice(-1),[allowedFile])
  await rejects(service.prepare(f.request({params:{file:path.join(selected,'..','outside')}})),'PATH_OUTSIDE_ALLOWLIST')
  const hard=path.join(selected,'hard.txt');await link(allowedFile,hard)
  await rejects(service.prepare(f.request({params:{file:hard}})),'UNSAFE_PATH_LINK')
  const dirLink=path.join(f.root,'linked');await symlink(selected,dirLink,process.platform==='win32'?'junction':'dir')
  await rejects(createLocalActionService({...f.config,registrations:[{...f.definition,cwd:dirLink}]}),'UNSAFE_PATH_LINK')
})

test('executable hash mismatch and non-schema registration options fail before launch',async t=>{
  const f=await fixture(t)
  await rejects(createLocalActionService({...f.config,registrations:[{...f.definition,sha256:'0'.repeat(64)}]}),'EXECUTABLE_CHANGED')
  for(const field of ['shell','env','command']) await rejects(createLocalActionService({...f.config,registrations:[{...f.definition,[field]:true}]}),'INVALID_INPUT')
  await rejects(createLocalActionService({...f.config,registrations:[{...f.definition,schema:{script:{type:'string',maxLength:100}},argv:['-e',{param:'script'}]}]}),'UNSAFE_EXECUTABLE')
  await rejects(createLocalActionService({...f.config,registrations:[{...f.definition,lowRisk:false,delegation:{ownerId:'owner-test',policyEpoch:3,sourcePermissionRevision:2,events:['test'],expiresAt:STAMP+1000}}]}),'INVALID_DELEGATION')
  assert.equal(f.calls.length,0)
})

test('output credentials are redacted and combined output is capped at 64 KiB',async t=>{
  const f=await fixture(t,{output:'password=synthetic-secret token=synthetic-token sk-example12345678 Bearer synthetic-bearer\n'+KEY.toString('hex')+'\n'+'x'.repeat(MAX_OUTPUT_BYTES)})
  const result=await allowed(f)
  assert.equal(result.outputTruncated,true);assert(Buffer.byteLength(result.output)<=MAX_OUTPUT_BYTES)
  for(const secret of ['synthetic-secret','synthetic-token','sk-example12345678','synthetic-bearer',KEY.toString('hex')]) assert(!result.output.includes(secret))
})

test('unfinished durable claim recovers as unknown without launching again',async t=>{
  const f=await fixture(t),req=f.request(),first=await allowed(f)
  const files=await readdir(f.journal),filename=files.find(v=>!v.startsWith('nonce-'))
  const {signature,status,exitCode,signal,output,outputTruncated,timedOut,completedAt,...claim}=first
  void signature;void status;void exitCode;void signal;void output;void outputTruncated;void timedOut;void completedAt
  const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}'
  const claimSignature=crypto.createHmac('sha256',KEY).update('local-action-claim-v1\n'+canonical(claim)).digest('hex')
  await writeFile(path.join(f.journal,filename),JSON.stringify({...claim,claimSignature}))
  const restarted=await createLocalActionService(f.config),result=await restarted.execute(req)
  assert.equal(result.status,'unknown');assert(verifyLocalActionResult(result,KEY));assert.equal(f.calls.length,1)
})

test('redaction expansion cannot exceed 64 KiB',async t=>{
  const f=await fixture(t,{output:'token=x '.repeat(10000)})
  const result=await allowed(f);assert.equal(result.outputTruncated,true);assert(Buffer.byteLength(result.output)<=MAX_OUTPUT_BYTES)
})

test('tampered durable receipt and unsigned unfinished claim are never trusted',async t=>{
  const f=await fixture(t),req=f.request(),first=await allowed(f)
  const filename=(await readdir(f.journal)).find(v=>!v.startsWith('nonce-'))
  await writeFile(path.join(f.journal,filename),JSON.stringify({...first,output:'forged'}))
  await rejects(f.service.execute(req),'INVALID_JOURNAL')
  const {signature,...unfinished}=first;void signature
  await writeFile(path.join(f.journal,filename),JSON.stringify(unfinished))
  await rejects(f.service.execute(req),'INVALID_JOURNAL');assert.equal(f.calls.length,1)
})

test('30 second timeout terminates only the spawned child and produces a signed bounded result',async t=>{
  let child,killSignal
  const f=await fixture(t,{spawn:()=>{
    child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough()
    child.kill=signal=>{killSignal=signal;return true}
    return child
  }})
  const req=f.request(),approval=await f.service.approve(req,genuineTicket)
  t.mock.timers.enable({apis:['setTimeout']})
  const execution=f.service.execute(req,approval)
  // Filesystem verification is real; let it finish before advancing only timers.
  while(!child)await new Promise(resolve=>setImmediate(resolve))
  t.mock.timers.tick(MAX_RUN_MS)
  const result=await execution
  assert.equal(killSignal,'SIGKILL');assert.equal(result.status,'timed_out');assert.equal(result.timedOut,true)
  assert.equal(result.exitCode,null);assert(verifyLocalActionResult(result,KEY))
})

test('real allowlisted process emits harmless output, does not inherit secret-shaped environment',async t=>{
  const previous=process.env.COACH_TEST_I08_NO_INHERIT
  process.env.COACH_TEST_I08_NO_INHERIT='synthetic-fake-value'
  t.after(()=>{if(previous===undefined)delete process.env.COACH_TEST_I08_NO_INHERIT;else process.env.COACH_TEST_I08_NO_INHERIT=previous})
  const f=await fixture(t,{definition:{argv:['-e','process.stdout.write("real harmless test:" + String(process.env.COACH_TEST_I08_NO_INHERIT))']}})
  const service=await createLocalActionService({...f.config,spawn:undefined})
  const req=f.request(),approval=await service.approve(req,genuineTicket),result=await service.execute(req,approval)
  assert.equal(result.status,'succeeded');assert.equal(result.exitCode,0)
  assert.equal(result.output,'real harmless test:undefined');assert(verifyLocalActionResult(result,KEY))
})
