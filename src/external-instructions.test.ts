import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { resetApp, bridgeHarness, click } from './command-test-harness'
import { externalAIFor } from './external-authority'
import { clearExternalInstructionAuthority, confirmExternalInstructionFromUI, verifiedExternalInstruction } from './external-instructions'
import { externalCommandEnvelope } from './external-command-adapter'
import type { ExternalChangeRequest } from './external-command-gate'
import type { ExternalToolContext } from './external-tools'
afterEach(clearExternalInstructionAuthority)
it('native instruction binds the actual catalog target/revision/values, never a caller supplied second change list',async()=>{
 await resetApp();const taskId=await createTask({...newTaskInput(),title:'本人のタスク'}),foreign=await createTask({...newTaskInput(),title:'非共有'})
 const h=await bridgeHarness({taskIds:[taskId],fields:['title','manual_points']})
 try{
  const settings=(await db.settings.get('main'))!,registration=h.status().registration!,context:ExternalToolContext={registration,ownerId:settings.profileId,datasetId:settings.datasetId,externalEpoch:externalAIFor(settings).epoch,policyEpoch:registration.policy_epoch,sourcePermissionRevision:registration.source_permission_revision}
  const request:ExternalChangeRequest={request_key:crypto.randomUUID(),operation:'task.score.set_manual',task_id:taskId,expected_revision:1,payload:{points:0},basis:{kind:'external_request',note:'提案'}}
  await expect(confirmExternalInstructionFromUI(request,context,new Event('click'))).rejects.toThrow('確認ボタン')
  await expect(confirmExternalInstructionFromUI({...request,task_id:foreign},context,click())).rejects.toThrow('NOT_FOUND')
  const reference_id=await confirmExternalInstructionFromUI(request,context,click()),bound={...request,basis:{kind:'app_instruction' as const,reference_id}}
  expect(await verifiedExternalInstruction(bound,context)).not.toBeNull()
  for(const changed of [{...bound,payload:{points:1}},{...bound,task_id:foreign},{...bound,expected_revision:2}])expect(await verifiedExternalInstruction(changed,context)).toBeNull()
  expect(await verifiedExternalInstruction({...bound,request_key:crypto.randomUUID()},context)).not.toBeNull()
  const row=(await db.commands.get(`externalinstruction:${reference_id}`))!
  expect(row.resultId).not.toContain('提案');expect(await db.ledger.count()).toBe(0)
  await db.settings.update('main',{externalAI:{...externalAIFor(settings),epoch:context.externalEpoch+1}})
  expect(await verifiedExternalInstruction(bound,context)).toBeNull()
 }finally{await h.close()}
})
it('persisted instruction metadata cannot recreate runtime authority',async()=>{
 await resetApp();const id=await createTask({...newTaskInput(),title:'test'}),h=await bridgeHarness({taskIds:[id],fields:['title']})
 try{
  const s=(await db.settings.get('main'))!,reg=h.status().registration!,context:ExternalToolContext={registration:reg,ownerId:s.profileId,datasetId:s.datasetId,externalEpoch:externalAIFor(s).epoch,policyEpoch:reg.policy_epoch,sourcePermissionRevision:reg.source_permission_revision}
  const request:ExternalChangeRequest={request_key:crypto.randomUUID(),operation:'task.update',task_id:id,expected_revision:1,payload:{changes:{title:'new'}},basis:{kind:'external_request',note:'new'}}
  const reference_id=await confirmExternalInstructionFromUI(request,context,click());clearExternalInstructionAuthority()
  expect(await db.commands.get(`externalinstruction:${reference_id}`)).toBeDefined()
  expect(await verifiedExternalInstruction({...request,basis:{kind:'app_instruction',reference_id}},context)).toBeNull()
 }finally{await h.close()}
})
it('catalog conversion retains null and zero; unsupported fields never silently disappear',()=>{
 const base={request_key:crypto.randomUUID(),operation:'task.update',task_id:crypto.randomUUID(),expected_revision:1,payload:{changes:{scheduled_date:null,due:{kind:'none'}}},basis:{kind:'external_request' as const,note:'proposal'}}
 expect(externalCommandEnvelope(base,base.request_key).payload).toEqual({scheduled_date:null,due_date:null})
 expect(externalCommandEnvelope({...base,operation:'task.score.set_manual',payload:{points:0}},base.request_key).payload).toEqual({manual_points:0})
 expect(externalCommandEnvelope({...base,payload:{changes:{due:{kind:'datetime',at:'2026-10-04T01:00:00+09:00'}}}},base.request_key).payload).toEqual({due_date:'2026-10-03',due_at:{at:'2026-10-03T16:00:00.000Z',timezone:'UTC'}})
 expect(()=>externalCommandEnvelope({...base,payload:{changes:{labels:[]}}},base.request_key)).toThrow('LABEL_RESOLUTION_REQUIRED')
 expect(()=>externalCommandEnvelope({...base,operation:'task.complete',payload:{expected_assessment_id:null}},base.request_key)).toThrow('FORBIDDEN_OPERATION')
})
