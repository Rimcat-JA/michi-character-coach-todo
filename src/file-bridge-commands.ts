import Dexie from 'dexie'
import { db } from './db'
import { canonicalJSON, contentDigest } from './canonical'
import { newTaskInput } from './commands'
import { uid, type Settings } from './domain'
import { applyChangeSet, approveChangeSetFromUI, autoChangeCountsToday, changePolicyFor, decideChangePolicy, prepareTaskChanges, type ChangeContext, type ChangePolicy, type PreparedChangeSet, type TaskChangeField, type UIChangeApproval } from './change-set'
import { operationMode, ruleFor } from './automation-policy'
import { applyAssistedTasks, prepareAssistedTasks, type PreparedAssistedTasks } from './task-assist'
import { assertFileBridgeInboxEntry, assertFileBridgeLease, assertFileBridgeResult, assertFileBridgeStatus, fileBridgeDigest, fileBridgeTimestamp, rejectFileBridge } from './file-bridge-contract'
import { loadTaskEgress, recordEgressAudit } from './egress-policy'
import { fileBridgeReceiptKey, fileBridgeScopeKey, type FileBridgeApplicationBinding, type FileBridgeApplicationReceipt, type FileBridgeConfigure, type FileBridgeGateway, type FileBridgeInboxEntry, type FileBridgeLease, type FileBridgeRegistration, type FileBridgeResult, type FileBridgeStatus } from './file-bridge-types'

type PendingEntry = Extract<FileBridgeInboxEntry,{state:'awaiting_approval'}>
export type PreparedFileBridgeApplication = {
  version: 1; id: string; reference: string; entry: PendingEntry; registration: FileBridgeRegistration; actorContext: ChangeContext; humanContext: ChangeContext
  changeSet: PreparedChangeSet | null; assisted: PreparedAssistedTasks | null; digest: string
}
export type FileBridgeApplicationOutcome = { receipt: FileBridgeApplicationReceipt; result: FileBridgeResult | null; resultPending: boolean }
function freeze<T>(value:T):T { if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)}return value }
function trustedClick(event:Event) {
  if(!(event instanceof Event)||!event.isTrusted||event.type!=='click')rejectFileBridge('HUMAN_APPROVAL_REQUIRED','アプリの本人確認ボタンから承認してください。')
  try{const getter=Object.getOwnPropertyDescriptor(Event.prototype,'type')?.get;if(!getter||getter.call(event)!=='click')throw new Error()}catch{rejectFileBridge('HUMAN_APPROVAL_REQUIRED')}
}
async function settings():Promise<Settings>{const value=await db.settings.get('main');if(!value)rejectFileBridge('SETTINGS_MISSING');return value}
function assertSettings(registration:FileBridgeRegistration,value:Settings) {
  const policy=changePolicyFor(value)
  if(value.profileId!==registration.owner_id||value.datasetId!==registration.dataset_id)rejectFileBridge('OWNER_CHANGED')
  if(!value.aiEnabled||!policy.aiChangesEnabled||operationMode(policy,'task.text')==='deny'&&operationMode(policy,'task.schedule')==='deny'||policy.epoch!==registration.policy_epoch||policy.sourcePermissionRevision!==registration.source_permission_revision)rejectFileBridge('AUTHORITY_CHANGED','本人・AI設定または利用許可が変わりました。接続を確認してください。')
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
export async function readFileBridgeApplicationReceipt(commandId:string):Promise<FileBridgeApplicationReceipt|null> {
  if(!/^[a-f0-9-]{36}$/i.test(commandId))return null
  const stored=await db.commands.get(fileBridgeReceiptKey(commandId))
  if(!stored)return null
  try{const receipt:unknown=JSON.parse(stored.resultId),current=await settings();if(!validReceipt(receipt)||receipt.commandId!==commandId||stored.hash!==receipt.applicationDigest||stored.at!==receipt.appliedAt||receipt.ownerId!==current.profileId||receipt.datasetId!==current.datasetId)return null;return receipt}catch{return null}
}

/** Instantiate only with the isolated preload gateway, never a gateway from external material. */
export function createFileBridgeController(gateway:FileBridgeGateway) {
  const entries=new Map<string,PendingEntry>(),preparedRegistry=new Map<string,PreparedFileBridgeApplication>(),leases=new Map<string,FileBridgeLease>()
  let currentStatus:FileBridgeStatus|null=null,lastEgress:{withheldQuotes:number;notesWithheld:number}|null=null
  function clear(){entries.clear();preparedRegistry.clear();leases.clear()}
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
      const key=fileBridgeScopeKey(value.profileId,value.datasetId),previous=await db.commands.get(key)
      if(previous&&registration){try{const old=JSON.parse(previous.resultId).registration as FileBridgeRegistration|null;if(old?.client.id===registration.client.id&&(old.client.revision>registration.client.revision||old.client.grant_epoch>registration.client.grant_epoch))rejectFileBridge('REGISTRATION_ROLLBACK')}catch(error){if(error instanceof Error&&'code'in error)throw error}}
      await db.commands.put({key,hash:await Dexie.waitFor(contentDigest(payload)),resultId:JSON.stringify(payload),at:new Date().toISOString()})
    })
    if(currentStatus&&canonicalJSON({registration:currentStatus.registration,snapshot:currentStatus.snapshot})!==canonicalJSON({registration:status.registration,snapshot:status.snapshot}))clear()
    currentStatus=status
    return status
  }
  async function assertCurrent(prepared:PreparedFileBridgeApplication) {
    assertSettings(prepared.registration,await settings())
    const scope=await db.commands.get(fileBridgeScopeKey(prepared.registration.owner_id,prepared.registration.dataset_id))
    if(!scope||scope.hash!==await Dexie.waitFor(contentDigest({version:1,registration:prepared.registration})))rejectFileBridge('AUTHORITY_CHANGED')
    if(Date.parse(prepared.entry.prepared.expiresAt)<=Date.now())rejectFileBridge('EXPIRED')
    if(preparedRegistry.get(prepared.id)!==prepared)rejectFileBridge('UNVERIFIED_COMMAND')
  }
  async function verifyPrepared(prepared:PreparedFileBridgeApplication) {
    if(preparedRegistry.get(prepared.id)!==prepared)rejectFileBridge('UNVERIFIED_COMMAND','外部ファイルや保存したJSONから承認権限は復元しません。受信箱から確認してください。')
    const {digest,...payload}=prepared
    if(digest!==await Dexie.waitFor(contentDigest(payload)))rejectFileBridge('DIGEST_MISMATCH')
  }
  async function notify(prepared:PreparedFileBridgeApplication,receipt:FileBridgeApplicationReceipt,lease:FileBridgeLease):Promise<FileBridgeApplicationOutcome> {
    try{
      const persisted=await readFileBridgeApplicationReceipt(receipt.commandId)
      if(!persisted||canonicalJSON(persisted)!==canonicalJSON(receipt))rejectFileBridge('RECEIPT_MISSING')
      const result=await gateway.recordApplied({leaseId:lease.leaseId,reference:prepared.reference,receipt})
      assertFileBridgeResult(result)
      if(result.command_id!==receipt.commandId||result.digest!==receipt.fileDigest||result.owner_id!==receipt.ownerId||result.dataset_id!==receipt.datasetId||result.client_id!==receipt.clientId||result.state!=='applied'||canonicalJSON(result.receipt?.taskIds)!==canonicalJSON(receipt.taskIds)||result.receipt?.appliedAt!==receipt.appliedAt)rejectFileBridge('RESULT_MISMATCH')
      return {receipt,result,resultPending:false}
    }catch{return {receipt,result:null,resultPending:true}}
  }
  async function priorOutcome(prepared:PreparedFileBridgeApplication):Promise<FileBridgeApplicationOutcome|null> {
    const prior=await readFileBridgeApplicationReceipt(prepared.entry.prepared.command.command_id)
    if(!prior)return null
    if(prior.applicationDigest!==prepared.digest)rejectFileBridge('IDEMPOTENCY_MISMATCH')
    const existingLease=leases.get(prepared.id)
    if(!existingLease)rejectFileBridge('RECEIPT_ALREADY_APPLIED','このコマンドは保存済みです。受信箱の結果を更新してください。')
    return notify(prepared,prior,existingLease)
  }
  async function commit(prepared:PreparedFileBridgeApplication,approval:UIChangeApproval|null,lease:FileBridgeLease,automatic:boolean):Promise<FileBridgeApplicationOutcome> {
    const reg=prepared.registration
    try{
      assertFileBridgeLease(lease)
      if(canonicalJSON(binding(prepared))!==canonicalJSON({reference:lease.reference,fileDigest:lease.fileDigest,applicationDigest:lease.applicationDigest,ownerId:lease.ownerId,datasetId:lease.datasetId,policyEpoch:lease.policyEpoch,sourcePermissionRevision:lease.sourcePermissionRevision})||lease.automatic!==automatic||lease.clientId!==reg.client.id||lease.registrationRevision!==reg.client.revision||lease.grantEpoch!==reg.client.grant_epoch||Date.parse(lease.expiresAt)<=Date.now()||Date.parse(lease.expiresAt)>Date.parse(prepared.entry.prepared.expiresAt))rejectFileBridge('LEASE_INVALID')
    }catch(error){if(lease&&typeof lease.leaseId==='string')await gateway.cancelApplication({leaseId:lease.leaseId,reference:prepared.reference}).catch(()=>{});throw error}
    leases.set(prepared.id,freeze(structuredClone(lease)))
    let receipt:FileBridgeApplicationReceipt
    try{
      receipt=await db.transaction('rw',[db.tasks,db.assessments,db.commands,db.audits,db.containers,db.settings,db.labelGroups,db.labelDefinitions,db.tripBundles],async()=>{
        await verifyPrepared(prepared);await assertCurrent(prepared)
        if(Date.parse(lease.expiresAt)<=Date.now())rejectFileBridge('EXPIRED')
        const command=prepared.entry.prepared.command,key=fileBridgeReceiptKey(command.command_id),existing=await db.commands.get(key)
        if(existing){const previous=JSON.parse(existing.resultId) as FileBridgeApplicationReceipt;if(!validReceipt(previous)||existing.hash!==prepared.digest||previous.applicationDigest!==prepared.digest||previous.fileDigest!==prepared.entry.prepared.digest)rejectFileBridge('IDEMPOTENCY_MISMATCH');return previous}
        const today=new Date().toISOString().slice(0,10),receipts=await db.commands.toArray()
        const count=receipts.filter(item=>item.key.startsWith('filebridge:applied:')&&item.at.slice(0,10)===today).reduce((sum,item)=>{try{const stored=JSON.parse(item.resultId);return sum+(validReceipt(stored)&&stored.clientId===reg.client.id&&stored.ownerId===reg.owner_id&&stored.datasetId===reg.dataset_id?1:0)}catch{return sum}},0)
        if(count>=reg.client.grant.max_operations_per_day)rejectFileBridge('DAILY_BOUND')
        // applyChangeSet re-decides inside this transaction; with no approval it succeeds only when the N09 decision is auto.
        const taskIds=prepared.changeSet?(await applyChangeSet(prepared.changeSet,approval,prepared.actorContext,`filebridge:${command.command_id}`)).taskIds:prepared.assisted&&!automatic?await applyAssistedTasks(prepared.assisted,prepared.assisted.digest):rejectFileBridge('INVALID_APPLICATION')
        const appliedAt=new Date().toISOString(),result:FileBridgeApplicationReceipt={version:1,commandId:command.command_id,fileDigest:prepared.entry.prepared.digest,applicationDigest:prepared.digest,ownerId:reg.owner_id,datasetId:reg.dataset_id,clientId:reg.client.id,policyEpoch:reg.policy_epoch,sourcePermissionRevision:reg.source_permission_revision,registrationRevision:reg.client.revision,grantEpoch:reg.client.grant_epoch,taskIds,appliedAt}
        await db.commands.add({key,hash:prepared.digest,resultId:JSON.stringify(result),at:appliedAt})
        await db.audits.add({id:uid(),taskId:taskIds[0]??null,operation:automatic?'filebridge.auto':'filebridge.approved',at:appliedAt,detail:JSON.stringify({...result,approvedBy:automatic?null:reg.owner_id,decision:automatic?'auto':'approved',entrance:'file-bridge',snapshotId:command.snapshot_id,operation:command.type})})
        return result
      })
    }catch(error){await gateway.cancelApplication({leaseId:lease.leaseId,reference:prepared.reference}).catch(()=>{});throw error}
    return notify(prepared,receipt,lease)
  }
  return {
    clearAuthority:clear,
    lastEgress:()=>lastEgress,
    refresh:async()=>adoptStatus(await gateway.status()),
    async configure(request:Pick<FileBridgeConfigure,'intendedHost'|'taskIds'|'fields'|'lifetimeHours'>&{automation?:FileBridgeConfigure['automation']},event:Event) {
      trustedClick(event)
      const current=await settings(),policy=changePolicyFor(current)
      if(!current.aiEnabled||!policy.aiChangesEnabled)rejectFileBridge('AUTHORITY_CHANGED')
      if(request.automation&&!fileBridgeAutomationAllowed(policy,request.fields,request.automation.maxScheduleShiftDays))rejectFileBridge('AUTOMATION_NOT_GRANTED','自動化設定（S20）でメモ・予定日の範囲内自動を許可してから、同じかより狭い範囲で委任してください。')
      const value={...structuredClone(request),automation:request.automation??null,ownerId:current.profileId,datasetId:current.datasetId,policyEpoch:policy.epoch,sourcePermissionRevision:policy.sourcePermissionRevision}
      return adoptStatus(await gateway.configure(value))
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
      return adoptStatus(await gateway.exportSnapshot({tasks:views.map(({task,egress})=>({id:task.id,revision:task.revision,title:task.title,notes:egress.notes,scheduledDate:task.scheduledDate,containerId:task.containerId??null}))}))
    },
    async scanInbox() {
      const scanned=await gateway.scanInbox(),status=await adoptStatus(scanned.status)
      if(!Array.isArray(scanned.entries)||scanned.entries.length>100)rejectFileBridge('ENTRY_INVALID')
      entries.clear();preparedRegistry.clear()
      for(const raw of scanned.entries){assertFileBridgeInboxEntry(raw);if(raw.state==='awaiting_approval'){
        const entry=freeze(structuredClone(raw)),reg=status.registration,manifest=status.snapshot,value=entry.prepared
        if(!reg||!manifest||value.ownerId!==reg.owner_id||value.datasetId!==reg.dataset_id||value.principal.id!==reg.client.id||value.policyEpoch!==reg.policy_epoch||value.sourcePermissionRevision!==reg.source_permission_revision||value.snapshotId!==manifest.snapshot_id||value.digest!==await contentDigest(commandDigestPayload(entry,reg))||entries.has(entry.reference))rejectFileBridge('COMMAND_BINDING')
        if(value.command.type==='task.update'&&(!reg.task_ids.includes(value.command.target_id!)||manifest.entity_revisions[value.command.target_id!]!==value.command.expected_revision))rejectFileBridge('TASK_SCOPE')
        entries.set(entry.reference,entry)
      }}
      return {status,entries:freeze(structuredClone(scanned.entries))}
    },
    async prepare(reference:string):Promise<PreparedFileBridgeApplication> {
      const entry=entries.get(reference),registration=currentStatus?.registration
      if(!entry||!registration)rejectFileBridge('UNVERIFIED_COMMAND')
      assertSettings(registration,await settings())
      const command=entry.prepared.command,grant=registration.client.grant
      if(!grant.keys.includes('tasks:prepare')||!grant.keys.includes('changes:submit')||!grant.max_operations_per_day||Object.keys(command.payload).some(field=>!grant.fields.includes(field as typeof grant.fields[number])))rejectFileBridge('SCOPE_DENIED')
      if(Date.parse(command.expires_at)<=Date.now()||Date.parse(command.expires_at)>Date.parse(grant.expires_at)||Date.parse(command.expires_at)>Date.now()+24*60*60*1000)rejectFileBridge('EXPIRED')
      const allowedFields:TaskChangeField[]=grant.fields.flatMap(field=>field==='notes'?['notes' as const]:field==='scheduled_date'?['scheduledDate' as const]:[])
      const actorContext:ChangeContext={ownerId:registration.owner_id,datasetId:registration.dataset_id,principal:{id:registration.client.id,kind:'external-agent'},allowedFields,sourceRevisions:[{id:`external-registration:${registration.client.id}`,revision:registration.client.revision},{id:`external-grant:${registration.client.id}`,revision:registration.client.grant_epoch}]}
      const humanContext:ChangeContext={...actorContext,principal:{id:registration.owner_id,kind:'human'}}
      let changeSet:PreparedChangeSet|null=null,assisted:PreparedAssistedTasks|null=null
      if(command.type==='task.update'){
        const task=await db.tasks.get(command.target_id!)
        if(!task||task.deletedAt||!registration.task_ids.includes(task.id)||grant.project_ids.length&&!grant.project_ids.includes(task.containerId??''))rejectFileBridge('TASK_SCOPE')
        const after=command.payload.scheduled_date
        if(Object.hasOwn(command.payload,'scheduled_date')&&after&&task.scheduledDate&&Math.abs(Date.parse(after)-Date.parse(task.scheduledDate))/86400000>grant.max_schedule_shift_days)rejectFileBridge('SCHEDULE_BOUND')
        const patch={...(Object.hasOwn(command.payload,'notes')?{notes:command.payload.notes}:{}),...(Object.hasOwn(command.payload,'scheduled_date')?{scheduledDate:command.payload.scheduled_date}: {})}
        changeSet=await prepareTaskChanges([{taskId:command.target_id!,expectedRevision:command.expected_revision!,patch}],actorContext,'選択した外部エージェントからのメモ・予定日変更')
      }else{
        if(grant.project_ids.length)rejectFileBridge('TASK_SCOPE','プロジェクトを限定した接続での新規作成は未対応です。アプリで作成してください。')
        const input={...newTaskInput(),title:command.payload.title!,notes:command.payload.notes??'',scheduledDate:command.payload.scheduled_date??null}
        assisted=await prepareAssistedTasks([{input,notices:[],source:`外部エージェント ${registration.client.id} / コマンド ${command.command_id}`}],'ai')
      }
      const payload={version:1 as const,id:uid(),reference,entry,registration:structuredClone(registration),actorContext,humanContext,changeSet,assisted},prepared=freeze({...payload,digest:await contentDigest(payload)})
      preparedRegistry.set(prepared.id,prepared);await assertCurrent(prepared)
      return prepared
    },
    async applyFromUI(prepared:PreparedFileBridgeApplication,event:Event,checkedProtectedFields:TaskChangeField[]=[]):Promise<FileBridgeApplicationOutcome> {
      trustedClick(event);await verifyPrepared(prepared);await assertCurrent(prepared)
      const prior=await priorOutcome(prepared);if(prior)return prior
      let approval:UIChangeApproval|null=null
      if(prepared.changeSet)approval=await approveChangeSetFromUI(prepared.changeSet,prepared.humanContext,event,checkedProtectedFields)
      return commit(prepared,approval,await gateway.authorizeApplication(binding(prepared)),false)
    },
    /** No click. Only for an owner-delegated auto grant where the shared N09 engine decides auto; otherwise the entry waits for approval. */
    async applyAutomatically(prepared:PreparedFileBridgeApplication):Promise<FileBridgeApplicationOutcome> {
      await verifyPrepared(prepared);await assertCurrent(prepared)
      const reg=prepared.registration,current=changePolicyFor(await settings())
      if(!prepared.changeSet||reg.client.grant.mutation_mode!=='auto_within_bounds'||!gateway.authorizeAutomaticApplication)rejectFileBridge('AUTOMATION_NOT_GRANTED','この接続には範囲内の自動適用が委任されていません。')
      const decision=decideChangePolicy(prepared.changeSet,current,{autoCountToday:await autoChangeCountsToday()})
      if(decision.status!=='auto')rejectFileBridge('APPROVAL_REQUIRED',decision.reason)
      const prior=await priorOutcome(prepared);if(prior)return prior
      return commit(prepared,null,await gateway.authorizeAutomaticApplication(binding(prepared)),true)
    },
    async retryResultFromUI(prepared:PreparedFileBridgeApplication,event:Event):Promise<FileBridgeApplicationOutcome> {
      trustedClick(event);await verifyPrepared(prepared)
      const receipt=await readFileBridgeApplicationReceipt(prepared.entry.prepared.command.command_id),lease=leases.get(prepared.id)
      if(!receipt||!lease||receipt.applicationDigest!==prepared.digest)rejectFileBridge('RECEIPT_MISSING')
      return notify(prepared,receipt,lease)
    }
  }
}
export type FileBridgeController=ReturnType<typeof createFileBridgeController>
