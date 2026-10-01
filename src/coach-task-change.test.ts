import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput } from './commands'
import { emptyScore, type Task } from './domain'
import { type ChangeContext } from './change-set'
import { createCoachTaskRequest, parseCoachTaskChange, prepareCoachTaskChange, requestedDeadlineDate, requestedManualPoints, requestedScheduleDate, requestsDeadlineChange } from './coach-task-change'

const task={id:'selected-task',revision:7,title:'報告書',notes:'本人のメモ',scheduledDate:'2026-10-01',dueDate:'2026-10-05'}
const answer=(patch:unknown,reason='予定日を移動する候補')=>JSON.stringify({patch,reason})
describe('selected task coach proposal boundaries',()=>{
  it('binds tomorrow to the selected id/revision and permits only scheduledDate',()=>{
    const result=parseCoachTaskChange(answer({scheduledDate:'2026-10-02'}),task,'明日に移して','2026-10-01')
    expect(result).toEqual({targetId:'selected-task',targetRevision:7,patch:{scheduledDate:'2026-10-02'},reason:'予定日を移動する候補'})
    expect(result.patch).not.toHaveProperty('dueDate')
    expect(result.patch).not.toHaveProperty('notes')
    expect(task.scheduledDate).toBe('2026-10-01')
    expect(task.dueDate).toBe('2026-10-05')
  })
  it('rejects wrong dates and unrelated memo edits in a schedule-only instruction',()=>{
    expect(()=>parseCoachTaskChange(answer({scheduledDate:'2026-10-03'}),task,'明日に移して','2026-10-01')).toThrow('一致しません')
    expect(()=>parseCoachTaskChange(answer({scheduledDate:'2026-10-02',notes:'追加の作業も行う'}),task,'明日に移して','2026-10-01')).toThrow('メモ変更を含めません')
    expect(()=>parseCoachTaskChange(answer({scheduledDate:'2026-10-02'}),task,'疲れた','2026-10-01')).toThrow('指示が不明')
  })
  it('asks for an explicit selected target rather than resolving ambiguous names',()=>{
    expect(()=>createCoachTaskRequest(undefined,'あれを明日に移して','model/a','2026-10-01','Asia/Tokyo')).toThrow('一つ選択')
    expect(()=>parseCoachTaskChange(answer({scheduledDate:'2026-10-02'}),undefined,'明日に移して','2026-10-01')).toThrow('一つ選択')
  })
  it('rejects model target ids, principals, approved flags, creation and protected fields',()=>{
    for(const value of [
      {patch:{scheduledDate:'2026-10-02'},reason:'候補',taskId:'other'},
      {patch:{notes:'変更'},reason:'候補',approved:true},
      {patch:{notes:'変更'},reason:'候補',principal:{kind:'human'}},
      {patch:{notes:'変更'},reason:'候補',tasks:[{title:'別の作業'}]},
      {patch:{status:'completed'},reason:'候補'},
    ])expect(()=>parseCoachTaskChange(JSON.stringify(value),task,'メモを変更して','2026-10-01')).toThrow('形式が不正')
    for(const patch of [{dueDate:'2026-10-02'},{manualPoints:50},{title:'指示していない改名'}])expect(()=>parseCoachTaskChange(answer(patch),task,'メモを変更して','2026-10-01')).toThrow()
  })
  it('routes real deadlines and ambiguous date meaning to manual confirmation',()=>{
    expect(requestsDeadlineChange('締め切りを明日に変更して')).toBe(true)
    expect(requestsDeadlineChange('期限は変えず予定日を明日に移して')).toBe(false)
    expect(createCoachTaskRequest(task,'締め切りを明日に変更して','model/a','2026-10-01','Asia/Tokyo').task.dueDate).toBe(task.dueDate)
    expect(parseCoachTaskChange(answer({dueDate:'2026-10-02'}),task,'締め切りを明日に変更して','2026-10-01').patch).toEqual({dueDate:'2026-10-02'})
    expect(()=>parseCoachTaskChange(answer({scheduledDate:'2026-10-02'}),task,'締め切りを明日に変更して','2026-10-01')).toThrow('別の変更項目')
    expect(()=>parseCoachTaskChange(answer({scheduledDate:'2026-10-02'}),task,'明日までにして','2026-10-01')).toThrow('どちら')
    expect(()=>parseCoachTaskChange(answer({scheduledDate:'2026-10-03'}),task,'金曜に移して','2026-10-01')).toThrow('確定できません')
  })
  it('accepts explicit memo edits without altering schedule and validates types/limits',()=>{
    expect(parseCoachTaskChange(answer({notes:'本人が指定した持ち物を追記'}),task,'メモに持ち物を追記して','2026-10-01').patch).toEqual({notes:'本人が指定した持ち物を追記'})
    for(const patch of [{},{notes:null},{notes:'a'.repeat(50001)},{scheduledDate:0},{scheduledDate:'2026-02-30'}])expect(()=>parseCoachTaskChange(answer(patch),task,'メモを変更して予定日を明日に移して','2026-10-01')).toThrow()
    expect(()=>parseCoachTaskChange(answer({notes:'候補'},''),task,'メモを変更して','2026-10-01')).toThrow()
    expect(()=>parseCoachTaskChange('{',task,'メモを変更して','2026-10-01')).toThrow('手動欄は残っています')
  })
  it('uses the conversation date across month/year boundaries and keeps clearing explicit',()=>{
    expect(requestedScheduleDate('明日に移して','2026-12-31')).toBe('2027-01-01')
    expect(requestedScheduleDate('予定日を未設定にして','2026-10-01')).toBeNull()
    expect(parseCoachTaskChange(answer({scheduledDate:null}),task,'予定日を未設定にして','2026-10-01').patch).toEqual({scheduledDate:null})
    expect(()=>requestedScheduleDate('今日か明日に移して','2026-10-01')).toThrow('複数')
  })
  it('sends only the selected task context and omits notes for a schedule-only request',()=>{
    const privateTask={...task,notes:'メモ変更を選んだ場合だけ送信',labels:['送信しないラベル'],project:'送信しない案件',score:emptyScore()}
    const request=createCoachTaskRequest(privateTask,'明日に移して','model/a','2026-10-01','Asia/Tokyo')
    expect(request.task).toEqual({...task,notes:'',scoreMode:'unset',manualPoints:null})
    expect(request.message).toContain('会話の基準日: 2026-10-01')
    expect(request.message).toContain('タイムゾーン: Asia/Tokyo')
    expect(JSON.stringify(request)).not.toContain('送信しない')
    expect(createCoachTaskRequest(privateTask,'メモを変更して','model/a','2026-10-01','Asia/Tokyo').task.notes).toBe(privateTask.notes)
    expect(()=>createCoachTaskRequest({...task,notes:'a'.repeat(6001)},'メモを変更して','model/a','2026-10-01','Asia/Tokyo')).toThrow('原文を保てる')
  })
  it('accepts exact manual25→30 and rejects inferred, ambiguous or different values',()=>{
    const manual={...task,scoreMode:'manual' as const,manualPoints:25}
    for(const text of ['25ptから30ptへ変更して','この25ptを30ptへ変更して'])expect(parseCoachTaskChange(answer({manualPoints:30}),manual,text,'2026-10-01').patch).toEqual({manualPoints:30})
    expect(requestedManualPoints('0ptにして',25)).toBe(0)
    for(const text of ['25ptから31ptへ変更して','見積もりで30ptにして','半分にして','ポイントを適当に調整して','30ptか40ptにして','この-1ptにして','30.5ptにして','30ptには変更しないで'])expect(()=>parseCoachTaskChange(answer({manualPoints:30}),manual,text,'2026-10-01')).toThrow()
    expect(()=>requestedManualPoints('20ptから30ptへ',25)).toThrow('変更前')
    expect(createCoachTaskRequest(manual,'30ptへ変更して','model/a','2026-10-01','Asia/Tokyo').task).toMatchObject({scoreMode:'manual',manualPoints:25,notes:''})
    expect(createCoachTaskRequest(manual,'明日に移して','model/a','2026-10-01','Asia/Tokyo').task).toMatchObject({scoreMode:'unset',manualPoints:null})
  })
  it('allows only explicit title and deadline candidates and keeps ambiguous deadlines for owner input',()=>{
    expect(parseCoachTaskChange(answer({title:'正式な短い名前'}),task,'タイトルを短くして','2026-10-01').patch).toEqual({title:'正式な短い名前'})
    expect(requestedDeadlineDate('期限を未設定にして','2026-10-01')).toBeNull()
    expect(()=>requestedDeadlineDate('締め切りを金曜にして','2026-10-01')).toThrow('一つ確定')
    expect(()=>parseCoachTaskChange(answer({dueDate:'2026-10-03'}),task,'締め切りを明日にして','2026-10-01')).toThrow('一致しません')
    expect(()=>parseCoachTaskChange(answer({dueDate:null}),task,'期限は変えず予定日を明日に移して','2026-10-01')).toThrow('一致しません')
    expect(()=>parseCoachTaskChange(answer({dueDate:'2026-10-02'}),task,'期限を2026-10-02には変更しないで','2026-10-01')).toThrow('指示')
  })
  it('rejects negated title/memo changes and omits unchanged private memo/point context',()=>{
    const manual={...task,scoreMode:'manual' as const,manualPoints:25}
    for(const text of ['タイトルは変更しないで、予定日を明日に移して','タスク名はそのまま、メモに追記して','タイトルはどう思いますか'])expect(()=>parseCoachTaskChange(answer({title:'不正な改名候補'}),task,text,'2026-10-01')).toThrow('タイトル変更')
    const text='タイトルを短くして、メモは変えない、25ptはそのまま'
    expect(parseCoachTaskChange(answer({title:'短い名前'}),manual,text,'2026-10-01').patch).toEqual({title:'短い名前'})
    expect(()=>parseCoachTaskChange(answer({notes:'否定したメモ変更'}),manual,text,'2026-10-01')).toThrow('メモ変更を含めません')
    expect(createCoachTaskRequest(manual,text,'model/a','2026-10-01','Asia/Tokyo').task).toMatchObject({notes:'',scoreMode:'unset',manualPoints:null})
    expect(()=>parseCoachTaskChange(answer({manualPoints:30}),manual,'25ptは変更しないで、タイトルを短くして','2026-10-01')).toThrow()
  })
})

describe('coach candidate to ChangeSet preparation',()=>{
  let actual:Task,context:ChangeContext
  beforeEach(async()=>{
    await db.delete();await db.open()
    const settings=await ensureSettings();await db.settings.update('main',{aiEnabled:true})
    const id=await createTask({...newTaskInput(),title:'選択対象',dueDate:'2026-10-05',score:{...emptyScore(),mode:'manual',manualPoints:25}})
    actual=(await db.tasks.get(id))!
    context={principal:{id:'app-coach',kind:'coach',model:'model/a'},ownerId:settings.profileId,datasetId:settings.datasetId,allowedFields:['notes','scheduledDate'],sourceRevisions:[]}
  })
  it('prepares a fixed target without saving or accepting a model success claim',async()=>{
    const proposal=parseCoachTaskChange(answer({scheduledDate:'2026-10-02'},'既に変更しました'),actual,'明日に移して','2026-10-01')
    const prepared=await prepareCoachTaskChange(proposal,actual,context)
    expect(prepared.changes[0].taskId).toBe(actual.id)
    expect(prepared.changes[0].baseRevision).toBe(1)
    expect(prepared.reason).not.toContain('既に変更しました')
    expect(prepared.reason).toContain('まだ適用していません')
    expect(await db.tasks.get(actual.id)).toMatchObject({revision:1,scheduledDate:null,dueDate:'2026-10-05',effectivePoints:25})
    expect(await db.ledger.count()).toBe(0)
  })
  it('rejects a changed target or revision and retains the original candidate',async()=>{
    const proposal=parseCoachTaskChange(answer({scheduledDate:'2026-10-02'}),actual,'明日に移して','2026-10-01')
    await expect(prepareCoachTaskChange(proposal,{...actual,id:'other'},context)).rejects.toThrow('タスクまたは版')
    await expect(prepareCoachTaskChange(proposal,{...actual,revision:2},context)).rejects.toThrow('タスクまたは版')
    expect(proposal.targetRevision).toBe(1)
  })
})
