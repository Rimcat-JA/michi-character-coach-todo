import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { bridgeHarness, resetApp } from './command-test-harness'
import { runExternalSelftest } from './external-ai'
import { externalAIFor } from './external-authority'
import type { CapabilityCheck } from './external-authority'

it('records only local diagnostic evidence; ignores foreign, promoted and stale connection results', async () => {
  await resetApp()
  const taskId=await createTask({...newTaskInput(),title:'診断の対象'}),h=await bridgeHarness({taskIds:[taskId],fields:['title']})
  try {
    const clientId=h.status().registration!.client.id
    const check:CapabilityCheck={checkedAt:new Date().toISOString(),surface:'local_selftest',protocolVersion:'2025-11-25',auth:'not_tested',read:'verified_local',write:'not_tested',revoke:'not_tested'}
    h.gateway.selftest=async()=>({clientId,check,code:null})
    await runExternalSelftest(h.gateway,clientId,'read')
    const client=externalAIFor((await db.settings.get('main'))!).clients[0]
    expect(client.capabilityChecks).toEqual([check]);expect(client.shippingState).toBe('implemented')
    for(const bad of [{clientId:crypto.randomUUID(),check,code:null},{clientId,check:{...check,surface:'real_host' as const,read:'verified_real' as const},code:null},{clientId,check:{...check,revoke:'verified_local' as const},code:null}]){
      h.gateway.selftest=async()=>bad
      await expect(runExternalSelftest(h.gateway,clientId,'read')).rejects.toThrow()
    }
    h.gateway.selftest=async()=>{
      const s=(await db.settings.get('main'))!,state=externalAIFor(s)
      await db.settings.put({...s,externalAI:{...state,epoch:state.epoch+1}})
      return {clientId,check,code:null}
    }
    await expect(runExternalSelftest(h.gateway,clientId,'read')).rejects.toThrow('対象が変わりました')
    expect(externalAIFor((await db.settings.get('main'))!).clients[0].capabilityChecks).toHaveLength(1)
  } finally { await h.close() }
})
