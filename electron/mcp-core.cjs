const crypto=require('node:crypto')
const catalog=require('./contracts/plugin-tools.resolved.json')
const fail=code=>{throw Object.assign(Error(code),{code})}
const plain=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype)
/** Transport-independent MCP. Authentication/context are main-owned callbacks, never tool parameters. */
async function createMCPCore({authenticate,getContext,dispatch,implemented=[]}){
 const {assertSchema}=await import('./plugin-schema.mjs')
 const supported=new Set(implemented)
 async function context(identity){
  const authentication=await authenticate(identity)
  if(!authentication)fail('UNAUTHENTICATED')
  const current=await getContext(authentication.clientId)
  if(!current?.externalEnabled)fail('PLUGIN_DISABLED')
  if(!current.active||Date.parse(current.registration?.client.grant.expires_at)<=Date.now())fail('GRANT_REVOKED')
  if(current.externalEpoch!==authentication.externalEpoch||current.registration.client.revision!==authentication.revision||current.registration.client.grant_epoch!==authentication.grantEpoch)fail('STALE_GRANT')
  if(current.policyEpoch!==current.registration.policy_epoch||current.sourcePermissionRevision!==current.registration.source_permission_revision)fail('STALE_GRANT')
  if(current.ownerId!==current.registration.owner_id||current.datasetId!==current.registration.dataset_id)fail('NOT_FOUND')
  if(current.frozen)fail('DATASET_FROZEN')
  return current
 }
 async function handle(identity,message){
  if(!plain(message)||message.jsonrpc!=='2.0'||!['string','number'].includes(typeof message.id)&&message.id!==undefined||typeof message.method!=='string')return {jsonrpc:'2.0',id:null,error:{code:-32600,message:'INVALID_REQUEST'}}
  const id=message.id??null
  try{
   const current=await context(identity)
   if(message.method==='notifications/initialized'&&message.id===undefined)return null
   if(message.id===undefined)fail('INVALID_REQUEST')
   if(message.method==='initialize'){
    const version=message.params?.protocolVersion
    if(!['2025-03-26','2025-06-18','2025-11-25'].includes(version))fail('PROTOCOL_UNSUPPORTED')
    return {jsonrpc:'2.0',id,result:{protocolVersion:version,capabilities:{tools:{}},serverInfo:{name:'michi-app',version:'1.0'}}}
   }
   if(message.method==='ping')return {jsonrpc:'2.0',id,result:{}}
   if(message.method==='tools/list')return {jsonrpc:'2.0',id,result:{tools:structuredClone(catalog.tools)}}
   if(message.method!=='tools/call')return {jsonrpc:'2.0',id,error:{code:-32601,message:'METHOD_NOT_FOUND'}}
   const params=message.params
   if(!plain(params)||Object.keys(params).some(key=>!['name','arguments','_meta'].includes(key)))fail('TOOL_SCHEMA')
   const tool=catalog.tools.find(tool=>tool.name===params.name)
   if(!tool)fail('TOOL_NOT_FOUND')
   assertSchema(tool.inputSchema,params.arguments??{})
   const meta={request_id:crypto.randomUUID(),dataset_id:current.datasetId,authority:'local',tool_catalog_version:'1.0',actor_id:current.registration.client.id,generated_at:new Date().toISOString()}
   try{
    if(!supported.has(tool.name))fail('FEATURE_NOT_IMPLEMENTED')
    const data=await dispatch(tool.name,params.arguments??{},current)
    // Revocation/epoch changes during an async read discard the response before disclosure.
    const latest=await context(identity)
    if(latest.sourcePermissionRevision!==current.sourcePermissionRevision||latest.policyEpoch!==current.policyEpoch)fail('STALE_GRANT')
    const result={state:'ok',data,error:null,meta}
    assertSchema(tool.outputSchema,result,'TOOL_OUTPUT_SCHEMA')
    return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result}}
   }catch(error){
    const code=/^[A-Z_]{1,80}$/.test(error.code??'')?error.code:'TOOL_FAILED',result={state:'error',data:null,error:{code,message:code,retryable:false},meta}
    assertSchema(tool.outputSchema,result,'TOOL_OUTPUT_SCHEMA')
    return {jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result}}
   }
  }catch(error){return {jsonrpc:'2.0',id,error:{code:-32000,message:/^[A-Z_]{1,80}$/.test(error.code??'')?error.code:'REQUEST_FAILED'}}}
 }
 return Object.freeze({handle,catalogVersion:'1.0'})
}
module.exports={createMCPCore}
