import { externalAIFor } from './external-authority'
import { clearExternalInstructionAuthority } from './external-instructions'
import { clearChangeSetAuthority } from './change-set'
import { clearCommandAuthority } from './command-bus'
import type { FileBridgeRevise } from './file-bridge-types'
import './external-task-create'
import Dexie from 'dexie'
import { db } from './db'
import { canonicalJSON, contentDigest } from './canonical'
import { uid, type Settings } from './domain'
import { ChangeSetError, autoChangeCountsToday, changePolicyFor, decideChangePolicy, type ChangePolicy, type PreparedChangeSet, type TaskChangeField } from './change-set'
import { operationMode, ruleFor } from './automation-policy'
import { type PreparedAssistedTasks } from './task-assist'
import { agentChangesStopped, commandOutcomeFacts, recordCommandOutcomeAudit, applyCommand, issueExternalApplyCapability, approveCommandFromUI, cancelCommand, commandDecision, commandFields, commandOutcome, confirmCommandValuesFromUI, externalAgentActor, isPendingCommand, noteReceivedCommands, prepareCommand, refineCommandOutcome, settleCommand, terminalCommandState, type CommandEnvelope, type CommandField, type CommandGrant, type CommandOutcome, type CommandPreparation, type PreparedCommand } from './command-bus'
import { confirmSplitCommandFromUI, type SplitChildDraft } from './task-split-change'
import { confirmRoutineCommandFromUI, triggerForCommand } from './routine-external-change'
import { loadCalendarRulesState } from './calendar-rules-save'
import { calendarRuleEditorDefinition } from './calendar-rule-editor'
import { assertFileBridgeInboxEntry, assertFileBridgeLease, assertFileBridgeResult, assertFileBridgeStatus, fileBridgeDigest, fileBridgeTimestamp, rejectFileBridge } from './file-bridge-contract'
import { loadTaskEgress, ownerNotesForEgress, recordEgressAudit } from './egress-policy'
import { fileBridgeReceiptKey, fileBridgeScopeKey, type FileBridgeApplicationBinding, type FileBridgeApplicationReceipt, type FileBridgeCommand, type FileBridgeConfigure, type FileBridgeGateway, type FileBridgeInboxEntry, type FileBridgeLease, type FileBridgeRegistration, type FileBridgeResult, type FileBridgeStatus } from './file-bridge-types'

type PendingEntry = Extract<FileBridgeInboxEntry,{state:'awaiting_approval'}>
/** A scanned inbox command after the shared command bus prepared it (K12). */
export type PreparedFileBridgeApplication = {
  version: 1; id: string; reference: string; entry: PendingEntry; registration: FileBridgeRegistration; entrance: 'file' | 'mcp'
  command: PreparedCommand; changeSet: PreparedChangeSet | null; assisted: PreparedAssistedTasks | null; digest: string
}
export type FileBridgeApplicationOutcome = { receipt: FileBridgeApplicationReceipt; result: FileBridgeResult | null; resultPending: boolean }
const fileStates:Record<string,'denied'|'conflict'|'expired'|'rejected'>={denied:'denied',conflict:'conflict',expired:'expired',rejected:'rejected'}
function freeze<T>(value:T):T { if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)}return value }
function trustedClick(event:Event) {
  if(!(event instanceof Event)||!event.isTrusted||event.type!=='click')rejectFileBridge('HUMAN_APPROVAL_REQUIRED','アプリの本人確認ボタンから承認してください。')
  try{const getter=Object.getOwnPropertyDescriptor(Event.prototype,'type')?.get;if(!getter||getter.call(event)!=='click')throw new Error()}catch{rejectFileBridge('HUMAN_APPROVAL_REQUIRED')}
}
async function settings():Promise<Settings>{const value=await db.settings.get('main');if(!value)rejectFileBridge('SETTINGS_MISSING');return value}
function assertSettings(registration:FileBridgeRegistration,value:Settings) {
  const policy=changePolicyFor(value)
  if(value.profileId!==registration.owner_id||value.datasetId!==registration.dataset_id)rejectFileBridge('OWNER_CHANGED')
  // The shared reason is named so S06, file and MCP report the same code.
  if(agentChangesStopped(value,fileBridgeCommandGrant(registration),{kind:'external-agent',id:registration.client.id}))rejectFileBridge('AUTHORITY_CHANGED','AIによる変更は停止しています。接続を確認してください。','CHANGES_STOPPED')
  if(policy.epoch!==registration.policy_epoch||policy.sourcePermissionRevision!==registration.source_permission_revision)rejectFileBridge('AUTHORITY_CHANGED','本人・AI設定または利用許可が変わりました。接続を確認してください。','POLICY_CHANGED')
  if(Date.parse(registration.client.grant.expires_at)<=Date.now())rejectFileBridge('EXPIRED')
}
/** Renderer-side mirror of main's check: the N09 table itself must allow automatic notes/schedule changes in these bounds. */
export function fileBridgeAutomationAllowed(policy:ChangePolicy,fields:string[],maxScheduleShiftDays:number){
  if(!fields.length||fields.some(field=>!['notes','scheduled_date'].includes(field)))return false
  if(fields.includes('notes')&&operationMode(policy,'task.text')!=='auto_within_bounds')return false
  if(!fields.includes('scheduled_date'))return true
  const limit=ruleFor(policy,'task.schedule').max_schedule_days_delta??policy.bounds.maxScheduledDayShift
  return operationMode(policy,'task.schedule')==='auto_within_bounds'&&maxScheduleShiftDays<=limit
}
/** Effective authority = owner policy ∩ this signed grant; the grant never approves by itself. */
export function fileBridgeCommandGrant(registration:FileBridgeRegistration):CommandGrant {
  const grant=registration.client.grant
  return {fields:grant.fields.filter(field=>commandFields.includes(field as CommandField)) as CommandField[],operations:['task.update','task.create',...(grant.keys.includes('tasks:split')?['task.split']:[]),...(grant.keys.includes('routines:prepare')?['routine.change']:[])],mutationMode:grant.mutation_mode,maxScheduleShiftDays:grant.max_schedule_shift_days,autoMaxScheduleShiftDays:grant.automation?.max_schedule_shift_days??null}
}
export function fileBridgeEnvelope(command:FileBridgeCommand):CommandEnvelope {
  return {schema_version:'1',command_id:command.command_id,type:command.type,target_id:command.target_id,expected_revision:command.expected_revision,payload:structuredClone(command.payload) as Record<string,unknown>,basis:command.basis?structuredClone(command.basis):{kind:'external_request'}}
}
const entranceOf=(command:FileBridgeCommand):'file'|'mcp'=>command.via==='mcp_stdio'?'mcp':'file'
function outcomeError(outcome:CommandOutcome):never { throw Object.assign(new ChangeSetError(outcome.code??'COMMAND_FAILED',outcome.message),{commonCode:outcome.code??undefined}) }

function commandDigestPayload(entry:PendingEntry,reg:FileBridgeRegistration) {
  return {command:entry.prepared.command,owner_id:reg.owner_id,dataset_id:reg.dataset_id,client_id:reg.client.id,policy_epoch:reg.policy_epoch,source_permission_revision:reg.source_permission_revision,registration_revision:reg.client.revision,grant_epoch:reg.client.grant_epoch}
}
function binding(prepared:PreparedFileBridgeApplication):FileBridgeApplicationBinding {
  const reg=prepared.registration
  return {reference:prepared.reference,fileDigest:prepared.entry.prepared.digest,applicationDigest:prepared.digest,ownerId:reg.owner_id,datasetId:reg.dataset_id,policyEpoch:reg.policy_epoch,sourcePermissionRevision:reg.source_permission_revision}
}
function validReceipt(value:unknown):value is FileBridgeApplicationReceipt {
  if(!value||typeof value!=='object'||Array.isArray(value))return false
  const item=value as Record<string,unknown>,keys=['version','commandId','fileDigest','applicationDigest','ownerId','datasetId','clientId','policyEpoch','sourcePermissionRevision','registrationRevision','grantEpoch','taskIds','appliedAt']
  const uuid=(raw:unknown)=>typeof raw==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(raw)
  return Object.keys(item).length===keys.length&&keys.every(key=>Object.hasOwn(item,key))&&item.version===1&&uuid(item.commandId)&&typeof item.ownerId==='string'&&Boolean(item.ownerId.trim())&&item.ownerId.length<=200&&uuid(item.datasetId)&&uuid(item.clientId)&&fileBridgeDigest(item.fileDigest)&&fileBridgeDigest(item.applicationDigest)&&['policyEpoch','sourcePermissionRevision','registrationRevision','grantEpoch'].every(key=>Number.isSafeInteger(item[key])&&Number(item[key])>=(['registrationRevision','grantEpoch'].includes(key)?1:0))&&Array.isArray(item.taskIds)&&item.taskIds.length===1&&uuid(item.taskIds[0])&&fileBridgeTimestamp(item.appliedAt)
}
/** Main's designated renderer queries this persisted fact. It cannot create an approval. */
export async function readFileBridgeApplicationReceipt(commandId:string,clientId?:string):Promise<FileBridgeApplicationReceipt|null> {
  if(!/^[a-f0-9-]{36}$/i.test(commandId))return null
  const stored=await db.commands.get(fileBridgeReceiptKey(commandId,clientId)) ?? await db.commands.get(fileBridgeReceiptKey(commandId))
  if(!stored)return null
  try{const receipt:unknown=JSON.parse(stored.resultId),current=await settings();if(!validReceipt(receipt)||receipt.commandId!==commandId||clientId!==undefined&&receipt.clientId!==clientId||stored.hash!==receipt.applicationDigest||stored.at!==receipt.appliedAt||receipt.ownerId!==current.profileId||receipt.datasetId!==current.datasetId)return null;return receipt}catch{return null}
}

const applicationTables=()=>[db.tasks,db.assessments,db.commands,db.audits,db.containers,db.settings,db.labelGroups,db.labelDefinitions,db.tripBundles,db.completions,db.checklistItems,db.calendarRules,db.calendarEvents,db.sessions,db.contextSources,db.contextSnapshots,db.sourceArtifacts]
/** Instantiate only with the isolated preload gateway, never a gateway from external material. */
export function createFileBridgeController(gateway:FileBridgeGateway) {
  const entries=new Map<string,PendingEntry>(),preparedRegistry=new Map<string,PreparedFileBridgeApplication>(),leases=new Map<string,FileBridgeLease>()
  let currentStatus:FileBridgeStatus|null=null,lastEgress:{withheldQuotes:number;notesWithheld:number}|null=null
  /** Dropped reviews cancel their unapproved bus commands so S21 never lists them; applied commands are already settled. */
  async function dropPrepared(){const dropped=[...preparedRegistry.values()];preparedRegistry.clear();for(const value of dropped)if(isPendingCommand(value.command))await cancelCommand(value.command)}
  function clear(){void dropPrepared();entries.clear();leases.clear();noteReceivedCommands('external',[],currentStatus?.registration?.client.id)}
  async function adoptStatus(raw:FileBridgeStatus):Promise<FileBridgeStatus> {
    assertFileBridgeStatus(raw)
    const status=freeze(structuredClone(raw)),current=await settings(),registration=status.registration
    if(registration&&(registration.owner_id!==current.profileId||registration.dataset_id!==current.datasetId))rejectFileBridge('OWNER_CHANGED')
    if(status.results.some(result=>result.owner_id!==current.profileId||result.dataset_id!==current.datasetId))rejectFileBridge('OWNER_CHANGED')
    if(registration&&status.snapshot&&status.snapshot.registration_sha256!==await contentDigest(registration))rejectFileBridge('SNAPSHOT_INVALID')
    const payload={version:1,registration}
    await db.transaction('rw',db.settings,db.commands,async()=>{
      const value=await settings()
      if(value.profileId!==current.profileId||value.datasetId!==current.datasetId)rejectFileBridge('OWNER_CHANGED')
      const key=fileBridgeScopeKey(value.profileId,value.datasetId,registration?.client.id??currentStatus?.registration?.client.id),previous=await db.commands.get(key)
      if(previous&&registration){try{const old=JSON.parse(previous.resultId).registration as FileBridgeRegistration|null;if(old?.client.id===registration.client.id&&(old.client.revision>registration.client.revision||old.client.grant_epoch>registration.client.grant_epoch))rejectFileBridge('REGISTRATION_ROLLBACK')}catch(error){if(error instanceof Error&&'code'in error)throw error}}
      const external=externalAIFor(value), clients=external.clients.filter(client=>client.registration.client.id!==registration?.client.id).map(client=>!registration&&client.registration.client.id===currentStatus?.registration?.client.id?{...client,status:'revoked' as const}:client)
      if(registration){const previous=external.clients.find(client=>client.registration.client.id===registration.client.id);clients.push({registration:structuredClone(registration),status:'active',capabilityChecks:previous?.registration.client.revision===registration.client.revision&&previous?.registration.client.grant_epoch===registration.client.grant_epoch?previous.capabilityChecks:[],shippingState:'implemented'})}
      await db.settings.put({...value,externalAI:{...external,clients:clients.slice(-50)}})
      await db.commands.put({key,hash:await Dexie.waitFor(contentDigest(payload)),resultId:JSON.stringify(payload),at:new Date().toISOString()})
    })
    if(currentStatus&&canonicalJSON({registration:currentStatus.registration,snapshot:currentStatus.snapshot})!==canonicalJSON({registration:status.registration,snapshot:status.snapshot}))clear()
    currentStatus=status
    return status
  }
  async function assertCurrent(prepared:PreparedFileBridgeApplication) {
    assertSettings(prepared.registration,await settings())
    const scope=await db.commands.get(fileBridgeScopeKey(prepared.registration.owner_id,prepared.registration.dataset_id,prepared.registration.client.id))
    if(!scope||scope.hash!==await Dexie.waitFor(contentDigest({version:1,registration:prepared.registration})))rejectFileBridge('AUTHORITY_CHANGED')
    if(Date.parse(prepared.entry.prepared.expiresAt)<=Date.now())rejectFileBridge('EXPIRED')
    if(preparedRegistry.get(prepared.id)!==prepared)rejectFileBridge('UNVERIFIED_COMMAND')
  }
  async function verifyPrepared(prepared:PreparedFileBridgeApplication) {
    const saved=preparedRegistry.get(prepared?.id)
    if(!saved)rejectFileBridge('UNVERIFIED_COMMAND','外部ファイルや保存したJSONから承認権限は復元しません。受信箱から確認してください。')
    // A substituted copy reports a digest mismatch like S06; an identical copy is still not the registered authority.
    const {digest,...payload}=prepared
    if(digest!==saved.digest||digest!==await Dexie.waitFor(contentDigest(payload)))rejectFileBridge('DIGEST_MISMATCH','確認した変更内容が変わりました。受信箱から確認し直してください。')
    if(saved!==prepared)rejectFileBridge('UNVERIFIED_COMMAND','外部ファイルや保存したJSONから承認権限は復元しません。受信箱から確認してください。')
  }
  /** Signs why a scanned command did not run, so michi_command_result shows the app's code (best effort). */
  async function reportOutcome(reference:string,outcome:CommandOutcome) {
    const state=fileStates[outcome.state]
    if(!state||!outcome.code||!gateway.recordRejected||!entries.has(reference))return
    try{const result=await gateway.recordRejected({reference,state,code:outcome.code});assertFileBridgeResult(result);entries.delete(reference)}catch{/* The inbox entry stays; the next scan reports it again. */}
  }
  /** S21 record of a scanned command that ends unapplied; identity comes from the signed registration, never the file. */
  async function noteOutcome(reference:string,prepared:PreparedFileBridgeApplication|null,outcome:Pick<CommandOutcome,'state'|'code'|'message'>) {
    if(prepared)return recordCommandOutcomeAudit(commandOutcomeFacts(prepared.command),outcome)
    const entry=entries.get(reference),reg=currentStatus?.registration
    if(!entry||!reg||entry.prepared.principal.id!==reg.client.id)return
    const command=entry.prepared.command
    await recordCommandOutcomeAudit({commandId:command.command_id,entrance:entranceOf(command),principal:{id:reg.client.id,kind:'external-agent',model:null},type:command.type,targetId:command.target_id,basis:'external_request',fields:Object.keys(command.payload)},outcome)
  }
  async function terminal(reference:string,prepared:PreparedFileBridgeApplication|null,error:unknown):Promise<CommandOutcome> {
    const outcome=await refineCommandOutcome(commandOutcome(error,{commandId:prepared?.entry.prepared.command.command_id??entries.get(reference)?.prepared.command.command_id??null,entrance:prepared?.entrance??null}),prepared?.command.actor??null)
    if(terminalCommandState(outcome.state)){await noteOutcome(reference,prepared,outcome);await reportOutcome(reference,outcome);if(prepared){preparedRegistry.delete(prepared.id);if(isPendingCommand(prepared.command))await cancelCommand(prepared.command)}}
    return outcome
  }
  async function wrap(reference:string,entry:PendingEntry,registration:FileBridgeRegistration,preparation:CommandPreparation):Promise<PreparedFileBridgeApplication> {
    if(!preparation.prepared)outcomeError(preparation.outcome)
    const command=preparation.prepared,body=command.body as {assisted?:PreparedAssistedTasks}|null
    const payload={version:1 as const,id:uid(),reference,entry,registration:structuredClone(registration),entrance:entranceOf(entry.prepared.command),command,changeSet:command.changeSet,assisted:body?.assisted??null},prepared=freeze({...payload,digest:await contentDigest(payload)})
    for(const [key,value] of preparedRegistry)if(value.reference===reference){preparedRegistry.delete(key);if(value.command!==command&&isPendingCommand(value.command))await cancelCommand(value.command)}
    preparedRegistry.set(prepared.id,prepared);await assertCurrent(prepared)
    return prepared
  }
  async function notify(prepared:PreparedFileBridgeApplication,receipt:FileBridgeApplicationReceipt,lease:FileBridgeLease):Promise<FileBridgeApplicationOutcome> {
    try{
      const persisted=await readFileBridgeApplicationReceipt(receipt.commandId,prepared.registration.client.id)
      if(!persisted||canonicalJSON(persisted)!==canonicalJSON(receipt))rejectFileBridge('RECEIPT_MISSING')
      const result=await gateway.recordApplied({leaseId:lease.leaseId,reference:prepared.reference,receipt})
      assertFileBridgeResult(result)
      if(result.command_id!==receipt.commandId||result.digest!==receipt.fileDigest||result.owner_id!==receipt.ownerId||result.dataset_id!==receipt.datasetId||result.client_id!==receipt.clientId||result.state!=='applied'||canonicalJSON(result.receipt?.taskIds)!==canonicalJSON(receipt.taskIds)||result.receipt?.appliedAt!==receipt.appliedAt)rejectFileBridge('RESULT_MISMATCH')
      return {receipt,result,resultPending:false}
    }catch{return {receipt,result:null,resultPending:true}}
  }
  async function priorOutcome(prepared:PreparedFileBridgeApplication):Promise<FileBridgeApplicationOutcome|null> {
    const prior=await readFileBridgeApplicationReceipt(prepared.entry.prepared.command.command_id,prepared.registration.client.id)
    if(!prior)return null
    if(prior.applicationDigest!==prepared.digest)rejectFileBridge('IDEMPOTENCY_MISMATCH')
    const existingLease=leases.get(prepared.id)
    if(!existingLease)rejectFileBridge('RECEIPT_ALREADY_APPLIED','このコマンドは保存済みです。受信箱の結果を更新してください。')
    return notify(prepared,prior,existingLease)
  }
  async function commit(prepared:PreparedFileBridgeApplication,approval:unknown,lease:FileBridgeLease,automatic:boolean):Promise<FileBridgeApplicationOutcome> {
    const reg=prepared.registration
    try{
      assertFileBridgeLease(lease)
      if(canonicalJSON(binding(prepared))!==canonicalJSON({reference:lease.reference,fileDigest:lease.fileDigest,applicationDigest:lease.applicationDigest,ownerId:lease.ownerId,datasetId:lease.datasetId,policyEpoch:lease.policyEpoch,sourcePermissionRevision:lease.sourcePermissionRevision})||lease.automatic!==automatic||lease.clientId!==reg.client.id||lease.registrationRevision!==reg.client.revision||lease.grantEpoch!==reg.client.grant_epoch||Date.parse(lease.expiresAt)<=Date.now()||Date.parse(lease.expiresAt)>Date.parse(prepared.entry.prepared.expiresAt))rejectFileBridge('LEASE_INVALID')
    }catch(error){if(lease&&typeof lease.leaseId==='string')await gateway.cancelApplication({leaseId:lease.leaseId,reference:prepared.reference}).catch(()=>{});throw error}
    leases.set(prepared.id,freeze(structuredClone(lease)))
    let receipt:FileBridgeApplicationReceipt
    try{
      receipt=await db.transaction('rw',applicationTables(),async()=>{
        await verifyPrepared(prepared);await assertCurrent(prepared)
        if(Date.parse(lease.expiresAt)<=Date.now())rejectFileBridge('EXPIRED')
        const command=prepared.entry.prepared.command,key=fileBridgeReceiptKey(command.command_id,prepared.registration.client.id),existing=await db.commands.get(key)
        if(existing){const previous=JSON.parse(existing.resultId) as FileBridgeApplicationReceipt;if(!validReceipt(previous)||existing.hash!==prepared.digest||previous.applicationDigest!==prepared.digest||previous.fileDigest!==prepared.entry.prepared.digest)rejectFileBridge('IDEMPOTENCY_MISMATCH');return previous}
        const today=new Date().toISOString().slice(0,10),receipts=await db.commands.toArray()
        const count=receipts.filter(item=>item.key.startsWith('filebridge:applied:')&&item.at.slice(0,10)===today).reduce((sum,item)=>{try{const stored=JSON.parse(item.resultId);return sum+(validReceipt(stored)&&stored.clientId===reg.client.id&&stored.ownerId===reg.owner_id&&stored.datasetId===reg.dataset_id?1:0)}catch{return sum}},0)
        if(count>=reg.client.grant.max_operations_per_day)rejectFileBridge('DAILY_BOUND')
        if(automatic&&!prepared.changeSet)rejectFileBridge('INVALID_APPLICATION')
        // applyChangeSet re-decides inside this transaction; with no approval it succeeds only when the N09 decision is auto.
        const applied=await applyCommand(prepared.command,approval,`filebridge:${command.command_id}`,issueExternalApplyCapability(prepared.command))
        // The file receipt names the command target (or the created task); split children and rule details stay in the app audit.
        const taskIds=[command.type==='task.create'?applied.taskIds[0]:command.target_id!]
        const appliedAt=new Date().toISOString(),result:FileBridgeApplicationReceipt={version:1,commandId:command.command_id,fileDigest:prepared.entry.prepared.digest,applicationDigest:prepared.digest,ownerId:reg.owner_id,datasetId:reg.dataset_id,clientId:reg.client.id,policyEpoch:reg.policy_epoch,sourcePermissionRevision:reg.source_permission_revision,registrationRevision:reg.client.revision,grantEpoch:reg.client.grant_epoch,taskIds,appliedAt}
        await db.commands.add({key,hash:prepared.digest,resultId:JSON.stringify(result),at:appliedAt})
        await db.audits.add({id:uid(),taskId:command.type==='routine.change'?null:taskIds[0]??null,operation:automatic?'filebridge.auto':'filebridge.approved',at:appliedAt,detail:JSON.stringify({...result,approvedBy:automatic?null:reg.owner_id,decision:automatic?'auto':'approved',snapshotId:command.snapshot_id,operation:command.type,entrance:prepared.entrance,basis:'external_request',changeSetId:applied.changeSetId,appliedTaskIds:applied.taskIds})})
        return result
      })
    }catch(error){
      const outcome=await refineCommandOutcome(commandOutcome(error,{commandId:prepared.entry.prepared.command.command_id,entrance:prepared.entrance}),prepared.command.actor)
      const state=fileStates[outcome.state]
      await gateway.cancelApplication({leaseId:lease.leaseId,reference:prepared.reference,...(state&&outcome.code?{outcome:{state,code:outcome.code}}:{})}).catch(()=>{})
      if(terminalCommandState(outcome.state)){await noteOutcome(prepared.reference,prepared,outcome);entries.delete(prepared.reference);preparedRegistry.delete(prepared.id);if(isPendingCommand(prepared.command))await cancelCommand(prepared.command)}
      throw error
    }
    settleCommand(prepared.command)
    return notify(prepared,receipt,lease)
  }
  return {
    clearAuthority:clear,
    lastEgress:()=>lastEgress,
    refresh:async()=>adoptStatus(await gateway.status()),
    selectClient:async(clientId:string)=>{if(!gateway.selectClient)rejectFileBridge('UNSUPPORTED_OPERATION');return adoptStatus(await gateway.selectClient({clientId}))},
    async configure(request:Pick<FileBridgeConfigure,'intendedHost'|'taskIds'|'fields'|'lifetimeHours'|'allowSplit'|'ruleIds'>&{automation?:FileBridgeConfigure['automation']},event:Event) {
      trustedClick(event)
      const current=await settings(),policy=changePolicyFor(current)
      if(!externalAIFor(current).enabled||!policy.aiChangesEnabled)rejectFileBridge('AUTHORITY_CHANGED')
      if(request.automation&&!fileBridgeAutomationAllowed(policy,request.fields,request.automation.maxScheduleShiftDays))rejectFileBridge('AUTOMATION_NOT_GRANTED','自動化設定（S20）でメモ・予定日の範囲内自動を許可してから、同じかより狭い範囲で委任してください。')
      const {allowSplit,ruleIds,...basic}=structuredClone(request),extended=allowSplit||ruleIds?.length?{allowSplit:Boolean(allowSplit),ruleIds:ruleIds??[]}:{}
      const value={...basic,automation:request.automation??null,...extended,ownerId:current.profileId,datasetId:current.datasetId,policyEpoch:policy.epoch,sourcePermissionRevision:policy.sourcePermissionRevision}
      return adoptStatus(await gateway.configure(value))
    },
    async revise(request:FileBridgeRevise,event?:Event){
      if(event)trustedClick(event)
      if(!gateway.revise||!gateway.invalidateClient)rejectFileBridge('FEATURE_NOT_IMPLEMENTED')
      request=structuredClone(request)
      const reg=currentStatus?.registration
      if(!reg||request.clientId!==reg.client.id||request.expectedRevision!==reg.client.revision)rejectFileBridge('REVISION_CONFLICT')
      await db.transaction('rw',db.settings,db.commands,db.datasetState,async()=>{
        const current=await settings(),external=externalAIFor(current),client=external.clients.find(value=>value.registration.client.id===reg.client.id)
        if(!external.enabled||!client||client.status!=='active'||canonicalJSON(client.registration)!==canonicalJSON(reg))rejectFileBridge('AUTHORITY_CHANGED')
        if((await db.datasetState.get('main'))?.mode&&((await db.datasetState.get('main'))!.mode!=='active')||(current.datasetMode??'active')!=='active')rejectFileBridge('DATASET_FROZEN')
        await db.settings.put({...current,externalAI:{...external,clients:external.clients.map(value=>value===client?{...value,status:'needs_reauth' as const}:value)}})
        const payload={version:1,registration:null}
        await db.commands.put({key:fileBridgeScopeKey(reg.owner_id,reg.dataset_id,reg.client.id),hash:await Dexie.waitFor(contentDigest(payload)),resultId:JSON.stringify(payload),at:new Date().toISOString()})
      })
      // This transaction serializes with old applies; no old capability survives the scope latch.
      clearCommandAuthority({clientId:reg.client.id});clearChangeSetAuthority({clientId:reg.client.id});clearExternalInstructionAuthority(reg.client.id)
      await dropPrepared();entries.clear();leases.clear();noteReceivedCommands('external',[],reg.client.id)
      try{return await adoptStatus(await gateway.revise(request))}
      catch(error){
        await gateway.invalidateClient({clientId:reg.client.id}).catch(()=>{})
        await db.transaction('rw',db.settings,async()=>{const current=await settings(),external=externalAIFor(current);await db.settings.put({...current,externalAI:{...external,clients:external.clients.map(value=>value.registration.client.id===reg.client.id?{...value,status:'revoked' as const}:value)}})})
        throw error
      }
    },
    async disconnect(event:Event) {
      trustedClick(event)
      const clientId=currentStatus?.registration?.client.id
      if(!clientId)rejectFileBridge('DISCONNECTED')
      const status=await gateway.disconnect({clientId});clear();return adoptStatus(status)
    },
    async exportSnapshot(event:Event) {
      trustedClick(event)
      const reg=currentStatus?.registration
      if(!reg)rejectFileBridge('DISCONNECTED')
      assertSettings(reg,await settings())
      const tasks=await db.tasks.bulkGet(reg.task_ids)
      if(tasks.some(task=>!task||task.deletedAt||task.status!=='open'||reg.client.grant.project_ids.length&&!reg.client.grant.project_ids.includes(task.containerId??'')))rejectFileBridge('TASK_SCOPE')
      // An agent host cannot be bound to a model or a revocable copy, so source quotes never enter the view.
      const destination={kind:'external-agent' as const,route:'file-bridge' as const,clientId:reg.client.id,host:reg.client.intended_host}
      const views=await Promise.all(tasks.map(async task=>({task:task!,egress:await loadTaskEgress(task!,destination)})))
      await db.transaction('rw',db.audits,db.settings,()=>recordEgressAudit(destination,views.map(({task,egress})=>({taskId:task.id,egress}))))
      lastEgress={withheldQuotes:views.reduce((sum,view)=>sum+view.egress.withheldQuotes,0),notesWithheld:views.filter(view=>view.egress.notesWithheld).length}
      // Owner-selected series only: id, revision, current title and trigger. No facts, sources or completions.
      const rules=reg.rule_ids?.length?(await loadCalendarRulesState()).rules.filter(rule=>reg.rule_ids!.includes(rule.id)).map(rule=>{const definition=calendarRuleEditorDefinition(rule),trigger=triggerForCommand(definition.trigger);if(!trigger)rejectFileBridge('RULE_SCOPE','RRULE・完了起点の系列は外部へ書き出しません。接続の系列選択を見直してください。');return {id:rule.id,revision:rule.revision,title:definition.title,trigger}}):[]
      return adoptStatus(await gateway.exportSnapshot({tasks:views.map(({task,egress})=>({id:task.id,revision:task.revision,title:task.title,notes:egress.notes,scheduledDate:task.scheduledDate,containerId:task.containerId??null})),...(rules.length?{rules}:{})}))
    },
    async scanInbox() {
      const scanned=await gateway.scanInbox(),status=await adoptStatus(scanned.status)
      if(!Array.isArray(scanned.entries)||scanned.entries.length>100)rejectFileBridge('ENTRY_INVALID')
      // A rescan drops earlier reviews; their bus commands must not stay listed in S21.
      entries.clear();await dropPrepared()
      for(const raw of scanned.entries){assertFileBridgeInboxEntry(raw);if(raw.state==='awaiting_approval'){
        const entry=freeze(structuredClone(raw)),reg=status.registration,manifest=status.snapshot,value=entry.prepared
        if(!reg||!manifest||value.ownerId!==reg.owner_id||value.datasetId!==reg.dataset_id||value.principal.id!==reg.client.id||value.policyEpoch!==reg.policy_epoch||value.sourcePermissionRevision!==reg.source_permission_revision||value.snapshotId!==manifest.snapshot_id||value.digest!==await contentDigest(commandDigestPayload(entry,reg))||entries.has(entry.reference))rejectFileBridge('COMMAND_BINDING')
        if((value.command.type==='task.update'||value.command.type==='task.split')&&(!reg.task_ids.includes(value.command.target_id!)||manifest.entity_revisions[value.command.target_id!]!==value.command.expected_revision))rejectFileBridge('TASK_SCOPE')
        if(value.command.type==='routine.change'&&!reg.rule_ids?.includes(value.command.target_id!))rejectFileBridge('TASK_SCOPE')
        entries.set(entry.reference,entry)
      }}
      noteReceivedCommands('external',[...entries.values()].map(entry=>{const command=entry.prepared.command;return {commandId:command.command_id,entrance:entranceOf(command),type:command.type,targetId:command.target_id,expectedRevision:command.expected_revision,principalId:entry.prepared.principal.id,host:status.registration?.client.intended_host??null,fields:Object.keys(command.payload),expiresAt:command.expires_at}}),status.registration?.client.id)
      return {status,entries:freeze(structuredClone(scanned.entries))}
    },
    async prepare(reference:string):Promise<PreparedFileBridgeApplication> {
      const entry=entries.get(reference),registration=currentStatus?.registration
      if(!entry||!registration)rejectFileBridge('UNVERIFIED_COMMAND')
      try{
        assertSettings(registration,await settings())
        const command=entry.prepared.command,grant=registration.client.grant
        if(!grant.keys.includes('tasks:prepare')||!grant.keys.includes('changes:submit')||!grant.max_operations_per_day||(command.type==='task.update'||command.type==='task.create')&&Object.keys(command.payload).some(field=>!grant.fields.includes(field as typeof grant.fields[number]))||command.type==='task.split'&&!grant.keys.includes('tasks:split')||command.type==='routine.change'&&!grant.keys.includes('routines:prepare'))rejectFileBridge('SCOPE_DENIED')
        if(Date.parse(command.expires_at)<=Date.now()||Date.parse(command.expires_at)>Date.parse(grant.expires_at)||Date.parse(command.expires_at)>Date.now()+24*60*60*1000)rejectFileBridge('EXPIRED')
        if(command.type==='task.update'||command.type==='task.split'){
          const task=await db.tasks.get(command.target_id!)
          if(!task||task.deletedAt||!registration.task_ids.includes(task.id)||grant.project_ids.length&&!grant.project_ids.includes(task.containerId??''))rejectFileBridge('TASK_SCOPE')
          const after=command.payload.scheduled_date
          if(Object.hasOwn(command.payload,'scheduled_date')&&after&&task.scheduledDate&&Math.abs(Date.parse(after)-Date.parse(task.scheduledDate))/86400000>grant.max_schedule_shift_days)rejectFileBridge('SCHEDULE_BOUND')
        }else if(command.type==='task.create'&&grant.project_ids.length)rejectFileBridge('TASK_SCOPE','プロジェクトを限定した接続での新規作成は未対応です。アプリで作成してください。')
        const actor=externalAgentActor({ownerId:registration.owner_id,datasetId:registration.dataset_id,clientId:registration.client.id,registrationRevision:registration.client.revision,grantEpoch:registration.client.grant_epoch,host:registration.client.intended_host},entranceOf(command),fileBridgeCommandGrant(registration))
        const reason=command.type==='task.update'?'選択した外部エージェントからの変更案（まだ適用していません）':command.type==='task.split'?'外部エージェントからの分割案（本人が配分を確認します）':command.type==='routine.change'?'外部エージェントからの周期変更案（本人が次回日程を確認します）':'外部エージェントからの新規作成'
        return await wrap(reference,entry,registration,await prepareCommand(fileBridgeEnvelope(command),actor,{reason}))
      }catch(error){await terminal(reference,null,error);throw error}
    },
    /** Owner confirms exact title/deadline/points values an agent proposed (same as S06). */
    async confirmValuesFromUI(prepared:PreparedFileBridgeApplication,event:Event,message='') {
      trustedClick(event);await verifyPrepared(prepared);await assertCurrent(prepared)
      return wrap(prepared.reference,prepared.entry,prepared.registration,await confirmCommandValuesFromUI(prepared.command,event,message))
    },
    async confirmSplitFromUI(prepared:PreparedFileBridgeApplication,values:SplitChildDraft[],event:Event,message='') {
      trustedClick(event);await verifyPrepared(prepared);await assertCurrent(prepared)
      return wrap(prepared.reference,prepared.entry,prepared.registration,await confirmSplitCommandFromUI(prepared.command,values,event,message))
    },
    async confirmRoutineFromUI(prepared:PreparedFileBridgeApplication,event:Event) {
      trustedClick(event);await verifyPrepared(prepared);await assertCurrent(prepared)
      return wrap(prepared.reference,prepared.entry,prepared.registration,await confirmRoutineCommandFromUI(prepared.command,event))
    },
    /** Closes queued entries after AI OFF or an authority change, so agents see the same code as the app.
     *  CHANGES_STOPPED only when AI changes are off or every operation this grant carries is denied (N09 ∩ grant); otherwise POLICY_CHANGED. */
    async closePending(requested:'CHANGES_STOPPED'|'POLICY_CHANGED'='CHANGES_STOPPED') {
      const reg=currentStatus?.registration,current=await db.settings.get('main')
      const code=requested==='CHANGES_STOPPED'&&current&&agentChangesStopped(current,reg?fileBridgeCommandGrant(reg):null,{kind:'external-agent',id:reg?.client.id??'external'})?'CHANGES_STOPPED' as const:'POLICY_CHANGED' as const
      const state=code==='CHANGES_STOPPED'?'denied' as const:'expired' as const
      for(const reference of [...entries.keys()]){const outcome={commandId:null,entrance:null,state,code,message:code==='CHANGES_STOPPED'?'AIによる変更の停止で待機中のコマンドを閉じました':'設定・権限の変更で待機中のコマンドを閉じました',receipt:null};const prepared=[...preparedRegistry.values()].find(value=>value.reference===reference)??null;await noteOutcome(reference,prepared,outcome);await reportOutcome(reference,outcome)}
    },
    async applyFromUI(prepared:PreparedFileBridgeApplication,event:Event,checkedProtectedFields:TaskChangeField[]=[]):Promise<FileBridgeApplicationOutcome> {
      trustedClick(event);await verifyPrepared(prepared);await assertCurrent(prepared)
      const prior=await priorOutcome(prepared);if(prior)return prior
      let approval:unknown
      try{approval=await approveCommandFromUI(prepared.command,event,checkedProtectedFields)}
      catch(error){await terminal(prepared.reference,prepared,error);throw error}
      return commit(prepared,approval,await gateway.authorizeApplication(binding(prepared)),false)
    },
    /** No click. Only for an owner-delegated auto grant where the shared N09 engine decides auto; otherwise the entry waits for approval. */
    async applyAutomatically(prepared:PreparedFileBridgeApplication):Promise<FileBridgeApplicationOutcome> {
      await verifyPrepared(prepared);await assertCurrent(prepared)
      const reg=prepared.registration,current=await settings()
      if(!prepared.changeSet||reg.client.grant.mutation_mode!=='auto_within_bounds'||!gateway.authorizeAutomaticApplication)rejectFileBridge('AUTOMATION_NOT_GRANTED','この接続には範囲内の自動適用が委任されていません。')
      // The bus decision is N09 ∩ this grant's automation bounds; daily counts come from the audits of every entrance.
      const decision=commandDecision(prepared.command,current),counted=decideChangePolicy(prepared.changeSet,changePolicyFor(current),{autoCountToday:await autoChangeCountsToday()})
      if(decision.status!=='auto'||counted.status!=='auto')rejectFileBridge('APPROVAL_REQUIRED',decision.status!=='auto'?decision.reason:counted.reason)
      // The agent saw these notes with source-quote lines withheld, so its replacement would drop them unseen.
      const command=prepared.entry.prepared.command,target=command.target_id?await db.tasks.get(command.target_id):undefined
      if(target&&Object.hasOwn(command.payload,'notes')&&ownerNotesForEgress(target.notes).notes!==target.notes)rejectFileBridge('APPROVAL_REQUIRED','資料由来の行を伏せたメモへの変更は、本人が確認して適用してください。')
      const prior=await priorOutcome(prepared);if(prior)return prior
      return commit(prepared,null,await gateway.authorizeAutomaticApplication(binding(prepared)),true)
    },
    async retryResultFromUI(prepared:PreparedFileBridgeApplication,event:Event):Promise<FileBridgeApplicationOutcome> {
      trustedClick(event);await verifyPrepared(prepared)
      const receipt=await readFileBridgeApplicationReceipt(prepared.entry.prepared.command.command_id,prepared.registration.client.id),lease=leases.get(prepared.id)
      if(!receipt||!lease||receipt.applicationDigest!==prepared.digest)rejectFileBridge('RECEIPT_MISSING')
      return notify(prepared,receipt,lease)
    }
  }
}
export type FileBridgeController=ReturnType<typeof createFileBridgeController>
