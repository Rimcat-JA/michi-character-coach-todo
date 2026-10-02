import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { emptyScore } from './domain'
import { bridgeHarness, resetApp, click } from './command-test-harness'
import { externalAIFor } from './external-authority'
import { dispatchExternalChangeTool } from './external-change-plans'
import { dispatchExternalReadTool, implementedExternalTools, type ExternalToolContext } from './external-tools'
import { captureSnapshot } from './backup'
const require=createRequire(import.meta.url),{createMCPCore}=require('../electron/mcp-core.cjs'),{createAppChangeDispatcher}=require('../electron/mcp-app-changes.cjs')
it('catalog prepare/submit uses the real signed inbox, shared owner-value confirmation and atomic receipt; replays never award points',async()=>{
 await resetApp();const taskId=await createTask({...newTaskInput(),title:'本人の25pt',scheduledDate:'2026-10-03',dueDate:'2026-10-10',score:{...emptyScore(),mode:'manual',manualPoints:25}})
 const h=await bridgeHarness({taskIds:[taskId],fields:['title','manual_points','scheduled_date']})
 try{
  const s=(await db.settings.get('main'))!,registration=h.status().registration!,context:ExternalToolContext={registration,ownerId:s.profileId,datasetId:s.datasetId,externalEpoch:externalAIFor(s).epoch,policyEpoch:registration.policy_epoch,sourcePermissionRevision:registration.source_permission_revision}
  const dispatch=createAppChangeDispatcher({getHub:async()=>h.service,readDB:(table:'commands',key:string)=>db[table].get(key),dispatch:(name:string,args:Record<string,unknown>,ctx:ExternalToolContext)=>name==='coach_prepare_change'||name==='coach_submit_change'?dispatchExternalChangeTool(name,args,ctx):dispatchExternalReadTool(name,args,ctx)})
  const core=await createMCPCore({authenticate:async()=>({clientId:registration.client.id,externalEpoch:context.externalEpoch,revision:1,grantEpoch:1}),getContext:async()=>({...context,active:true,externalEnabled:externalAIFor((await db.settings.get('main'))!).enabled,frozen:false}),dispatch,implemented:implementedExternalTools})
  let rpc=0;const call=async(name:string,args:Record<string,unknown>)=>(await core.handle('synthetic',{jsonrpc:'2.0',id:++rpc,method:'tools/call',params:{name,arguments:args}})).result.structuredContent
  const request={request_key:crypto.randomUUID(),operation:'task.score.set_manual',task_id:taskId,expected_revision:1,payload:{points:0},basis:{kind:'external_request',note:'0ptへの提案'}}
  const prepared=await call('coach_prepare_change',request);expect(prepared.state).toBe('ok');expect(prepared.data.field_diffs).toEqual([{path:'manual_points',before:25,after:0}])
  expect((await call('coach_prepare_change',request)).data).toEqual(prepared.data)
  expect((await call('coach_prepare_change',{...request,payload:{points:30}})).error.code).toBe('IDEMPOTENCY_MISMATCH')
  expect((await db.tasks.get(taskId))?.score.manualPoints).toBe(25)
  const submit={request_key:crypto.randomUUID(),change_set_id:prepared.data.change_set_id,digest:prepared.data.digest}
  expect((await call('coach_submit_change',submit)).data.state).toBe('awaiting_approval');expect((await call('coach_submit_change',submit)).data).toEqual(prepared.data)
  expect((await readdir(join(h.status().root!,'inbox'))).filter(name=>name.endsWith('.ready.json'))).toHaveLength(1)
  expect((await db.tasks.get(taskId))?.revision).toBe(1)
  const scanned=await h.controller.scanInbox(),entry=scanned.entries.find(entry=>entry.state==='awaiting_approval')!;if(entry.state!=='awaiting_approval')throw Error('missing inbox')
  const pending=await h.controller.prepare(entry.reference);expect(pending.command.stage).toBe('owner_values')
  const confirmed=await h.controller.confirmValuesFromUI(pending,click(),'本人が0ptに確定')
  await h.controller.applyFromUI(confirmed,click(),['manualPoints'])
  const task=(await db.tasks.get(taskId))!;expect(task.revision).toBe(2);expect(task.score.manualPoints).toBe(0);expect(task.dueDate).toBe('2026-10-10')
  expect((await call('coach_submit_change',submit)).data.state).toBe('applied');expect((await call('coach_submit_change',{...submit,request_key:crypto.randomUUID()})).data.state).toBe('applied')
  expect((await call('coach_get_command_result',{command_id:prepared.data.command_id})).data).toMatchObject({state:'applied',replayed:true})
  expect((await db.tasks.get(taskId))?.revision).toBe(2);expect(await db.ledger.count()).toBe(0);expect(await db.completions.count()).toBe(0)
  expect((await captureSnapshot()).commands.some(row=>/^external(plan|prepare|submit|instruction):/.test(row.key))).toBe(false)
  await db.settings.update('main',{externalAI:{...externalAIFor(s),enabled:false}})
  const revoked=await core.handle('synthetic',{jsonrpc:'2.0',id:++rpc,method:'tools/call',params:{name:'coach_get_command_result',arguments:{command_id:prepared.data.command_id}}});expect(revoked.error.message).toBe('PLUGIN_DISABLED')
 }finally{await h.close()}
})
it('foreign scope, unverified evidence, lifecycle operations, stale revisions, native approval flags and freeze fail before proposal publication',async()=>{
 await resetApp();const id=await createTask({...newTaskInput(),title:'allowed'}),other=await createTask({...newTaskInput(),title:'secret'}),h=await bridgeHarness({taskIds:[id],fields:['title']})
 try{
  const s=(await db.settings.get('main'))!,reg=h.status().registration!,context:ExternalToolContext={registration:reg,ownerId:s.profileId,datasetId:s.datasetId,externalEpoch:externalAIFor(s).epoch,policyEpoch:reg.policy_epoch,sourcePermissionRevision:reg.source_permission_revision}
  const request={request_key:crypto.randomUUID(),operation:'task.update',task_id:id,expected_revision:1,payload:{changes:{title:'new'}},basis:{kind:'external_request',note:'proposal'}}
  for(const [value,error] of [[{...request,task_id:other},'NOT_FOUND'],[{...request,basis:{kind:'app_instruction',reference_id:crypto.randomUUID()}},'UNVERIFIED_REFERENCE'],[{...request,operation:'task.complete',payload:{expected_assessment_id:null}},'FORBIDDEN_OPERATION'],[{...request,expected_revision:2},'REVISION_CONFLICT'],[{...request,approved:true},'TOOL_SCHEMA']] as const)await expect(dispatchExternalChangeTool('coach_prepare_change',value,context)).rejects.toThrow(error)
  expect(await db.commands.toCollection().filter(row=>row.key.startsWith('externalplan:')).count()).toBe(0)
  await db.datasetState.put({id:'main',mode:'frozen',moveId:crypto.randomUUID(),updatedAt:new Date().toISOString()})
  await expect(dispatchExternalChangeTool('coach_prepare_change',request,context)).rejects.toThrow('DATASET_FROZEN')
  expect((await readdir(join(h.status().root!,'inbox'))).filter(name=>name.endsWith('.ready.json'))).toEqual([])
 }finally{await h.close()}
})
