const {validateFileBridgeRegistration}=require('./local-file-bridge.cjs')
const fail=code=>{throw Object.assign(Error(code),{code})}
const subset=(next,previous)=>next.every(value=>previous.includes(value))
/** Comparing only app-issued registrations; external request bodies cannot declare their own authority. */
function grantExpands(previous,next){
 validateFileBridgeRegistration(previous);validateFileBridgeRegistration(next)
 const a=previous.client.grant,b=next.client.grant
 return previous.owner_id!==next.owner_id||previous.dataset_id!==next.dataset_id||previous.client.id!==next.client.id||!subset(next.task_ids,previous.task_ids)||!subset(next.rule_ids??[],previous.rule_ids??[])||!subset(b.keys,a.keys)||!subset(b.fields,a.fields)||!a.allow_external_context&&b.allow_external_context||!a.allow_handoffs&&b.allow_handoffs||a.project_ids.length>0&&(b.project_ids.length===0||!subset(b.project_ids,a.project_ids))||Date.parse(b.expires_at)>Date.parse(a.expires_at)||b.max_operations_per_day>a.max_operations_per_day||b.max_schedule_shift_days>a.max_schedule_shift_days||a.mutation_mode==='require_approval'&&b.mutation_mode==='auto_within_bounds'||Boolean(b.automation)&&(!a.automation||b.automation.max_schedule_shift_days>a.automation.max_schedule_shift_days||b.automation.max_operations_per_day>a.automation.max_operations_per_day)
}
function revisedRegistration(previous,request){
 const keys=['clientId','expectedRevision','taskIds','fields','expiresAt','automation','maxScheduleShiftDays','maxOperationsPerDay','allowSplit','ruleIds','allowHistory','allowRoutinePreview','allowContextRead','allowExternalContext','allowDetection','allowHandoffPrepare','allowHandoffs','allowRoutineChange']
 if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).length!==keys.length||keys.some(key=>!Object.hasOwn(request,key))||request.clientId!==previous.client.id||request.expectedRevision!==previous.client.revision)fail('REVISION_CONFLICT')
 if(typeof request.allowSplit!=='boolean'||['allowHistory','allowRoutinePreview','allowContextRead','allowExternalContext','allowDetection','allowHandoffPrepare','allowHandoffs','allowRoutineChange'].some(key=>typeof request[key]!=='boolean')||!Array.isArray(request.ruleIds)||!Array.isArray(request.taskIds)||!Array.isArray(request.fields)||Date.parse(request.expiresAt)>Date.now()+168*3600000||Date.parse(request.expiresAt)<=Date.now())fail('CONFIG_INVALID')
 if(!Number.isSafeInteger(previous.client.revision+1)||!Number.isSafeInteger(previous.client.grant_epoch+1))fail('REGISTRATION_LIMIT')
 const next=structuredClone(previous)
 next.task_ids=[...request.taskIds];delete next.rule_ids;if(request.ruleIds.length)next.rule_ids=[...request.ruleIds]
 const grant=next.client.grant
 grant.fields=[...request.fields];grant.expires_at=request.expiresAt;grant.max_schedule_shift_days=request.maxScheduleShiftDays;grant.max_operations_per_day=request.maxOperationsPerDay
 grant.keys=['tasks:read','tasks:prepare','changes:submit','commands:read',...(request.allowSplit?['tasks:split']:[]),...((request.ruleIds.length||request.allowRoutineChange)?['routines:prepare']:[]),...(request.allowHistory?['history:read']:[]),...(request.allowRoutinePreview?['routines:read']:[]),...(request.allowContextRead?['context:read']:[]),...(request.allowDetection?['detection:request','detection:read']:[]),...(request.allowHandoffPrepare?['handoff:prepare']:[])]
grant.allow_external_context=request.allowExternalContext===true;grant.allow_handoffs=request.allowHandoffs===true
 grant.mutation_mode=request.automation?'auto_within_bounds':'require_approval';delete grant.automation
 if(request.automation){const a=request.automation;if(Object.keys(a).length!==2||!Number.isInteger(a.maxScheduleShiftDays)||a.maxScheduleShiftDays<0||a.maxScheduleShiftDays>7||!Number.isInteger(a.maxOperationsPerDay)||a.maxOperationsPerDay<1||a.maxOperationsPerDay>20)fail('AUTOMATION_SCOPE');grant.automation={max_schedule_shift_days:a.maxScheduleShiftDays,max_operations_per_day:a.maxOperationsPerDay}}
 next.client.revision++;next.client.grant_epoch++;validateFileBridgeRegistration(next)
 return next
}
module.exports={grantExpands,revisedRegistration}
