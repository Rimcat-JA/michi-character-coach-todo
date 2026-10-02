const crypto=require('node:crypto')
const events=['task.completed','work_session.logged']
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}'
const digest=v=>crypto.createHash('sha256').update(canonical(v)).digest('hex')
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k))
function fail(code){throw Object.assign(Error(code),{code})}
function validateAutomation(v,{now,allowExpired=false}={}){
 if(!exact(v,['events','params','lowRisk','expiresAt','maxRunsPerHour','grantedAt','policyEpoch','sourcePermissionRevision'])||!Array.isArray(v.events)||!v.events.length||v.events.length>2||new Set(v.events).size!==v.events.length||v.events.some(e=>!events.includes(e))||typeof v.lowRisk!=='boolean'||!v.params||typeof v.params!=='object'||Array.isArray(v.params)||Object.keys(v.params).length>16||Object.values(v.params).some(p=>!['string','number','boolean'].includes(typeof p))||!Number.isInteger(v.maxRunsPerHour)||v.maxRunsPerHour<1||v.maxRunsPerHour>6||![v.expiresAt,v.grantedAt,v.policyEpoch,v.sourcePermissionRevision].every(n=>Number.isSafeInteger(n)&&n>=0)||v.expiresAt<=v.grantedAt||v.expiresAt>v.grantedAt+30*86400000||!allowExpired&&v.expiresAt<=now)fail('AUTOMATION_INVALID')
}
/** Fixed params only; input events are ids and main supplies the actual committed DB fact. */
function createLocalActionTriggers({now,ensure,context,getConfiguration,replaceConfiguration,getService,getFact,loadTriggers,saveTriggers,verifyNativeProof,mutate,signRequest,remember,prepareNative,deviceId,verifyResult}){
 const bootAt=now(),inspections=new Map();let records=null
 function getEnvelopeDigest(envelope){const {signature:_signature,...body}=envelope;return digest(body)}
 async function load(){if(records)return;const saved=await loadTriggers();if(!Array.isArray(saved)||saved.length>2000||saved.some(r=>!r||typeof r.requestId!=='string'||!/^[a-f0-9]{64}$/.test(r.requestId)||typeof r.actionId!=='string'||!events.includes(r.event)||typeof r.factId!=='string'||!Number.isSafeInteger(r.at)||typeof r.reserved!=='boolean'||r.reserved&&(!r.envelope||r.envelope.requestId!==r.requestId)))fail('TRIGGER_STATE_INVALID');for(const r of saved)if(r.result&&(!verifyResult(r.result)||r.result.requestId!==r.requestId||r.result.actionId!==r.actionId||r.result.digest!==getEnvelopeDigest(r.envelope)))fail('TRIGGER_STATE_INVALID');records=saved}
 async function inspectAutomation(input,proof){
  if(!exact(input,['actionId','events','params','lowRisk','expiresAt','maxRunsPerHour'])||!await verifyNativeProof('configure','automation-inspect:'+input.actionId,proof))fail('HUMAN_APPROVAL_REQUIRED')
  await ensure();const c=await context(),def=getConfiguration()?.definitions.find(d=>d.id===input.actionId)
  if(!c.enabled||!def)fail('UNREGISTERED_ACTION')
  const automation={events:structuredClone(input.events),params:structuredClone(input.params),lowRisk:input.lowRisk,expiresAt:input.expiresAt,maxRunsPerHour:input.maxRunsPerHour,grantedAt:now(),policyEpoch:c.policyEpoch,sourcePermissionRevision:c.sourcePermissionRevision}
  validateAutomation(automation,{now:now()})
  // Primitive preparation performs the real typed argv validation without running anything.
  const envelope=signRequest({version:1,requestId:crypto.randomUUID(),nonce:crypto.randomUUID(),issuedAt:now(),expiresAt:now()+60000,ownerId:c.ownerId,datasetId:c.datasetId,deviceId,policyEpoch:c.policyEpoch,sourcePermissionRevision:c.sourcePermissionRevision,definitionRevision:def.revision,actionId:def.id,event:'owner-click',params:automation.params})
  await getService().prepare(envelope)
  const payload={reference:crypto.randomUUID(),actionId:def.id,definitionRevision:def.revision,ownerId:c.ownerId,datasetId:c.datasetId,policyEpoch:c.policyEpoch,sourcePermissionRevision:c.sourcePermissionRevision,automation,expiresAt:now()+5*60000},value={...payload,digest:digest(payload)}
  inspections.set(value.reference,value);return structuredClone(value)
 }
 async function configureAutomation(input,proof){
  if(!exact(input,['reference','digest'])||!await verifyNativeProof('configure',input.reference,proof))fail('HUMAN_APPROVAL_REQUIRED')
  await ensure();return mutate(async()=>{
   const p=inspections.get(input.reference),c=await context(),config=getConfiguration(),def=config?.definitions.find(d=>d.id===p?.actionId)
   if(!p||p.digest!==input.digest||p.expiresAt<=now()||!c.enabled||!def||def.revision!==p.definitionRevision||p.ownerId!==c.ownerId||p.datasetId!==c.datasetId||p.policyEpoch!==c.policyEpoch||p.sourcePermissionRevision!==c.sourcePermissionRevision)fail('AUTHORITY_CHANGED')
   validateAutomation(p.automation,{now:now()})
   await replaceConfiguration({...config,definitions:config.definitions.map(d=>d.id===def.id?{...d,revision:d.revision+1,automation:{...structuredClone(p.automation),grantedAt:now()}}:d)})
   inspections.delete(p.reference);return true
  })
 }
 async function revokeAutomation(input){
  if(!exact(input,['actionId'])||input.actionId!==null&&typeof input.actionId!=='string')fail('INVALID_INPUT')
  await ensure();return mutate(async()=>{const config=getConfiguration();if(!config)return true;await replaceConfiguration({...config,definitions:config.definitions.map(d=>{if(input.actionId!==null&&d.id!==input.actionId||!d.automation)return d;const {automation:_automation,...rest}=d;return {...rest,revision:d.revision+1}})});inspections.clear();return true})
 }
 async function trigger(input){
  if(!exact(input,['event','factId'])||!events.includes(input.event)||typeof input.factId!=='string'||!input.factId||input.factId.length>500)fail('INVALID_TRIGGER')
  await ensure();return mutate(async()=>{
   const c=await context();if(!c.enabled)return {results:[],pending:[],skipped:['authority']}
   await load();const verified=await getFact(input.event,input.factId),stamp=Date.parse(input.event==='task.completed'?verified?.fact?.currentAt:verified?.fact?.endedAt)
   if(!verified||verified.ownerId!==c.ownerId||verified.datasetId!==c.datasetId||verified.fact?.ownerId&&verified.fact.ownerId!==c.ownerId||!verified.task||verified.task.deletedAt||input.event==='task.completed'&&verified.task.status!=='completed'||!Number.isFinite(stamp)||stamp>now()||stamp<bootAt||stamp<now()-60000)return {results:[],pending:[],skipped:['stale_or_absent_fact']}
   const output={results:[],pending:[],skipped:[]}
   for(const def of getConfiguration().definitions){
    const a=def.automation;if(!a||!a.events.includes(input.event)||a.expiresAt<=now()||stamp<a.grantedAt||a.policyEpoch!==c.policyEpoch||a.sourcePermissionRevision!==c.sourcePermissionRevision)continue
    const requestId=digest({actionId:def.id,revision:def.revision,event:input.event,factId:input.factId,occurredAt:stamp})
    const previous=records.find(r=>r.requestId===requestId)
    if(previous){if(previous.result)output.results.push(structuredClone(previous.result));else if(previous.reserved&&previous.envelope.expiresAt>now()){const review=await getService().prepare(previous.envelope);if(review.approvalRequired)output.pending.push(await prepareNative(previous.envelope,review));else{const result=await getService().execute(previous.envelope);await remember(result);previous.result=result;await saveTriggers(records);output.results.push(result)}}else output.skipped.push('already_seen');continue}
    records=records.filter(r=>r.at>now()-2*3600000)
    const reserved=records.filter(r=>r.actionId===def.id&&r.reserved&&r.at>now()-3600000).length<a.maxRunsPerHour
    if(records.length>=2000)fail('TRIGGER_LIMIT')
    if(!reserved){records.push({requestId,actionId:def.id,event:input.event,factId:input.factId,at:now(),reserved:false});await saveTriggers(records);output.skipped.push('rate_limit');continue}
    const envelope=signRequest({version:1,requestId,nonce:crypto.randomUUID(),issuedAt:now(),expiresAt:now()+60000,ownerId:c.ownerId,datasetId:c.datasetId,deviceId,policyEpoch:c.policyEpoch,sourcePermissionRevision:c.sourcePermissionRevision,definitionRevision:def.revision,actionId:def.id,event:input.event,params:structuredClone(a.params)}),review=await getService().prepare(envelope)
    const record={requestId,actionId:def.id,event:input.event,factId:input.factId,at:now(),reserved:true,envelope};records.push(record)
    // Durable reservation precedes launching; cache failures must never cause a blind relaunch.
    try{await saveTriggers(records)}catch(e){records.pop();throw e}
    if(review.approvalRequired)output.pending.push(await prepareNative(envelope,review))
    else{const result=await getService().execute(envelope);await remember(result);record.result=result;await saveTriggers(records);output.results.push(result)}
   }
   return output
  })
 }
 return {inspectAutomation,configureAutomation,revokeAutomation,trigger,clear:()=>{inspections.clear()},runs:async()=>{await load();return records.filter(r=>r.reserved&&r.at>now()-3600000).map(r=>({actionId:r.actionId,event:r.event,requestId:r.requestId,at:r.at}))}}
}
module.exports={createLocalActionTriggers,validateAutomation}
