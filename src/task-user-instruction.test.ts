import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput } from './commands'
import { emptyScore } from './domain'
import { contentDigest } from './canonical'
import { taskChangeFields, type ChangeContext } from './change-set'
import { assertTaskInstruction, clearTaskInstructionAuthority, confirmTaskInstructionFromUI, revokeTaskInstruction, type TaskInstructionInput } from './task-user-instruction'

let owner:ChangeContext,input:TaskInstructionInput
function click(){const event=new Event('click');Object.defineProperty(event,'isTrusted',{value:true});return event}
beforeEach(async()=>{
  clearTaskInstructionAuthority();await db.delete();await db.open();const settings=await ensureSettings()
  owner={principal:{id:settings.profileId,kind:'human'},ownerId:settings.profileId,datasetId:settings.datasetId,allowedFields:[...taskChangeFields],sourceRevisions:[]}
  const taskId=await createTask({...newTaskInput(),title:'本人のタスク',score:{...emptyScore(),mode:'manual',manualPoints:25}})
  input={message:'この25ptを30ptへ',referenceDate:'2026-10-01',timezone:'Asia/Tokyo',changes:[{taskId,expectedRevision:1,patch:{manualPoints:30}}]}
})
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers()})
describe('native exact task instruction authority',()=>{
  it('captures immutable target/revision/score/value and stores only a digest of the statement',async()=>{
    const instruction=await confirmTaskInstructionFromUI(input,owner,click())
    expect(Object.isFrozen(instruction.changes[0].patch)).toBe(true)
    expect(instruction.changes[0]).toMatchObject({expectedRevision:1,patch:{manualPoints:30},scoreBefore:{mode:'manual',manualPoints:25}})
    expect(JSON.stringify(instruction)).not.toContain(input.message)
    expect(instruction.messageDigest).toBe(await contentDigest(input.message))
    const {digest:_,...payload}=instruction;expect(instruction.digest).toBe(await contentDigest(payload))
    const settings=(await db.settings.get('main'))!;expect(()=>assertTaskInstruction(instruction,input.changes,owner,settings)).not.toThrow()
    expect((await db.tasks.get(input.changes[0].taskId))?.score.manualPoints).toBe(25)
    expect(await db.assessments.count()).toBe(1)
  })
  it('requires an actual native owner event, rejecting JSON flags and agent self confirmation',async()=>{
    for(const event of [new Event('click'),{isTrusted:true,type:'click'} as Event])await expect(confirmTaskInstructionFromUI(input,owner,event)).rejects.toThrow('確認ボタン')
    const forged=Object.create(Event.prototype);Object.defineProperties(forged,{isTrusted:{value:true},type:{value:'click'}})
    await expect(confirmTaskInstructionFromUI(input,owner,forged)).rejects.toThrow('確認ボタン')
    await expect(confirmTaskInstructionFromUI(input,{...owner,principal:{id:'agent',kind:'coach'}},click())).rejects.toThrow('確認ボタン')
  })
  it('refuses a cloned/fabricated instruction and every substituted point/target/revision',async()=>{
    const instruction=await confirmTaskInstructionFromUI(input,owner,click()),settings=(await db.settings.get('main'))!
    for(const copy of [structuredClone(instruction),{...instruction,id:'fabricated'}])expect(()=>assertTaskInstruction(copy,input.changes,owner,settings)).toThrow('確認ボタン')
    for(const request of [{...input.changes[0],patch:{manualPoints:31}},{...input.changes[0],taskId:'other'},{...input.changes[0],expectedRevision:2}])expect(()=>assertTaskInstruction(instruction,[request],owner,settings)).toThrow('一致しません')
    expect(()=>assertTaskInstruction(instruction,input.changes,{...owner,ownerId:'other'},settings)).toThrow()
    expect(()=>assertTaskInstruction(instruction,input.changes,{...owner,datasetId:'other'},settings)).toThrow()
  })
  it('expires and revokes without saved metadata restoring its authority',async()=>{
    const instruction=await confirmTaskInstructionFromUI(input,owner,click()),settings=(await db.settings.get('main'))!
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.parse(instruction.expiresAt))
    expect(()=>assertTaskInstruction(instruction,input.changes,owner,settings)).toThrow()
    vi.useRealTimers();revokeTaskInstruction(instruction);expect(()=>assertTaskInstruction(instruction,input.changes,owner,settings)).toThrow()
    const fresh=await confirmTaskInstructionFromUI(input,owner,click());clearTaskInstructionAuthority();expect(()=>assertTaskInstruction(fresh,input.changes,owner,settings)).toThrow()
  })
  it('invalidates after policy/source permission changes and rejects stale target or field scope',async()=>{
    const instruction=await confirmTaskInstructionFromUI(input,owner,click()),settings=(await db.settings.get('main'))!
    expect(()=>assertTaskInstruction(instruction,input.changes,owner,{...settings,changePolicy:{epoch:1,sourcePermissionRevision:0,aiChangesEnabled:true,taskUpdate:'require_approval',bounds:{maxTasks:20,maxScheduledDayShift:3,maxNotesCharacters:1000},locks:{}}})).toThrow()
    await expect(confirmTaskInstructionFromUI(input,{...owner,allowedFields:['notes']},click())).rejects.toThrow('許可')
    await db.tasks.update(input.changes[0].taskId,{revision:2})
    await expect(confirmTaskInstructionFromUI(input,owner,click())).rejects.toThrow('版')
  })
  it('rejects impossible dates, unknown timezone, noninteger points and material approval properties',async()=>{
    for(const patch of [{manualPoints:-1},{manualPoints:1.5},{manualPoints:100001},{dueDate:'2026-02-30'},{status:'completed'},{manualPoints:30,approved:true}])await expect(confirmTaskInstructionFromUI({...input,changes:[{...input.changes[0],patch:patch as typeof input.changes[0]['patch']}]},owner,click())).rejects.toThrow()
    await expect(confirmTaskInstructionFromUI({...input,timezone:'Not/AZone'},owner,click())).rejects.toThrow('タイムゾーン')
    await expect(confirmTaskInstructionFromUI({...input,referenceDate:'2026-02-30'},owner,click())).rejects.toThrow('基準日')
    await expect(confirmTaskInstructionFromUI({...input,approved:true} as TaskInstructionInput,owner,click())).rejects.toThrow()
  })
})
