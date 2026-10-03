import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { bridgeHarness, resetApp, click } from './command-test-harness'
import { isPendingCommand } from './command-bus'
import { dispatchExternalChangeTool } from './external-change-plans'
import { externalAIFor } from './external-authority'
import type { FileBridgeRegistration, FileBridgeRevise } from './file-bridge-types'
const revision=(r:FileBridgeRegistration):FileBridgeRevise=>({clientId:r.client.id,expectedRevision:r.client.revision,taskIds:r.task_ids,fields:['scheduled_date'],expiresAt:r.client.grant.expires_at,automation:null,maxScheduleShiftDays:3,maxOperationsPerDay:5,allowSplit:false,ruleIds:[],allowHistory:false,allowRoutinePreview:false,allowContextRead:false,allowExternalContext:false,allowDetection:false,allowHandoffPrepare:false,allowHandoffs:false,allowRoutineChange:false})
it('revision latches old scope before main, cancels the bus and invalidates plan replay while preserving tasks/BYOK/ledger',async()=>{
 await resetApp();const id=await createTask({...newTaskInput(),title:'private title',scheduledDate:'2026-10-03'}),h=await bridgeHarness({taskIds:[id],fields:['title','notes','scheduled_date']})
 try{
  const s=(await db.settings.get('main'))!,reg=h.status().registration!,context={registration:reg,ownerId:s.profileId,datasetId:s.datasetId,externalEpoch:externalAIFor(s).epoch,policyEpoch:reg.policy_epoch,sourcePermissionRevision:reg.source_permission_revision}
  const plan=await dispatchExternalChangeTool('coach_prepare_change',{request_key:crypto.randomUUID(),operation:'task.update',task_id:id,expected_revision:1,payload:{changes:{title:'external title'}},basis:{kind:'external_request',note:'proposed'}},context)
  await h.writeCommand({type:'task.update',target_id:id,expected_revision:1,payload:{notes:'proposed'}})
  const scanned=await h.controller.scanInbox(),entry=scanned.entries.find(e=>e.state==='awaiting_approval')!;if(entry.state!=='awaiting_approval')throw Error('missing')
  const prepared=await h.controller.prepare(entry.reference)
  const next=await h.controller.revise(revision(reg)) // Reduction needs no Event; main decides whether it expands.
  expect(next.registration?.client).toMatchObject({id:reg.client.id,revision:2,grant_epoch:2});expect(next.snapshot).toBeNull();expect(isPendingCommand(prepared.command)).toBe(false)
  await expect(h.controller.applyFromUI(prepared,click())).rejects.toThrow()
  await expect(dispatchExternalChangeTool('coach_submit_change',{request_key:crypto.randomUUID(),change_set_id:plan.change_set_id,digest:plan.digest},context)).rejects.toThrow('STALE_GRANT')
  const current=(await db.settings.get('main'))!;expect(current.aiEnabled).toBe(s.aiEnabled);expect(current.externalAI?.epoch).toBe(s.externalAI?.epoch);expect(current.externalAI?.clients[0].registration.client.revision).toBe(2)
  expect((await db.tasks.get(id))?.title).toBe('private title');expect((await db.tasks.get(id))?.revision).toBe(1);expect(await db.ledger.count()).toBe(0)
 }finally{await h.close()}
})
it('failed main revision remains revoked instead of refreshing an older broader grant',async()=>{
 await resetApp();const id=await createTask({...newTaskInput(),title:'owner'}),h=await bridgeHarness({taskIds:[id],fields:['title']})
 try{
  const reg=h.status().registration!,invalid={...revision(reg),maxScheduleShiftDays:32}
  await expect(h.controller.revise(invalid,click())).rejects.toThrow()
  expect((await db.settings.get('main'))?.externalAI?.clients[0].status).toBe('revoked')
  expect((await h.controller.refresh()).connected).toBe(false)
  expect((await db.tasks.get(id))?.revision).toBe(1)
 }finally{await h.close()}
})
