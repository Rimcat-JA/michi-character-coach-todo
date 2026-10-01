import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { contentDigest } from './canonical'
import { createTask, newTaskInput } from './commands'
import { changePolicyFor } from './change-set'
import { automationRulesFor, type OperationGroup, type OperationMode } from './automation-policy'
import { emptyScore } from './domain'
import { createLocalActionController, validateLocalActionInput, validateLocalActionResult } from './local-action-client'
import { localActionReceiptKey, type LocalActionDefinition, type LocalActionGateway, type LocalActionInspection, type LocalActionPrepared, type LocalActionResult, type LocalActionStatus } from './local-action-types'
beforeEach(async()=>{await db.delete();await db.open();await ensureSettings();await db.settings.update('main',{aiEnabled:true})})
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers()})
// Node-only fixture; production browser/native approval cannot set isTrusted.
function click(){const event=new Event('click');Object.defineProperty(event,'isTrusted',{value:true});return event}
async function fixture(){
  const settings=(await db.settings.get('main'))!,deviceId=crypto.randomUUID(),definition:LocalActionDefinition={title:'安全確認',executable:'C:\\synthetic\\registered.exe',cwd:'C:\\synthetic',argv:['--version'],schema:{},id:crypto.randomUUID(),revision:1,ownerId:settings.profileId,datasetId:settings.datasetId,deviceId,executableRoot:'C:\\synthetic',sha256:'b'.repeat(64)}
  const status:LocalActionStatus={version:1,available:true,enabled:true,ownerId:settings.profileId,datasetId:settings.datasetId,deviceId,definitions:[definition],results:[],notice:'synthetic trusted app gateway'},payload={version:1 as const,reference:crypto.randomUUID(),ownerId:settings.profileId,datasetId:settings.datasetId,deviceId,policyEpoch:0,sourcePermissionRevision:0,definition,expiresAt:Date.now()+300000},inspection:LocalActionInspection={...payload,digest:await contentDigest(payload)}
  const prepared:LocalActionPrepared={version:1,reference:crypto.randomUUID(),event:'owner-click',review:{requestId:crypto.randomUUID(),digest:'c'.repeat(64),actionId:definition.id,executable:definition.executable,argv:['--version'],cwd:definition.cwd,expiresAt:Date.now()+60000,approvalRequired:true,ownerId:settings.profileId,datasetId:settings.datasetId,deviceId,policyEpoch:0,sourcePermissionRevision:0,definitionRevision:1}},result:LocalActionResult={version:1,requestId:prepared.review.requestId,digest:prepared.review.digest,ownerId:settings.profileId,datasetId:settings.datasetId,deviceId,actionId:definition.id,policyEpoch:0,sourcePermissionRevision:0,definitionRevision:1,startedAt:Date.now(),status:'succeeded',exitCode:0,signal:null,output:'vSynthetic\n',outputTruncated:false,timedOut:false,completedAt:Date.now()+10,signature:'d'.repeat(64)}
  const gateway:LocalActionGateway={status:vi.fn(async()=>structuredClone(status)),inspectDefinition:vi.fn(async()=>structuredClone(inspection)),configure:vi.fn(async()=>structuredClone(status)),remove:vi.fn(async()=>({...structuredClone(status),definitions:[]})),prepare:vi.fn(async()=>structuredClone(prepared)),execute:vi.fn(async()=>structuredClone(result)),recordReceipt:vi.fn(async({requestId,digest})=>{const actual=await db.commands.get(localActionReceiptKey(requestId));if(!actual||actual.hash!==digest||JSON.stringify(JSON.parse(actual.resultId))!==JSON.stringify(result))throw new Error('actual persisted receipt required')}),invalidate:vi.fn(async()=>{})}
  const controller=createLocalActionController(gateway);await controller.refresh()
  return {settings,definition,status,inspection,prepared,result,gateway,controller}
}
describe('local action renderer authority and actual execution receipts',()=>{
  it('registers only a native host inspection and an immutable digest-bound preview',async()=>{
    const f=await fixture(),input={title:f.definition.title,executable:f.definition.executable,cwd:f.definition.cwd,argv:f.definition.argv,schema:f.definition.schema},inspection=await f.controller.inspectFromUI(input,click())
    expect(Object.isFrozen(inspection)).toBe(true)
    await expect(f.controller.configureFromUI(structuredClone(inspection),click())).rejects.toThrow()
    await expect(f.controller.configureFromUI(inspection,new Event('click'))).rejects.toThrow('本人')
    await expect(f.controller.configureFromUI(inspection,click())).resolves.toMatchObject({enabled:true})
    expect(f.gateway.configure).toHaveBeenCalledWith({reference:inspection.reference,digest:inspection.digest})
  })
  it('executes only a genuine owner click and atomically saves signed output and audit without changing tasks',async()=>{
    const f=await fixture(),id=await createTask({...newTaskInput(),title:'点数を維持',dueDate:'2026-10-03',score:{...emptyScore(),mode:'manual',manualPoints:25}}),prepared=await f.controller.prepare(f.definition.id,{})
    await expect(f.controller.executeFromUI(prepared,{isTrusted:true,type:'click'} as Event)).rejects.toThrow('本人')
    await expect(f.controller.executeFromUI(prepared,new Event('click'))).rejects.toThrow('本人')
    const outcome=await f.controller.executeFromUI(prepared,click())
    expect(outcome.receiptSaved).toBe(true);expect(outcome.result).toEqual(f.result)
    expect(JSON.parse((await db.commands.get(localActionReceiptKey(f.result.requestId)))!.resultId)).toEqual(f.result)
    expect((await db.audits.toArray()).filter(item=>item.operation==='localaction.result')).toHaveLength(1)
    expect(await db.tasks.get(id)).toMatchObject({revision:1,status:'open',dueDate:'2026-10-03',effectivePoints:25,score:{manualPoints:25}})
    expect(await db.ledger.count()).toBe(0)
  })
  it('rejects cloned prepared content, another controller and self declared executable or authority',async()=>{
    const f=await fixture(),prepared=await f.controller.prepare(f.definition.id,{})
    await expect(f.controller.executeFromUI(structuredClone(prepared),click())).rejects.toThrow()
    await expect(createLocalActionController(f.gateway).executeFromUI(prepared,click())).rejects.toThrow()
    expect(f.gateway.execute).not.toHaveBeenCalled()
    const input={title:f.definition.title,executable:f.definition.executable,cwd:f.definition.cwd,argv:['--version'],schema:{}}
    for(const extra of [{approved:true},{ownerId:'other'},{env:{secret:'synthetic'}},{shell:true},{policyEpoch:100}])expect(()=>validateLocalActionInput({...input,...extra})).toThrow()
  })
  it.each(['owner','dataset','epoch','source','ai'] as const)('invalidates %s-bound previews before the main execution call',async(kind)=>{
    const f=await fixture(),prepared=await f.controller.prepare(f.definition.id,{}),settings=(await db.settings.get('main'))!
    await db.settings.update('main',kind==='owner'?{profileId:crypto.randomUUID()}:kind==='dataset'?{datasetId:crypto.randomUUID()}:kind==='ai'?{aiEnabled:false}:kind==='epoch'?{changePolicy:{...changePolicyFor(settings),epoch:1}}:{changePolicy:{...changePolicyFor(settings),sourcePermissionRevision:1}})
    await expect(f.controller.executeFromUI(prepared,click())).rejects.toThrow();expect(f.gateway.execute).not.toHaveBeenCalled()
  })
  it('does not record substituted result identities, injected success fields or unbounded output',async()=>{
    const f=await fixture(),prepared=await f.controller.prepare(f.definition.id,{})
    f.result.actionId=crypto.randomUUID()
    await expect(f.controller.executeFromUI(prepared,click())).rejects.toThrow('一致')
    expect(await db.commands.get(localActionReceiptKey(f.result.requestId))).toBeUndefined()
    expect(()=>validateLocalActionResult({...f.result,completed:true,manualPoints:25})).toThrow()
    expect(()=>validateLocalActionResult({...f.result,output:'x'.repeat(65537)})).toThrow()
    expect(()=>validateLocalActionResult({...f.result,status:'succeeded',exitCode:2})).toThrow()
  })
  it('preserves the real OS result when audit save rolls back; retry saves history without executing again',async()=>{
    const f=await fixture(),prepared=await f.controller.prepare(f.definition.id,{})
    vi.spyOn(db.audits,'add').mockRejectedValueOnce(new Error('synthetic audit failure'))
    const outcome=await f.controller.executeFromUI(prepared,click())
    expect(outcome.receiptSaved).toBe(false);expect(outcome.result).toEqual(f.result)
    expect(await db.commands.get(localActionReceiptKey(f.result.requestId))).toBeUndefined()
    vi.restoreAllMocks()
    expect((await f.controller.retryReceiptFromUI(outcome.result,click())).receiptSaved).toBe(true)
    expect(f.gateway.execute).toHaveBeenCalledOnce();expect((await db.audits.toArray()).filter(item=>item.operation==='localaction.result')).toHaveLength(1)
  })
  it('retries a failed main receipt acknowledgement without rewriting or reexecuting the action',async()=>{
    const f=await fixture(),prepared=await f.controller.prepare(f.definition.id,{}),ack=f.gateway.recordReceipt
    f.gateway.recordReceipt=vi.fn(async()=>{throw new Error('synthetic acknowledgement failure')})
    const outcome=await f.controller.executeFromUI(prepared,click())
    expect(outcome.receiptSaved).toBe(false);expect(await db.commands.get(localActionReceiptKey(f.result.requestId))).toBeDefined()
    f.gateway.recordReceipt=ack
    expect((await f.controller.retryReceiptFromUI(outcome.result,click())).receiptSaved).toBe(true)
    expect(f.gateway.execute).toHaveBeenCalledOnce();expect((await db.audits.toArray()).filter(item=>item.operation==='localaction.result')).toHaveLength(1)
    await expect(f.controller.retryReceiptFromUI(structuredClone(outcome.result),click())).rejects.toThrow()
  })
  it('refuses unexpected literal args, automatic approvals and expired requests before execution',async()=>{
    const f=await fixture();f.prepared.review.argv=['--eval','bad']
    await expect(f.controller.prepare(f.definition.id,{})).rejects.toThrow()
    f.prepared.review.argv=['--version'];f.prepared.review.approvalRequired=false as true
    await expect(f.controller.prepare(f.definition.id,{})).rejects.toThrow()
    f.prepared.review.approvalRequired=true
    const prepared=await f.controller.prepare(f.definition.id,{})
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(Date.now()+60000))
    await expect(f.controller.executeFromUI(prepared,click())).rejects.toThrow('期限')
    expect(f.gateway.execute).not.toHaveBeenCalled()
  })
  it('permits only enum strings, bounded integer definitions and booleans in declared argv slots',()=>{
    const input={title:'typed',executable:'C:\\registered.exe',cwd:'C:\\cwd',argv:[{param:'choice'},{param:'count'},{param:'flag'}],schema:{choice:{type:'string',enum:['safe','quiet'],maxLength:10},count:{type:'number',min:0,max:2},flag:{type:'boolean'}}}
    expect(()=>validateLocalActionInput(input)).not.toThrow()
    expect(()=>validateLocalActionInput({...input,schema:{choice:{type:'string',enum:['--eval'],maxLength:20}}})).toThrow()
    expect(()=>validateLocalActionInput({...input,schema:{choice:{type:'string',maxLength:20}}})).toThrow()
    expect(()=>validateLocalActionInput({...input,schema:{choice:{type:'path',roots:['C:\\']}}})).toThrow()
    expect(()=>validateLocalActionInput({...input,argv:[{param:'not-declared'}]})).toThrow()
  })
})
async function setOperation(operation: OperationGroup, mode: OperationMode) { const current = (await db.settings.get('main'))!, policy = changePolicyFor(current); await db.settings.put({ ...current, changePolicy: { ...policy, operations: automationRulesFor(policy).map(rule => rule.operation === operation ? { ...rule, mode } : rule) } }) }
describe('N09 local_action.run gate',()=>{
  it('local_action.run=deny blocks registration, preparation and execution without invalidating the registered definition',async()=>{
    const f=await fixture(),input={title:f.definition.title,executable:f.definition.executable,cwd:f.definition.cwd,argv:f.definition.argv,schema:f.definition.schema},prepared=await f.controller.prepare(f.definition.id,{})
    await setOperation('local_action.run','deny')
    await expect(f.controller.inspectFromUI(input,click())).rejects.toThrow('変わりました')
    await expect(f.controller.prepare(f.definition.id,{})).rejects.toThrow('変わりました')
    await expect(f.controller.executeFromUI(prepared,click())).rejects.toThrow('変わりました')
    expect(f.gateway.execute).not.toHaveBeenCalled();expect(f.gateway.invalidate).not.toHaveBeenCalled()
  })
})
