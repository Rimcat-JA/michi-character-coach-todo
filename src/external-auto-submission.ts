import { assertExternalToolAuthority, type ExternalToolContext } from './external-tools'
import { createFileBridgeController } from './file-bridge-commands'
import type { FileBridgeGateway } from './file-bridge-types'
import { forgetReceivedCommand,pendingCommands } from './command-bus'

/** Internal main-to-renderer request. It is absent from the remote tool catalog.
 * The existing main lease, N09 decision and atomic receipt remain authoritative. */
export async function processExternalSubmission(args:Record<string,unknown>,context:ExternalToolContext,gateway:FileBridgeGateway){
 const {registration}=await assertExternalToolAuthority(context)
 if(Object.keys(args).length!==2||args.clientId!==registration.client.id||typeof args.commandId!=='string'||!registration.client.grant.keys.includes('tasks:prepare')||!registration.client.grant.keys.includes('changes:submit'))throw Object.assign(Error('INSUFFICIENT_SCOPE'),{code:'INSUFFICIENT_SCOPE'})
 if(registration.client.grant.mutation_mode!=='auto_within_bounds'||!gateway.clientStatus||!gateway.scanClientInbox)return {state:'awaiting_approval'}
 // A native review in progress owns its scanned references. A background scan must not replace them.
 if(pendingCommands().some(row=>row.actor.principal.kind==='external-agent'&&row.actor.principal.id===registration.client.id))return {state:'awaiting_approval'}
 const clientId=registration.client.id,controller=createFileBridgeController({...gateway,status:()=>gateway.clientStatus!({clientId}),scanInbox:()=>gateway.scanClientInbox!({clientId})})
 try{
  const scanned=await controller.scanInbox(),entry=scanned.entries.find(row=>row.state==='awaiting_approval'&&row.prepared.command.command_id===args.commandId)
  if(!entry||entry.state!=='awaiting_approval')return {state:'awaiting_approval'}
  const prepared=await controller.prepare(entry.reference)
  const result=await controller.applyAutomatically(prepared)
  if(result.receipt)forgetReceivedCommand(clientId,args.commandId)
  return {state:result.resultPending?'unknown':'applied'}
 }catch(error){
  const code=(error as {code?:string}).code??(error as Error).message
  if(['APPROVAL_REQUIRED','AUTOMATION_NOT_GRANTED','AUTO_DAILY_BOUND','APPLICATION_IN_PROGRESS'].includes(code))return {state:'awaiting_approval'}
  throw error
 }finally{await controller.releaseReviewAuthority()}
}
