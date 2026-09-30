import { readFileSync } from 'node:fs'
import { describe,expect,it } from 'vitest'
import { detectionDeliveryMode,detectionSemanticsPassed,inspectDetectionOutput,parseDetectionOutput,parseDetectionVerification,type DetectionRequest } from './detection-contract'

// Unmodified synthetic API observations. Same model, not a holdout accuracy evaluation.
const evidence=JSON.parse(readFileSync(new URL('./detection-live-fixtures.json',import.meta.url),'utf8')) as {model:string;independentModelHoldout:false;results:{name:string;request:DetectionRequest;answer:string;verifications:{answer:string}[]}[]}
const deadlineEvidence=JSON.parse(readFileSync(new URL('./detection-live-deadline-fixtures.json',import.meta.url),'utf8')) as typeof evidence
describe('実APIの未改変合成観測をstrict guardsへ通す',()=>{
  it('明日の実施の約束をdeadlineへ変換した出力は意味判定entailedでも拒否する',()=>{
    const observation=evidence.results[0],parsed=parseDetectionOutput(observation.answer)
    expect(parsed.changes).toHaveLength(1)
    expect(inspectDetectionOutput(parsed,observation.request)).toEqual({status:'reject',reasons:['DATE_ROLE_UNCONFIRMED']})
    const verification=parseDetectionVerification(observation.verifications[0].answer,observation.request)
    expect(detectionSemanticsPassed(parsed.changes[0],verification)).toBe(true)
    expect(verification.checks.every(check=>check.source_refs.every(ref=>ref==='positive:positive:1:0'))).toBe(true)
    expect(evidence.independentModelHoldout).toBe(false)
    expect(detectionDeliveryMode('A2')).toBe('review-only')
  })
  it('任意・仮定・他人・取消・完了・予定・引用注入の観測は0件として保持する',()=>{
    const observation=evidence.results[1],parsed=parseDetectionOutput(observation.answer)
    expect(parsed.changes).toEqual([])
    expect(parsed.ignored.map(item=>item.reason)).toEqual(['optional','condition_unmet','other_assignee','canceled','completed','event_only','quoted_example'])
    expect(inspectDetectionOutput(parsed,observation.request).status).toBe('review')
  })
  it('span ID省略形を全資料で一意かつsource prefix一致の場合だけ正規化する',()=>{
    const observation=evidence.results[0],request=structuredClone(observation.request)
    request.sources.push({...request.sources[0],source_id:'other',spans:[{span_id:'positive:1:0',text:'別資料の同じspan ID'}]})
    expect(()=>parseDetectionVerification(observation.verifications[0].answer,request)).toThrow('JSON形式')
    const unscoped=structuredClone(observation.request);unscoped.sources[0].spans[0].span_id='s1'
    const raw=JSON.parse(observation.verifications[0].answer);raw.checks.forEach((check:{source_refs:string[]})=>{check.source_refs=['s1']})
    expect(()=>parseDetectionVerification(JSON.stringify(raw),unscoped)).toThrow('JSON形式')
  })
  it('明示期限の実API観測はaction/assignee/active/dueの厳密な根拠検証を通して本人reviewへ留める',()=>{
    const positive=deadlineEvidence.results[0],parsed=parseDetectionOutput(positive.answer),verification=parseDetectionVerification(positive.verifications[0].answer,positive.request)
    expect(inspectDetectionOutput(parsed,positive.request).status).toBe('review')
    expect(parsed.changes).toHaveLength(1)
    expect(parsed.changes[0].due).toMatchObject({kind:'date',value:'2026-10-02',raw:'2026-10-02までに'})
    expect(verification.checks.map(check=>check.field)).toEqual(['action','assignee','active','due'])
    expect(detectionSemanticsPassed(parsed.changes[0],verification)).toBe(true)
    const negative=deadlineEvidence.results[1]
    expect(parseDetectionOutput(negative.answer).changes).toEqual([])
    expect(deadlineEvidence.independentModelHoldout).toBe(false)
    expect(detectionDeliveryMode('A2')).toBe('review-only')
  })
})
