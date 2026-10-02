import 'fake-indexeddb/auto'
import { beforeEach,describe,expect,it,vi } from 'vitest'
import { db,ensureSettings } from './db'
import { defaultChangePolicy } from './change-set'
import { defaultSourcePermissions,deleteSource,importLocalSource,setSourcePermissions } from './source-library'
import { applyDetectionCreateFromUI,clearDetectionAuthority,detectionRunCurrent,detectObligationsForSource,isLiveDetectionRun,prepareDetectionCreate,prepareDetectionFromUI,prepareThreadDetectionFromUI,savedDetectionRuns,type DetectionTransport,type PreparedDetection } from './detection-run'
import { requiredDetectionClaims,type DetectionChange,type DetectionOutput } from './detection-contract'
import { designDetectionFixtures } from './detection-fixtures'
import { humanClick,prepareFixture,replayTransport } from './detection-fixture-replay'
import { calendarFixture,monthlyRule } from './calendar-test-fixtures'
import { saveAIVerifierModel } from './ai-connection'
import { contentDigest } from './canonical'

const model='synthetic/replay-model'
beforeEach(async()=>{vi.restoreAllMocks();clearDetectionAuthority();await db.delete();await db.open();await ensureSettings();await db.settings.update('main',{aiEnabled:true,aiModel:model,changePolicy:defaultChangePolicy()})})
async function importText(text='Karinさん、2026年10月2日までに見積書を送ってください。',allowedModels=[model],extra:{provider?:'local'|'line';externalId?:string|null;conversation?:string|null;date?:string}={}){const date=extra.date??'2026-10-01';return importLocalSource({title:`合成資料 ${extra.externalId??''}`,provider:extra.provider??'local',externalId:extra.externalId??null,conversation:extra.conversation??null,author:null,sourceUrl:null,date,fromDate:date,toDate:date,text,permissions:{...defaultSourcePermissions(),aiEgress:true},allowedModels,retentionUntil:null})}
async function prepared(id:string){const row=await db.contextSources.get(id);return prepareDetectionFromUI(id,row!.revision,model,{confirmedAliases:['Karinさん'],authorIsOwner:false,existingTaskIds:[]},humanClick())}
function output(value:PreparedDetection):DetectionOutput{
  const source=value.request.sources[0],span=source.spans[0]
  const change:DetectionChange={action:'create',target_task_id:null,expected_revision:null,title:'見積書を送る',assignee_id:value.ownerId,basis:'explicit_request',obligation_state:'requested',change_fields:['title','assignee'],due:{kind:'none',value:null,timezone:null,raw:null},recurrence:null,applicability_ref:null,rule_ref:null,evidence:[{source_id:source.source_id,revision:source.revision,span_id:span.span_id,quote:span.text,supports:['action','assignee','active']}]}
  return {schema_version:'1',changes:[change],review_items:[],ignored:[]}
}
function transport(value:PreparedDetection){return {detect:vi.fn(async()=>JSON.stringify(output(value))),verify:vi.fn(async({change}:{change:DetectionChange})=>JSON.stringify({verdict:'entailed',checks:requiredDetectionClaims(change).map(field=>({field,verdict:'entailed',source_refs:[`${change.evidence[0].source_id}:${change.evidence[0].span_id}`],reason:'合成'}))}))}}

describe('K04 所属・承認済みルールを本人の画面から渡す',()=>{
  async function calendar(){
    const current=(await db.settings.get('main'))!,base=calendarFixture()
    const state={...base,ownerId:current.profileId,datasetId:current.datasetId,bindings:[{...base.bindings[0],id:'binding-dev',personId:current.profileId}],rules:[monthlyRule({id:'rule-attend',bindingId:'binding-dev',originBasis:'user_approved_rule',title:'公開勤務割当の出勤'})]}
    await db.calendarRules.put(state);return state
  }
  it.each(['DET-003','DET-025','DET-028','DET-043'])('%s 確認済み所属・承認済みルールを選ぶとstructural passになり、検証後はready-for-review',async id=>{
    await calendar();const fixture=designDetectionFixtures.find(item=>item.id===id)!,withRule=fixture.input.trusted_context.approved_rules.length>0
    const context=await prepareFixture(fixture,{keepFixtureBindings:false,bindingIds:['binding-dev'],ruleIds:withRule?['rule-attend']:[]})
    const run=await detectObligationsForSource(context.prepared,replayTransport(context))
    expect(run.candidates.map(candidate=>candidate.status)).toEqual(['ready-for-review'])
    expect(run.context).toEqual({bindings:[{id:'binding-dev',revision:1}],rules:withRule?[{id:'rule-attend',revision:1}]:[]})
  })
  it('所属を選ばないと理由付きで拒否し、規程の対象外（DET-039）はcreateにならない',async()=>{
    await calendar()
    const context=await prepareFixture(designDetectionFixtures.find(item=>item.id==='DET-003')!,{keepFixtureBindings:false})
    await expect(detectObligationsForSource(context.prepared,replayTransport(context))).rejects.toThrow('所属の確認を選んでいません')
    expect(await db.sourceArtifacts.count()).toBe(0)
    const outside=await prepareFixture(designDetectionFixtures.find(item=>item.id==='DET-039')!,{keepFixtureBindings:false,bindingIds:['binding-dev']})
    const run=await detectObligationsForSource(outside.prepared,replayTransport(outside))
    expect(run.candidates.some(candidate=>candidate.change.action==='create')).toBe(false)
  })
  it('検出後に所属を未確認へ戻すかルールを停止すると、採用準備と採用を拒否し、Inboxでは失効になる',async()=>{
    const state=await calendar(),fixture=designDetectionFixtures.find(item=>item.id==='DET-025')!
    const context=await prepareFixture(fixture,{keepFixtureBindings:false,bindingIds:['binding-dev'],ruleIds:['rule-attend']}),run=await detectObligationsForSource(context.prepared,replayTransport(context))
    const confirmation=await prepareDetectionCreate(run,run.candidates[0].id)
    const settings=(await db.settings.get('main'))!,sources=await db.contextSources.toArray()
    expect(detectionRunCurrent(run,settings,sources,state,Date.now())).toBe(true)
    const unconfirmed={...state,bindings:[{...state.bindings[0],confirmed:false,revision:2}]}
    await db.calendarRules.put(unconfirmed)
    await expect(prepareDetectionCreate(run,run.candidates[0].id)).rejects.toThrow('失効')
    await expect(applyDetectionCreateFromUI(run,confirmation,confirmation.digest,humanClick())).rejects.toThrow('失効')
    expect(detectionRunCurrent(run,settings,sources,unconfirmed,Date.now())).toBe(false)
    await db.calendarRules.put({...state,rules:[{...state.rules[0],enabled:false,revision:2}]})
    await expect(prepareDetectionCreate(run,run.candidates[0].id)).rejects.toThrow('失効')
    expect(await db.tasks.count()).toBe(0)
  })
  it('未確認の所属・未承認ルールは選べず、送信要求には選んだidと説明だけが入る',async()=>{
    const state=await calendar()
    await db.calendarRules.put({...state,bindings:[...state.bindings,{...state.bindings[0],id:'unconfirmed',confirmed:false}],rules:[...state.rules,monthlyRule({id:'instruction-only',bindingId:'binding-dev'})]})
    const fixture=designDetectionFixtures.find(item=>item.id==='DET-003')!
    await expect(prepareFixture(fixture,{keepFixtureBindings:false,bindingIds:['unconfirmed']})).rejects.toThrow('確認済み')
    await expect(prepareFixture(fixture,{keepFixtureBindings:false,ruleIds:['instruction-only']})).rejects.toThrow('承認済み')
    const context=await prepareFixture(fixture,{keepFixtureBindings:false,bindingIds:['binding-dev']}),sent:string[]=[],calls=replayTransport(context)
    await detectObligationsForSource(context.prepared,{detect:async payload=>{sent.push(JSON.stringify(payload));return calls.detect(payload)},verify:calls.verify})
    const trusted=JSON.parse(sent[0]).request.trusted_context
    expect(trusted.participation_bindings).toEqual([{id:'binding-dev',confirmed:true,description:expect.stringContaining('本人の会社暦')}]);expect(trusted.approved_rules).toEqual([])
    // Only the selected ids and descriptions may travel as calendar data; the source
    // spans below are the analyzed document itself, not calendar leakage.
    for(const hidden of ['staff-001','会社営業日','勤怠を提出','公開勤務割当の出勤'])expect(JSON.stringify(trusted)).not.toContain(hidden)
  })
})

describe('K04 独立した検証モデルの選択',()=>{
  const verifier='othervendor/verifier-model'
  it('verify transportは検証モデルIDを受け取り、runは別提供元として保存する。配信はreview-onlyのまま',async()=>{
    await db.settings.update('main',{aiVerifierModel:verifier});const value=await prepared(await importText(undefined,[model,verifier])),calls=transport(value),run=await detectObligationsForSource(value,calls)
    expect(calls.detect).toHaveBeenCalledWith(expect.objectContaining({model}));expect(calls.verify).toHaveBeenCalledWith(expect.objectContaining({model:verifier}))
    expect(run).toMatchObject({version:2,detectorModel:model,verifierModel:verifier,verifierIndependence:'different-provider',evaluationGate:'review-only',independentModelHoldout:false})
    expect(run.candidates[0].reason).toContain('別の検証モデル')
    expect((await db.audits.toArray()).filter(audit=>audit.operation==='source.sent').map(audit=>JSON.parse(audit.detail).model).sort()).toEqual([model,verifier].sort())
  })
  it('資料が検出モデルだけを許可していると、prepareは明確な文言で拒否する',async()=>{
    const id=await importText();await db.settings.update('main',{aiVerifierModel:verifier})
    await expect(prepared(id)).rejects.toThrow(`検証用モデル ${verifier} へのAI送信が資料`)
  })
  it('実行中に検証モデルの許可を外すと、検証もInbox保存もしない',async()=>{
    await db.settings.update('main',{aiVerifierModel:verifier});const value=await prepared(await importText(undefined,[model,verifier])),calls=transport(value)
    calls.detect=vi.fn(async()=>{const row=await db.contextSources.get(value.source.sourceId);await setSourcePermissions(row!.id,row!.revision,row!.permissions,[model],null);return JSON.stringify(output(value))})
    await expect(detectObligationsForSource(value,calls)).rejects.toThrow('変わりました')
    expect(calls.verify).not.toHaveBeenCalled();expect(await db.sourceArtifacts.count()).toBe(0)
  })
  it('検証モデルの変更でpolicy epochが進み、準備済みの検出と候補の採用権限は失効する',async()=>{
    await db.settings.update('main',{aiVerifierModel:verifier});const value=await prepared(await importText(undefined,[model,verifier])),run=await detectObligationsForSource(value,transport(value))
    const before=(await db.settings.get('main'))!.changePolicy!.epoch
    await saveAIVerifierModel(null)
    expect((await db.settings.get('main'))!.changePolicy!.epoch).toBe(before+1);expect(isLiveDetectionRun(run)).toBe(false)
    await expect(prepareDetectionCreate(run,run.candidates[0].id)).rejects.toThrow('承認権限は復元しません')
  })
  it('保存済みv1（同じモデル）は表示でき、v2の独立性を改ざんすると表示しない',async()=>{
    const value=await prepared(await importText()),run=await detectObligationsForSource(value,transport(value)),artifactId=`detection:${run.id}`
    const v1=JSON.parse(JSON.stringify(run));v1.version=1;for(const key of ['sources','context','verifierIndependence'])delete v1[key];for(const candidate of v1.candidates)delete candidate.obligationKey
    {const {digest:_v2,...payload}=v1;v1.digest=await contentDigest(payload)}
    await db.sourceArtifacts.update(artifactId,{payload:JSON.stringify(v1)})
    expect((await savedDetectionRuns(value.ownerId)).map(item=>item.version)).toEqual([1])
    for(const recompute of [false,true]){
      const tampered=JSON.parse(JSON.stringify(run));tampered.verifierIndependence='different-provider'
      if(recompute){const {digest:_old,...payload}=tampered;tampered.digest=await contentDigest(payload)}
      await db.sourceArtifacts.update(artifactId,{payload:JSON.stringify(tampered)})
      expect(await savedDetectionRuns(value.ownerId)).toEqual([])
    }
  })
})

describe('N04 同じ会話の複数発言をまとめて検出する',()=>{
  const message=(text:string,externalId:string,date:string)=>importText(text,[model],{provider:'line',externalId,conversation:'仕事グループ',date})
  async function thread(){return [await message('Karinさん、2026年10月5日までに報告書を送ってください。','m1','2026-10-01'),await message('先ほどの報告書の依頼は取り消します。送らなくて大丈夫です。','m2','2026-10-02')]}
  async function prepareThread(ids:string[]){return prepareThreadDetectionFromUI(await Promise.all(ids.map(async id=>({sourceId:id,expectedRevision:(await db.contextSources.get(id))!.revision}))),model,{confirmedAliases:['Karinさん'],authorIsOwner:false,existingTaskIds:[]},humanClick())}
  const cancelled=(value:PreparedDetection):DetectionTransport=>({detect:async()=>JSON.stringify({schema_version:'1',changes:[],review_items:[],ignored:value.request.sources.map(source=>({source_id:source.source_id,reason:'canceled'}))}),verify:async()=>'{}'})
  it('依頼と取消の2発言を両方含めるとcreate 0件・ignored canceled。日時順に送る',async()=>{
    const [first,second]=await thread(),value=await prepareThread([second,first])
    expect(value.request.sources.map(source=>source.source_id)).toEqual([first,second]);expect(value.coverageNotice).not.toContain('未包含')
    const run=await detectObligationsForSource(value,cancelled(value))
    expect(run.candidates).toHaveLength(0);expect(run.ignored.map(item=>item.reason)).toEqual(['canceled','canceled'])
    expect(await db.sourceArtifacts.count()).toBe(2);expect((await savedDetectionRuns(value.ownerId)).map(item=>item.id)).toEqual([run.id])
  })
  it('1件だけ含めると「他の発言は未包含」と通知する',async()=>{
    const [first]=await thread(),value=await prepareThread([first])
    expect(value.coverageNotice).toContain('他の発言は未包含')
  })
  it('2件目の資料を削除するとrun全体が失効し、採用できない',async()=>{
    const [first,second]=await thread(),value=await prepareThread([first,second]),run=await detectObligationsForSource(value,transport(value))
    expect(run.candidates[0].status).toBe('ready-for-review')
    await deleteSource(second,(await db.contextSources.get(second))!.revision)
    expect(await savedDetectionRuns(value.ownerId)).toEqual([])
    await expect(prepareDetectionCreate(run,run.candidates[0].id)).rejects.toThrow()
    expect(await db.tasks.count()).toBe(0)
  })
  it('どちらかの許可を応答待ちの間に取り消すとverifyも保存もしない',async()=>{
    const [first,second]=await thread(),value=await prepareThread([first,second]),calls=transport(value)
    calls.detect=vi.fn(async()=>{const row=await db.contextSources.get(second);await setSourcePermissions(second,row!.revision,{...row!.permissions,aiEgress:false},row!.allowedModels,null);return JSON.stringify(output(value))})
    await expect(detectObligationsForSource(value,calls)).rejects.toThrow('変わりました')
    expect(calls.verify).not.toHaveBeenCalled();expect(await db.sourceArtifacts.count()).toBe(0)
  })
  it('件数・文字数の上限を超える選択は拒否する',async()=>{
    const ids:string[]=[];for(let index=0;index<21;index++)ids.push(await message(`発言${index}`,`x${index}`,'2026-10-01'))
    await expect(prepareThread(ids)).rejects.toThrow('1〜20件')
    const long=[await message('あ'.repeat(30000),'l1','2026-10-01'),await message('い'.repeat(30000),'l2','2026-10-01')]
    await expect(prepareThread(long)).rejects.toThrow('50,000文字')
  })
})
