import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { contentDigest } from './canonical'
import { createTask, newTaskInput, updateTask } from './commands'
import { emptyScore } from './domain'
import { applyChangeSet, changePolicyFor, clearChangeSetAuthority, prepareTaskChanges } from './change-set'
import { presetRules } from './automation-policy'
import { previewAutomationPolicy, reduceAuthority, setAutomationPolicyFromUI } from './automation-control'
import { createFileBridgeController, readFileBridgeApplicationReceipt } from './file-bridge-commands'
import { isPendingCommand, pendingCommands, submitCommand } from './command-bus'
import { assertFileBridgeCommand, assertFileBridgeInboxEntry, assertFileBridgeStatus } from './file-bridge-contract'
import { fileBridgeReceiptKey, fileBridgeScopeKey, type FileBridgeApplicationBinding, type FileBridgeGateway, type FileBridgeInboxEntry, type FileBridgeLease, type FileBridgeRegistration, type FileBridgeResult, type FileBridgeStatus } from './file-bridge-types'

beforeEach(async()=>{await db.delete();await db.open();await ensureSettings();await db.settings.update('main',{aiEnabled:true,externalAI:{version:1,enabled:true,epoch:0,clients:[]}});clearChangeSetAuthority()})
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers()})
const future=(ms=600000)=>new Date(Date.now()+ms).toISOString()
// Node-only test fixture; native browser Event.isTrusted has no writable setter.
function click(){const event=new Event('click');Object.defineProperty(event,'isTrusted',{value:true});return event}
async function fixture(type:'task.update'|'task.create'='task.update',options:{auto?:boolean;payload?:{notes?:string;scheduled_date?:string|null}}={}) {
  const settings=(await db.settings.get('main'))!,policy=changePolicyFor(settings),taskId=await createTask({...newTaskInput(),title:'本人が選んだ25pt',notes:'元のメモ',scheduledDate:'2026-10-01',dueDate:'2026-10-09',score:{...emptyScore(),mode:'manual',manualPoints:25}})
  const registration:FileBridgeRegistration={schema_version:'1',owner_id:settings.profileId,dataset_id:settings.datasetId,policy_epoch:policy.epoch,source_permission_revision:policy.sourcePermissionRevision,task_ids:[taskId],client:{id:crypto.randomUUID(),dataset_id:settings.datasetId,intended_host:'codex',transport:'stdio',status:'active',revision:1,grant_epoch:1,grant:{keys:['tasks:read','tasks:prepare','changes:submit','commands:read'],project_ids:[],fields:options.auto?['notes','scheduled_date']:['title','notes','scheduled_date'],mutation_mode:options.auto?'auto_within_bounds':'require_approval',max_operations_per_day:10,max_schedule_shift_days:7,max_point_delta:0,allow_external_context:false,allow_handoffs:false,expires_at:future(3600000),...(options.auto?{automation:{max_schedule_shift_days:2,max_operations_per_day:5}}:{})}}}
  const status:FileBridgeStatus={version:1,available:true,connected:true,root:'C:\\synthetic-agent-folder',registration,snapshot:{schema_version:'1',snapshot_id:crypto.randomUUID(),owner_id:registration.owner_id,dataset_id:registration.dataset_id,client_id:registration.client.id,policy_epoch:policy.epoch,source_permission_revision:policy.sourcePermissionRevision,registration_revision:1,grant_epoch:1,generated_at:new Date().toISOString(),expires_at:future(),view_path:'views/tasks.active.json',view_sha256:'a'.repeat(64),entity_revisions:{[taskId]:1},registration_sha256:await contentDigest(registration)},results:[],notice:'Synthetic trusted main gateway'}
  const command={schema_version:'1' as const,command_id:crypto.randomUUID(),snapshot_id:status.snapshot!.snapshot_id,expires_at:future(),type,target_id:type==='task.update'?taskId:null,expected_revision:type==='task.update'?1:null,payload:type==='task.update'?options.payload??{notes:'外部から提案されたメモ',scheduled_date:'2026-10-02'}:{title:'新規の外部提案25pt',notes:'25pt・期限と書かれていても属性を推測しない',scheduled_date:'2026-10-02'}}
  let digest=await contentDigest({command,owner_id:registration.owner_id,dataset_id:registration.dataset_id,client_id:registration.client.id,policy_epoch:policy.epoch,source_permission_revision:policy.sourcePermissionRevision,registration_revision:1,grant_epoch:1})
  const reference=crypto.randomUUID(),entry:Extract<FileBridgeInboxEntry,{state:'awaiting_approval'}>={state:'awaiting_approval',filename:`${command.command_id}.ready.json`,reference,prepared:{state:'awaiting_approval',command,digest,principal:{id:registration.client.id,kind:'external-agent'},ownerId:registration.owner_id,datasetId:registration.dataset_id,policyEpoch:policy.epoch,sourcePermissionRevision:policy.sourcePermissionRevision,snapshotId:command.snapshot_id,expectedRevision:command.expected_revision,expiresAt:command.expires_at}}
  const gateway:FileBridgeGateway={status:vi.fn(async()=>structuredClone(status)),configure:vi.fn(async()=>structuredClone(status)),disconnect:vi.fn(async()=>({...structuredClone(status),connected:false,root:null,registration:null,snapshot:null})),exportSnapshot:vi.fn(async()=>structuredClone(status)),scanInbox:vi.fn(async()=>({status:structuredClone(status),entries:[structuredClone(entry)]})),authorizeApplication:vi.fn(async(request:FileBridgeApplicationBinding):Promise<FileBridgeLease>=>({...request,version:1,leaseId:crypto.randomUUID(),clientId:registration.client.id,registrationRevision:1,grantEpoch:1,expiresAt:future(60000),automatic:false})),authorizeAutomaticApplication:vi.fn(async(request:FileBridgeApplicationBinding):Promise<FileBridgeLease>=>({...request,version:1,leaseId:crypto.randomUUID(),clientId:registration.client.id,registrationRevision:1,grantEpoch:1,expiresAt:future(60000),automatic:true})),recordApplied:vi.fn(async({receipt}:Parameters<FileBridgeGateway['recordApplied']>[0]):Promise<FileBridgeResult>=>{
    const stored=await readFileBridgeApplicationReceipt(receipt.commandId);if(!stored||JSON.stringify(stored)!==JSON.stringify(receipt))throw new Error('unpersisted receipt')
    return {schema_version:'1',command_id:receipt.commandId,digest:receipt.fileDigest,owner_id:receipt.ownerId,dataset_id:receipt.datasetId,client_id:receipt.clientId,state:'applied',receipt:{commandId:receipt.commandId,digest:receipt.fileDigest,taskIds:receipt.taskIds,appliedAt:receipt.appliedAt},finished_at:new Date().toISOString()}
  }),cancelApplication:vi.fn(async()=>{}),invalidate:vi.fn(async()=>{})}
  const controller=createFileBridgeController(gateway)
  async function rescan(){status.snapshot!.registration_sha256=await contentDigest(registration);digest=await contentDigest({command,owner_id:registration.owner_id,dataset_id:registration.dataset_id,client_id:registration.client.id,policy_epoch:registration.policy_epoch,source_permission_revision:registration.source_permission_revision,registration_revision:registration.client.revision,grant_epoch:registration.client.grant_epoch});entry.prepared.digest=digest;await controller.scanInbox()}
  await rescan()
  return {settings,registration,status,command,entry,reference,taskId,gateway,controller,rescan}
}

describe('registered external file commands require native owner approval',()=>{
  it('applies update atomically and preserves manual25, true deadline, assessment and ledger',async()=>{
    const f=await fixture(),prepared=await f.controller.prepare(f.reference)
    expect((await db.tasks.get(f.taskId))?.revision).toBe(1)
    const result=await f.controller.applyFromUI(prepared,click())
    expect(result.resultPending).toBe(false);expect(result.result?.state).toBe('applied')
    expect(await db.tasks.get(f.taskId)).toMatchObject({notes:'外部から提案されたメモ',scheduledDate:'2026-10-02',dueDate:'2026-10-09',score:{mode:'manual',manualPoints:25},effectivePoints:25,revision:2,status:'open'})
    expect(await db.assessments.count()).toBe(1);expect(await db.ledger.count()).toBe(0)
    expect(await readFileBridgeApplicationReceipt(f.command.command_id)).toEqual(result.receipt)
    expect((await db.audits.toArray()).filter(item=>item.operation==='filebridge.approved')).toHaveLength(1)
    expect((await f.controller.applyFromUI(prepared,click())).receipt).toEqual(result.receipt)
    expect((await db.tasks.get(f.taskId))?.revision).toBe(2)
  })
  it('a rescan cancels the dropped review so S21 lists no stale pending copy of an applied command (synthetic gateway, temp data)',async()=>{
    const f=await fixture(),first=await f.controller.prepare(f.reference)
    expect(pendingCommands().filter(item=>item.envelope.command_id===f.command.command_id)).toHaveLength(1)
    await f.rescan()
    expect(isPendingCommand(first.command)).toBe(false)
    const second=await f.controller.prepare(f.reference)
    expect((await f.controller.applyFromUI(second,click())).result?.state).toBe('applied')
    expect(pendingCommands().filter(item=>item.envelope.command_id===f.command.command_id)).toHaveLength(0)
    expect((await db.tasks.get(f.taskId))?.revision).toBe(2);expect(await readFileBridgeApplicationReceipt(f.command.command_id)).not.toBeNull()
  })
  it('creates through N02 with unknown score and deadline, without interpreting title or note points',async()=>{
    const f=await fixture('task.create'),prepared=await f.controller.prepare(f.reference)
    expect(prepared.assisted?.inputs[0]).toMatchObject({score:{mode:'unset',manualPoints:null},dueDate:null})
    const result=await f.controller.applyFromUI(prepared,click()),created=(await db.tasks.get(result.receipt.taskIds[0]))!
    expect(created).toMatchObject({title:'新規の外部提案25pt',effectivePoints:null,dueDate:null,status:'open',scheduledDate:'2026-10-02'})
    expect(await db.ledger.count()).toBe(0);expect((await db.audits.toArray()).some(item=>item.operation==='assist.approved')).toBe(true)
  })
  it('refuses JSON, synthetic clicks, cloned prepared content and authority restored from serialization',async()=>{
    const f=await fixture(),prepared=await f.controller.prepare(f.reference)
    for(const event of [new Event('click'),{isTrusted:true,type:'click'} as Event])await expect(f.controller.applyFromUI(prepared,event)).rejects.toMatchObject({code:'HUMAN_APPROVAL_REQUIRED'})
    await expect(f.controller.applyFromUI(structuredClone(prepared),click())).rejects.toMatchObject({code:'UNVERIFIED_COMMAND'})
    const other=createFileBridgeController(f.gateway)
    await expect(other.applyFromUI(prepared,click())).rejects.toMatchObject({code:'UNVERIFIED_COMMAND'})
    expect(f.gateway.authorizeApplication).not.toHaveBeenCalled();expect((await db.tasks.get(f.taskId))?.revision).toBe(1)
  })
  it('requires explicit protected-field approval even when automatic policy bounds allow the patch',async()=>{
    const f=await fixture(),settings=(await db.settings.get('main'))!
    await db.settings.put({...settings,changePolicy:{...changePolicyFor(settings),taskUpdate:'auto_within_bounds',locks:{notes:'locked_until_human_approval'}}})
    const prepared=await f.controller.prepare(f.reference)
    await expect(f.controller.applyFromUI(prepared,click())).rejects.toMatchObject({code:'PROTECTED_FIELD_APPROVAL_REQUIRED'})
    expect(f.gateway.authorizeApplication).not.toHaveBeenCalled()
    await expect(f.controller.applyFromUI(prepared,click(),['notes'])).resolves.toMatchObject({resultPending:false})
  })
  it.each(['ai','epoch','source','owner','dataset'] as const)('rejects %s changes before reservation or task effects',async(kind)=>{
    const f=await fixture(),prepared=await f.controller.prepare(f.reference),current=(await db.settings.get('main'))!
    const patch=kind==='ai'?{externalAI:{...current.externalAI!,enabled:false,epoch:current.externalAI!.epoch+1}}:kind==='epoch'?{changePolicy:{...changePolicyFor(current),epoch:1}}:kind==='source'?{changePolicy:{...changePolicyFor(current),sourcePermissionRevision:1}}:kind==='owner'?{profileId:crypto.randomUUID()}:{datasetId:crypto.randomUUID()}
    await db.settings.update('main',patch)
    await expect(f.controller.applyFromUI(prepared,click())).rejects.toMatchObject({code:kind==='owner'||kind==='dataset'?'OWNER_CHANGED':'AUTHORITY_CHANGED'})
    expect(f.gateway.authorizeApplication).not.toHaveBeenCalled();expect((await db.tasks.get(f.taskId))?.revision).toBe(1)
  })
  it('rechecks authority in the task transaction after main creates its durable reservation',async()=>{
    const f=await fixture(),prepared=await f.controller.prepare(f.reference),authorize=f.gateway.authorizeApplication
    f.gateway.authorizeApplication=vi.fn(async input=>{const lease=await authorize(input);await db.settings.update('main',{externalAI:{version:1,enabled:false,epoch:1,clients:[]}});return lease})
    await expect(f.controller.applyFromUI(prepared,click())).rejects.toMatchObject({code:'AUTHORITY_CHANGED'})
    expect(f.gateway.cancelApplication).toHaveBeenCalledOnce();expect(f.gateway.recordApplied).not.toHaveBeenCalled()
    expect((await db.tasks.get(f.taskId))?.revision).toBe(1);expect(await db.commands.get(fileBridgeReceiptKey(f.command.command_id))).toBeUndefined()
  })
  it('rolls back task and nested ChangeSet receipts when the outer file receipt cannot be saved',async()=>{
    const f=await fixture(),prepared=await f.controller.prepare(f.reference),add=db.commands.add.bind(db.commands)
    vi.spyOn(db.commands,'add').mockImplementation((item,...args)=>item.key===fileBridgeReceiptKey(f.command.command_id)?Dexie.Promise.reject(new Error('synthetic outer receipt failure')):add(item,...args))
    await expect(f.controller.applyFromUI(prepared,click())).rejects.toThrow('synthetic outer receipt failure')
    expect(await db.tasks.get(f.taskId)).toMatchObject({notes:'元のメモ',revision:1,score:{manualPoints:25}})
    expect((await db.commands.toArray()).filter(item=>item.key.startsWith('changeset:')||item.key.startsWith('filebridge:applied:'))).toHaveLength(0)
    expect((await db.audits.toArray()).filter(item=>item.operation==='changeset.update'||item.operation==='filebridge.approved')).toHaveLength(0)
    expect(f.gateway.cancelApplication).toHaveBeenCalledOnce();expect(f.gateway.recordApplied).not.toHaveBeenCalled()
  })
  it('rolls back N02 task and assessment when the file receipt fails',async()=>{
    const f=await fixture('task.create'),prepared=await f.controller.prepare(f.reference),add=db.commands.add.bind(db.commands)
    vi.spyOn(db.commands,'add').mockImplementation((item,...args)=>item.key===fileBridgeReceiptKey(f.command.command_id)?Dexie.Promise.reject(new Error('synthetic create receipt failure')):add(item,...args))
    await expect(f.controller.applyFromUI(prepared,click())).rejects.toThrow('synthetic create receipt failure')
    expect(await db.tasks.count()).toBe(1);expect(await db.assessments.count()).toBe(1)
    expect((await db.commands.toArray()).some(item=>item.key.startsWith('assist:'))).toBe(false)
    expect(f.gateway.cancelApplication).toHaveBeenCalledOnce()
  })
  it('returns a real saved receipt when result-file transport fails, and only retries notification',async()=>{
    const f=await fixture(),prepared=await f.controller.prepare(f.reference),record=f.gateway.recordApplied
    f.gateway.recordApplied=vi.fn(async()=>{throw new Error('synthetic result file unavailable')})
    const first=await f.controller.applyFromUI(prepared,click())
    expect(first.resultPending).toBe(true);expect(await readFileBridgeApplicationReceipt(f.command.command_id)).toEqual(first.receipt)
    f.gateway.recordApplied=record
    const retried=await f.controller.retryResultFromUI(prepared,click())
    expect(retried.resultPending).toBe(false);expect((await db.tasks.get(f.taskId))?.revision).toBe(2)
    expect(f.gateway.authorizeApplication).toHaveBeenCalledOnce();expect(f.gateway.cancelApplication).not.toHaveBeenCalled()
  })
  it('refuses a mismatched main lease and main refusal without applying',async()=>{
    const f=await fixture(),prepared=await f.controller.prepare(f.reference),authorize=f.gateway.authorizeApplication
    f.gateway.authorizeApplication=vi.fn(async input=>({...await authorize(input),applicationDigest:'f'.repeat(64)}))
    await expect(f.controller.applyFromUI(prepared,click())).rejects.toMatchObject({code:'LEASE_INVALID'})
    expect((await db.tasks.get(f.taskId))?.revision).toBe(1)
    f.gateway.authorizeApplication=vi.fn(async()=>{throw new Error('COMMAND_CHANGED')})
    await expect(f.controller.applyFromUI(prepared,click())).rejects.toThrow('COMMAND_CHANGED');expect(f.gateway.recordApplied).not.toHaveBeenCalled()
  })
  it('rejects stale tasks, unselected targets, revoked field scope and large schedule shifts',async()=>{
    const f=await fixture(),prepared=await f.controller.prepare(f.reference)
    await updateTask(f.taskId,1,{...newTaskInput(),title:'本人の変更',score:{...emptyScore(),mode:'manual',manualPoints:25}})
    await expect(f.controller.applyFromUI(prepared,click())).rejects.toMatchObject({code:'CONFLICT'})
    expect(f.gateway.cancelApplication).toHaveBeenCalledOnce()
    const bound=await fixture();bound.command.payload.scheduled_date='2026-10-20';await bound.rescan()
    await expect(bound.controller.prepare(bound.reference)).rejects.toMatchObject({code:'SCHEDULE_BOUND'})
    const scoped=await fixture();scoped.registration.client.grant.fields=['title'];await scoped.rescan()
    await expect(scoped.controller.prepare(scoped.reference)).rejects.toMatchObject({code:'SCOPE_DENIED'})
    const unknown=await fixture();unknown.command.target_id=crypto.randomUUID();await expect(unknown.rescan()).rejects.toMatchObject({code:'TASK_SCOPE'})
  })
  it('atomically enforces a daily DB quota and invalidates an old proposal on trusted scope revocation',async()=>{
    const f=await fixture('task.create');f.registration.client.grant.max_operations_per_day=1;await f.rescan();const prepared=await f.controller.prepare(f.reference)
    const fakeId=crypto.randomUUID(),fakeReceipt={version:1,commandId:fakeId,fileDigest:'b'.repeat(64),applicationDigest:'c'.repeat(64),ownerId:f.settings.profileId,datasetId:f.settings.datasetId,clientId:f.registration.client.id,policyEpoch:0,sourcePermissionRevision:0,registrationRevision:1,grantEpoch:1,taskIds:[f.taskId],appliedAt:new Date().toISOString()}
    await db.commands.add({key:fileBridgeReceiptKey(fakeId),hash:fakeReceipt.applicationDigest,resultId:JSON.stringify(fakeReceipt),at:fakeReceipt.appliedAt})
    await expect(f.controller.applyFromUI(prepared,click())).rejects.toMatchObject({code:'DAILY_BOUND'})
    expect(await db.tasks.count()).toBe(1);expect(f.gateway.cancelApplication).toHaveBeenCalledOnce()
    // K12: the denial is signed as a terminal result, so the same proposal cannot be retried.
    expect(f.gateway.cancelApplication).toHaveBeenCalledWith(expect.objectContaining({outcome:{state:'denied',code:'DAILY_BOUND'}}))
    await expect(f.controller.applyFromUI(prepared,click())).rejects.toMatchObject({code:'UNVERIFIED_COMMAND'})
    const g=await fixture('task.create'),next=await g.controller.prepare(g.reference)
    await db.commands.delete(fileBridgeScopeKey(g.settings.profileId,g.settings.datasetId))
    await expect(g.controller.applyFromUI(next,click())).rejects.toMatchObject({code:'AUTHORITY_CHANGED'})
  })
  it('does not export score, deadlines, ledger or unrelated tasks into the IPC snapshot input',async()=>{
    const f=await fixture();await f.controller.exportSnapshot(click())
    const request=vi.mocked(f.gateway.exportSnapshot).mock.calls[0][0]
    expect(request.tasks).toHaveLength(1);expect(Object.keys(request.tasks[0]).sort()).toEqual(['containerId','id','notes','revision','scheduledDate','title'].sort())
    expect(JSON.stringify(request)).not.toMatch(/manualPoints|dueDate|effectivePoints|assessmentId|ledger/)
    await expect(f.controller.configure({intendedHost:'codex',taskIds:[f.taskId],fields:['title'],lifetimeHours:1},new Event('click'))).rejects.toMatchObject({code:'HUMAN_APPROVAL_REQUIRED'})
  })
  it('invalidates live proposals after grant changes, rejects permission rollback and ignores tampered saved receipts',async()=>{
    const f=await fixture(),prepared=await f.controller.prepare(f.reference)
    f.registration.client.revision=2;f.registration.client.grant_epoch=2;f.status.snapshot!.registration_revision=2;f.status.snapshot!.grant_epoch=2;f.status.snapshot!.registration_sha256=await contentDigest(f.registration)
    await f.controller.refresh()
    await expect(f.controller.applyFromUI(prepared,click())).rejects.toMatchObject({code:'UNVERIFIED_COMMAND'})
    f.registration.client.revision=1;f.registration.client.grant_epoch=1;f.status.snapshot!.registration_revision=1;f.status.snapshot!.grant_epoch=1;f.status.snapshot!.registration_sha256=await contentDigest(f.registration)
    await expect(f.controller.refresh()).rejects.toMatchObject({code:'REGISTRATION_ROLLBACK'})
    expect((await db.tasks.get(f.taskId))?.revision).toBe(1)
    await db.commands.put({key:fileBridgeReceiptKey(f.command.command_id),hash:'a'.repeat(64),resultId:JSON.stringify({approved:true,commandId:f.command.command_id}),at:new Date().toISOString()})
    expect(await readFileBridgeApplicationReceipt(f.command.command_id)).toBeNull()
  })
  it('rejects self approval/protected JSON and stale or mismatched status values strictly',async()=>{
    const f=await fixture()
    for(const extra of [{approved:true},{actor:'human'},{ownerId:'other'},{policyEpoch:500}])expect(()=>assertFileBridgeCommand({...f.command,...extra})).toThrow()
    for(const field of ['dueDate','manualPoints','status','sql','ledger','permissions'])expect(()=>assertFileBridgeCommand({...f.command,payload:{notes:'memo',[field]:1}})).toThrow()
    expect(()=>assertFileBridgeInboxEntry({...f.entry,approved:true})).toThrow()
    expect(()=>assertFileBridgeStatus({...f.status,snapshot:{...f.status.snapshot,grant_epoch:2}})).toThrow()
    const bad=await fixture();bad.entry.prepared.digest='0'.repeat(64)
    await expect(bad.controller.scanInbox()).rejects.toMatchObject({code:'COMMAND_BINDING'})
    const expired=await fixture();const prepared=await expired.controller.prepare(expired.reference);vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(Date.now()+7200000))
    await expect(expired.controller.applyFromUI(prepared,click())).rejects.toMatchObject({code:'EXPIRED'})
  })
})
describe('N09 owner-delegated automatic application for file/MCP entries',()=>{
  async function enableA2(){
    const settings=(await db.settings.get('main'))!,policy=changePolicyFor(settings),owner={principal:{id:settings.profileId,kind:'human' as const},ownerId:settings.profileId,datasetId:settings.datasetId,allowedFields:['notes','scheduledDate'] as ('notes'|'scheduledDate')[],sourceRevisions:[]}
    const next={preset:'A2' as const,rules:presetRules('A2'),allowedHours:{},titleRule:'require_approval' as const,bounds:policy.bounds,locks:policy.locks}
    await setAutomationPolicyFromUI(owner,click(),next,(await previewAutomationPolicy(next)).token)
    return owner
  }
  it('applies an in-bounds entry without a click and matches the in-app (S06) automatic result',async()=>{
    const owner=await enableA2(),f=await fixture('task.update',{auto:true}),prepared=await f.controller.prepare(f.reference)
    const result=await f.controller.applyAutomatically(prepared)
    expect(result.result?.state).toBe('applied');expect(f.gateway.authorizeApplication).not.toHaveBeenCalled();expect(f.gateway.authorizeAutomaticApplication).toHaveBeenCalledOnce()
    const viaFile=(await db.tasks.get(f.taskId))!
    const inApp=await createTask({...newTaskInput(),title:'本人が選んだ25pt',notes:'元のメモ',scheduledDate:'2026-10-01',dueDate:'2026-10-09',score:{...emptyScore(),mode:'manual',manualPoints:25}})
    const coach={...owner,principal:{id:'app-coach',kind:'coach' as const,model:'model/A'}},s06=await prepareTaskChanges([{taskId:inApp,expectedRevision:1,patch:{notes:'外部から提案されたメモ',scheduledDate:'2026-10-02'}}],coach)
    await applyChangeSet(s06,null,coach,'s06-auto')
    const viaApp=(await db.tasks.get(inApp))!,pick=(task:typeof viaApp)=>({notes:task.notes,scheduledDate:task.scheduledDate,dueDate:task.dueDate,score:task.score,effectivePoints:task.effectivePoints,revision:task.revision,status:task.status})
    expect(pick(viaFile)).toEqual(pick(viaApp))
    const decisions=(await db.audits.toArray()).filter(audit=>audit.operation==='changeset.update').map(audit=>{const detail=JSON.parse(audit.detail);return {decision:detail.decision,operations:detail.operations,approvedBy:detail.approvedBy}})
    expect(decisions).toEqual([{decision:'auto',operations:['task.text','task.schedule'],approvedBy:null},{decision:'auto',operations:['task.text','task.schedule'],approvedBy:null}])
    expect(JSON.parse((await db.audits.toArray()).find(audit=>audit.operation==='filebridge.auto')!.detail)).toMatchObject({decision:'auto',entrance:'file',basis:'external_request',approvedBy:null})
  })
  it('the shared bus refuses file commands outside the controller lease, with a click or without one under an auto grant',async()=>{
    await enableA2()
    const f=await fixture('task.update',{auto:true}),prepared=await f.controller.prepare(f.reference),receipts=async()=>(await db.commands.toArray()).filter(row=>row.key.startsWith('filebridge:applied:')).length
    for(const event of [click(),null])expect(await submitCommand(prepared.command,{event,checkedProtectedFields:[],requestKey:`bypass-${event?'click':'auto'}`})).toMatchObject({state:'awaiting_approval',code:'LEASE_INVALID'})
    expect((await db.tasks.get(f.taskId))!).toMatchObject({notes:'元のメモ',revision:1});expect(await receipts()).toBe(0)
    expect(isPendingCommand(prepared.command)).toBe(true)
    expect((await f.controller.applyAutomatically(prepared)).result?.state).toBe('applied');expect(await receipts()).toBe(1)
    const g=await fixture(),manual=await g.controller.prepare(g.reference)
    expect(await submitCommand(manual.command,{event:click(),checkedProtectedFields:[],requestKey:'bypass-manual'})).toMatchObject({state:'awaiting_approval',code:'LEASE_INVALID'})
    expect((await g.controller.applyFromUI(manual,click())).result?.state).toBe('applied');expect(await receipts()).toBe(2)
  })
  it('keeps out-of-bound or non-delegated entries waiting for native approval',async()=>{
    await enableA2()
    const far=await fixture('task.update',{auto:true,payload:{scheduled_date:'2026-10-06'}}),farPrepared=await far.controller.prepare(far.reference)
    await expect(far.controller.applyAutomatically(farPrepared)).rejects.toMatchObject({code:'APPROVAL_REQUIRED'})
    expect(far.gateway.authorizeAutomaticApplication).not.toHaveBeenCalled();expect((await db.tasks.get(far.taskId))?.revision).toBe(1)
    const manual=await fixture('task.update'),manualPrepared=await manual.controller.prepare(manual.reference)
    await expect(manual.controller.applyAutomatically(manualPrepared)).rejects.toMatchObject({code:'AUTOMATION_NOT_GRANTED'})
    await manual.controller.applyFromUI(manualPrepared,click())
    expect((await db.tasks.get(manual.taskId))?.revision).toBe(2)
  })
  it('never auto-applies a notes change to notes whose source-derived lines were withheld from the export',async()=>{
    await enableA2()
    const f=await fixture('task.update',{auto:true}),legacy='本人が書き足した行\n[source-1 内容版1 span-1] 第三者の発言'
    await db.tasks.update(f.taskId,{notes:legacy})
    const prepared=await f.controller.prepare(f.reference)
    await expect(f.controller.applyAutomatically(prepared)).rejects.toMatchObject({code:'APPROVAL_REQUIRED',message:expect.stringContaining('伏せたメモ')})
    expect(f.gateway.authorizeAutomaticApplication).not.toHaveBeenCalled();expect((await db.tasks.get(f.taskId))?.notes).toBe(legacy)
  })
  it('emergency stop turns a queued inbox entry into AUTHORITY_CHANGED for both approval and automatic paths',async()=>{
    await enableA2()
    const f=await fixture('task.update',{auto:true}),prepared=await f.controller.prepare(f.reference)
    await reduceAuthority('all','button')
    await expect(f.controller.applyAutomatically(prepared)).rejects.toMatchObject({code:'AUTHORITY_CHANGED'})
    await expect(f.controller.applyFromUI(prepared,click())).rejects.toMatchObject({code:'AUTHORITY_CHANGED'})
    expect((await db.tasks.get(f.taskId))?.revision).toBe(1);expect(f.gateway.authorizeAutomaticApplication).not.toHaveBeenCalled()
  })
  it('shares the daily automatic count with in-app changes: after 10 coach auto moves the file entry waits for approval',async()=>{
    const owner=await enableA2(),coach={...owner,principal:{id:'app-coach',kind:'coach' as const,model:'model/A'}}
    for(let index=0;index<10;index++){const taskId=await createTask({...newTaskInput(),title:`in-app ${index}`,scheduledDate:'2026-10-01'}),prepared=await prepareTaskChanges([{taskId,expectedRevision:1,patch:{scheduledDate:'2026-10-02'}}],coach);await applyChangeSet(prepared,null,coach,`count-${index}`)}
    const f=await fixture('task.update',{auto:true,payload:{scheduled_date:'2026-10-02'}}),prepared=await f.controller.prepare(f.reference)
    await expect(f.controller.applyAutomatically(prepared)).rejects.toMatchObject({code:'APPROVAL_REQUIRED',message:expect.stringContaining('10件')})
    expect(f.gateway.authorizeAutomaticApplication).not.toHaveBeenCalled()
    await f.controller.applyFromUI(prepared,click())
    expect((await db.tasks.get(f.taskId))?.scheduledDate).toBe('2026-10-02')
  })
  it('policy fields written into a file envelope or payload are rejected and never raise the decision',async()=>{
    const f=await fixture('task.update',{auto:true})
    for(const extra of [{policy_level:'A3'},{mutation_mode:'auto_within_bounds'},{automation:{max_schedule_shift_days:31}},{decision:'auto'}])expect(()=>assertFileBridgeCommand({...f.command,...extra})).toThrow()
    for(const field of ['policy_level','mutation_mode','approved','operations'])expect(()=>assertFileBridgeCommand({...f.command,payload:{notes:'memo',[field]:'auto'}})).toThrow()
    expect(f.gateway.authorizeAutomaticApplication).not.toHaveBeenCalled();expect((await db.tasks.get(f.taskId))?.revision).toBe(1)
  })
})
