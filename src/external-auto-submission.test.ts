import 'fake-indexeddb/auto'
import {expect,it} from 'vitest'
import {createRequire} from 'node:module'
import {db} from './db'
import {bridgeHarness,resetApp,click} from './command-test-harness'
import {createTask,newTaskInput} from './commands'
import {emptyScore} from './domain'
import {changePolicyFor} from './change-set'
import {presetRules} from './automation-policy'
import {previewAutomationPolicy,setAutomationPolicyFromUI} from './automation-control'
import {externalAIFor} from './external-authority'
import {dispatchExternalChangeTool} from './external-change-plans'
import {dispatchExternalReadTool,type ExternalToolContext} from './external-tools'
import {processExternalSubmission} from './external-auto-submission'
import {receivedCommands,clearCommandAuthority} from './command-bus'
const {createAppChangeDispatcher}=createRequire(import.meta.url)('../electron/mcp-app-changes.cjs')
it('catalog submit automatically applies only delegated notes/date through real signed leases; protected and out-of-auto-bounds requests wait, with client selection unchanged',async()=>{
 await resetApp()
 const s=(await db.settings.get('main'))!,policy=changePolicyFor(s),input={preset:'A2' as const,rules:presetRules('A2'),allowedHours:{},titleRule:'require_approval' as const,bounds:policy.bounds,locks:policy.locks}
 await setAutomationPolicyFromUI({principal:{kind:'human',id:s.profileId},ownerId:s.profileId,datasetId:s.datasetId,allowedFields:['notes','scheduledDate'],sourceRevisions:[]},click(),input,(await previewAutomationPolicy(input)).token)
 const id=await createTask({...newTaskInput(),title:'owner 25',scheduledDate:'2026-10-03',dueDate:'2026-10-10',score:{...emptyScore(),mode:'manual',manualPoints:25}}),h=await bridgeHarness({taskIds:[id],fields:['title','notes','scheduled_date','manual_points'],automation:{maxScheduleShiftDays:3,maxOperationsPerDay:5}})
 try{
  const registration=h.status().registration!,settings=(await db.settings.get('main'))!,context:ExternalToolContext={registration,ownerId:settings.profileId,datasetId:settings.datasetId,externalEpoch:externalAIFor(settings).epoch,policyEpoch:registration.policy_epoch,sourcePermissionRevision:registration.source_permission_revision}
  // Another connection is selected. The background request must still use the original slot.
  const b=await h.gateway.configure({ownerId:settings.profileId,datasetId:settings.datasetId,policyEpoch:context.policyEpoch,sourcePermissionRevision:context.sourcePermissionRevision,intendedHost:'claude',taskIds:[id],fields:['notes'],lifetimeHours:24,automation:null})
  const dispatch=createAppChangeDispatcher({getHub:async()=>h.service,readDB:(table:'commands',key:string)=>db[table].get(key),dispatch:(name:string,args:Record<string,unknown>,ctx:ExternalToolContext)=>name==='michi_process_catalog_submission'?processExternalSubmission(args,ctx,h.gateway):name==='coach_prepare_change'||name==='coach_submit_change'?dispatchExternalChangeTool(name,args,ctx):dispatchExternalReadTool(name,args,ctx)})
  const prepare=(operation:string,payload:unknown,revision:number)=>dispatch('coach_prepare_change',{request_key:crypto.randomUUID(),operation,task_id:id,expected_revision:revision,payload,basis:{kind:'external_request',note:'proposal'}},context)
  const plan=await prepare('task.update',{changes:{notes:'in bounds',scheduled_date:'2026-10-05'}},1)
  expect((await db.tasks.get(id))?.revision).toBe(1)
  const request={request_key:crypto.randomUUID(),change_set_id:plan.change_set_id,digest:plan.digest}
  expect((await dispatch('coach_submit_change',request,context)).state).toBe('applied')
  expect((await dispatch('coach_submit_change',request,context)).state).toBe('applied')
  expect((await dispatch('coach_submit_change',{...request,request_key:crypto.randomUUID()},context)).state).toBe('applied')
  expect(await db.tasks.get(id)).toMatchObject({revision:2,notes:'in bounds',scheduledDate:'2026-10-05',dueDate:'2026-10-10',score:{manualPoints:25}})
  expect((await h.gateway.status()).registration?.client.id).toBe(b.registration?.client.id)
  expect(receivedCommands().some(row=>row.commandId===plan.command_id)).toBe(false)
  await h.controller.selectClient(registration.client.id);await h.refreshSnapshot();await h.gateway.selectClient!({clientId:b.registration!.client.id})
  const protectedPlan=await prepare('task.score.set_manual',{points:36},2)
  expect((await dispatch('coach_submit_change',{request_key:crypto.randomUUID(),change_set_id:protectedPlan.change_set_id,digest:protectedPlan.digest},context)).state).toBe('awaiting_approval')
  expect((await db.tasks.get(id))?.score.manualPoints).toBe(25)
  const outside=await prepare('task.update',{changes:{scheduled_date:'2026-10-10'}},2)
  expect((await dispatch('coach_submit_change',{request_key:crypto.randomUUID(),change_set_id:outside.change_set_id,digest:outside.digest},context)).state).toBe('awaiting_approval')
  expect((await db.tasks.get(id))?.scheduledDate).toBe('2026-10-05')
  await h.controller.selectClient(registration.client.id)
  const scanned=await h.controller.scanInbox(),protectedEntry=scanned.entries.find(row=>row.state==='awaiting_approval'&&row.prepared.command.command_id===protectedPlan.command_id)!
  if(protectedEntry.state!=='awaiting_approval')throw Error('missing review')
  const review=await h.controller.prepare(protectedEntry.reference)
  await h.gateway.selectClient!({clientId:b.registration!.client.id})
  const whileReview=await prepare('task.update',{changes:{notes:'wait for native review'}},2)
  expect((await dispatch('coach_submit_change',{request_key:crypto.randomUUID(),change_set_id:whileReview.change_set_id,digest:whileReview.digest},context)).state).toBe('awaiting_approval')
  expect((await db.tasks.get(id))?.notes).toBe('in bounds')
  const confirmed=await h.controller.confirmValuesFromUI(review,click(),'owner confirms 36')
  await h.controller.applyFromUI(confirmed,click(),['manualPoints'])
  expect((await db.tasks.get(id))?.score.manualPoints).toBe(36)
  expect(await db.ledger.count()).toBe(0);expect(await db.completions.count()).toBe(0)
  expect(receivedCommands().some(row=>row.commandId===protectedPlan.command_id)).toBe(false)
  expect(receivedCommands().some(row=>row.commandId===outside.command_id)).toBe(true)
  clearCommandAuthority({coachOnly:true});expect(receivedCommands().some(row=>row.commandId===outside.command_id)).toBe(true)
  clearCommandAuthority({externalOnly:true});expect(receivedCommands()).toEqual([])
 }finally{await h.close()}
})
