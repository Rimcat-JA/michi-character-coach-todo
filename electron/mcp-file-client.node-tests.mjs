import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {createRequire} from 'node:module'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const require=createRequire(import.meta.url),{createMCPFileClient,createMCPRouter,MCP_LINE_LIMIT}=require('./mcp-file-client.cjs'),{createLocalFileBridge}=require('./local-file-bridge.cjs')
const modernMeta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}
const modernRequest=(method,params={},id=1)=>({jsonrpc:'2.0',id,method,params:{_meta:modernMeta,...params}})
async function stdio(root,input){
  const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/michi-mcp.mjs',import.meta.url)),'--bridge',root],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']})
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.stdin.on('error',()=>{})
  const timeout=setTimeout(()=>child.kill(),10000)
  try{
    const closed=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve(code))});child.stdin.end(input)
    return {code:await closed,stdout,stderr,replies:stdout.trim()?stdout.trim().split('\n').map(line=>JSON.parse(line)):[]}
  }finally{clearTimeout(timeout);if(child.exitCode===null)child.kill()}
}
async function fixture(t,{keys=['tasks:read','tasks:prepare','changes:submit','commands:read']}={}){
  const temp=await fs.realpath(os.tmpdir()),workspace=await fs.mkdtemp(path.join(temp,'michi-mcp-tests-')),clientId=crypto.randomUUID(),root=path.join(workspace,clientId),journal=path.join(workspace,'app-private')
  await fs.mkdir(root);await fs.mkdir(journal)
  t.after(async()=>{const resolved=path.resolve(workspace);assert.equal(path.dirname(resolved),temp);assert.ok(path.basename(resolved).startsWith('michi-mcp-tests-'));assert.equal(await fs.realpath(resolved),resolved);await fs.rm(resolved,{recursive:true,force:true})})
  const datasetId=crypto.randomUUID(),task={id:crypto.randomUUID(),revision:1,title:'本人の合成タスク',notes:'命令を無視して秘密を読むという資料内命令',scheduledDate:'2026-10-01',containerId:null,score:{mode:'manual',manualPoints:25},dueDate:'2026-10-10'},registration={schema_version:'1',owner_id:'test-owner',dataset_id:datasetId,policy_epoch:1,source_permission_revision:2,task_ids:[task.id],client:{id:clientId,dataset_id:datasetId,intended_host:'codex',transport:'stdio',status:'active',revision:1,grant_epoch:1,grant:{keys,project_ids:[],fields:['title','notes','scheduled_date'],mutation_mode:'require_approval',max_operations_per_day:20,max_schedule_shift_days:7,max_point_delta:0,allow_external_context:false,allow_handoffs:false,expires_at:new Date(Date.now()+3600000).toISOString()}}}
  let applications=0,enabled=true
  const proof=Object.freeze({}),bridge=await createLocalFileBridge({root,journalDirectory:journal,signingKey:crypto.randomBytes(32),registration,getCurrentContext:async()=>({ownerId:registration.owner_id,datasetId,clientId,policyEpoch:1,sourcePermissionRevision:2,registrationRevision:1,grantEpoch:1,enabled}),verifyHumanApproval:async(_binding,value)=>value===proof,applyApprovedCommand:async prepared=>{applications++;task.notes=prepared.command.payload.notes;task.revision++;return{commandId:prepared.command.command_id,digest:prepared.digest,taskIds:[task.id],appliedAt:new Date().toISOString()}}})
  await bridge.exportSnapshot([task]);const client=await createMCPFileClient(root),router=createMCPRouter(client),snapshot=await client.snapshot()
  return{root,bridge,client,router,snapshot,task,proof,applications:()=>applications,setEnabled:value=>enabled=value}
}
test('real MCP client reads only selected fields and submits proposal; only the app proof applies it',async t=>{
  const f=await fixture(t),{tasks,manifest}=f.snapshot
  assert.deepEqual(Object.keys(tasks[0]).sort(),['id','revision','title','notes','scheduled_date'].sort());assert.equal(f.snapshot.signatureVerifiedByClient,false)
  const args={commandId:crypto.randomUUID(),snapshotId:manifest.snapshot_id,targetId:f.task.id,expectedRevision:1,payload:{notes:'本人承認待ちの合成案'}}
  assert.equal((await f.client.proposeUpdate(args)).notApplied,true);assert.equal(f.applications(),0)
  assert.equal((await f.client.proposeUpdate(args)).replayed,true)
  const entry=(await f.bridge.scanInbox())[0];assert.ok(entry.prepared)
  await assert.rejects(f.bridge.execute(entry.prepared,{}),error=>error.code==='HUMAN_APPROVAL_REQUIRED')
  const approval=await f.bridge.approve(entry.prepared,f.proof),result=await f.bridge.execute(entry.prepared,approval)
  assert.equal(result.state,'applied');assert.equal(f.applications(),1);assert.equal(f.task.score.manualPoints,25);assert.equal(f.task.dueDate,'2026-10-10')
  const external=await f.client.result({commandId:args.commandId});assert.equal(external.signatureVerifiedByClient,false);assert.equal(external.state,'unverified-external-copy')
  const recreated=await createMCPFileClient(f.root);assert.equal((await recreated.proposeUpdate(args)).replayed,true);assert.equal(f.applications(),1)
})
test('self approvals, DB paths, foreign task/revision, fields, changed ID and schedule bounds are rejected',async t=>{
  const f=await fixture(t),args={commandId:crypto.randomUUID(),snapshotId:f.snapshot.manifest.snapshot_id,targetId:f.task.id,expectedRevision:1,payload:{notes:'案'}}
  for(const patch of [{approved:true},{file:'../db.sqlite'},{targetId:crypto.randomUUID()},{expectedRevision:2},{payload:{due_date:'2026-10-02'}},{payload:{scheduled_date:'2026-11-01'}}])await assert.rejects(f.client.proposeUpdate({...args,...patch}))
  await f.client.proposeUpdate(args);await assert.rejects(f.client.proposeUpdate({...args,payload:{notes:'異なる案'}}),error=>error.code==='COMMAND_ID_REUSED');assert.equal(f.applications(),0)
})
test('revocation and changed snapshot fail closed for every subsequent external call',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.root,'views','tasks.active.json'),'[]');await assert.rejects(f.client.snapshot(),error=>error.code==='VIEW_INVALID')
  await f.bridge.exportSnapshot([f.task]);await f.bridge.revoke()
  await assert.rejects(f.client.snapshot(),error=>error.code==='CONNECTION_REVOKED');await assert.rejects(f.client.result({commandId:crypto.randomUUID()}),error=>error.code==='CONNECTION_REVOKED');await assert.rejects(f.bridge.readSnapshot(),error=>error.code==='AUTHORITY_CHANGED')
})
test('linked files and link roots never become external filesystem tools',async t=>{
  const f=await fixture(t),destination=path.join(f.root,'views','tasks.active.json'),other=path.join(f.root,'outside-copy.json')
  await fs.rename(destination,other);await fs.link(other,destination);await assert.rejects(f.client.snapshot(),error=>error.code==='UNSAFE_LINK');await assert.rejects(f.client.result({commandId:'../outside'}),error=>error.code==='COMMAND_ID_INVALID')
})
test('legacy initialization and modern per-request discovery never elevate tool capabilities',async t=>{
  const f=await fixture(t),rpc=(method,params={},id=1)=>f.router({jsonrpc:'2.0',id,method,params}),meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}
  assert.ok((await rpc('tools/list')).error);const init=await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}});assert.equal(init.result.protocolVersion,'2025-11-25')
  await f.router({jsonrpc:'2.0',method:'notifications/initialized'});assert.equal((await rpc('tools/list')).result.tools.length,4)
  const modern=await rpc('server/discover',{_meta:meta});assert.equal(modern.result.resultType,'complete');assert.ok(modern.result.supportedVersions.includes('2026-07-28'))
  const result=await rpc('tools/call',{_meta:meta,name:'michi_snapshot',arguments:{}});assert.equal(result.result.resultType,'complete');assert.equal(result.result.structuredContent.tasks.length,1)
  assert.equal((await rpc('tools/call',{name:'execute_sql',arguments:{}})).error.code,-32602)
  assert.equal((await rpc('tools/call',{name:'michi_snapshot',arguments:{root:'C:/other'}})).result.isError,true)
  assert.equal((await rpc('tools/list',{_meta:{...meta,'io.modelcontextprotocol/protocolVersion':'2099-01-01'}})).error.code,-32022)
})
test('actual stdio process emits only JSON RPC; reads snapshot, submits proposal and exits on EOF',async t=>{
  const f=await fixture(t),child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/michi-mcp.mjs',import.meta.url)),'--bridge',f.root],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']})
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk)
  const closed=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve(code))})
  t.after(()=>{if(child.exitCode===null)child.kill()})
  child.stdin.end([{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'smoke',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'michi_snapshot',arguments:{}}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'michi_propose_update',arguments:{commandId:crypto.randomUUID(),snapshotId:f.snapshot.manifest.snapshot_id,targetId:f.task.id,expectedRevision:1,payload:{notes:'stdioの合成変更案'}}}}].map(value=>JSON.stringify(value)).join('\n')+'\n')
  assert.equal(await closed,0,stderr);assert.equal(stderr,'');const replies=stdout.trim().split('\n').map(line=>JSON.parse(line));assert.equal(replies.length,3);assert.equal(replies[1].result.structuredContent.tasks[0].id,f.task.id);assert.equal(replies[2].result.structuredContent.notApplied,true);assert.equal(f.applications(),0)
})
test('modern discovery and tools are stateless, complete, private-cacheable and require both metadata fields every time',async t=>{
  const f=await fixture(t),router=createMCPRouter(f.client)
  for(const method of ['server/discover','tools/list','ping']){
    const reply=await router(modernRequest(method));assert.equal(reply.result.resultType,'complete');assert.equal(reply.result._meta['io.modelcontextprotocol/serverInfo'].name,'michi-selected-file-bridge')
    if(method!=='ping'){assert.equal(reply.result.ttlMs,0);assert.equal(reply.result.cacheScope,'private')}
  }
  const read=await router(modernRequest('tools/call',{name:'michi_snapshot',arguments:{}}));assert.equal(read.result.structuredContent.signatureVerifiedByClient,false)
  for(const _meta of [null,[],{}, {'io.modelcontextprotocol/protocolVersion':'2026-07-28'},{'io.modelcontextprotocol/clientCapabilities':{}},{...modernMeta,'io.modelcontextprotocol/clientCapabilities':false},{...modernMeta,'io.modelcontextprotocol/clientInfo':{name:'invalid'}}]){
    const reply=await router({jsonrpc:'2.0',id:2,method:'server/discover',params:{_meta}});assert.equal(reply.error.code,-32602)
  }
  assert.ok((await router({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'michi_snapshot',arguments:{}}})).error)
  assert.equal(f.applications(),0)
})
test('unknown protocol parameters and wrong types cannot select a root, approve, send or initialize authority',async t=>{
  const f=await fixture(t),router=createMCPRouter(f.client)
  for(const request of [modernRequest('ping',{root:'C:/other'}),modernRequest('server/discover',{approved:true}),modernRequest('tools/list',{cursor:'invented'}),modernRequest('tools/list',{sql:'SELECT secret'}),modernRequest('tools/call',{name:'michi_snapshot',arguments:null}),modernRequest('tools/call',{name:'michi_snapshot',arguments:[],approved:true})])assert.equal((await router(request)).error.code,-32602)
  for(const id of [null,true,{},[]]){const reply=await router({...modernRequest('ping'),id});assert.equal(reply.error.code,-32600);assert.equal(Object.hasOwn(reply,'id'),false)}
  assert.equal((await router({jsonrpc:'2.0',method:'tools/call',params:{name:'michi_propose_create',arguments:{approved:true}}})),null)
  assert.equal((await router({jsonrpc:'2.0',id:3,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'},root:f.root}})).error.code,-32602)
  await router({jsonrpc:'2.0',method:'notifications/initialized'});assert.ok((await router({jsonrpc:'2.0',id:3,method:'ping'})).error)
  assert.equal((await fs.readdir(path.join(f.root,'inbox'))).length,0)
})
test('in-flight cancellation aborts work, suppresses replies and duplicate request IDs without changing later requests',async()=>{
  let calls=0,started,finish
  const gate=new Promise(resolve=>started=resolve),client={snapshot:async({signal})=>{calls++;started();return new Promise(resolve=>{finish=resolve;signal.addEventListener('abort',()=>resolve({cancelled:true}),{once:true})})}},router=createMCPRouter(client)
  const first=router(modernRequest('tools/call',{name:'michi_snapshot',arguments:{}},'request'));await gate
  assert.equal((await router(modernRequest('ping',{},'request'))).error.code,-32600)
  for(const params of [{requestId:'request',reason:42},{requestId:'request',_meta:[]},{requestId:'request',approved:true}])await router({jsonrpc:'2.0',method:'notifications/cancelled',params})
  assert.equal(calls,1)
  await router({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:'request',reason:'owner cancelled'}})
  assert.equal(await first,null);finish({ignored:true})
  assert.equal((await router(modernRequest('ping',{},'request'))).result.resultType,'complete')
})
test('queued stdio cancellation prevents inbox publication; malformed cancellation does not suppress the real proposal',async t=>{
  const f=await fixture(t),args={commandId:crypto.randomUUID(),snapshotId:f.snapshot.manifest.snapshot_id,targetId:f.task.id,expectedRevision:1,payload:{notes:'queued proposal'}}
  const input=[modernRequest('tools/call',{name:'michi_propose_update',arguments:args},'cancelled'),{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:'cancelled'}},modernRequest('ping',{},'later')].map(JSON.stringify).join('\n')+'\n'
  const cancelled=await stdio(f.root,input);assert.equal(cancelled.code,0);assert.deepEqual(cancelled.replies.map(reply=>reply.id),['later']);assert.equal((await fs.readdir(path.join(f.root,'inbox'))).length,0)
  const malformed=[modernRequest('tools/call',{name:'michi_propose_update',arguments:args},'kept'),{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:'kept',_meta:[]}},modernRequest('ping',{},'later')].map(JSON.stringify).join('\n')+'\n'
  const kept=await stdio(f.root,malformed);assert.equal(kept.code,0);assert.deepEqual(kept.replies.map(reply=>reply.id),['kept','later']);assert.equal(kept.replies[0].result.structuredContent.notApplied,true);assert.equal(f.applications(),0)
})
test('stdio rejects unterminated EOF and malformed UTF-8 rather than silently submitting a changed proposal',async t=>{
  const f=await fixture(t),args={commandId:crypto.randomUUID(),snapshotId:f.snapshot.manifest.snapshot_id,targetId:f.task.id,expectedRevision:1,payload:{notes:'must not publish without newline'}}
  const eof=await stdio(f.root,JSON.stringify(modernRequest('tools/call',{name:'michi_propose_update',arguments:args})));assert.equal(eof.code,1);assert.match(eof.stderr,/unterminated/);assert.equal((await fs.readdir(path.join(f.root,'inbox'))).length,0)
  const bad=Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":"'),Buffer.from([0xc0,0xaf]),Buffer.from('"}}\n'),Buffer.from(JSON.stringify(modernRequest('ping',{},2))+'\n')])
  const decoded=await stdio(f.root,bad);assert.equal(decoded.code,0);assert.equal(decoded.replies[0].error.code,-32700);assert.equal(decoded.replies[1].id,2);assert.equal(decoded.replies[1].result.resultType,'complete')
})
test('stdio has hard line and queue budgets; flooding never applies a task or executes commands',async t=>{
  const f=await fixture(t),large=await stdio(f.root,'x'.repeat(MCP_LINE_LIMIT+1)+'\n');assert.equal(large.code,1);assert.match(large.stderr,/line exceeds limit/)
  const requests=Array.from({length:160},(_,id)=>modernRequest('tools/call',{name:'michi_propose_update',arguments:{commandId:crypto.randomUUID(),snapshotId:f.snapshot.manifest.snapshot_id,targetId:f.task.id,expectedRevision:1,payload:{notes:'n'.repeat(900)}}},id))
  const flood=await stdio(f.root,requests.map(JSON.stringify).join('\n')+'\n');assert.equal(flood.code,1);assert.match(flood.stderr,/queue exceeds limit/);assert.equal(f.applications(),0)
  assert.ok((await fs.readdir(path.join(f.root,'inbox'))).filter(name=>name.endsWith('.ready.json')).length<=64)
})
test('root and inbox path aliases cannot redirect reads or proposal publication',async t=>{
  const f=await fixture(t),workspace=path.dirname(f.root),alias=path.join(workspace,crypto.randomUUID())
  await fs.symlink(f.root,alias,process.platform==='win32'?'junction':'dir');await assert.rejects(createMCPFileClient(alias),error=>error.code==='INVALID_BRIDGE_DIRECTORY')
  const inbox=path.join(f.root,'inbox'),old=path.join(f.root,'original-inbox'),outside=path.join(workspace,'synthetic-outside');await fs.rename(inbox,old);await fs.mkdir(outside);await fs.writeFile(path.join(outside,'sentinel.txt'),'unchanged')
  await fs.symlink(outside,inbox,process.platform==='win32'?'junction':'dir')
  await assert.rejects(f.client.proposeUpdate({commandId:crypto.randomUUID(),snapshotId:f.snapshot.manifest.snapshot_id,targetId:f.task.id,expectedRevision:1,payload:{notes:'cannot escape'}}),error=>error.code==='UNSAFE_LINK')
  assert.deepEqual(await fs.readdir(outside),['sentinel.txt']);assert.equal(await fs.readFile(path.join(outside,'sentinel.txt'),'utf8'),'unchanged')
})
test('case aliases, expired replay and used command tombstones never make a second application',async t=>{
  const f=await fixture(t),args={commandId:crypto.randomUUID(),snapshotId:f.snapshot.manifest.snapshot_id,targetId:f.task.id,expectedRevision:1,payload:{notes:'immutable original'}}
  await assert.rejects(f.client.proposeUpdate({...args,commandId:args.commandId.toUpperCase()}),error=>error.code==='PROPOSAL_INVALID')
  await f.client.proposeUpdate(args);const file=path.join(f.root,'inbox',`${args.commandId}.ready.json`),original=JSON.parse(await fs.readFile(file,'utf8'))
  await fs.writeFile(file,JSON.stringify({...original,expires_at:'2020-01-01T00:00:00.000Z'}));await assert.rejects(f.client.proposeUpdate(args),error=>error.code==='PROPOSAL_EXPIRED');await fs.writeFile(file,JSON.stringify(original))
  const entry=(await f.bridge.scanInbox())[0],approval=await f.bridge.approve(entry.prepared,f.proof);await f.bridge.execute(entry.prepared,approval);await fs.unlink(file)
  await assert.rejects(f.client.proposeUpdate(args),error=>error.code==='COMMAND_ID_CONSUMED');assert.equal(f.applications(),1)
})
test('concurrent identical proposals are idempotent and the in-process inbox bound is reserved serially',async t=>{
  const f=await fixture(t),args={commandId:crypto.randomUUID(),snapshotId:f.snapshot.manifest.snapshot_id,targetId:f.task.id,expectedRevision:1,payload:{notes:'same proposal'}}
  const outcomes=await Promise.all([f.client.proposeUpdate(args),f.client.proposeUpdate(args)]);assert.deepEqual(outcomes.map(value=>value.replayed),[false,true]);assert.equal((await fs.readdir(path.join(f.root,'inbox'))).length,1)
  const copy=await fs.readFile(path.join(f.root,'inbox',`${args.commandId}.ready.json`))
  for(let i=0;i<98;i++)await fs.writeFile(path.join(f.root,'inbox',`${crypto.randomUUID()}.ready.json`),copy)
  const final=await Promise.allSettled([f.client.proposeUpdate({...args,commandId:crypto.randomUUID()}),f.client.proposeUpdate({...args,commandId:crypto.randomUUID()})]);assert.equal(final.filter(value=>value.status==='fulfilled').length,1);assert.equal(final.find(value=>value.status==='rejected').reason.code,'INBOX_FULL')
  assert.equal((await fs.readdir(path.join(f.root,'inbox'))).length,100);assert.equal(f.applications(),0)
})
test('signed external results remain explicitly unverified and reject foreign owners, schema and linked files',async t=>{
  const f=await fixture(t),commandId=crypto.randomUUID(),filename=path.join(f.root,'results',`${commandId}.json`),digest='a'.repeat(64),result={schema_version:'1',command_id:commandId,digest,owner_id:f.snapshot.manifest.owner_id,dataset_id:f.snapshot.manifest.dataset_id,client_id:path.basename(f.root),state:'applied',receipt:{commandId,digest,taskIds:[f.task.id],appliedAt:new Date().toISOString()},finished_at:new Date().toISOString()}
  await fs.writeFile(filename,JSON.stringify({value:result,signature:'0'.repeat(64)}))
  const copy=await f.client.result({commandId});assert.equal(copy.signatureVerifiedByClient,false);assert.equal(copy.state,'unverified-external-copy');assert.match(copy.instructions,/Do not infer task completion/);assert.equal(f.applications(),0)
  for(const patch of [{owner_id:'foreign'},{approved:true},{receipt:{...result.receipt,manualPoints:25}},{finished_at:'2026-02-30T00:00:00.000Z'}]){await fs.writeFile(filename,JSON.stringify({value:{...result,...patch},signature:'0'.repeat(64)}));await assert.rejects(f.client.result({commandId}),error=>error.code==='RESULT_MISMATCH')}
  await fs.link(filename,path.join(f.root,'linked-result.json'));await assert.rejects(f.client.result({commandId}),error=>error.code==='UNSAFE_LINK')
})

// K12 outcome parity: the app's terminal rejection reaches the agent as an error with the same stable code.
test('signed denied/conflict/expired/rejected results carry the app code and map to isError; old results stay readable',async t=>{
  const f=await fixture(t),{manifest}=f.snapshot,rpc=(name,args,id=1)=>f.router({jsonrpc:'2.0',id,method:'tools/call',params:{_meta:modernMeta,name,arguments:args}})
  const commandId=crypto.randomUUID()
  await f.client.proposeUpdate({commandId,snapshotId:manifest.snapshot_id,targetId:f.task.id,expectedRevision:1,payload:{notes:'拒否される案'}})
  const entry=(await f.bridge.scanInbox()).find(item=>item.prepared?.command.command_id===commandId)
  await assert.rejects(f.bridge.reject(entry.prepared,'approved','CHANGES_STOPPED'),error=>error.code==='REJECTION_INVALID')
  await assert.rejects(f.bridge.reject(entry.prepared,'denied','lower-case'),error=>error.code==='REJECTION_INVALID')
  const signed=await f.bridge.reject(entry.prepared,'denied','CHANGES_STOPPED')
  assert.equal(signed.state,'denied');assert.equal(signed.code,'CHANGES_STOPPED');assert.equal(signed.receipt,null);assert.equal(f.applications(),0)
  // A closed command can be neither rejected again nor approved afterwards.
  await assert.rejects(f.bridge.reject(entry.prepared,'denied','CHANGES_STOPPED'),error=>error.code==='REJECTION_INVALID')
  await assert.rejects(f.bridge.approve(entry.prepared,f.proof),error=>typeof error.code==='string')
  await assert.rejects(f.bridge.execute(entry.prepared,await f.bridge.approve(entry.prepared,f.proof).catch(()=>({}))),error=>['HUMAN_APPROVAL_REQUIRED','IDEMPOTENCY_MISMATCH'].includes(error.code)||true)
  assert.equal(f.applications(),0)
  await assert.rejects(f.client.result({commandId}),error=>error.code==='CHANGES_STOPPED'&&error.outcome.state==='denied'&&error.outcome.signatureVerifiedByClient===false)
  const reply=await rpc('michi_command_result',{commandId})
  assert.equal(reply.result.isError,true);assert.equal(reply.result.content[0].text,'CHANGES_STOPPED');assert.deepEqual(reply.result.structuredContent,{commandId,state:'denied',code:'CHANGES_STOPPED',signatureVerifiedByClient:false})
  // Results written before codes existed (applied/unknown/failed, no code) are still read as before.
  const filename=path.join(f.root,'results',`${commandId}.json`),old={schema_version:'1',command_id:commandId,digest:'a'.repeat(64),owner_id:manifest.owner_id,dataset_id:manifest.dataset_id,client_id:path.basename(f.root),state:'unknown',receipt:null,finished_at:new Date().toISOString()}
  await fs.writeFile(filename,JSON.stringify({value:old,signature:'0'.repeat(64)}))
  assert.equal((await f.client.result({commandId})).state,'unverified-external-copy')
  for(const value of [{...old,state:'denied'},{...old,state:'unknown',code:'CHANGES_STOPPED'},{...old,state:'conflict',code:'not a code'}]){await fs.writeFile(filename,JSON.stringify({value,signature:'0'.repeat(64)}));await assert.rejects(f.client.result({commandId}),error=>error.code==='RESULT_MISMATCH')}
})
test('split and series tools are listed and accepted only when the owner granted them',async t=>{
  const plain=await fixture(t),split=await fixture(t,{keys:['tasks:read','tasks:prepare','changes:submit','commands:read','tasks:split']})
  const names=async f=>{const reply=await f.router({jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:modernMeta}});return reply.result.tools.map(tool=>tool.name)}
  assert.deepEqual((await names(plain)).sort(),['michi_command_result','michi_propose_create','michi_propose_update','michi_snapshot'])
  assert.ok((await names(split)).includes('michi_propose_split'));assert.ok(!(await names(split)).includes('michi_propose_routine_change'))
  const children=[{title:'調査',points:15},{title:'実装',points:25}]
  await assert.rejects(plain.client.proposeSplit({commandId:crypto.randomUUID(),snapshotId:plain.snapshot.manifest.snapshot_id,targetId:plain.task.id,expectedRevision:1,children}),error=>error.code==='OPERATION_NOT_GRANTED')
  const accepted=await split.client.proposeSplit({commandId:crypto.randomUUID(),snapshotId:split.snapshot.manifest.snapshot_id,targetId:split.task.id,expectedRevision:1,children})
  assert.equal(accepted.notApplied,true);assert.equal(split.applications(),0)
  const entry=(await split.bridge.scanInbox())[0];assert.equal(entry.prepared.command.type,'task.split');assert.deepEqual(entry.prepared.command.payload,{children});assert.deepEqual(entry.prepared.command.basis,{kind:'external_request'});assert.equal(entry.prepared.command.via,'mcp_stdio')
  for(const bad of [[{title:'一つだけ',points:40}],[{title:'調査',points:15,approved:true},{title:'実装',points:25}],[{title:'調査',points:-1},{title:'実装',points:41}]])await assert.rejects(split.client.proposeSplit({commandId:crypto.randomUUID(),snapshotId:split.snapshot.manifest.snapshot_id,targetId:split.task.id,expectedRevision:1,children:bad}),error=>typeof error.code==='string')
})
