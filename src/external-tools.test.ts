import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { emptyScore } from './domain'
import { resetApp, bridgeHarness } from './command-test-harness'
import { dispatchExternalReadTool, implementedExternalTools, type ExternalToolContext } from './external-tools'
import { externalAIFor } from './external-authority'
import catalog from '../electron/contracts/plugin-tools.resolved.json'
const {createMCPCore}=createRequire(import.meta.url)('../electron/mcp-core.cjs')
it('real app reads through the catalog core: exact 15 schemas, only granted tasks/fields, no memory or source disclosure',async()=>{
 await resetApp()
 const a=await createTask({...newTaskInput(),title:'共有',notes:'本人メモ',scheduledDate:'2026-10-03',score:{...emptyScore(),mode:'manual',manualPoints:25}}),b=await createTask({...newTaskInput(),title:'秘密',notes:'秘密資料と会話'})
 const h=await bridgeHarness({taskIds:[a],fields:['title','notes','scheduled_date','manual_points']})
 try{
  const reg=h.status().registration!,s=(await db.settings.get('main'))!,external=externalAIFor(s),context:ExternalToolContext={registration:reg,ownerId:s.profileId,datasetId:s.datasetId,externalEpoch:external.epoch,policyEpoch:reg.policy_epoch,sourcePermissionRevision:reg.source_permission_revision}
  const core=await createMCPCore({authenticate:async(identity:string)=>identity==='synthetic-credential'?{clientId:reg.client.id,externalEpoch:external.epoch,revision:1,grantEpoch:1}:null,getContext:async()=>({...context,externalEnabled:externalAIFor((await db.settings.get('main'))!).enabled,active:true,frozen:false}),dispatch:dispatchExternalReadTool,implemented:implementedExternalTools})
  let id=0
  const message=(method:string,params?:unknown)=>({jsonrpc:'2.0',id:++id,method,params})
  const call=async(name:string,args:Record<string,unknown>)=>(await core.handle('synthetic-credential',message('tools/call',{name,arguments:args}))).result
  expect((await core.handle('wrong-credential',message('tools/list'))).error.message).toBe('UNAUTHENTICATED')
  expect((await core.handle('synthetic-credential',message('tools/list'))).result.tools).toEqual(catalog.tools)
  const read=await call('coach_get_task',{task_id:a})
  expect(read.structuredContent.data.task).toMatchObject({id:a,revision:1,points:25});expect(read.structuredContent.data.notes).toBe('本人メモ');expect(read.structuredContent.meta.actor_id).toBe(reg.client.id)
  const foreign=await call('coach_get_task',{task_id:b});expect(foreign.isError).toBe(true);expect(foreign.structuredContent.data).toBeNull();expect(foreign.structuredContent.error.code).toBe('NOT_FOUND')
  const search=await call('coach_search_tasks',{});expect(search.structuredContent.data.items).toHaveLength(1);expect(JSON.stringify(search)).not.toContain('秘密')
  const contextRead=await call('coach_search_context',{query:'秘密',scope_ids:[b]});expect(contextRead.structuredContent.data.excerpts).toEqual([]);expect(JSON.stringify(contextRead)).not.toContain('秘密資料')
  const zero=await call('coach_preview_score',{score:{mode:'manual',points:0}});expect(zero.structuredContent.data.effective_points).toBe(0)
  expect((await call('coach_prepare_handoff',{request_key:crypto.randomUUID(),summary:'下書き',task_ids:[a]})).structuredContent.error.code).toBe('FEATURE_NOT_IMPLEMENTED')
  expect((await core.handle('synthetic-credential',message('tools/call',{name:'coach_get_task',arguments:{task_id:a,approved:true}}))).error.message).toBe('TOOL_SCHEMA')
  expect(await db.ledger.count()).toBe(0);expect(await db.completions.count()).toBe(0)
  await db.settings.update('main',{externalAI:{...external,enabled:false}})
  expect((await core.handle('synthetic-credential',message('tools/list'))).error.message).toBe('PLUGIN_DISABLED')
 }finally{await h.close()}
})
it('renderer rechecks scope and registration; hidden fields cannot become query oracles and pagination does not exceed 50',async()=>{
 await resetApp()
 const ids=await Promise.all(Array.from({length:51},(_,i)=>createTask({...newTaskInput(),title:`secret ${i}`,notes:'secret notes'})))
 const h=await bridgeHarness({taskIds:ids,fields:['scheduled_date']})
 try{
  const reg=h.status().registration!,s=(await db.settings.get('main'))!,context:ExternalToolContext={registration:reg,ownerId:s.profileId,datasetId:s.datasetId,externalEpoch:externalAIFor(s).epoch,policyEpoch:reg.policy_epoch,sourcePermissionRevision:reg.source_permission_revision}
  const first=await dispatchExternalReadTool('coach_search_tasks',{limit:50},context) as {items:{title:string;points:null}[];next_cursor:string}
  expect(first.items).toHaveLength(50);expect(first.items.every(row=>row.title==='非共有'&&row.points===null)).toBe(true)
  expect((await dispatchExternalReadTool('coach_search_tasks',{limit:50,cursor:first.next_cursor},context) as {items:unknown[]}).items).toHaveLength(1)
  expect((await dispatchExternalReadTool('coach_search_tasks',{filter:{query:'secret'}},context) as {items:unknown[]}).items).toEqual([])
  await expect(dispatchExternalReadTool('coach_search_tasks',{limit:51},context)).rejects.toThrow('TOOL_SCHEMA')
  await expect(dispatchExternalReadTool('coach_get_task',{task_id:ids[0]},{...context,datasetId:crypto.randomUUID()})).rejects.toThrow('NOT_FOUND')
  await expect(dispatchExternalReadTool('coach_get_task',{task_id:ids[0]},{...context,externalEpoch:context.externalEpoch+1})).rejects.toThrow('STALE_GRANT')
 }finally{await h.close()}
})
