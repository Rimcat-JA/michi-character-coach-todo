import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
const require=createRequire(import.meta.url),{createFileBridgeHub}=require('./file-bridge-hub.cjs'),{runMCPFileSelftest}=require('./mcp-selftest.cjs')
async function fixture(t){
 const temp=await fs.realpath(os.tmpdir()),base=await fs.mkdtemp(path.join(temp,'michi-selftest-'))
 t.after(async()=>{assert.equal(path.dirname(base),temp);assert.ok(path.basename(base).startsWith('michi-selftest-'));assert.equal(await fs.realpath(base),base);await fs.rm(base,{recursive:true,force:true,maxRetries:5,retryDelay:50})})
 const settings={profileId:'synthetic-owner',datasetId:crypto.randomUUID(),externalAI:{version:1,enabled:true,epoch:0,clients:[]},changePolicy:{epoch:0,sourcePermissionRevision:0,aiChangesEnabled:true}},task={id:crypto.randomUUID(),title:'日本語の自己診断',notes:'資料の本文はログに返さない',scheduledDate:null,revision:1,containerId:null,deletedAt:null}
 let config=null
 const hub=await createFileBridgeHub({agentDirectory:path.join(base,'agents'),journalDirectory:path.join(base,'private'),signingKey:crypto.randomBytes(32),getSettings:async()=>settings,getTasks:async ids=>ids.includes(task.id)?[task]:[],getReceipt:async()=>null,loadConfiguration:async()=>config,saveConfiguration:async value=>config=value,verifyNativeProof:async()=>true})
 await hub.configure({ownerId:settings.profileId,datasetId:settings.datasetId,policyEpoch:0,sourcePermissionRevision:0,intendedHost:'codex',taskIds:[task.id],fields:['title','notes'],lifetimeHours:1,automation:null},'synthetic-proof')
 const status=await hub.exportSnapshot({tasks:[{id:task.id}]}),options={executable:process.execPath,scriptPath:fileURLToPath(new URL('../scripts/michi-mcp.mjs',import.meta.url)),root:status.root}
 return {base,hub,status,options}
}
test('actual stdio subprocess verifies local read only, then revoked copies fail; no commands or raw text are returned',async t=>{
 const f=await fixture(t),result=await runMCPFileSelftest(f.options)
 assert.equal(result.code,null);assert.equal(result.surface,'local_selftest');assert.equal(result.read,'verified_local');assert.equal(result.auth,'not_tested');assert.equal(result.write,'not_tested')
 assert.equal(JSON.stringify(result).includes('資料の本文'),false);assert.deepEqual(await fs.readdir(path.join(f.status.root,'inbox')),[])
 await f.hub.disconnect({clientId:f.status.registration.client.id},'synthetic-proof')
 const revoked=await runMCPFileSelftest({...f.options,expectRevoked:true});assert.equal(revoked.code,null);assert.equal(revoked.revoke,'verified_local');assert.equal(revoked.read,'not_tested')
})
test('closed app and unavailable executable cannot report success; a live copy cannot pass revocation',async t=>{
 const f=await fixture(t)
 assert.equal((await runMCPFileSelftest({...f.options,appRunning:false})).code,'APP_NOT_RUNNING')
 assert.equal((await runMCPFileSelftest({...f.options,executable:path.join(f.base,'missing.exe')})).code,'SELFTEST_START_FAILED')
 assert.equal((await runMCPFileSelftest({...f.options,expectRevoked:true})).revoke,'failed')
 const controller=new AbortController();controller.abort();assert.equal((await runMCPFileSelftest({...f.options,signal:controller.signal})).code,'APP_NOT_RUNNING')
})
test('foreign protocol output, oversized output and malformed UTF-8 are bounded and never become capability evidence',async t=>{
 const f=await fixture(t),script=path.join(f.base,'fake-host.cjs')
 for(const source of ["process.stdout.write('not json\\n')","process.stdout.write('x'.repeat(1100000))","process.stdout.write(Buffer.from([0xc0,0xaf]))"]){await fs.writeFile(script,source);assert.notEqual((await runMCPFileSelftest({...f.options,scriptPath:script})).code,null)}
 assert.deepEqual(await fs.readdir(path.join(f.status.root,'inbox')),[])
})
