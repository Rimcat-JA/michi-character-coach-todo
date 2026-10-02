/** The single egress point of the main process. Every external request names a purpose;
 * offline_only rejects before URL parsing, DNS or the underlying fetch. Counters carry no URLs or secrets. */
const PURPOSE_HOSTS=Object.freeze({openrouter:Object.freeze(['openrouter.ai']),github:Object.freeze(['api.github.com']),webhook:Object.freeze([]),embedding:Object.freeze(['127.0.0.1','[::1]'])})
const POLICIES=['offline_only','explicit_online']
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
function gatewayError(code,message){const error=new Error(message);error.code=code;return error}
/** Mirrors src/runtime-profile.ts. A broken profile fails closed; a missing one keeps an already configured online feature working. */
function policyFromSettings(settings,legacyOnlineConfigured=false){
 if(!settings||typeof settings!=='object')return {policy:'offline_only',source:'unreadable'}
 const profile=settings.runtimeProfile
 if(profile===undefined)return {policy:settings.aiEnabled===true||legacyOnlineConfigured===true?'explicit_online':'offline_only',source:'legacy'}
 const keys=['schema_version','kind','dataset_id','authority','network_policy','server_url']
 if(!profile||typeof profile!=='object'||Array.isArray(profile)||Object.keys(profile).length!==keys.length||keys.some(key=>!Object.hasOwn(profile,key))||profile.schema_version!=='1'||profile.kind!=='standalone'||profile.authority!=='local'||profile.server_url!==null||!uuid(profile.dataset_id)||profile.dataset_id!==settings.datasetId||!POLICIES.includes(profile.network_policy))return {policy:'offline_only',source:'invalid'}
 return {policy:profile.network_policy,source:'profile'}
}
function createNetworkGateway({getPolicy,fetchImpl=globalThis.fetch,hosts=PURPOSE_HOSTS}){
 if(typeof getPolicy!=='function'||typeof fetchImpl!=='function')throw new Error('NETWORK_GATEWAY_INVALID')
 const counters=Object.fromEntries(Object.keys(hosts).map(purpose=>[purpose,{attempts:0,blockedOffline:0,blockedHost:0,failed:0}]))
 let last={policy:'offline_only',source:'not_checked',checkedAt:null}
 async function refresh(){let value;try{value=await getPolicy()}catch{value=null}const policy=POLICIES.includes(value?.policy)?value.policy:'offline_only';last={policy,source:POLICIES.includes(value?.policy)?value.source??'profile':'unreadable',checkedAt:new Date().toISOString()};return policy}
 async function assertAllowed(purpose){
  if(!Object.hasOwn(counters,purpose))throw gatewayError('NETWORK_PURPOSE_INVALID','通信の用途が不正です')
  if(await refresh()!=='explicit_online'){counters[purpose].blockedOffline++;throw gatewayError('NETWORK_POLICY_OFFLINE','オフライン専用の設定のため通信しません。設定の「通信の許可」で変更できます')}
 }
 async function fetch(purpose,url,init={}){
  await assertAllowed(purpose)
  let target=null
  try{target=new URL(url)}catch{/* rejected below */}
  const transportAllowed=target&&(purpose==='embedding'?target.protocol==='http:'&&Boolean(target.port):target.protocol==='https:'&&(!target.port||target.port==='443'))
  if(!target||typeof url!=='string'||!transportAllowed||target.username||target.password||!hosts[purpose].includes(target.hostname)){counters[purpose].blockedHost++;throw gatewayError('NETWORK_HOST_NOT_ALLOWED','許可されていない通信先です')}
  counters[purpose].attempts++
  try{return await fetchImpl(url,{...init,redirect:'error'})}
  catch(error){counters[purpose].failed++;throw error}
 }
 const status=()=>({policy:last.policy,source:last.source,checkedAt:last.checkedAt,counters:structuredClone(counters)})
 return Object.freeze({fetch,assertAllowed,refresh,status})
}
module.exports={createNetworkGateway,policyFromSettings,PURPOSE_HOSTS}
