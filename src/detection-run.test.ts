import 'fake-indexeddb/auto'
import { beforeEach,describe,expect,it,vi } from 'vitest'
import { db,ensureSettings } from './db'
import { createTask,newTaskInput } from './commands'
import { emptyScore } from './domain'
import { defaultSourcePermissions,deleteSource,importLocalSource,setSourcePermissions } from './source-library'
import { defaultChangePolicy } from './change-set'
import { applyDetectionCreateFromUI,clearDetectionAuthority,detectObligationsForSource,discardDetectionRun,prepareDetectionCreate,prepareDetectionFromUI,savedDetectionRuns,type DetectionTransport,type PreparedDetection } from './detection-run'
import { requiredDetectionClaims,type DetectionChange,type DetectionOutput } from './detection-contract'
import { contentDigest } from './canonical'

const model='synthetic/model'
// Node fixture only: production uses the browser's native trusted click event.
function humanClick(){const event=new Event('click');Object.defineProperty(event,'isTrusted',{value:true});return event}
beforeEach(async()=>{vi.restoreAllMocks();clearDetectionAuthority();await db.delete();await db.open();await ensureSettings();await db.settings.update('main',{aiEnabled:true,aiModel:model,changePolicy:defaultChangePolicy()})})
async function source(text='Karinさん、2026年10月2日までに見積書を送ってください。'){
  return importLocalSource({title:'合成資料',provider:'local',externalId:null,conversation:null,author:'Karin',sourceUrl:null,date:'2026-10-01',fromDate:'2026-10-01',toDate:'2026-10-01',text,permissions:{...defaultSourcePermissions(),aiEgress:true},allowedModels:[model],retentionUntil:null})
}
async function prepared(sourceId?:string){const id=sourceId??await source(),row=await db.contextSources.get(id);return prepareDetectionFromUI(id,row!.revision,model,{confirmedAliases:['Karinさん'],authorIsOwner:false,existingTaskIds:[]},humanClick())}
function output(value:PreparedDetection):DetectionOutput{
  const source=value.request.sources[0],span=source.spans[0]
  const change:DetectionChange={action:'create',target_task_id:null,expected_revision:null,title:'見積書を送る',assignee_id:value.ownerId,basis:'explicit_request',obligation_state:'requested',change_fields:['title','assignee','due'],due:{kind:'date',value:'2026-10-02',timezone:'Asia/Tokyo',raw:span.text},recurrence:null,applicability_ref:null,rule_ref:null,evidence:[{source_id:source.source_id,revision:source.revision,span_id:span.span_id,quote:span.text,supports:['action','assignee','active','due']}]}
  return {schema_version:'1',changes:[change],review_items:[{source_ids:[source.source_id],reason:'coverage_incomplete',question:'未取得の添付や期間を確認してください'}],ignored:[]}
}
function transport(value:PreparedDetection):DetectionTransport{return {detect:vi.fn(async()=>JSON.stringify(output(value))),verify:vi.fn(async({change})=>JSON.stringify({verdict:'entailed',checks:requiredDetectionClaims(change).map(field=>({field,verdict:'entailed',source_refs:[`${value.request.sources[0].source_id}:${value.request.sources[0].spans[0].span_id}`],reason:'合成の原文を照合した'}))}))}}
describe('資料からの検出Inboxと本人の採用境界',()=>{
  it('検出2件と手動Inbox1件を分離し、未採用候補を件数・必要点へ加算しない',async()=>{
    await createTask({...newTaskInput(),title:'本人のInbox',score:{...emptyScore(),mode:'manual',manualPoints:25}})
    for(let index=0;index<2;index++){const value=await prepared();await detectObligationsForSource(value,transport(value))}
    const settings=(await db.settings.get('main'))!,runs=await savedDetectionRuns(settings.profileId),tasks=await db.tasks.toArray()
    expect(runs.reduce((count,run)=>count+run.candidates.length,0)).toBe(2)
    expect(tasks).toHaveLength(1);expect(tasks.reduce((points,task)=>points+(task.effectivePoints??0),0)).toBe(25)
    expect(await db.ledger.count()).toBe(0);expect(await db.completions.count()).toBe(0)
  })
  it('検出・検証を別callし、候補と確認事項はタスク・ポイントへ数えない',async()=>{
    const value=await prepared(),calls=transport(value),run=await detectObligationsForSource(value,calls)
    expect(calls.detect).toHaveBeenCalledTimes(1);expect(calls.verify).toHaveBeenCalledTimes(1)
    expect(run.candidates).toHaveLength(1);expect(run.reviewItems).toHaveLength(1)
    expect(run).toMatchObject({detectorModel:model,verifierModel:model,independentModelHoldout:false,evaluationGate:'review-only'})
    expect(await db.tasks.count()).toBe(0);expect(await db.assessments.count()).toBe(0);expect(await db.completions.count()).toBe(0);expect(await db.ledger.count()).toBe(0)
    expect((await savedDetectionRuns(value.ownerId))[0].digest).toBe(run.digest)
  })
  it('本人clickと確認digestでのみ1回保存し、必要点・時間・優先度を推定しない',async()=>{
    const value=await prepared(),run=await detectObligationsForSource(value,transport(value)),candidate=run.candidates[0],confirmation=await prepareDetectionCreate(run,candidate.id)
    await expect(applyDetectionCreateFromUI(run,confirmation,confirmation.digest,new Event('click'))).rejects.toThrow('本人')
    await expect(applyDetectionCreateFromUI(run,confirmation,'different',humanClick())).rejects.toThrow('内容が変わり')
    expect(await db.tasks.count()).toBe(0)
    const first=await applyDetectionCreateFromUI(run,confirmation,confirmation.digest,humanClick()),second=await applyDetectionCreateFromUI(run,confirmation,confirmation.digest,humanClick())
    expect(second.taskIds).toEqual(first.taskIds);expect(await db.tasks.count()).toBe(1)
    expect(await db.tasks.get(first.taskIds[0])).toMatchObject({title:'見積書を送る',dueDate:'2026-10-02',scheduledDate:null,score:{mode:'unset',manualPoints:null,minutes:null},status:'open'})
    expect((await db.audits.toArray()).filter(audit=>audit.operation==='detection.approved')).toHaveLength(1)
    expect(await db.ledger.count()).toBe(0)
  })
  it('検証unknownまたは失敗では登録不可、元の資料と確認候補を残す',async()=>{
    for(const failure of ['unknown','network']){
      const value=await prepared(),calls=transport(value)
      calls.verify=async()=>{if(failure==='network')throw new Error('network');return JSON.stringify({verdict:'unknown',checks:[]})}
      const run=await detectObligationsForSource(value,calls)
      expect(run.candidates[0].status).not.toBe('ready-for-review')
      await expect(prepareDetectionCreate(run,run.candidates[0].id)).rejects.toThrow('登録できません')
      expect(await db.contextSnapshots.count()).toBe(1)
    }
    expect(await db.tasks.count()).toBe(0)
  })
  it('模型が本人約束を捏造しても、未確認authorから承認を作れない',async()=>{
    const value=await prepared(),raw=output(value);raw.changes[0].basis='self_commitment';raw.changes[0].obligation_state='committed'
    await expect(detectObligationsForSource(value,{...transport(value),detect:async()=>JSON.stringify(raw)})).rejects.toThrow('SELF_IDENTITY_UNVERIFIED')
    expect(await db.sourceArtifacts.count()).toBe(0)
  })
  it('資料の権限取消・本文hash差替え・span差替えで進行中と承認待ちを拒否',async()=>{
    const value=await prepared(),run=await detectObligationsForSource(value,transport(value)),confirmation=await prepareDetectionCreate(run,run.candidates[0].id)
    const row=await db.contextSources.get(value.source.sourceId)
    await setSourcePermissions(row!.id,row!.revision,{...row!.permissions,aiEgress:false},row!.allowedModels,null)
    await expect(applyDetectionCreateFromUI(run,confirmation,confirmation.digest,humanClick())).rejects.toThrow('変わりました')
    expect(await db.sourceArtifacts.count()).toBe(0);expect(await db.tasks.count()).toBe(0)
    const next=await prepared(await source('Karinさん、別の見積書を送ってください。')),snapshot=await db.contextSnapshots.get(`${next.source.sourceId}:1`)
    await db.contextSnapshots.update(snapshot!.id,{text:snapshot!.text+'追加'})
    await expect(detectObligationsForSource(next,transport(next))).rejects.toThrow('ハッシュ')
    await db.contextSnapshots.put({...snapshot!,spans:snapshot!.spans.map(span=>({...span,text:'別の義務'}))})
    await expect(detectObligationsForSource(next,transport(next))).rejects.toThrow('ハッシュ')
  })
  it('AI OFF→ON・policy変更・dataset変更・資料削除で古い承認は復活しない',async()=>{
    const value=await prepared(),run=await detectObligationsForSource(value,transport(value)),confirmation=await prepareDetectionCreate(run,run.candidates[0].id)
    const current=await db.settings.get('main')
    await db.settings.update('main',{aiEnabled:false,changePolicy:{...current!.changePolicy!,epoch:current!.changePolicy!.epoch+1}})
    await db.settings.update('main',{aiEnabled:true})
    await expect(applyDetectionCreateFromUI(run,confirmation,confirmation.digest,humanClick())).rejects.toThrow('変わりました')
    await db.settings.update('main',{changePolicy:current!.changePolicy!,datasetId:'different'})
    await expect(applyDetectionCreateFromUI(run,confirmation,confirmation.digest,humanClick())).rejects.toThrow('変わりました')
    await db.settings.update('main',{datasetId:current!.datasetId})
    await deleteSource(value.source.sourceId,value.source.sourceRevision)
    await expect(applyDetectionCreateFromUI(run,confirmation,confirmation.digest,humanClick())).rejects.toThrow()
    expect(await db.tasks.count()).toBe(0)
  })
  it('既存変更・取消・完了・周期候補から新規タスクや実績を作らない',async()=>{
    const taskId=await createTask({...newTaskInput(),title:'見積書を送る',score:{...newTaskInput().score,mode:'manual',manualPoints:25}})
    const sourceId=await source(),row=await db.contextSources.get(sourceId),value=await prepareDetectionFromUI(sourceId,row!.revision,model,{confirmedAliases:['Karinさん'],authorIsOwner:false,existingTaskIds:[taskId]},humanClick())
    const raw=output(value),task=await db.tasks.get(taskId)
    raw.changes[0]={...raw.changes[0],action:'cancel',target_task_id:taskId,expected_revision:task!.revision,change_fields:[],due:{kind:'none',value:null,timezone:null,raw:null},evidence:raw.changes[0].evidence.map(reference=>({...reference,supports:['action','assignee','active','target']}))}
    const run=await detectObligationsForSource(value,{...transport(value),detect:async()=>JSON.stringify(raw)})
    await expect(prepareDetectionCreate(run,run.candidates[0].id)).rejects.toThrow('既存タスクへの差分')
    expect(await db.tasks.get(taskId)).toMatchObject({status:'open',score:{mode:'manual',manualPoints:25},revision:1})
    expect(await db.ledger.count()).toBe(0)
  })
  it('serialized履歴・JSON承認・偽eventは書込み権限を復元しない',async()=>{
    const value=await prepared(),run=await detectObligationsForSource(value,transport(value)),restored=(await savedDetectionRuns(value.ownerId))[0]
    await expect(prepareDetectionCreate(restored,restored.candidates[0].id)).rejects.toThrow('承認権限は復元しません')
    await expect(prepareDetectionFromUI(value.source.sourceId,value.source.sourceRevision,model,{confirmedAliases:[],authorIsOwner:false,existingTaskIds:[]},{type:'click',isTrusted:true} as Event)).rejects.toThrow('本人')
    clearDetectionAuthority();await expect(prepareDetectionCreate(run,run.candidates[0].id)).rejects.toThrow('承認権限は復元しません')
  })
  it('検出後に同じ作業が登録されたら重複せず、atomic保存の失敗で全件rollback',async()=>{
    const value=await prepared(),run=await detectObligationsForSource(value,transport(value)),confirmation=await prepareDetectionCreate(run,run.candidates[0].id)
    const add=vi.spyOn(db.audits,'add').mockRejectedValueOnce(new Error('disk-full'))
    await expect(applyDetectionCreateFromUI(run,confirmation,confirmation.digest,humanClick())).rejects.toThrow('disk-full');add.mockRestore()
    expect(await db.tasks.count()).toBe(0);expect(await db.assessments.count()).toBe(0);expect(await db.commands.count()).toBe(0)
    await createTask({...newTaskInput(),title:'見積書を送る'})
    await expect(applyDetectionCreateFromUI(run,confirmation,confirmation.digest,humanClick())).rejects.toThrow('既に登録')
    expect(await db.tasks.count()).toBe(1)
  })
  it('取得範囲だけを送り、既存タスクのメモ・手動点数・別資料を送らない',async()=>{
    const taskId=await createTask({...newTaskInput(),title:'既存作業',notes:'送信しない秘密のメモ',score:{...newTaskInput().score,mode:'manual',manualPoints:25}}),sourceId=await source(),row=await db.contextSources.get(sourceId)
    const value=await prepareDetectionFromUI(sourceId,row!.revision,model,{confirmedAliases:['Karinさん'],authorIsOwner:false,existingTaskIds:[taskId]},humanClick())
    const sent=JSON.stringify(value.request)
    expect(sent).not.toContain('秘密のメモ');expect(sent).not.toContain('manualPoints');expect(value.request.sources).toHaveLength(1)
    expect(value.request.sources[0].author_id).toBe('unverified-import-author');expect(value.request.sources[0].sent_at).toBe('2026-10-01')
  })
  it('応答を待つ間の資料許可変更でverifyとInbox保存をしない',async()=>{
    const value=await prepared(),calls=transport(value)
    calls.detect=async()=>{const row=await db.contextSources.get(value.source.sourceId);await setSourcePermissions(row!.id,row!.revision,{...row!.permissions,aiEgress:false},row!.allowedModels,null);return JSON.stringify(output(value))}
    await expect(detectObligationsForSource(value,calls)).rejects.toThrow('変わりました')
    expect(calls.verify).not.toHaveBeenCalled();expect(await db.sourceArtifacts.count()).toBe(0)
  })
  it('候補破棄で承認待ち作成を撤回する',async()=>{
    const value=await prepared(),run=await detectObligationsForSource(value,transport(value)),confirmation=await prepareDetectionCreate(run,run.candidates[0].id)
    await discardDetectionRun(run)
    await expect(applyDetectionCreateFromUI(run,confirmation,confirmation.digest,humanClick())).rejects.toThrow()
    expect(await db.tasks.count()).toBe(0);expect(await db.sourceArtifacts.count()).toBe(0)
  })
  it('壊れた保存候補はdigestを自己申告しても画面に読み込まない',async()=>{
    const value=await prepared(),run=await detectObligationsForSource(value,transport(value)),artifactId=`detection:${run.id}`
    const malformed=JSON.parse(JSON.stringify(run));malformed.candidates[0].change.evidence=null
    const {digest:_old,...payload}=malformed;malformed.digest=await contentDigest(payload)
    await db.sourceArtifacts.update(artifactId,{payload:JSON.stringify(malformed)})
    expect(await savedDetectionRuns(value.ownerId)).toEqual([])
    const injection=JSON.parse(JSON.stringify(run));injection.approved=true
    const {digest:_oldInjection,...injectedPayload}=injection;injection.digest=await contentDigest(injectedPayload)
    await db.sourceArtifacts.update(artifactId,{payload:JSON.stringify(injection)})
    expect(await savedDetectionRuns(value.ownerId)).toEqual([])
  })
})
