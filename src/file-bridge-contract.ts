import { isTimeZone } from './zoned-time'
import { validateDate } from './domain'
import type { FileBridgeCommand, FileBridgeInboxEntry, FileBridgeLease, FileBridgeManifest, FileBridgeRegistration, FileBridgeResult, FileBridgeStatus } from './file-bridge-types'

/** commonCode names the shared K12 reason when an entrance code is ambiguous (AUTHORITY_CHANGED). */
export class FileBridgeError extends Error { readonly code: string; readonly commonCode?: string; constructor(code: string, message: string, commonCode?: string) { super(message); this.code=code; if(commonCode)this.commonCode=commonCode } }
export function rejectFileBridge(code: string, message='接続・コマンドまたは承認内容を確認できません。もう一度確認してください。', commonCode?: string): never { throw new FileBridgeError(code,message,commonCode) }
export const fileBridgeRejectedStates=['denied','conflict','expired','rejected'] as const
const resultStates=['applied','failed','unknown',...fileBridgeRejectedStates]
const fields=['title','notes','scheduled_date','due_date','due_at','manual_points'],grantKeys=['tasks:read','tasks:prepare','changes:submit','commands:read','tasks:split','routines:prepare','history:read','routines:read','context:read','detection:request','detection:read','handoff:prepare']
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype)
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))
const text=(value:unknown,max=200)=>typeof value==='string'&&Boolean(value.trim())&&value.length<=max
const integer=(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&Number(value)>=min&&Number(value)<=max
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const ids=(value:unknown,max=100)=>Array.isArray(value)&&value.length<=max&&value.every(uuid)&&new Set(value).size===value.length
const strings=(value:unknown,allowed:string[])=>Array.isArray(value)&&value.every(item=>allowed.includes(item))&&new Set(value).size===value.length
export const fileBridgeTimestamp=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
export const fileBridgeDigest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
export function assertFileBridgeRegistration(value:unknown):asserts value is FileBridgeRegistration {
  const base=['schema_version','owner_id','dataset_id','policy_epoch','source_permission_revision','task_ids','client']
  if(!record(value)||!(exact(value,base)||exact(value,[...base,'rule_ids']))||Object.hasOwn(value,'rule_ids')&&!ids(value.rule_ids,50)||value.schema_version!=='1'||!text(value.owner_id)||!uuid(value.dataset_id)||!integer(value.policy_epoch)||!integer(value.source_permission_revision)||!ids(value.task_ids))rejectFileBridge('REGISTRATION_INVALID')
  const client=value.client
  if(!record(client)||!exact(client,['id','dataset_id','intended_host','transport','status','revision','grant_epoch','grant'])||!uuid(client.id)||client.dataset_id!==value.dataset_id||!['chatgpt','claude','codex','claude_code','other'].includes(client.intended_host as string)||client.transport!=='stdio'||client.status!=='active'||!integer(client.revision,1)||!integer(client.grant_epoch,1))rejectFileBridge('REGISTRATION_INVALID')
  const grant=client.grant
  const grantFields=['keys','project_ids','fields','mutation_mode','max_operations_per_day','max_schedule_shift_days','max_point_delta','allow_external_context','allow_handoffs','expires_at']
  if(!record(grant)||!exact(grant,grantFields)&&!exact(grant,[...grantFields,'automation'])||!strings(grant.keys,grantKeys)||!ids(grant.project_ids)||!strings(grant.fields,fields)||!['require_approval','auto_within_bounds'].includes(grant.mutation_mode as string)||(grant.mutation_mode==='auto_within_bounds')!==Object.hasOwn(grant,'automation')||!integer(grant.max_operations_per_day,0,100)||!integer(grant.max_schedule_shift_days,0,31)||grant.max_point_delta!==0||typeof grant.allow_external_context!=='boolean'||typeof grant.allow_handoffs!=='boolean'||!fileBridgeTimestamp(grant.expires_at))rejectFileBridge('REGISTRATION_INVALID')
  if(grant.mutation_mode==='auto_within_bounds'){const automation=grant.automation;if(!record(automation)||!exact(automation,['max_schedule_shift_days','max_operations_per_day'])||!integer(automation.max_schedule_shift_days,0,Number(grant.max_schedule_shift_days))||!integer(automation.max_operations_per_day,1,Number(grant.max_operations_per_day))||!(grant.fields as string[]).some(field=>['notes','scheduled_date'].includes(field)))rejectFileBridge('REGISTRATION_INVALID')}
}
const day=(value:unknown)=>{if(value===null)return true;if(typeof value!=='string')return false;try{validateDate(value,'日付');return true}catch{return false}}
const clock=(value:unknown)=>typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value)
function assertSplitPayload(payload:Record<string,unknown>) {
  if(!exact(payload,['children'])||!Array.isArray(payload.children))rejectFileBridge('UNSUPPORTED_FIELD')
  const children=payload.children as unknown[]
  if(children.length<2||children.length>20||children.some(child=>!record(child)||!exact(child,['title','points'])||!text(child.title,300)||child.points!==null&&!integer(child.points,0,100000)))rejectFileBridge('INVALID_PAYLOAD')
}
function assertRoutinePayload(payload:Record<string,unknown>) {
  if(!exact(payload,['scope','definition'])||!record(payload.definition)||!exact(payload.definition,['trigger']))rejectFileBridge('UNSUPPORTED_FIELD')
  const scope=payload.scope,trigger=(payload.definition as Record<string,unknown>).trigger
  if(!record(scope)||!(exact(scope,['kind'])&&scope.kind==='all_uncompleted'||exact(scope,['kind','from_date'])&&scope.kind==='this_and_future'&&typeof scope.from_date==='string'&&day(scope.from_date)||exact(scope,['kind','generation_key'])&&scope.kind==='this_instance'&&text(scope.generation_key)))rejectFileBridge('INVALID_PAYLOAD')
  const weekly=record(trigger)&&exact(trigger,['kind','weekdays','time'])&&trigger.kind==='weekly'&&Array.isArray(trigger.weekdays)&&trigger.weekdays.length>0&&trigger.weekdays.length<=7&&trigger.weekdays.every(item=>integer(item,0,6))&&new Set(trigger.weekdays).size===trigger.weekdays.length&&clock(trigger.time)
  const monthly=record(trigger)&&exact(trigger,['kind','ordinal','from','time'])&&trigger.kind==='monthly_business'&&integer(trigger.ordinal,1,31)&&['start','end'].includes(trigger.from as string)&&clock(trigger.time)
  const relative=record(trigger)&&exact(trigger,['kind','activity_id','edge','offset_days','offset_minutes'])&&trigger.kind==='activity_relative'&&text(trigger.activity_id)&&['start','end'].includes(trigger.edge as string)&&Number.isInteger(trigger.offset_days)&&Math.abs(Number(trigger.offset_days))<=366&&Number.isInteger(trigger.offset_minutes)&&Math.abs(Number(trigger.offset_minutes))<=10080
  const rrule=record(trigger)&&exact(trigger,['kind','rrule'])&&trigger.kind==='rrule'&&text(trigger.rrule,2000)
  const completion=record(trigger)&&exact(trigger,['kind','after_days'])&&trigger.kind==='completion_relative'&&integer(trigger.after_days,1,3650)
  if(!weekly&&!monthly&&!relative&&!rrule&&!completion)rejectFileBridge('INVALID_PAYLOAD')
}
export function assertFileBridgeCommand(value:unknown):asserts value is FileBridgeCommand {
  const base=['schema_version','command_id','snapshot_id','expires_at','type','target_id','expected_revision','payload']
  if(!record(value)||base.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!base.includes(key)&&!['basis','via'].includes(key))||Object.hasOwn(value,'basis')&&(!record(value.basis)||!(exact(value.basis,['kind'])||exact(value.basis,['kind','note']))||value.basis.kind!=='external_request'||Object.hasOwn(value.basis,'note')&&(typeof value.basis.note!=='string'||value.basis.note.length>1000))||Object.hasOwn(value,'via')&&value.via!=='mcp_stdio'||value.schema_version!=='1'||!uuid(value.command_id)||!uuid(value.snapshot_id)||!fileBridgeTimestamp(value.expires_at)||!record(value.payload))rejectFileBridge('COMMAND_SCHEMA','外部コマンドの形式が不正です。承認・操作者・権限は受け付けません。')
  if(!['task.create','task.update','task.split','routine.change'].includes(value.type as string))rejectFileBridge('UNSUPPORTED_OPERATION')
  const payload=value.payload as Record<string,unknown>
  if(value.type==='task.split')assertSplitPayload(payload)
  else if(value.type==='routine.change')assertRoutinePayload(payload)
  else {
    const keys=Object.keys(payload)
    if(!keys.length||keys.some(field=>!(value.type==='task.create'?['title','notes','scheduled_date']:fields).includes(field)))rejectFileBridge('UNSUPPORTED_FIELD')
    if(Object.hasOwn(payload,'title')&&!text(payload.title,300)||Object.hasOwn(payload,'notes')&&(typeof payload.notes!=='string'||payload.notes.length>50000)||['scheduled_date','due_date'].some(field=>Object.hasOwn(payload,field)&&!day(payload[field]))||Object.hasOwn(payload,'due_at')&&payload.due_at!==null&&(!record(payload.due_at)||!exact(payload.due_at,['at','timezone'])||!fileBridgeTimestamp(payload.due_at.at)||!isTimeZone(payload.due_at.timezone))||Object.hasOwn(payload,'manual_points')&&!integer(payload.manual_points,0,100000))rejectFileBridge('INVALID_PAYLOAD')
  }
  if(value.type==='task.create'?(value.target_id!==null||value.expected_revision!==null||!Object.hasOwn(payload,'title')):(!uuid(value.target_id)||!integer(value.expected_revision,1)))rejectFileBridge('INVALID_TARGET')
}
export function assertFileBridgeManifest(value:unknown):asserts value is FileBridgeManifest {
  if(!record(value)||!exact(value,['schema_version','snapshot_id','owner_id','dataset_id','client_id','policy_epoch','source_permission_revision','registration_revision','grant_epoch','generated_at','expires_at','view_path','view_sha256','entity_revisions','registration_sha256'])||value.schema_version!=='1'||!uuid(value.snapshot_id)||!text(value.owner_id)||!uuid(value.dataset_id)||!uuid(value.client_id)||!integer(value.policy_epoch)||!integer(value.source_permission_revision)||!integer(value.registration_revision,1)||!integer(value.grant_epoch,1)||!fileBridgeTimestamp(value.generated_at)||!fileBridgeTimestamp(value.expires_at)||value.view_path!=='views/tasks.active.json'||!fileBridgeDigest(value.view_sha256)||!fileBridgeDigest(value.registration_sha256)||!record(value.entity_revisions)||Object.keys(value.entity_revisions).length>100||Object.entries(value.entity_revisions).some(([id,revision])=>!uuid(id)||!integer(revision,1)))rejectFileBridge('SNAPSHOT_INVALID')
}
export function assertFileBridgeResult(value:unknown):asserts value is FileBridgeResult {
  const keys=['schema_version','command_id','digest','owner_id','dataset_id','client_id','state','receipt','finished_at'],rejected=record(value)&&(fileBridgeRejectedStates as readonly string[]).includes(value.state as string)
  if(!record(value)||!exact(value,rejected?[...keys,'code']:keys)||rejected&&(typeof value.code!=='string'||!/^[A-Z0-9_]{1,60}$/.test(value.code))||value.schema_version!=='1'||!uuid(value.command_id)||!fileBridgeDigest(value.digest)||!text(value.owner_id)||!uuid(value.dataset_id)||!uuid(value.client_id)||!resultStates.includes(value.state as string)||!fileBridgeTimestamp(value.finished_at))rejectFileBridge('RESULT_INVALID')
  if(value.receipt!==null){const receipt=value.receipt;if(!record(receipt)||!exact(receipt,['commandId','digest','taskIds','appliedAt'])||receipt.commandId!==value.command_id||receipt.digest!==value.digest||!ids(receipt.taskIds,1)||(receipt.taskIds as unknown[]).length!==1||!fileBridgeTimestamp(receipt.appliedAt))rejectFileBridge('RESULT_INVALID')}
  if(value.state==='applied'&&value.receipt===null||value.state!=='applied'&&value.receipt!==null)rejectFileBridge('RESULT_INVALID')
}
export function assertFileBridgeStatus(value:unknown):asserts value is FileBridgeStatus {
  if(!record(value)||!exact(value,['version','available','connected','root','registration','snapshot','results','notice'])||value.version!==1||typeof value.available!=='boolean'||typeof value.connected!=='boolean'||value.root!==null&&!text(value.root,4000)||!Array.isArray(value.results)||value.results.length>100||typeof value.notice!=='string'||value.notice.length>2000)rejectFileBridge('STATUS_INVALID')
  if(value.registration!==null)assertFileBridgeRegistration(value.registration)
  if(value.snapshot!==null)assertFileBridgeManifest(value.snapshot)
  value.results.forEach(assertFileBridgeResult)
  if(value.connected&&(!value.available||!value.registration||!value.root)||!value.connected&&(value.registration!==null||value.snapshot!==null))rejectFileBridge('STATUS_INVALID')
  if(value.snapshot&&value.registration){const reg=value.registration;if(value.snapshot.owner_id!==reg.owner_id||value.snapshot.dataset_id!==reg.dataset_id||value.snapshot.client_id!==reg.client.id||value.snapshot.policy_epoch!==reg.policy_epoch||value.snapshot.source_permission_revision!==reg.source_permission_revision||value.snapshot.registration_revision!==reg.client.revision||value.snapshot.grant_epoch!==reg.client.grant_epoch)rejectFileBridge('SNAPSHOT_INVALID')}
}
export function assertFileBridgeInboxEntry(value:unknown):asserts value is FileBridgeInboxEntry {
  if(!record(value)||!text(value.filename,200)||!/^[-\w]+\.ready\.json$/i.test(value.filename as string))rejectFileBridge('ENTRY_INVALID')
  if(value.state==='rejected'){if(!exact(value,['state','filename','error'])||!text(value.error))rejectFileBridge('ENTRY_INVALID');return}
  if(value.state==='finished'){if(!exact(value,['state','filename','result']))rejectFileBridge('ENTRY_INVALID');assertFileBridgeResult(value.result);return}
  if(value.state!=='awaiting_approval'||!exact(value,['state','filename','reference','prepared'])||!text(value.reference)||!record(value.prepared))rejectFileBridge('ENTRY_INVALID')
  const prepared=value.prepared
  if(!exact(prepared,['state','command','digest','principal','ownerId','datasetId','policyEpoch','sourcePermissionRevision','snapshotId','expectedRevision','expiresAt'])||prepared.state!=='awaiting_approval'||!fileBridgeDigest(prepared.digest)||!record(prepared.principal)||!exact(prepared.principal,['id','kind'])||!uuid(prepared.principal.id)||prepared.principal.kind!=='external-agent'||!text(prepared.ownerId)||!uuid(prepared.datasetId)||!integer(prepared.policyEpoch)||!integer(prepared.sourcePermissionRevision)||!uuid(prepared.snapshotId)||!fileBridgeTimestamp(prepared.expiresAt))rejectFileBridge('ENTRY_INVALID')
  assertFileBridgeCommand(prepared.command)
  if((value.filename as string).toLowerCase()!==`${prepared.command.command_id}.ready.json`.toLowerCase()||prepared.snapshotId!==prepared.command.snapshot_id||prepared.expectedRevision!==prepared.command.expected_revision||prepared.expiresAt!==prepared.command.expires_at)rejectFileBridge('ENTRY_INVALID')
}
export function assertFileBridgeLease(value:unknown):asserts value is FileBridgeLease {
  if(!record(value)||!exact(value,['version','leaseId','reference','fileDigest','applicationDigest','ownerId','datasetId','policyEpoch','sourcePermissionRevision','clientId','registrationRevision','grantEpoch','expiresAt','automatic'])||value.version!==1||typeof value.automatic!=='boolean'||!text(value.leaseId)||!text(value.reference)||!fileBridgeDigest(value.fileDigest)||!fileBridgeDigest(value.applicationDigest)||!text(value.ownerId)||!uuid(value.datasetId)||!integer(value.policyEpoch)||!integer(value.sourcePermissionRevision)||!uuid(value.clientId)||!integer(value.registrationRevision,1)||!integer(value.grantEpoch,1)||!fileBridgeTimestamp(value.expiresAt))rejectFileBridge('LEASE_INVALID')
}
