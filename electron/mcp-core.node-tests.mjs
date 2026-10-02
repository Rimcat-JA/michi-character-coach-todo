import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import crypto from 'node:crypto'
const require=createRequire(import.meta.url),{createMCPCore}=require('./mcp-core.cjs'),catalog=require('./contracts/plugin-tools.resolved.json')
function facts(){const id=crypto.randomUUID(),datasetId=crypto.randomUUID();return {registration:{owner_id:'owner',dataset_id:datasetId,policy_epoch:1,source_permission_revision:1,client:{id,revision:1,grant_epoch:1,grant:{expires_at:new Date(Date.now()+60000).toISOString()}}},ownerId:'owner',datasetId,externalEnabled:true,externalEpoch:1,active:true,frozen:false,policyEpoch:1,sourcePermissionRevision:1}}
const msg=(method,params={})=>({jsonrpc:'2.0',id:1,method,params})
test('catalog schemas are exact, no arbitrary shell/SQL/approve endpoint and malformed arguments never reach dispatch',async()=>{
 const context=facts();let called=0
 const core=await createMCPCore({authenticate:async()=>({clientId:context.registration.client.id,externalEpoch:1,revision:1,grantEpoch:1}),getContext:async()=>context,dispatch:async()=>{called++;return {}},implemented:['coach_get_task']})
 assert.deepEqual((await core.handle({},msg('tools/list'))).result.tools,catalog.tools)
 for(const name of ['execute_shell','execute_sql','approve'])assert.equal((await core.handle({},msg('tools/call',{name,arguments:{}}))).error.message,'TOOL_NOT_FOUND')
 assert.equal((await core.handle({},msg('tools/call',{name:'coach_get_task',arguments:{task_id:crypto.randomUUID(),approved:true}}))).error.message,'TOOL_SCHEMA');assert.equal(called,0)
 assert.equal((await core.handle({},msg('initialize',{protocolVersion:'2025-11-25'}))).result.protocolVersion,'2025-11-25')
 assert.equal((await core.handle({},msg('initialize',{protocolVersion:'unknown'}))).error.message,'PROTOCOL_UNSUPPORTED')
})
test('every call including list/ping rechecks auth, active epoch, owner/dataset and freeze',async()=>{
 const initial=facts();let context=initial,valid=true
 const core=await createMCPCore({authenticate:async()=>valid?{clientId:initial.registration.client.id,externalEpoch:1,revision:1,grantEpoch:1}:null,getContext:async()=>context,dispatch:async()=>({})})
 for(const [patch,expected] of [[{externalEnabled:false},'PLUGIN_DISABLED'],[{active:false},'GRANT_REVOKED'],[{externalEpoch:2},'STALE_GRANT'],[{datasetId:crypto.randomUUID()},'NOT_FOUND'],[{ownerId:'foreign'},'NOT_FOUND'],[{policyEpoch:2},'STALE_GRANT'],[{sourcePermissionRevision:2},'STALE_GRANT'],[{frozen:true},'DATASET_FROZEN']]){context={...initial,...patch};assert.equal((await core.handle({},msg('tools/list'))).error.message,expected)}
 valid=false;assert.equal((await core.handle({},msg('ping'))).error.message,'UNAUTHENTICATED')
})
test('revocation during an async read discards the body; invalid output also stays body-free',async()=>{
 const context=facts();let revoke=true
 const core=await createMCPCore({authenticate:async()=>({clientId:context.registration.client.id,externalEpoch:1,revision:1,grantEpoch:1}),getContext:async()=>context,dispatch:async()=>{if(revoke)context.active=false;return {secret:'never return this'}},implemented:['coach_get_task']})
 const call=()=>core.handle({},msg('tools/call',{name:'coach_get_task',arguments:{task_id:crypto.randomUUID()}}))
 const result=await call();assert.equal(result.result.structuredContent.error.code,'GRANT_REVOKED');assert.equal(JSON.stringify(result).includes('never return this'),false)
 revoke=false;context.active=true;assert.equal((await call()).result.structuredContent.error.code,'TOOL_OUTPUT_SCHEMA')
})
