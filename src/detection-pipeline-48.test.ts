import 'fake-indexeddb/auto'
import { beforeEach,describe,expect,it,vi } from 'vitest'
import { db,ensureSettings } from './db'
import { defaultChangePolicy } from './change-set'
import { designDetectionFixtures } from './detection-fixtures'
import { applyDetectionCreateFromUI,clearDetectionAuthority,detectObligationsForSource,prepareDetectionCreate,savedDetectionRuns } from './detection-run'
import { humanClick,mapFixtureOutput,prepareFixture,replayModel,replayTransport } from './detection-fixture-replay'
import type { DetectionChange } from './detection-contract'

beforeEach(async()=>{vi.restoreAllMocks();clearDetectionAuthority();await db.delete();await db.open();await ensureSettings();await db.settings.update('main',{aiEnabled:true,aiModel:replayModel,changePolicy:defaultChangePolicy()})})
async function counts(){return {tasks:await db.tasks.count(),completions:await db.completions.count(),ledger:await db.ledger.count(),assessments:await db.assessments.count()}}

describe('設計48例を実際のpipelineへ再生する（モデル精度の評価ではない・設計者の期待出力の再生）',()=>{
  it.each(designDetectionFixtures)('$id $name: 取込→準備→検出→検査→検証→Inboxで、登録は本人clickまで0件',async fixture=>{
    const context=await prepareFixture(fixture),before=await counts()
    const run=await detectObligationsForSource(context.prepared,replayTransport(context))
    expect(run.evaluationGate).toBe('review-only');expect(run.candidates.map(candidate=>candidate.change.action)).toEqual(fixture.expected.actions)
    expect(await counts()).toEqual(before)
    const creates=run.candidates.filter(candidate=>candidate.change.action==='create')
    if(fixture.expected.must_not_create)expect(creates).toHaveLength(0)
    if(fixture.expected.needs_review)expect(run.reviewItems.length).toBeGreaterThan(0)
    for(const candidate of run.candidates.filter(item=>item.change.action!=='create'))await expect(prepareDetectionCreate(run,candidate.id)).rejects.toThrow('登録できません')
    // Positive creates only reach the owner's confirmation step; nothing is written without the native click.
    for(const candidate of creates){const confirmation=await prepareDetectionCreate(run,candidate.id);await expect(applyDetectionCreateFromUI(run,confirmation,confirmation.digest,new Event('click'))).rejects.toThrow('本人')}
    expect(await counts()).toEqual(before)
    expect((await savedDetectionRuns(context.prepared.ownerId))[0].digest).toBe(run.digest)
  })
  it('DET-017 期限の訂正は既存タスクへのupdate候補だけで、新規作成も既存の変更もしない',async()=>{
    const context=await prepareFixture(designDetectionFixtures.find(item=>item.id==='DET-017')!),taskId=[...context.taskIds.values()][0],before=await db.tasks.get(taskId)
    const run=await detectObligationsForSource(context.prepared,replayTransport(context))
    expect(run.candidates.map(candidate=>candidate.change.action)).toEqual(['update']);expect(run.candidates[0].change.target_task_id).toBe(taskId)
    await expect(prepareDetectionCreate(run,run.candidates[0].id)).rejects.toThrow('既存タスクへの差分')
    expect(await db.tasks.get(taskId)).toEqual(before);expect(await db.tasks.count()).toBe(1)
  })
  it('DET-016/020/036 取消・移管はcreateにならず、DET-029/031 注入はchanges 0件、DET-040 は取得不足を確認事項にする',async()=>{
    for(const id of ['DET-016','DET-020','DET-036']){const context=await prepareFixture(designDetectionFixtures.find(item=>item.id===id)!),run=await detectObligationsForSource(context.prepared,replayTransport(context));expect(run.candidates.some(candidate=>candidate.change.action==='create')).toBe(false)}
    for(const id of ['DET-029','DET-031']){const context=await prepareFixture(designDetectionFixtures.find(item=>item.id===id)!),run=await detectObligationsForSource(context.prepared,replayTransport(context));expect(run.candidates).toHaveLength(0);expect(run.ignored.map(item=>item.reason)).toContain('injection')}
    const context=await prepareFixture(designDetectionFixtures.find(item=>item.id==='DET-040')!),run=await detectObligationsForSource(context.prepared,replayTransport(context))
    expect(run.candidates).toHaveLength(0);expect(run.reviewItems.map(item=>item.reason)).toContain('coverage_incomplete');expect(run.coverageNotice).toContain('0件でも義務がないとは確定しません')
  })
  it.each(designDetectionFixtures.filter(fixture=>fixture.expected.must_not_create))('$id 敵対的変種: 検出器と検証器の両方が誤って捏造createを支持しても、本人clickなしでは0件',async fixture=>{
    const context=await prepareFixture(fixture),real=context.prepared.request.sources[0],span=real.spans[0]
    const fabricated:DetectionChange={action:'create',target_task_id:null,expected_revision:null,title:'捏造された作業',assignee_id:context.prepared.ownerId,basis:'explicit_request',obligation_state:'requested',change_fields:['title','assignee'],due:{kind:'none',value:null,timezone:null,raw:null},recurrence:null,applicability_ref:null,rule_ref:null,evidence:[{source_id:real.source_id,revision:real.revision,span_id:span.span_id,quote:span.text,supports:['action','assignee','active']}]}
    const mapped=mapFixtureOutput(context),before=await counts()
    const run=await detectObligationsForSource(context.prepared,replayTransport(context,{...mapped,changes:[...mapped.changes,fabricated]}))
    const candidate=run.candidates.find(item=>item.change.title==='捏造された作業')!
    expect(candidate.status).toBe('ready-for-review');expect(run.evaluationGate).toBe('review-only')
    const confirmation=await prepareDetectionCreate(run,candidate.id)
    await expect(applyDetectionCreateFromUI(run,confirmation,confirmation.digest,new Event('click'))).rejects.toThrow('本人')
    expect(await counts()).toEqual(before)
  })
  it('承認・役割の注入フィールドはparseで拒否し、本文にない引用はreject。どちらもInboxへ保存しない',async()=>{
    const fixture=designDetectionFixtures[0]
    for(const extra of [{approved:true},{role:'system'}]){
      const context=await prepareFixture(fixture),mapped=mapFixtureOutput(context)
      await expect(detectObligationsForSource(context.prepared,replayTransport(context,JSON.stringify({...mapped,changes:[{...mapped.changes[0],...extra}]})))).rejects.toThrow('JSON形式')
      await expect(detectObligationsForSource((await prepareFixture(fixture)).prepared,replayTransport(context,JSON.stringify({...mapped,...extra})))).rejects.toThrow()
    }
    const context=await prepareFixture(fixture),mapped=mapFixtureOutput(context);mapped.changes[0].evidence[0].quote='本文にない依頼を送ってください'
    await expect(detectObligationsForSource(context.prepared,replayTransport(context,mapped))).rejects.toThrow('QUOTE_NOT_FOUND')
    expect(await db.sourceArtifacts.count()).toBe(0);expect(await db.tasks.count()).toBe(0)
  })
})
