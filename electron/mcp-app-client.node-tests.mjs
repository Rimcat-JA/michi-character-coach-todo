import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import crypto from 'node:crypto'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const require=createRequire(import.meta.url),{createMCPPipeServer}=require('./mcp-pipe-server.cjs'),{createMCPAppClient}=require('./mcp-app-client.cjs'),{createMCPCore}=require('./mcp-core.cjs')
test('Windows synthetic stdio host lists 15 tools through owner pipe, then old credentials/revoked grant/app exit fail',{skip:process.platform!=='win32'},async t=>{
 const clientId=crypto.randomUUID(),datasetId=crypto.randomUUID();let credential=crypto.randomBytes(32).toString('hex'),active=true
 const context={registration:{owner_id:'owner',dataset_id:datasetId,policy_epoch:1,source_permission_revision:1,client:{id:clientId,revision:1,grant_epoch:1,grant:{expires_at:new Date(Date.now()+60000).toISOString()}}},ownerId:'owner',datasetId,externalEnabled:true,externalEpoch:1,active:true,frozen:false,policyEpoch:1,sourcePermissionRevision:1}
 const core=await createMCPCore({authenticate:async identity=>identity.clientId===clientId&&identity.credential===credential?{clientId,externalEpoch:1,revision:1,grantEpoch:1}:null,getContext:async()=>({...context,active}),implemented:['coach_get_capabilities'],dispatch:async()=>({enabled:true,operations:['coach_get_capabilities'],limitations:['synthetic host only']})})
 const server=await createMCPPipeServer({handle:core.handle});t.after(()=>server.close())
 const host=spawn(process.execPath,[fileURLToPath(new URL('../scripts/michi-mcp.mjs',import.meta.url)),'--connect',clientId],{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',MICHI_MCP_ENDPOINT:server.endpoint,MICHI_MCP_CREDENTIAL:credential},stdio:['pipe','pipe','pipe']})
 const output=[],errors=[];host.stdout.on('data',data=>output.push(data));host.stderr.on('data',data=>errors.push(data));t.after(()=>host.kill())
 const exit=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{host.kill();reject(Error('STDIO_TIMEOUT'))},10000);host.once('close',code=>{clearTimeout(timer);resolve(code)})})
 host.stdin.end([{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'coach_get_capabilities',arguments:{}}}].map(JSON.stringify).join('\n')+'\n')
 assert.equal(await exit,0);assert.equal(Buffer.concat(errors).toString(), '');const lines=Buffer.concat(output).toString('utf8').trim().split('\n').map(JSON.parse)
 assert.equal(lines.length,3);assert.equal(lines[1].result.tools.length,15);assert.equal(lines[2].result.structuredContent.meta.actor_id,clientId);assert.equal(lines[2].result.structuredContent.meta.authority,'local')
 const route=await createMCPAppClient(clientId,server.endpoint,credential);t.after(()=>route.close())
 const old=credential;credential=crypto.randomBytes(32).toString('hex')
 assert.equal((await route({jsonrpc:'2.0',id:9,method:'tools/list'})).error.message,'UNAUTHENTICATED')
 await assert.rejects(createMCPAppClient(clientId,server.endpoint,old),error=>error.code==='UNAUTHENTICATED')
 active=false;await assert.rejects(createMCPAppClient(clientId,server.endpoint,credential),error=>error.code==='UNAUTHENTICATED')
 await server.close();await assert.rejects(createMCPAppClient(clientId,server.endpoint,credential),error=>error.code==='APP_NOT_RUNNING')
})
test('app adapter accepts only local generated pipe endpoints and validated non-file credentials',async()=>{
 for(const endpoint of ['http://127.0.0.1/mcp','\\\\other-pc\\pipe\\michi-'+crypto.randomBytes(16).toString('hex'),'/tmp/socket','C:\\private\\db'])await assert.rejects(createMCPAppClient(crypto.randomUUID(),endpoint,'a'.repeat(64)),error=>error.code==='APP_CONNECTION_CONFIG_INVALID')
})
