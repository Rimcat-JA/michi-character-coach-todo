import Dexie from 'dexie'
import { db } from './db'
import { canonicalJSON, contentDigest } from './canonical'
import { uid } from './domain'
import { assertExternalChangeRequest, decideExternalCommand, type ExternalChangeRequest } from './external-command-gate'
import { externalCommandEnvelope } from './external-command-adapter'
import { verifiedExternalInstruction } from './external-instructions'
import { assertExternalToolAuthority, type ExternalToolContext } from './external-tools'
import { operationMode, operationsForFields } from './automation-policy'
import { toTaskPatch } from './command-bus'
import { ownerNotesForEgress } from './egress-policy'
import { readFileBridgeApplicationReceipt } from './file-bridge-commands'
import type { TaskChangeField } from './change-set'
import catalog from '../electron/contracts/plugin-tools.resolved.json'
import { assertSchema } from '../electron/plugin-schema.mjs'

export type ExternalChangePlan={version:1;id:string;request:ExternalChangeRequest;context:ExternalToolContext;createdAt:string;expiresAt:string;fieldDiffs:{path:string;before:unknown;after:unknown}[]}
function fail(code:string):never {throw Object.assign(Error(code),{code})}
const boundContext=(c:ExternalToolContext):ExternalToolContext=>({registration:structuredClone(c.registration),ownerId:c.ownerId,datasetId:c.datasetId,externalEpoch:c.externalEpoch,policyEpoch:c.policyEpoch,sourcePermissionRevision:c.sourcePermissionRevision})
const prepareKey=(client:string,key:string)=>`externalprepare:${client}:${key}`
export const externalPlanKey=(client:string,id:string)=>`externalplan:${client}:${id}`
/** Keep request-key tombstones: a capacity error never evicts old keys or remints their commands. */
async function assertPlanCapacity(client:string,newPlan:boolean){
 const rows=await db.commands.toCollection().filter(row=>/^external(plan|prepare|submit):/.test(row.key)).toArray()
 if(rows.length>=(newPlan?14999:15000)||rows.filter(row=>/^external(plan|prepare|submit):/.test(row.key)&&row.key.split(':')[1]===client).length>=(newPlan?2999:3000))fail('TOO_MANY_PROPOSALS')
 if(newPlan){
  const plans=rows.filter(row=>row.key.startsWith(`externalplan:${client}:`))
  if(plans.length>=1000)fail('TOO_MANY_PROPOSALS')
  let active=0
  for(const row of plans){let plan:ExternalChangePlan;try{plan=JSON.parse(row.resultId)}catch{fail('PLAN_INVALID')};if(Date.parse(plan.expiresAt)>Date.now()&&!await readFileBridgeApplicationReceipt(plan.id,client))active++}
  if(active>=100)fail('TOO_MANY_PROPOSALS')
 }
}
function publicPlan(plan:ExternalChangePlan,digest:string){return {change_set_id:plan.id,digest,state:'awaiting_approval',approval_url:null,reasons:[plan.context.registration.client.grant.mutation_mode==='auto_within_bounds'?'送信時に共通コマンドバスで自動適用の範囲を再確認します。タイトル・期限・点数・範囲外の変更は本人の確認待ちです。':'ローカル接続の受信箱で本人が確認します。送信だけではタスクを保存しません。'],field_diffs:plan.fieldDiffs,command_id:plan.id}}
async function authorizeRequest(request:ExternalChangeRequest,context:ExternalToolContext,checkRevision:boolean){
 const {registration,policy}=await assertExternalToolAuthority(context),grant=registration.client.grant
 assertExternalChangeRequest(request)
 if(!['task.create','task.update','task.score.set_manual'].includes(request.operation))fail('FORBIDDEN_OPERATION')
 let verifiedBasis=false
 if(request.basis.kind==='external_request')verifiedBasis=false
 else if(request.basis.kind==='app_instruction')verifiedBasis=(await verifiedExternalInstruction(request,context))!==null
 else fail('UNVERIFIED_REFERENCE')
 if(request.basis.kind!=='external_request'&&!verifiedBasis)fail('UNVERIFIED_REFERENCE')
 if(request.task_id&&!registration.task_ids.includes(request.task_id))fail('NOT_FOUND')
 const task=request.task_id?await db.tasks.get(request.task_id):null
 if(request.task_id&&(!task||task.deletedAt||grant.project_ids.length&&!grant.project_ids.includes(task.containerId??'')))fail('NOT_FOUND')
 if(request.operation==='task.create'&&grant.project_ids.length)fail('FEATURE_NOT_IMPLEMENTED')
 const envelope=externalCommandEnvelope(request,request.request_key),patch=toTaskPatch(envelope.payload)
 if(task?.dueAt&&Object.hasOwn(envelope.payload,'due_date'))fail('FEATURE_NOT_IMPLEMENTED')
 const fieldMap:Record<string,string>={due_date:'due',manual_points:'points'}
 const decision=decideExternalCommand(request,{enabled:true,authenticated:true,tokenValid:true,audienceMatches:true,active:true,ownerMatches:true,datasetMatches:true,egressAllowed:true,mutationsEnabled:policy.aiChangesEnabled&&operationsForFields(Object.keys(patch) as TaskChangeField[]).every(operation=>operationMode(policy,operation)!=='deny'),scopes:grant.keys,fields:grant.fields.map(field=>fieldMap[field]??field),revision:checkRevision?task?.revision??null:request.expected_revision??null,mode:grant.mutation_mode,protectedFields:['title','due','points'],hardLockedFields:[],boundsAllowed:false,quotaAllowed:grant.max_operations_per_day>0},()=>verifiedBasis)
 if(decision!=='AWAITING_APPROVAL'&&decision!=='AUTO_ELIGIBLE')fail(decision)
 if(Object.keys(envelope.payload).some(field=>!grant.fields.includes(field as typeof grant.fields[number])))fail('FIELD_DENIED')
 if(typeof envelope.payload.notes==='string'&&envelope.payload.notes.length>1000)fail('PROPOSAL_BOUND')
 if(task&&envelope.payload.scheduled_date&&task.scheduledDate&&Math.abs(Date.parse(String(envelope.payload.scheduled_date))-Date.parse(task.scheduledDate))/86400000>grant.max_schedule_shift_days)fail('SCHEDULE_BOUND')
 return {task,envelope}
}
export async function dispatchExternalChangeTool(name:string,args:Record<string,unknown>,rawContext:ExternalToolContext){
 const tool=catalog.tools.find(tool=>tool.name===name);if(!tool)fail('TOOL_NOT_FOUND');assertSchema(tool.inputSchema,args)
 const context=boundContext(rawContext),client=context.registration.client.id
 return db.transaction('rw',db.settings,db.datasetState,db.tasks,db.commands,async()=>{
  await assertExternalToolAuthority(context)
  if(name==='coach_prepare_change'){
   const request=structuredClone(args) as ExternalChangeRequest
   await authorizeRequest(request,context,false)
   const hash=await Dexie.waitFor(contentDigest(request)),key=prepareKey(client,request.request_key),prior=await db.commands.get(key)
   if(prior){if(prior.hash!==hash)fail('IDEMPOTENCY_MISMATCH');const row=await db.commands.get(externalPlanKey(client,prior.resultId));if(!row)fail('PLAN_NOT_FOUND');const plan=JSON.parse(row.resultId) as ExternalChangePlan;if(row.hash!==await Dexie.waitFor(contentDigest(plan))||canonicalJSON(plan.context)!==canonicalJSON(context)||Date.parse(plan.expiresAt)<=Date.now())fail('PLAN_EXPIRED');return publicPlan(plan,row.hash)}
   await assertPlanCapacity(client,true)
   const {task,envelope}=await authorizeRequest(request,context,true),createdAt=new Date().toISOString(),expiresAt=new Date(Math.min(Date.now()+300000,Date.parse(context.registration.client.grant.expires_at))).toISOString()
   const before:Record<string,unknown>=task?{title:task.title,notes:ownerNotesForEgress(task.notes).notes,scheduled_date:task.scheduledDate,due_date:task.dueDate,manual_points:task.score.manualPoints}:{}
   const plan:ExternalChangePlan={version:1,id:uid(),request,context,createdAt,expiresAt,fieldDiffs:Object.entries(envelope.payload).map(([path,after])=>({path,before:before[path]??null,after}))},digest=await Dexie.waitFor(contentDigest(plan))
   // Stored plans describe a request; they never recreate bus approval or an apply capability.
   await db.commands.add({key:externalPlanKey(client,plan.id),hash:digest,resultId:JSON.stringify(plan),at:createdAt});await db.commands.add({key,hash,resultId:plan.id,at:createdAt})
   return publicPlan(plan,digest)
  }
  if(name==='coach_submit_change'){
   const row=await db.commands.get(externalPlanKey(client,String(args.change_set_id)));if(!row)fail('NOT_FOUND')
   const plan=JSON.parse(row.resultId) as ExternalChangePlan
   if(args.digest!==row.hash||row.hash!==await Dexie.waitFor(contentDigest(plan)))fail('DIGEST_MISMATCH')
   if(canonicalJSON(plan.context)!==canonicalJSON(context))fail('STALE_GRANT')
   await authorizeRequest(plan.request,context,false)
   if(!context.registration.client.grant.keys.includes('changes:submit'))fail('INSUFFICIENT_SCOPE')
   const key=`externalsubmit:${client}:${String(args.request_key)}`,hash=await Dexie.waitFor(contentDigest({id:plan.id,digest:row.hash})),prior=await db.commands.get(key)
   if(prior){if(prior.hash!==hash||prior.resultId!==plan.id)fail('IDEMPOTENCY_MISMATCH')}
   else{await assertPlanCapacity(client,false);const applied=await readFileBridgeApplicationReceipt(plan.id,client);if(!applied){if(Date.parse(plan.expiresAt)<=Date.now())fail('PLAN_EXPIRED');await authorizeRequest(plan.request,context,true)}await db.commands.add({key,hash,resultId:plan.id,at:new Date().toISOString()})}
   return publicPlan(plan,row.hash)
  }
  return fail('FEATURE_NOT_IMPLEMENTED')
 })
}
