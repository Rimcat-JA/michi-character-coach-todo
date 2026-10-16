import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { createLabelDefinition, createLabelGroup } from './labels'
import { bridgeHarness, click, resetApp } from './command-test-harness'
import { dispatchExternalChangeTool } from './external-change-plans'
import { externalAIFor } from './external-authority'
import { taskChangeValueText,prepareTaskChanges,type ChangeContext } from './change-set'
import { confirmTaskInstructionFromUI } from './task-user-instruction'
import type { ExternalToolContext } from './external-tools'
import type { ExternalChangeRequest } from './external-command-gate'
const require = createRequire(import.meta.url)
const { createAppChangeDispatcher } = require('../electron/mcp-app-changes.cjs')

async function setup() {
  const s=await resetApp(), first=await createLabelDefinition('仕事'), second=await createLabelDefinition('生活')
  const taskId=await createTask({...newTaskInput(),title:'ラベル対象',labels:['仕事'],score:{...newTaskInput().score,mode:'manual',manualPoints:10}})
  return {s,first,second,taskId}
}
for(const entrance of ['file','mcp'] as const) it(`${entrance}: labels require exact native values and protected approval, preserve points and replay`,async()=>{
 const {taskId}=await setup(), h=await bridgeHarness({taskIds:[taskId],fields:['labels']})
 try {
  expect((await h.mcpCall('michi_snapshot',{})).structuredContent).toMatchObject({tasks:[{labels:['仕事']}]})
  const input={type:'task.update',target_id:taskId,expected_revision:1,payload:{labels:['生活']}}
  if(entrance==='file')await h.writeCommand(input)
  else expect((await h.mcpCall('michi_propose_update',{commandId:crypto.randomUUID(),snapshotId:h.snapshotId(),targetId:taskId,expectedRevision:1,payload:input.payload})).isError).not.toBe(true)
  const entry=(await h.controller.scanInbox()).entries.find(e=>e.state==='awaiting_approval')!; if(entry.state!=='awaiting_approval')throw Error('missing')
  const pending=await h.controller.prepare(entry.reference)
  expect(pending.command.ownerValues?.[0].patch.labels).toEqual(['生活'])
  await expect(h.controller.confirmValuesFromUI(pending,new Event('click'))).rejects.toThrow()
  const confirmed=await h.controller.confirmValuesFromUI(pending,click())
  await expect(h.controller.applyFromUI(confirmed,click(),[])).rejects.toThrow('個別')
  const result=await h.controller.applyFromUI(confirmed,click(),['labels'])
  expect(result.receipt.taskIds).toEqual([taskId]);expect(await db.tasks.get(taskId)).toMatchObject({labels:['生活'],revision:2,score:{manualPoints:10}});expect(await db.ledger.count()).toBe(0)
  await h.controller.applyFromUI(confirmed,click(),['labels']);expect((await db.tasks.get(taskId))?.revision).toBe(2)
  expect(taskChangeValueText(['生活'])).toBe('生活');expect(taskChangeValueText([])).toBe('ラベルなし')
 } finally{await h.close()}
})
it('catalog UUIDs resolve through actual owner definitions; signed inbox contains names, not UUIDs',async()=>{
 const {s,second,taskId}=await setup(),h=await bridgeHarness({taskIds:[taskId],fields:['labels']})
 try{
  const registration=h.status().registration!,context:ExternalToolContext={registration,ownerId:s.profileId,datasetId:s.datasetId,externalEpoch:externalAIFor(s).epoch,policyEpoch:registration.policy_epoch,sourcePermissionRevision:registration.source_permission_revision}
  const dispatch=createAppChangeDispatcher({getHub:async()=>h.service,readDB:(table:'commands'|'labelDefinitions',key:string)=>db[table].get(key),dispatch:(name:string,args:Record<string,unknown>,ctx:ExternalToolContext)=>dispatchExternalChangeTool(name,args,ctx)})
  const request:ExternalChangeRequest={request_key:crypto.randomUUID(),operation:'task.update',task_id:taskId,expected_revision:1,payload:{changes:{labels:[second]}},basis:{kind:'external_request',note:'生活に変更'}}
  const plan=await dispatch('coach_prepare_change',request,context)
  expect(plan.field_diffs).toEqual([{path:'labels',before:['仕事'],after:['生活']}])
  await dispatch('coach_submit_change',{request_key:crypto.randomUUID(),change_set_id:plan.change_set_id,digest:plan.digest},context)
  const entry=(await h.controller.scanInbox()).entries.find(e=>e.state==='awaiting_approval')!;if(entry.state!=='awaiting_approval')throw Error('missing')
  expect(entry.prepared.command.payload.labels).toEqual(['生活'])
  const confirmed=await h.controller.confirmValuesFromUI(await h.controller.prepare(entry.reference),click())
  await h.controller.applyFromUI(confirmed,click(),['labels']);expect((await db.tasks.get(taskId))?.labels).toEqual(['生活'])
 }finally{await h.close()}
})
it('catalog definition renamed after prepare refuses submit',async()=>{
 const {s,second,taskId}=await setup(),h=await bridgeHarness({taskIds:[taskId],fields:['labels']})
 try{
  const r=h.status().registration!,context={registration:r,ownerId:s.profileId,datasetId:s.datasetId,externalEpoch:externalAIFor(s).epoch,policyEpoch:r.policy_epoch,sourcePermissionRevision:r.source_permission_revision}
  const plan=await dispatchExternalChangeTool('coach_prepare_change',{request_key:crypto.randomUUID(),operation:'task.update',task_id:taskId,expected_revision:1,payload:{changes:{labels:[second]}},basis:{kind:'external_request',note:'提案'}},context)
  await db.labelDefinitions.update(second,{name:'別の意味'})
  await expect(dispatchExternalChangeTool('coach_submit_change',{request_key:crypto.randomUUID(),change_set_id:plan.change_set_id,digest:plan.digest},context)).rejects.toThrow('LABELS_CHANGED')
  expect((await db.tasks.get(taskId))?.labels).toEqual(['仕事'])
 }finally{await h.close()}
})
for(const mutation of ['rename','group'] as const)it(`confirmed labels: ${mutation} changes fail closed at commit`,async()=>{
 const {second,taskId}=await setup(),h=await bridgeHarness({taskIds:[taskId],fields:['labels']})
 try{
  await h.writeCommand({type:'task.update',target_id:taskId,expected_revision:1,payload:{labels:['生活']}})
  const entry=(await h.controller.scanInbox()).entries.find(e=>e.state==='awaiting_approval')!;if(entry.state!=='awaiting_approval')throw Error('missing')
  const confirmed=await h.controller.confirmValuesFromUI(await h.controller.prepare(entry.reference),click())
  if(mutation==='rename')await db.labelDefinitions.update(second,{name:'変更後'})
  else await createLabelGroup('別グループ','multi')
  await expect(h.controller.applyFromUI(confirmed,click(),['labels'])).rejects.toThrow()
  expect((await db.tasks.get(taskId))?.labels).toEqual(['仕事']);expect(await db.ledger.count()).toBe(0)
 }finally{await h.close()}
})
it('single-choice groups and nonexistent names are not created by external proposals',async()=>{
 const {taskId}=await setup(),group=await createLabelGroup('状態','single');await createLabelDefinition('A',group);await createLabelDefinition('B',group)
 const h=await bridgeHarness({taskIds:[taskId],fields:['labels']})
 try{
  for(const labels of [['A','B'],['未定義']]){
   await h.writeCommand({type:'task.update',target_id:taskId,expected_revision:1,payload:{labels}})
   const entry=(await h.controller.scanInbox()).entries.find(e=>e.state==='awaiting_approval'&&JSON.stringify(e.prepared.command.payload.labels)===JSON.stringify(labels))!;if(entry.state!=='awaiting_approval')throw Error('missing')
   await expect(h.controller.confirmValuesFromUI(await h.controller.prepare(entry.reference),click())).rejects.toThrow()
  }
  expect(await db.labelDefinitions.count()).toBe(4);expect((await db.tasks.get(taskId))?.labels).toEqual(['仕事'])
 }finally{await h.close()}
})
it('actual controller snapshot retains already existing clock, day and manual points with each grant',async()=>{
 await resetApp();const taskId=await createTask({...newTaskInput(),title:'既存の値',dueDate:'2026-10-04',dueAt:'2026-10-04T01:00:12.345Z',dueTimezone:'Asia/Tokyo',score:{...newTaskInput().score,mode:'manual',manualPoints:7}})
 const h=await bridgeHarness({taskIds:[taskId],fields:['due_at','due_date','manual_points']})
 try{expect((await h.mcpCall('michi_snapshot',{})).structuredContent).toMatchObject({tasks:[{due_date:'2026-10-04',due_at:{at:'2026-10-04T01:00:12.345Z',timezone:'Asia/Tokyo'},manual_points:7}]})}finally{await h.close()}
})
it('catalog rejects a missing label grant before resolving any definitions',async()=>{
 const {s,taskId}=await setup(),h=await bridgeHarness({taskIds:[taskId],fields:['notes']})
 try{const r=h.status().registration!,ctx={registration:r,ownerId:s.profileId,datasetId:s.datasetId,externalEpoch:externalAIFor(s).epoch,policyEpoch:r.policy_epoch,sourcePermissionRevision:r.source_permission_revision};await expect(dispatchExternalChangeTool('coach_prepare_change',{request_key:crypto.randomUUID(),operation:'task.update',task_id:taskId,expected_revision:1,payload:{changes:{labels:[crypto.randomUUID()]}},basis:{kind:'external_request',note:'提案'}},ctx)).rejects.toThrow('FIELD_DENIED');expect((await h.mcpCall('michi_snapshot',{})).structuredContent).not.toHaveProperty('tasks.0.labels')}finally{await h.close()}
})
it('catalog UUIDs for unknown or other-owner definitions never become task label strings',async()=>{
 const {s,second,taskId}=await setup(),h=await bridgeHarness({taskIds:[taskId],fields:['labels']});await db.labelDefinitions.update(second,{ownerId:'foreign-owner'})
 try{const r=h.status().registration!,ctx={registration:r,ownerId:s.profileId,datasetId:s.datasetId,externalEpoch:externalAIFor(s).epoch,policyEpoch:r.policy_epoch,sourcePermissionRevision:r.source_permission_revision};for(const id of [second,crypto.randomUUID()])await expect(dispatchExternalChangeTool('coach_prepare_change',{request_key:crypto.randomUUID(),operation:'task.update',task_id:taskId,expected_revision:1,payload:{changes:{labels:[id]}},basis:{kind:'external_request',note:'提案'}},ctx)).rejects.toThrow('LABEL_NOT_FOUND');expect((await db.tasks.get(taskId))?.labels).toEqual(['仕事'])}finally{await h.close()}
})

it('definition changes between native value confirmation and preparing the diff invalidate the instruction',async()=>{
 const {s,taskId}=await setup(),base={ownerId:s.profileId,datasetId:s.datasetId,allowedFields:['labels'] as const,sourceRevisions:[]},human:ChangeContext={...base,allowedFields:['labels'],principal:{id:s.profileId,kind:'human'}},agent:ChangeContext={...human,principal:{id:'agent',kind:'external-agent'}}
 const changes=[{taskId,expectedRevision:1,patch:{labels:['生活']}}],instruction=await confirmTaskInstructionFromUI({message:'本人確認',referenceDate:'2026-10-03',timezone:'Asia/Tokyo',changes},human,click())
 await createLabelGroup('確認後に増えた定義','multi')
 await expect(prepareTaskChanges(changes,agent,'候補',instruction)).rejects.toThrow('ラベル定義')
 expect((await db.tasks.get(taskId))?.labels).toEqual(['仕事'])
})
