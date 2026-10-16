import Dexie from 'dexie'
import { db } from './db'
import { canonicalJSON, contentDigest } from './canonical'
import { externalActionJSON, type ExternalChangeRequest } from './external-command-gate'
import { externalTaskChanges } from './external-command-adapter'
import { assertExternalToolAuthority, type ExternalToolContext } from './external-tools'
import { confirmTaskInstructionFromUI, assertTaskInstruction, type VerifiedTaskInstruction } from './task-user-instruction'
import { changeContextFor, externalAgentActor, humanContextFor, type CommandGrant, type CommandField } from './command-bus'
import { today } from './domain'
const issued=new Map<string,{instruction:VerifiedTaskInstruction;action:string;context:ExternalToolContext}>()
export async function confirmExternalInstructionFromUI(request:ExternalChangeRequest,context:ExternalToolContext,event:Event){
 request=structuredClone(request);context=structuredClone(context)
 const changes=await externalTaskChanges(request,context.ownerId)
 for(const [id,value] of issued)if(Date.parse(value.instruction.expiresAt)<=Date.now())issued.delete(id)
 if(issued.size>=1000)throw Error('INSTRUCTION_LIMIT')
 const {registration}=await assertExternalToolAuthority(context),grant:CommandGrant={fields:registration.client.grant.fields as CommandField[],operations:['task.update'],mutationMode:'require_approval',maxScheduleShiftDays:registration.client.grant.max_schedule_shift_days}
 if(!registration.client.grant.keys.includes('tasks:prepare')||changes.some(change=>!registration.task_ids.includes(change.taskId)))throw Error('NOT_FOUND')
 const actor=externalAgentActor({ownerId:context.ownerId,datasetId:context.datasetId,clientId:registration.client.id,registrationRevision:registration.client.revision,grantEpoch:registration.client.grant_epoch,host:registration.client.intended_host},'mcp',grant)
 const instruction=await confirmTaskInstructionFromUI({message:'外部AIへの本人指定値をアプリで確定',referenceDate:today(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,changes},humanContextFor(actor),event)
 const action=externalActionJSON(request)
 const hash=await contentDigest({action,context,instructionId:instruction.id})
 await db.transaction('rw',db.settings,db.datasetState,db.commands,async()=>{
  await assertExternalToolAuthority(context)
  await db.commands.put({key:`externalinstruction:${instruction.id}`,hash,resultId:JSON.stringify({ownerId:context.ownerId,datasetId:context.datasetId,clientId:registration.client.id,expiresAt:instruction.expiresAt}),at:new Date().toISOString()})
 })
 issued.set(instruction.id,{instruction,action,context:structuredClone(context)})
 return instruction.id
}
/** Persisted metadata cannot recreate owner instruction authority after restart or backup restore. */
export async function verifiedExternalInstruction(request:ExternalChangeRequest,context:ExternalToolContext):Promise<VerifiedTaskInstruction|null>{
 const changes=await externalTaskChanges(request,context.ownerId)
 if(request.basis.kind!=='app_instruction')return null
 const value=issued.get(request.basis.reference_id)
 if(!value||value.action!==externalActionJSON(request)||canonicalJSON(value.context)!==canonicalJSON(context))return null
 const row=await db.commands.get(`externalinstruction:${value.instruction.id}`)
 if(!row||row.hash!==await Dexie.waitFor(contentDigest({action:value.action,context,instructionId:value.instruction.id})))return null
 try{const {settings,registration}=await assertExternalToolAuthority(context),actor=externalAgentActor({ownerId:context.ownerId,datasetId:context.datasetId,clientId:registration.client.id,registrationRevision:registration.client.revision,grantEpoch:registration.client.grant_epoch,host:registration.client.intended_host},'mcp',{fields:registration.client.grant.fields as CommandField[],operations:['task.update'],mutationMode:'require_approval',maxScheduleShiftDays:registration.client.grant.max_schedule_shift_days});assertTaskInstruction(value.instruction,changes,changeContextFor(actor),settings);return value.instruction}catch{return null}
}
export function clearExternalInstructionAuthority(clientId?:string){if(clientId){for(const [id,value]of issued)if(value.context.registration.client.id===clientId)issued.delete(id)}else issued.clear()}
