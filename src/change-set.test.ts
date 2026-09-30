import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput, updateTask } from './commands'
import { emptyScore, type Settings } from './domain'
import { contentDigest } from './canonical'
import { applyChangeSet, approveChangeSetFromUI, cancelChangeSet, changePolicyFor, clearChangeSetAuthority, decideChangePolicy, defaultChangePolicy, prepareTaskChanges, setChangePolicyFromUI, type ChangeContext, type ChangePolicy, type PreparedChangeSet, type TaskChangeRequest, type UIChangeApproval } from './change-set'

let owner:ChangeContext,coach:ChangeContext,taskId:string
beforeEach(async()=>{
  await db.delete();await db.open()
  const settings=await ensureSettings()
  await db.settings.update('main',{aiEnabled:true})
  const shared={ownerId:settings.profileId,datasetId:settings.datasetId,allowedFields:['notes','scheduledDate'] as ChangeContext['allowedFields'],sourceRevisions:[]}
  owner={...shared,principal:{id:settings.profileId,kind:'human'}}
  coach={...shared,principal:{id:'local-coach',kind:'coach',model:'model/A'}}
  taskId=await createTask({...newTaskInput(),title:'手動作成',notes:'元のメモ',scheduledDate:'2026-10-01',score:{...emptyScore(),mode:'manual',manualPoints:25}})
})
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers()})
// Node's Event permits this test fixture. Browser Event.isTrusted is readonly;
// production approves only real user events, never this helper or JSON flags.
function humanClick() {const event=new Event('click');Object.defineProperty(event,'isTrusted',{value:true});return event}
const prepare=(patch:TaskChangeRequest['patch']={notes:'確認済みの新しいメモ'})=>prepareTaskChanges([{taskId,expectedRevision:1,patch}],coach)
const approve=(prepared:PreparedChangeSet)=>approveChangeSetFromUI(prepared,owner,humanClick())
async function setPolicy(patch:Partial<ChangePolicy>) {
  const settings=(await db.settings.get('main'))!,next={...changePolicyFor(settings),...patch}
  await db.settings.put({...settings,changePolicy:next} as Settings&{changePolicy:ChangePolicy})
}

describe('common ChangeSet approval and local application',()=>{
  it('prepares immutable before/after without writing and preserves manual25 on application',async()=>{
    const prepared=await prepare({notes:'予定を調整',scheduledDate:'2026-10-03'})
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(Object.isFrozen(prepared.changes[0].after)).toBe(true)
    expect((await db.tasks.get(taskId))?.notes).toBe('元のメモ')
    const grant=await approve(prepared)
    const result=await applyChangeSet(prepared,grant,coach,'first')
    expect(result.taskIds).toEqual([taskId])
    expect(await db.tasks.get(taskId)).toMatchObject({notes:'予定を調整',scheduledDate:'2026-10-03',revision:2,score:{mode:'manual',manualPoints:25},effectivePoints:25,status:'open'})
    expect(await db.assessments.count()).toBe(1)
    expect(await db.ledger.count()).toBe(0)
    const entry=(await db.audits.toArray()).find(item=>item.operation==='changeset.update')!
    expect(JSON.parse(entry.detail)).toMatchObject({principal:{kind:'coach',model:'model/A'},approvedBy:owner.ownerId,policyEpoch:0,undo:{expectedRevision:2,patch:{notes:'元のメモ',scheduledDate:'2026-10-01'}}})
  })

  it('rejects approved=true, material permission claims and all unsupported protected mutations',async()=>{
    for(const patch of [{manualPoints:30},{dueDate:'2026-10-09'},{status:'completed'},{score:{mode:'formula'}},{approved:true},{policyEpoch:100},{notes:'更新',ownerId:'other'}]) {
      await expect(prepare(patch as TaskChangeRequest['patch'])).rejects.toMatchObject({code:'UNSUPPORTED_FIELD'})
    }
    await expect(prepareTaskChanges([{taskId,expectedRevision:1,patch:{notes:'更新'},approved:true} as TaskChangeRequest],coach)).rejects.toMatchObject({code:'INVALID_INPUT'})
    expect((await db.tasks.get(taskId))?.effectivePoints).toBe(25)
  })

  it('requires a trusted native human UI event and rejects agent self approval',async()=>{
    const prepared=await prepare()
    await expect(approveChangeSetFromUI(prepared,owner,new Event('click'))).rejects.toMatchObject({code:'HUMAN_APPROVAL_REQUIRED'})
    await expect(approveChangeSetFromUI(prepared,owner,{isTrusted:true,type:'click'} as Event)).rejects.toMatchObject({code:'HUMAN_APPROVAL_REQUIRED'})
    await expect(approveChangeSetFromUI(prepared,coach,humanClick())).rejects.toMatchObject({code:'HUMAN_APPROVAL_REQUIRED'})
    const forgedEvent=Object.create(Event.prototype);Object.defineProperties(forgedEvent,{isTrusted:{value:true},type:{value:'click'}})
    await expect(approveChangeSetFromUI(prepared,owner,forgedEvent)).rejects.toMatchObject({code:'HUMAN_APPROVAL_REQUIRED'})
    await expect(applyChangeSet(prepared,null,coach,'no-approval')).rejects.toMatchObject({code:'HUMAN_APPROVAL_REQUIRED'})
    const grant=await approve(prepared)
    await expect(applyChangeSet(prepared,structuredClone(grant) as UIChangeApproval,coach,'forged-grant')).rejects.toMatchObject({code:'INVALID_APPROVAL'})
  })

  it('rejects substituted content and self-computed digests even with a valid approval',async()=>{
    const prepared=await prepare(),grant=await approve(prepared)
    const replaced=structuredClone(prepared)
    replaced.changes[0].after.notes='別の変更内容'
    await expect(applyChangeSet(replaced,grant,coach,'changed')).rejects.toMatchObject({code:'DIGEST_MISMATCH'})
    const {digest:_,...payload}=replaced
    replaced.digest=await contentDigest(payload)
    await expect(applyChangeSet(replaced,grant,coach,'changed-digest')).rejects.toMatchObject({code:'DIGEST_MISMATCH'})
    const fabricated={...prepared,id:crypto.randomUUID()}
    await expect(applyChangeSet(fabricated,grant,coach,'fabricated')).rejects.toMatchObject({code:'UNVERIFIED_CHANGE_SET'})
    expect((await db.tasks.get(taskId))?.revision).toBe(1)
  })

  it('invalidates queued approvals when AI stops, policy epoch changes or source permission changes',async()=>{
    const prepared=await prepare(),grant=await approve(prepared)
    await db.settings.update('main',{aiEnabled:false})
    await expect(applyChangeSet(prepared,grant,coach,'ai-off')).rejects.toMatchObject({code:'POLICY_CHANGED'})
    await db.settings.update('main',{aiEnabled:true})
    await setPolicy({epoch:1,aiChangesEnabled:false})
    await expect(applyChangeSet(prepared,grant,coach,'policy-off')).rejects.toMatchObject({code:'POLICY_CHANGED'})
    await setPolicy({epoch:2,aiChangesEnabled:true})
    await expect(applyChangeSet(prepared,grant,coach,'resumed')).rejects.toMatchObject({code:'POLICY_CHANGED'})
    const newer=await prepare(),newGrant=await approve(newer)
    await setPolicy({sourcePermissionRevision:1})
    await expect(applyChangeSet(newer,newGrant,coach,'source-revoked')).rejects.toMatchObject({code:'SOURCE_PERMISSION_CHANGED'})
    expect((await db.tasks.get(taskId))?.revision).toBe(1)
  })

  it('binds source revisions, owner, dataset, principal and field scope without reading another owner',async()=>{
    const withSource={...coach,sourceRevisions:[{id:'selected-source',revision:2}]}
    const prepared=await prepareTaskChanges([{taskId,expectedRevision:1,patch:{notes:'引用の訂正'}}],withSource)
    const grant=await approveChangeSetFromUI(prepared,{...owner,sourceRevisions:withSource.sourceRevisions},humanClick())
    await expect(applyChangeSet(prepared,grant,{...withSource,sourceRevisions:[{id:'selected-source',revision:3}]},'source-changed')).rejects.toMatchObject({code:'SOURCE_PERMISSION_CHANGED'})
    await expect(prepareTaskChanges([{taskId,expectedRevision:1,patch:{notes:'越境'}}],{...coach,ownerId:'other'})).rejects.toMatchObject({code:'UNAUTHORIZED'})
    await expect(applyChangeSet(prepared,grant,{...withSource,datasetId:'other'},'wrong-dataset')).rejects.toMatchObject({code:'UNAUTHORIZED'})
    await expect(applyChangeSet(prepared,grant,{...withSource,principal:{id:'agent-B',kind:'external-agent'}},'wrong-actor')).rejects.toMatchObject({code:'UNAUTHORIZED'})
    await expect(applyChangeSet(prepared,grant,{...withSource,allowedFields:['scheduledDate']},'scope-revoked')).rejects.toMatchObject({code:'UNAUTHORIZED'})
  })

  it('rejects stale targets atomically across a batch',async()=>{
    const second=await createTask({...newTaskInput(),title:'二件目'})
    const prepared=await prepareTaskChanges([{taskId,expectedRevision:1,patch:{notes:'一件目'}},{taskId:second,expectedRevision:1,patch:{notes:'二件目'}}],coach),grant=await approve(prepared)
    await updateTask(second,1,{...newTaskInput(),title:'二件目を別の画面で編集'})
    await expect(applyChangeSet(prepared,grant,coach,'stale-batch')).rejects.toMatchObject({code:'CONFLICT'})
    expect((await db.tasks.get(taskId))?.notes).toBe('元のメモ')
    expect((await db.tasks.get(second))?.notes).toBe('')
    expect((await db.commands.toArray()).filter(item=>item.key.startsWith('changeset:'))).toHaveLength(0)
  })

  it('rolls back task updates when audit or receipt persistence fails',async()=>{
    const prepared=await prepare(),grant=await approve(prepared)
    vi.spyOn(db.audits,'add').mockRejectedValueOnce(new Error('synthetic disk failure'))
    await expect(applyChangeSet(prepared,grant,coach,'rollback')).rejects.toThrow('synthetic disk failure')
    expect((await db.tasks.get(taskId))?.notes).toBe('元のメモ')
    expect((await db.tasks.get(taskId))?.revision).toBe(1)
    expect((await db.commands.toArray()).filter(item=>item.key.startsWith('changeset:'))).toHaveLength(0)
    vi.restoreAllMocks()
    await expect(applyChangeSet(prepared,grant,coach,'rollback')).resolves.toMatchObject({taskIds:[taskId]})
  })

  it('returns the same receipt for both request retries and a different key without applying twice',async()=>{
    const prepared=await prepare(),grant=await approve(prepared)
    const first=await applyChangeSet(prepared,grant,coach,'retry-key')
    expect(await applyChangeSet(prepared,grant,coach,'retry-key')).toEqual(first)
    expect(await applyChangeSet(prepared,grant,coach,'another-key')).toEqual(first)
    expect((await db.tasks.get(taskId))?.revision).toBe(2)
    expect((await db.audits.toArray()).filter(item=>item.operation==='changeset.update')).toHaveLength(1)
    const next=await prepareTaskChanges([{taskId,expectedRevision:2,patch:{notes:'別案'}}],coach),nextGrant=await approve(next)
    await expect(applyChangeSet(next,nextGrant,coach,'retry-key')).rejects.toMatchObject({code:'IDEMPOTENCY_MISMATCH'})
    await expect(applyChangeSet(prepared,grant,{...coach,allowedFields:[]},'retry-key')).rejects.toMatchObject({code:'UNAUTHORIZED'})
  })

  it('keeps digest verification alive in an outer transaction and commits task plus both receipts',async()=>{
    const prepared=await prepare(),grant=await approve(prepared)
    const receipt=await db.transaction('rw',db.tasks,db.settings,db.commands,db.audits,async()=>{
      const applied=await applyChangeSet(prepared,grant,coach,'outer-success')
      await db.commands.add({key:'outer:success',hash:applied.digest,resultId:JSON.stringify(applied),at:applied.appliedAt})
      return applied
    })
    expect(await db.tasks.get(taskId)).toMatchObject({notes:'確認済みの新しいメモ',revision:2,score:{mode:'manual',manualPoints:25}})
    expect(JSON.parse((await db.commands.get('outer:success'))!.resultId)).toEqual(receipt)
    expect((await db.commands.toArray()).filter(item=>item.key.startsWith('changeset:'))).toHaveLength(2)
    expect(await applyChangeSet(prepared,grant,coach,'outer-success')).toEqual(receipt)
    expect((await db.tasks.get(taskId))?.revision).toBe(2)
  })

  it('rolls back task, audit and nested receipts when the enclosing transaction fails',async()=>{
    const prepared=await prepare(),grant=await approve(prepared)
    await expect(db.transaction('rw',db.tasks,db.settings,db.commands,db.audits,async()=>{
      const applied=await applyChangeSet(prepared,grant,coach,'outer-failure')
      await db.commands.add({key:'outer:failure',hash:applied.digest,resultId:JSON.stringify(applied),at:applied.appliedAt})
      throw new Error('synthetic enclosing transaction failure')
    })).rejects.toThrow('synthetic enclosing transaction failure')
    expect(await db.tasks.get(taskId)).toMatchObject({notes:'元のメモ',revision:1,score:{mode:'manual',manualPoints:25}})
    expect(await db.commands.get('outer:failure')).toBeUndefined()
    expect((await db.commands.toArray()).filter(item=>item.key.startsWith('changeset:'))).toHaveLength(0)
    expect((await db.audits.toArray()).filter(item=>item.operation==='changeset.update')).toHaveLength(0)
    const retryGrant=await approve(prepared)
    await expect(applyChangeSet(prepared,retryGrant,coach,'outer-failure')).resolves.toMatchObject({taskIds:[taskId]})
    expect((await db.tasks.get(taskId))?.revision).toBe(2)
  })

  it('limits automatic edits to explicit bounds and requires approval outside them',async()=>{
    await setPolicy({taskUpdate:'auto_within_bounds',bounds:{maxTasks:1,maxScheduledDayShift:3,maxNotesCharacters:3}})
    const within=await prepare({scheduledDate:'2026-10-03'})
    expect(decideChangePolicy(within,changePolicyFor((await db.settings.get('main'))!)).status).toBe('auto')
    await applyChangeSet(within,null,coach,'within')
    const beyond=await prepareTaskChanges([{taskId,expectedRevision:2,patch:{scheduledDate:'2026-10-20'}}],coach)
    expect(decideChangePolicy(beyond,changePolicyFor((await db.settings.get('main'))!)).status).toBe('awaiting_approval')
    await expect(applyChangeSet(beyond,null,coach,'beyond')).rejects.toMatchObject({code:'HUMAN_APPROVAL_REQUIRED'})
    await applyChangeSet(beyond,await approve(beyond),coach,'beyond-confirmed')
    expect((await db.tasks.get(taskId))?.scheduledDate).toBe('2026-10-20')
  })

  it('requires explicit one-time confirmation of field locks even under automatic policy',async()=>{
    await setPolicy({taskUpdate:'auto_within_bounds',locks:{notes:'locked_until_human_approval'}})
    const prepared=await prepare()
    await expect(approve(prepared)).rejects.toMatchObject({code:'PROTECTED_FIELD_APPROVAL_REQUIRED'})
    const grant=await approveChangeSetFromUI(prepared,owner,humanClick(),['notes'])
    await applyChangeSet(prepared,grant,coach,'locked-confirmed')
    expect((await db.tasks.get(taskId))?.notes).toBe('確認済みの新しいメモ')
  })

  it('allows creator-independent human→coach A→coach B→human editing',async()=>{
    const a=await prepare(),grantA=await approve(a)
    await applyChangeSet(a,grantA,coach,'coach-A')
    const coachB={...coach,principal:{id:'coach-B',kind:'external-agent' as const,model:'model/B'}}
    const b=await prepareTaskChanges([{taskId,expectedRevision:2,patch:{notes:'モデルBによる修正'}}],coachB)
    await applyChangeSet(b,await approve(b),coachB,'coach-B')
    const human=await prepareTaskChanges([{taskId,expectedRevision:3,patch:{notes:'本人による修正'}}],owner)
    await applyChangeSet(human,await approve(human),owner,'human-edit')
    expect((await db.tasks.get(taskId))?.notes).toBe('本人による修正')
    expect((await db.tasks.get(taskId))?.score.manualPoints).toBe(25)
    await expect(prepareTaskChanges([{taskId,expectedRevision:1,patch:{notes:'古い版'}}],coach)).rejects.toMatchObject({code:'CONFLICT'})
  })

  it('allows only trusted owner UI policy changes and increments the epoch',async()=>{
    const prepared=await prepare(),grant=await approve(prepared)
    const {epoch:_,...next}=defaultChangePolicy()
    await expect(setChangePolicyFromUI(coach,humanClick(),{...next,taskUpdate:'auto_within_bounds'})).rejects.toMatchObject({code:'HUMAN_APPROVAL_REQUIRED'})
    await expect(setChangePolicyFromUI(owner,new Event('click'),next)).rejects.toMatchObject({code:'HUMAN_APPROVAL_REQUIRED'})
    const updated=await setChangePolicyFromUI(owner,humanClick(),{...next,aiChangesEnabled:false})
    expect(updated.epoch).toBe(1)
    await expect(applyChangeSet(prepared,grant,coach,'after-stop')).rejects.toMatchObject({code:'POLICY_CHANGED'})
    await expect(prepare()).rejects.toMatchObject({code:'CHANGES_STOPPED'})
    const manual=await prepareTaskChanges([{taskId,expectedRevision:1,patch:{notes:'AI停止中の本人編集'}}],owner)
    await applyChangeSet(manual,await approve(manual),owner,'manual-still-works')
  })

  it('expires a grant without applying any change',async()=>{
    const prepared=await prepare(),grant=await approve(prepared)
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(Date.parse(prepared.expiresAt)+1))
    await expect(applyChangeSet(prepared,grant,coach,'expired')).rejects.toMatchObject({code:'EXPIRED'})
    expect((await db.tasks.get(taskId))?.revision).toBe(1)
  })

  it('captures requests before async reads so a later mutation cannot add protected fields',async()=>{
    const request:TaskChangeRequest={taskId,expectedRevision:1,patch:{notes:'正しい変更'}}
    const preparing=prepareTaskChanges([request],coach)
    Object.assign(request.patch,{dueDate:'2026-10-10',notes:'差替え'})
    const prepared=await preparing
    expect(prepared.changes[0].after).toEqual({notes:'正しい変更',scheduledDate:'2026-10-01'})
    await applyChangeSet(prepared,await approve(prepared),coach,'captured')
    expect((await db.tasks.get(taskId))?.dueDate).toBeNull()
  })

  it('invalidates volatile approvals after restore or logout instead of trusting a saved approval',async()=>{
    const prepared=await prepare(),grant=await approve(prepared)
    clearChangeSetAuthority()
    await expect(applyChangeSet(prepared,grant,coach,'after-restore')).rejects.toMatchObject({code:'UNVERIFIED_CHANGE_SET'})
    expect((await db.tasks.get(taskId))?.revision).toBe(1)
  })

  it('revokes a cancelled proposal instead of leaving its previous approval executable',async()=>{
    const prepared=await prepare(),grant=await approve(prepared)
    await expect(cancelChangeSet(prepared,{...owner,ownerId:'other'})).rejects.toMatchObject({code:'UNAUTHORIZED'})
    await cancelChangeSet(prepared,owner)
    await expect(applyChangeSet(prepared,grant,coach,'cancelled')).rejects.toMatchObject({code:'UNVERIFIED_CHANGE_SET'})
    expect((await db.tasks.get(taskId))?.revision).toBe(1)
  })
})
