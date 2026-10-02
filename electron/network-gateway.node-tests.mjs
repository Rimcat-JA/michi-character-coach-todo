import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const {createNetworkGateway,policyFromSettings,PURPOSE_HOSTS}=require('./network-gateway.cjs')
const {inspectGitHubRepository}=require('./github-publish.cjs')

// Synthetic only: the underlying fetch is a recorder, no DNS or socket is opened.
const datasetId='0b6a4f0e-5d1c-4e2a-9f3b-2c4d5e6f7a8b'
const profile=policy=>({schema_version:'1',kind:'standalone',dataset_id:datasetId,authority:'local',network_policy:policy,server_url:null})
function recorder(){const calls=[];const fetchImpl=async(url,init)=>{calls.push({url,init});return new Response('{}',{status:200})};return {calls,fetchImpl}}

test('offline_only makes zero underlying fetch calls for every purpose and returns NETWORK_POLICY_OFFLINE',async()=>{
 const {calls,fetchImpl}=recorder(),gateway=createNetworkGateway({getPolicy:async()=>({policy:'offline_only',source:'profile'}),fetchImpl})
 for(const [purpose,url] of [['openrouter','https://openrouter.ai/api/v1/chat/completions'],['github','https://api.github.com/user'],['webhook','https://hooks.example.invalid/x'],['embedding','http://127.0.0.1:8080/v1/embeddings'],['schedule','https://example.com/feed'],['caldav','https://example.com/calendar']]){
  await assert.rejects(gateway.fetch(purpose,url,{method:'POST'}),error=>error.code==='NETWORK_POLICY_OFFLINE'&&/オフライン専用/.test(error.message))
  await assert.rejects(gateway.assertAllowed(purpose),error=>error.code==='NETWORK_POLICY_OFFLINE')
 }
 assert.equal(calls.length,0)
 const status=gateway.status()
 assert.equal(status.policy,'offline_only')
 for(const purpose of Object.keys(PURPOSE_HOSTS))assert.deepEqual(status.counters[purpose],{attempts:0,blockedOffline:2,blockedHost:0,failed:0})
 assert.doesNotMatch(JSON.stringify(status),/openrouter\.ai|api\.github\.com|Bearer|sk-/)
})

test('an unreadable or invalid policy fails closed before fetch',async()=>{
 const {calls,fetchImpl}=recorder()
 for(const getPolicy of [async()=>{throw new Error('db closed')},async()=>null,async()=>({policy:'always'})]){
  const gateway=createNetworkGateway({getPolicy,fetchImpl})
  await assert.rejects(gateway.fetch('openrouter','https://openrouter.ai/api/v1/chat/completions'),error=>error.code==='NETWORK_POLICY_OFFLINE')
 }
 assert.equal(calls.length,0)
})

test('explicit_online allows only the per-purpose host over https and forces redirect:error',async()=>{
 const {calls,fetchImpl}=recorder(),gateway=createNetworkGateway({getPolicy:async()=>({policy:'explicit_online',source:'profile'}),fetchImpl})
 const ok=await gateway.fetch('openrouter','https://openrouter.ai/api/v1/chat/completions',{method:'POST',redirect:'follow'})
 assert.equal(ok.status,200)
 await gateway.fetch('github','https://api.github.com/repos/o/n',{method:'GET'})
 for(const [purpose,url] of [['openrouter','https://api.github.com/user'],['github','https://openrouter.ai/api/v1/chat/completions'],['github','http://api.github.com/user'],['github','https://user:pw@api.github.com/user'],['github','https://api.github.com:8443/user'],['github','https://api.github.com.evil.invalid/user'],['webhook','https://hooks.example.invalid/x'],['openrouter','not a url']])
  await assert.rejects(gateway.fetch(purpose,url),error=>error.code==='NETWORK_HOST_NOT_ALLOWED')
 await assert.rejects(gateway.fetch('telemetry','https://openrouter.ai/'),error=>error.code==='NETWORK_PURPOSE_INVALID')
 assert.equal(calls.length,2)
 assert.ok(calls.every(call=>call.init.redirect==='error'))
 assert.deepEqual(gateway.status().counters,{openrouter:{attempts:1,blockedOffline:0,blockedHost:2,failed:0},github:{attempts:1,blockedOffline:0,blockedHost:5,failed:0},webhook:{attempts:0,blockedOffline:0,blockedHost:1,failed:0},embedding:{attempts:0,blockedOffline:0,blockedHost:0,failed:0},schedule:{attempts:0,blockedOffline:0,blockedHost:0,failed:0},caldav:{attempts:0,blockedOffline:0,blockedHost:0,failed:0}})
})

test('embedding only reaches literal loopback HTTP endpoints with an explicit port',async()=>{
 const {calls,fetchImpl}=recorder(),gateway=createNetworkGateway({getPolicy:async()=>({policy:'explicit_online'}),fetchImpl})
 for(const url of ['http://127.0.0.1:9000/v1/embeddings','http://[::1]:9000/v1/embeddings'])await gateway.fetch('embedding',url)
 for(const url of ['http://localhost:9000/v1/embeddings','http://example.test:9000/','http://127.0.0.1/','https://127.0.0.1:9000/'])await assert.rejects(gateway.fetch('embedding',url),error=>error.code==='NETWORK_HOST_NOT_ALLOWED')
 assert.equal(calls.length,2)
})

test('failed underlying requests are counted separately from attempts',async()=>{
 const gateway=createNetworkGateway({getPolicy:async()=>({policy:'explicit_online'}),fetchImpl:async()=>{throw new TypeError('fetch failed')}})
 await assert.rejects(gateway.fetch('openrouter','https://openrouter.ai/api/v1/chat/completions'),TypeError)
 assert.deepEqual(gateway.status().counters.openrouter,{attempts:1,blockedOffline:0,blockedHost:0,failed:1})
})

test('the policy is re-read for every request so a switch to offline_only applies immediately',async()=>{
 const {calls,fetchImpl}=recorder();let current='explicit_online'
 const gateway=createNetworkGateway({getPolicy:async()=>({policy:current,source:'profile'}),fetchImpl})
 await gateway.fetch('openrouter','https://openrouter.ai/api/v1/chat/completions')
 current='offline_only'
 await assert.rejects(gateway.fetch('openrouter','https://openrouter.ai/api/v1/chat/completions'),error=>error.code==='NETWORK_POLICY_OFFLINE')
 assert.equal(calls.length,1)
})

test('GitHub repository inspection through the gateway makes no request under offline_only',async()=>{
 const {calls,fetchImpl}=recorder(),gateway=createNetworkGateway({getPolicy:async()=>({policy:'offline_only'}),fetchImpl})
 await assert.rejects(inspectGitHubRepository({token:'ghp_'+'a'.repeat(36),owner:'owner',name:'repo',branch:'main',visibility:'private'},(url,init)=>gateway.fetch('github',url,init)))
 assert.equal(calls.length,0)
 assert.equal(gateway.status().counters.github.blockedOffline,1)
})

test('policyFromSettings mirrors the runtime profile schema and fails closed',()=>{
 assert.deepEqual(policyFromSettings({datasetId,runtimeProfile:profile('offline_only')}),{policy:'offline_only',source:'profile'})
 assert.deepEqual(policyFromSettings({datasetId,runtimeProfile:profile('explicit_online')}),{policy:'explicit_online',source:'profile'})
 // A dataset that already used AI or GitHub keeps working until the owner chooses.
 assert.deepEqual(policyFromSettings({datasetId,aiEnabled:true}),{policy:'explicit_online',source:'legacy'})
 assert.deepEqual(policyFromSettings({datasetId,aiEnabled:false},true),{policy:'explicit_online',source:'legacy'})
 assert.deepEqual(policyFromSettings({datasetId,aiEnabled:false}),{policy:'offline_only',source:'legacy'})
 for(const runtimeProfile of [{...profile('explicit_online'),authority:'server'},{...profile('explicit_online'),server_url:'https://example.invalid'},{...profile('explicit_online'),kind:'hosted'},{...profile('explicit_online'),dataset_id:'0b6a4f0e-5d1c-4e2a-9f3b-000000000000'},{...profile('explicit_online'),extra:1},{...profile('explicit_online'),network_policy:'always'},null])
  assert.equal(policyFromSettings({datasetId,aiEnabled:true,runtimeProfile},true).policy,'offline_only')
 assert.equal(policyFromSettings(null,true).policy,'offline_only')
})
