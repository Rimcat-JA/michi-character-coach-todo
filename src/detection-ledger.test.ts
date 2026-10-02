import 'fake-indexeddb/auto'
import { beforeEach,describe,expect,it,vi } from 'vitest'
import { db,ensureSettings } from './db'
import { defaultChangePolicy } from './change-set'
import { defaultSourcePermissions,deleteSource,importLocalSource } from './source-library'
import { applyDetectionCreateFromUI,clearDetectionAuthority,detectObligationsForSource,dismissDetectionCandidate,prepareDetectionCreate,prepareDetectionFromUI,reconsiderDetectedObligation,savedDetectionRuns,type DetectionTransport,type PreparedDetection } from './detection-run'
import { requiredDetectionClaims,type DetectionChange } from './detection-contract'
import { captureSnapshot,restoreBackup } from './backup'
import { findObligation } from './detection-ledger'

const model='synthetic/model'
function humanClick(){const event=new Event('click');Object.defineProperty(event,'isTrusted',{value:true});return event}
beforeEach(async()=>{vi.restoreAllMocks();clearDetectionAuthority();await db.delete();await db.open();await ensureSettings();await db.settings.update('main',{aiEnabled:true,aiModel:model,changePolicy:defaultChangePolicy()})})
const request='Karinさん、2026年10月2日までに見積書を送ってください。'
async function source(text=request,title='合成資料'){return importLocalSource({title,provider:'local',externalId:null,conversation:null,author:null,sourceUrl:null,date:'2026-10-01',fromDate:'2026-10-01',toDate:'2026-10-01',text,permissions:{...defaultSourcePermissions(),aiEgress:true},allowedModels:[model],retentionUntil:null})}
async function prepare(id:string){const row=await db.contextSources.get(id);return prepareDetectionFromUI(id,row!.revision,model,{confirmedAliases:['Karinさん'],authorIsOwner:false,existingTaskIds:[]},humanClick())}
function transport(value:PreparedDetection,title='見積書を送る',quoteOf:(text:string)=>string=text=>text):DetectionTransport{
  const source=value.request.sources[0],span=source.spans.find(item=>item.text.includes('までに'))??source.spans[source.spans.length-1]
  const change:DetectionChange={action:'create',target_task_id:null,expected_revision:null,title,assignee_id:value.ownerId,basis:'explicit_request',obligation_state:'requested',change_fields:['title','assignee'],due:{kind:'none',value:null,timezone:null,raw:null},recurrence:null,applicability_ref:null,rule_ref:null,evidence:[{source_id:source.source_id,revision:source.revision,span_id:span.span_id,quote:quoteOf(span.text),supports:['action','assignee','active']}]}
  return {detect:async()=>JSON.stringify({schema_version:'1',changes:[change],review_items:[],ignored:[]}),verify:async({change:checked})=>JSON.stringify({verdict:'entailed',checks:requiredDetectionClaims(checked).map(field=>({field,verdict:'entailed',source_refs:[`${source.source_id}:${span.span_id}`],reason:'合成'}))})}
}
async function detect(id:string,title?:string){const value=await prepare(id);return detectObligationsForSource(value,transport(value,title))}
async function adopt(run:Awaited<ReturnType<typeof detect>>){const confirmation=await prepareDetectionCreate(run,run.candidates[0].id);return applyDetectionCreateFromUI(run,confirmation,confirmation.digest,humanClick())}

describe('K04 検出結果の論理IDと観察台帳・抑制記録',()=>{
  it('不要にした根拠は、同じ資料の再検出でも同一本文の別資料再取込でも採用できない',async()=>{
    const first=await detect(await source())
    await expect(dismissDetectionCandidate(first,first.candidates[0].id,new Event('click'))).rejects.toThrow('本人')
    await dismissDetectionCandidate(first,first.candidates[0].id,humanClick())
    const again=await detect(first.source.sourceId)
    expect(again.candidates[0].obligationKey).toBe(first.candidates[0].obligationKey)
    await expect(prepareDetectionCreate(again,again.candidates[0].id)).rejects.toThrow('不要とした根拠')
    // Width/space variants of the same sentence in a different source still map to the same suppressed key.
    const copy=await detect(await source(`前置き\n${request.replace('2026','２０２６')}`,'別名で再取込'))
    expect(copy.candidates[0].obligationKey).toBe(first.candidates[0].obligationKey)
    await expect(prepareDetectionCreate(copy,copy.candidates[0].id)).rejects.toThrow('不要とした根拠')
    expect(await db.tasks.count()).toBe(0)
    expect((await findObligation(first.ownerId,first.candidates[0].obligationKey!))?.state).toBe('dismissed')
  })
  it('別の明示的な再依頼（新しい引用）は別の根拠として採用でき、「再検討する」で本人が抑制を解ける',async()=>{
    const first=await detect(await source());await dismissDetectionCandidate(first,first.candidates[0].id,humanClick())
    const renewed=await detect(await source('Karinさん、取り消した見積書の件、やはり10月5日までに送ってください。','再依頼'),'見積書を再送する')
    expect(renewed.candidates[0].obligationKey).not.toBe(first.candidates[0].obligationKey)
    expect((await adopt(renewed)).taskIds).toHaveLength(1)
    const row=(await findObligation(first.ownerId,first.candidates[0].obligationKey!))!
    await expect(reconsiderDetectedObligation(row.canonicalKey,row.revision,new Event('click'))).rejects.toThrow('本人')
    await reconsiderDetectedObligation(row.canonicalKey,row.revision,humanClick())
    const reopened=await detect(first.source.sourceId,'見積書を送る（再検討）')
    expect((await adopt(reopened)).taskIds).toHaveLength(1);expect(await db.tasks.count()).toBe(2)
  })
  it('採用済みの根拠から別タイトルのcreateが来ても登録しない（タイトル一致は補助）',async()=>{
    const id=await source(),run=await detect(id);const receipt=await adopt(run)
    expect((await findObligation(run.ownerId,run.candidates[0].obligationKey!))).toMatchObject({state:'linked',linkedTaskId:receipt.taskIds[0]})
    const other=await detect(id,'全く別の題名')
    await expect(prepareDetectionCreate(other,other.candidates[0].id)).rejects.toThrow('反映済み')
    expect(await db.tasks.count()).toBe(1)
  })
  it('同じ根拠の二つの確認を同時に採用してもタスクは1件',async()=>{
    const id=await source(),one=await detect(id),two=await detect(id,'見積書の送付')
    const [left,right]=[await prepareDetectionCreate(one,one.candidates[0].id),await prepareDetectionCreate(two,two.candidates[0].id)]
    const results=await Promise.allSettled([applyDetectionCreateFromUI(one,left,left.digest,humanClick()),applyDetectionCreateFromUI(two,right,right.digest,humanClick())])
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(await db.tasks.count()).toBe(1)
  })
  it('資料を削除すると未反映の観察はwithdrawnになり、台帳に本文・引用は残らない。抑制は残る',async()=>{
    const id=await source(),run=await detect(id),dismissedRun=await detect(await source('Karinさん、議事録を明日までに送ってください。','別資料'),'議事録を送る')
    await dismissDetectionCandidate(dismissedRun,dismissedRun.candidates[0].id,humanClick())
    await deleteSource(id,(await db.contextSources.get(id))!.revision)
    expect((await findObligation(run.ownerId,run.candidates[0].obligationKey!))?.state).toBe('withdrawn')
    const ledger=JSON.stringify([await db.detectedObligations.toArray(),await db.obligationObservations.toArray()])
    expect(ledger).not.toContain('見積書');expect(ledger).not.toContain('Karin');expect(ledger).not.toContain('議事録')
    expect((await db.obligationObservations.toArray()).map(row=>row.verdict)).toContain('withdrawn')
    await deleteSource(dismissedRun.source.sourceId,(await db.contextSources.get(dismissedRun.source.sourceId))!.revision)
    expect((await findObligation(run.ownerId,dismissedRun.candidates[0].obligationKey!))?.state).toBe('dismissed')
    expect(await savedDetectionRuns(run.ownerId)).toEqual([])
  })
  it('バックアップの往復で抑制と反映済みが残り、復元後に再検出しても採用できない',async()=>{
    const id=await source(),run=await detect(id);await dismissDetectionCandidate(run,run.candidates[0].id,humanClick())
    const snapshot=await captureSnapshot()
    expect(snapshot.detectedObligations).toHaveLength(1);expect(snapshot.obligationObservations!.length).toBeGreaterThanOrEqual(2)
    await db.detectedObligations.clear();await db.obligationObservations.clear()
    await restoreBackup(snapshot);clearDetectionAuthority()
    const again=await detect(id)
    await expect(prepareDetectionCreate(again,again.candidates[0].id)).rejects.toThrow('不要とした根拠')
  })
  it('バックアップ後に本人が不要にした根拠は、古いバックアップを復元しても解除されない',async()=>{
    const id=await source(),run=await detect(id),snapshot=await captureSnapshot()
    await dismissDetectionCandidate(run,run.candidates[0].id,humanClick())
    await restoreBackup(snapshot);clearDetectionAuthority()
    expect((await findObligation(run.ownerId,run.candidates[0].obligationKey!))?.state).toBe('dismissed')
  })
  it('壊れた台帳（不明な状態・存在しない反映先・本文の混入）はバックアップ検証で拒否',async()=>{
    const run=await detect(await source());await adopt(run)
    const snapshot=await captureSnapshot()
    for(const patch of [{state:'approved'},{linkedTaskId:'missing-task'},{quote:request}]){const broken=structuredClone(snapshot);Object.assign(broken.detectedObligations![0],patch);await expect(restoreBackup(broken)).rejects.toThrow()}
  })
})
