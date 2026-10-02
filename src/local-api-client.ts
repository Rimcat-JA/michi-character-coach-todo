import './external-task-create'
import Dexie from 'dexie'
import { db } from './db'
import { changePolicyFor } from './change-set'
import { canonicalJSON } from './canonical'
import { externalAgentActor, prepareCommand, approveCommandFromUI, applyCommand, issueExternalApplyCapability, settleCommand, type PreparedCommand } from './command-bus'
import type { LocalAPIPending, LocalAPILease, LocalAPIWindow } from './local-api-types'
const approvals = new WeakMap<object,{row:LocalAPIPending;command:PreparedCommand}>()
function sameAuthority(row: LocalAPIPending, s: Awaited<ReturnType<typeof settings>>) { const p=changePolicyFor(s);if(row.ownerId!==s.profileId||row.datasetId!==s.datasetId||row.policyEpoch!==p.epoch||row.sourcePermissionRevision!==p.sourcePermissionRevision||!Number.isFinite(Date.parse(row.expiresAt))||Date.parse(row.expiresAt)<=Date.now())throw Error('API要求の本人・期限・権限が変わりました') }
async function settings(){const s=await db.settings.get('main');if(!s)throw Error('本人設定がありません');return s}
export async function prepareLocalAPICommand(row: LocalAPIPending) {
 const s=await settings();sameAuthority(row,s)
 if(row.command.type!=='task.create'||row.receiptKey!==`localapi:applied:${row.tokenId}:${row.command.command_id}`)throw Error('API要求の形式が不正です')
 const actor=externalAgentActor({ownerId:row.ownerId,datasetId:row.datasetId,clientId:row.tokenId,registrationRevision:1,grantEpoch:row.grantEpoch,host:row.label},'api',{fields:['title','notes','scheduled_date'],operations:['task.create'],mutationMode:'require_approval',maxScheduleShiftDays:null},row.projectId)
 const next=await prepareCommand({schema_version:'1',command_id:row.command.command_id,type:'task.create',target_id:null,expected_revision:null,payload:row.command.payload,basis:{kind:'external_request'}},actor)
 if(!next.prepared)throw Error(next.outcome.message)
 const result=Object.freeze({id:next.prepared.id,row:structuredClone(row),command:next.prepared});approvals.set(result,{row:structuredClone(row),command:next.prepared});return result
}
export async function applyLocalAPICommand(preview: Awaited<ReturnType<typeof prepareLocalAPICommand>>,event:Event,gateway:LocalAPIWindow=window.michiLocalAPI!) {
 if(!(event instanceof Event)||!event.isTrusted||Object.getOwnPropertyDescriptor(Event.prototype,'type')!.get!.call(event)!=='click')throw Error('API受信箱の本人確認ボタンから承認してください')
 const current=approvals.get(preview);if(!current)throw Error('確認案が失効しました');const {row,command}=current;const s=await settings();sameAuthority(row,s)
 const prior=await db.commands.get(row.receiptKey)
 if(prior){if(prior.hash!==row.digest)throw Error('IDEMPOTENCY_MISMATCH');try{await gateway.request({action:'pending'});return {taskId:prior.resultId,resultPending:false}}catch{return {taskId:prior.resultId,resultPending:true}}}
 const approval=await approveCommandFromUI(command,event),lease=await gateway.request({action:'authorize',input:{tokenId:row.tokenId,commandId:row.command.command_id,digest:row.digest}}) as LocalAPILease
 if(!lease||lease.ownerId!==row.ownerId||lease.datasetId!==row.datasetId||lease.policyEpoch!==row.policyEpoch||lease.sourcePermissionRevision!==row.sourcePermissionRevision||lease.grantEpoch!==row.grantEpoch||lease.digest!==row.digest||lease.receiptKey!==row.receiptKey||lease.tokenId!==row.tokenId||canonicalJSON(lease.command)!==canonicalJSON(row.command)||lease.projectId!==row.projectId||!Number.isFinite(lease.expiresAt)||lease.expiresAt<=Date.now()||lease.expiresAt>Date.now()+30000||typeof lease.id!=='string')throw Error('API要求の端末承認が一致しません')
 const taskId=await db.transaction('rw',[db.tasks,db.assessments,db.commands,db.audits,db.containers,db.settings,db.labelGroups,db.labelDefinitions],async()=>{
  sameAuthority(row,(await db.settings.get('main'))!);if(lease.expiresAt<=Date.now())throw Error('端末承認の期限切れです')
  const prior=await db.commands.get(row.receiptKey);if(prior){if(prior.hash!==row.digest)throw Error('IDEMPOTENCY_MISMATCH');return prior.resultId}
  const result=await Dexie.waitFor(applyCommand(command,approval,row.receiptKey,issueExternalApplyCapability(command)));if(result.taskIds.length!==1)throw Error('API作成結果が不正です')
  await db.commands.add({key:row.receiptKey,hash:row.digest,resultId:result.taskIds[0],at:result.appliedAt});return result.taskIds[0]
 })
 settleCommand(command)
 try{await gateway.request({action:'applied',input:{leaseId:lease.id}})}catch{return {taskId,resultPending:true}}
 return {taskId,resultPending:false}
}
export function discardLocalAPIPreview(preview: Awaited<ReturnType<typeof prepareLocalAPICommand>>) { approvals.delete(preview);settleCommand(preview.command) }
