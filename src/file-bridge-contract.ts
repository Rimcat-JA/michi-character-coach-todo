import { validateDate } from './domain'
import type { FileBridgeCommand, FileBridgeInboxEntry, FileBridgeLease, FileBridgeManifest, FileBridgeRegistration, FileBridgeResult, FileBridgeStatus } from './file-bridge-types'

export class FileBridgeError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.code=code } }
export function rejectFileBridge(code: string, message='接続・コマンドまたは承認内容を確認できません。もう一度確認してください。'): never { throw new FileBridgeError(code,message) }
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
  if(!record(value)||!exact(value,['schema_version','owner_id','dataset_id','policy_epoch','source_permission_revision','task_ids','client'])||value.schema_version!=='1'||!text(value.owner_id)||!uuid(value.dataset_id)||!integer(value.policy_epoch)||!integer(value.source_permission_revision)||!ids(value.task_ids))rejectFileBridge('REGISTRATION_INVALID')
  const client=value.client
  if(!record(client)||!exact(client,['id','dataset_id','intended_host','transport','status','revision','grant_epoch','grant'])||!uuid(client.id)||client.dataset_id!==value.dataset_id||!['chatgpt','claude','codex','claude_code','other'].includes(client.intended_host as string)||client.transport!=='stdio'||client.status!=='active'||!integer(client.revision,1)||!integer(client.grant_epoch,1))rejectFileBridge('REGISTRATION_INVALID')
  const grant=client.grant
  if(!record(grant)||!exact(grant,['keys','project_ids','fields','mutation_mode','max_operations_per_day','max_schedule_shift_days','max_point_delta','allow_external_context','allow_handoffs','expires_at'])||!strings(grant.keys,['tasks:read','tasks:prepare','changes:submit','commands:read'])||!ids(grant.project_ids)||!strings(grant.fields,['title','notes','scheduled_date'])||grant.mutation_mode!=='require_approval'||!integer(grant.max_operations_per_day,0,100)||!integer(grant.max_schedule_shift_days,0,31)||grant.max_point_delta!==0||grant.allow_external_context!==false||grant.allow_handoffs!==false||!fileBridgeTimestamp(grant.expires_at))rejectFileBridge('REGISTRATION_INVALID')
}
export function assertFileBridgeCommand(value:unknown):asserts value is FileBridgeCommand {
  if(!record(value)||!exact(value,['schema_version','command_id','snapshot_id','expires_at','type','target_id','expected_revision','payload'])||value.schema_version!=='1'||!uuid(value.command_id)||!uuid(value.snapshot_id)||!fileBridgeTimestamp(value.expires_at)||!['task.create','task.update'].includes(value.type as string)||!record(value.payload))rejectFileBridge('COMMAND_SCHEMA','外部コマンドの形式が不正です。点数・期限・完了・権限は変更できません。')
  const fields=Object.keys(value.payload)
  if(!fields.length||fields.some(field=>!['title','notes','scheduled_date'].includes(field))||value.type==='task.update'&&fields.includes('title'))rejectFileBridge('UNSUPPORTED_FIELD')
  if(Object.hasOwn(value.payload,'title')&&!text(value.payload.title,300)||Object.hasOwn(value.payload,'notes')&&(typeof value.payload.notes!=='string'||value.payload.notes.length>50000))rejectFileBridge('INVALID_PAYLOAD')
  if(Object.hasOwn(value.payload,'scheduled_date')){if(value.payload.scheduled_date!==null&&typeof value.payload.scheduled_date!=='string')rejectFileBridge('INVALID_PAYLOAD');try{validateDate(value.payload.scheduled_date as string|null,'予定日')}catch{rejectFileBridge('INVALID_PAYLOAD')}}
  if(value.type==='task.create'?(value.target_id!==null||value.expected_revision!==null||!Object.hasOwn(value.payload,'title')):(!uuid(value.target_id)||!integer(value.expected_revision,1)))rejectFileBridge('INVALID_TARGET')
}
export function assertFileBridgeManifest(value:unknown):asserts value is FileBridgeManifest {
  if(!record(value)||!exact(value,['schema_version','snapshot_id','owner_id','dataset_id','client_id','policy_epoch','source_permission_revision','registration_revision','grant_epoch','generated_at','expires_at','view_path','view_sha256','entity_revisions','registration_sha256'])||value.schema_version!=='1'||!uuid(value.snapshot_id)||!text(value.owner_id)||!uuid(value.dataset_id)||!uuid(value.client_id)||!integer(value.policy_epoch)||!integer(value.source_permission_revision)||!integer(value.registration_revision,1)||!integer(value.grant_epoch,1)||!fileBridgeTimestamp(value.generated_at)||!fileBridgeTimestamp(value.expires_at)||value.view_path!=='views/tasks.active.json'||!fileBridgeDigest(value.view_sha256)||!fileBridgeDigest(value.registration_sha256)||!record(value.entity_revisions)||Object.keys(value.entity_revisions).length>100||Object.entries(value.entity_revisions).some(([id,revision])=>!uuid(id)||!integer(revision,1)))rejectFileBridge('SNAPSHOT_INVALID')
}
export function assertFileBridgeResult(value:unknown):asserts value is FileBridgeResult {
  if(!record(value)||!exact(value,['schema_version','command_id','digest','owner_id','dataset_id','client_id','state','receipt','finished_at'])||value.schema_version!=='1'||!uuid(value.command_id)||!fileBridgeDigest(value.digest)||!text(value.owner_id)||!uuid(value.dataset_id)||!uuid(value.client_id)||!['applied','failed','unknown'].includes(value.state as string)||!fileBridgeTimestamp(value.finished_at))rejectFileBridge('RESULT_INVALID')
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
  if(!record(value)||!exact(value,['version','leaseId','reference','fileDigest','applicationDigest','ownerId','datasetId','policyEpoch','sourcePermissionRevision','clientId','registrationRevision','grantEpoch','expiresAt'])||value.version!==1||!text(value.leaseId)||!text(value.reference)||!fileBridgeDigest(value.fileDigest)||!fileBridgeDigest(value.applicationDigest)||!text(value.ownerId)||!uuid(value.datasetId)||!integer(value.policyEpoch)||!integer(value.sourcePermissionRevision)||!uuid(value.clientId)||!integer(value.registrationRevision,1)||!integer(value.grantEpoch,1)||!fileBridgeTimestamp(value.expiresAt))rejectFileBridge('LEASE_INVALID')
}
