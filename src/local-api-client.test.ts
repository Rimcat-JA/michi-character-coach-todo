import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { changePolicyFor } from './change-set'
import { clearCommandAuthority, pendingCommands } from './command-bus'
import { prepareLocalAPICommand, applyLocalAPICommand } from './local-api-client'
import type { LocalAPIPending, LocalAPIWindow } from './local-api-types'
beforeEach(async()=>{await db.delete();await db.open();await ensureSettings();await db.settings.update('main',{aiEnabled:true});clearCommandAuthority()})
afterEach(()=>vi.restoreAllMocks())
// Synthetic Node Event only; native Chromium isTrusted is not writable.
function click(){const e=new Event('click');Object.defineProperty(e,'isTrusted',{value:true});return e}
async function fixture(){
 const settings=(await db.settings.get('main'))!,p=changePolicyFor(settings),tokenId=crypto.randomUUID(),id=crypto.randomUUID()
 const row:LocalAPIPending={tokenId,ownerId:settings.profileId,datasetId:settings.datasetId,policyEpoch:p.epoch,sourcePermissionRevision:p.sourcePermissionRevision,grantEpoch:1,digest:'a'.repeat(64),command:{command_id:id,type:'task.create',payload:{title:'API literal 25pt',notes:'due: tomorrow 99pt',scheduled_date:'2026-10-03'}},expiresAt:new Date(Date.now()+60000).toISOString(),projectId:null,label:'synthetic',receiptKey:`localapi:applied:${tokenId}:${id}`}
 const request=vi.fn(async(value:Record<string,unknown>)=>value.action==='authorize'?{...row,id:crypto.randomUUID(),expiresAt:Date.now()+29000}:true)
 const gateway:LocalAPIWindow={request,invalidate:vi.fn(async()=>{})}
 return {row,gateway,request,settings}
}
it('native approval writes one task plus durable receipt atomically, replay preserves unknown points and ledger',async()=>{
 const f=await fixture(),preview=await prepareLocalAPICommand(f.row)
 expect(await db.tasks.count()).toBe(0)
 const first=await applyLocalAPICommand(preview,click(),f.gateway),again=await applyLocalAPICommand(preview,click(),f.gateway)
 expect(again.taskId).toBe(first.taskId);expect(await db.tasks.count()).toBe(1)
 expect(await db.tasks.get(first.taskId)).toMatchObject({title:'API literal 25pt',notes:'due: tomorrow 99pt',scheduledDate:'2026-10-03',dueDate:null,effectivePoints:null,status:'open'})
 expect(await db.commands.get(f.row.receiptKey)).toMatchObject({hash:f.row.digest,resultId:first.taskId})
 expect(await db.ledger.count()).toBe(0);expect(await db.completions.count()).toBe(0)
 expect(pendingCommands().filter(p=>p.envelope.command_id===f.row.command.command_id)).toHaveLength(0)
 expect((await db.audits.toArray()).some(a=>a.detail.includes('entrance=api'))).toBe(true)
})
it('untrusted click, cloned preview, authority change and tampered native lease create nothing',async()=>{
 const f=await fixture(),preview=await prepareLocalAPICommand(f.row)
 await expect(applyLocalAPICommand(preview,new Event('click'),f.gateway)).rejects.toThrow('本人')
 await expect(applyLocalAPICommand({...preview},click(),f.gateway)).rejects.toThrow('失効')
 f.request.mockImplementationOnce(async()=>({...f.row,id:crypto.randomUUID(),expiresAt:Date.now()+29000,command:{...f.row.command,payload:{title:'tampered'}}}))
 await expect(applyLocalAPICommand(preview,click(),f.gateway)).rejects.toThrow('一致')
 await db.settings.update('main',{changePolicy:{...changePolicyFor(f.settings),epoch:f.row.policyEpoch+1}})
 await expect(applyLocalAPICommand(preview,click(),f.gateway)).rejects.toThrow('権限')
 expect(await db.tasks.count()).toBe(0);expect(await db.ledger.count()).toBe(0)
})
it('receipt failure rolls back task and audit, and lost main acknowledgment never duplicates a committed task',async()=>{
 const f=await fixture(),preview=await prepareLocalAPICommand(f.row),realAdd=db.commands.add.bind(db.commands)
 const add=vi.spyOn(db.commands,'add').mockImplementation((...args)=>args[0].key===f.row.receiptKey?Dexie.Promise.reject(Error('forced durable receipt failure')):realAdd(...args))
 await expect(applyLocalAPICommand(preview,click(),f.gateway)).rejects.toThrow('forced durable')
 expect(await db.tasks.count()).toBe(0);expect(await db.audits.count()).toBe(0);add.mockRestore()
 const fresh=await prepareLocalAPICommand(f.row)
 f.request.mockImplementation(async value=>{if(value.action==='applied')throw Error('lost acknowledgment');return value.action==='authorize'?{...f.row,id:crypto.randomUUID(),expiresAt:Date.now()+29000}:true})
 const result=await applyLocalAPICommand(fresh,click(),f.gateway);expect(result.resultPending).toBe(true)
 expect((await applyLocalAPICommand(fresh,click(),f.gateway)).taskId).toBe(result.taskId)
 expect(await db.tasks.count()).toBe(1);expect(await db.ledger.count()).toBe(0)
})
it('AI processing stop rejects API preparation and selected project creation stays scoped',async()=>{
 const f=await fixture();await db.settings.update('main',{aiEnabled:false});await expect(prepareLocalAPICommand(f.row)).rejects.toThrow('停止')
 await db.settings.update('main',{aiEnabled:true});const projectId=crypto.randomUUID(),at=new Date().toISOString()
 await db.containers.add({id:projectId,ownerId:f.settings.profileId,name:'scoped project',parentId:null,kind:'project',revision:1,createdAt:at,updatedAt:at,deletedAt:null})
 f.row.projectId=projectId
 const preview=await prepareLocalAPICommand(f.row),result=await applyLocalAPICommand(preview,click(),f.gateway)
 expect((await db.tasks.get(result.taskId))?.containerId).toBe(projectId)
})
