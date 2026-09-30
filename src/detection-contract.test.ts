import { describe,expect,it } from 'vitest'
import { designDetectionFixtures } from './detection-fixtures'
import { detectionDeliveryMode,detectionSemanticsPassed,inspectDetectionOutput,parseDetectionOutput,parseDetectionVerification,requiredDetectionClaims,type DetectionChange,type DetectionVerification } from './detection-contract'

const sample=()=>structuredClone(designDetectionFixtures[0])
describe('設計48例の形式・出典ガード（モデル精度測定ではない）',()=>{
  it.each(designDetectionFixtures)('$id $name',fixture=>{
    const parsed=parseDetectionOutput(JSON.stringify(fixture.output))
    expect(parsed.changes.map(change=>change.action)).toEqual(fixture.expected.actions)
    expect(inspectDetectionOutput(parsed,fixture.input).status).not.toBe('reject')
    if(fixture.expected.must_not_create)expect(parsed.changes.some(change=>change.action==='create')).toBe(false)
    if(fixture.expected.needs_review)expect(parsed.review_items.length).toBeGreaterThan(0)
    expect(detectionDeliveryMode('A1')).toEqual(detectionDeliveryMode('A2'))
  })
  it('資料の義務がないという断定は取得範囲が欠けると行わない',()=>{
    const fixture=sample();fixture.input.trusted_context.coverage='incomplete'
    expect(inspectDetectionOutput({schema_version:'1',changes:[],review_items:[],ignored:[]},fixture.input)).toEqual({status:'review',reasons:['REVIEW_OR_COVERAGE_PENDING']})
  })
  it('モデルによる承認・権限・点数・手順追加と不明なフィールドを拒否',()=>{
    for(const extra of [{approved:true},{role:'system'},{manualPoints:25},{steps:['準備']},{sourcePermissionRevision:99}]){
      const fixture=sample()
      expect(()=>parseDetectionOutput(JSON.stringify({...fixture.output,...extra}))).toThrow('JSON形式')
      expect(()=>parseDetectionOutput(JSON.stringify({...fixture.output,changes:[{...fixture.output.changes[0],...extra}]}))).toThrow('JSON形式')
    }
    for(const raw of ['説明 ```json {} ```','null','[]','{"schema_version":"1"}'])expect(()=>parseDetectionOutput(raw)).toThrow()
  })
  it('架空span・引用・資料・古い版・本人でない担当を拒否',()=>{
    const alterations=[{span_id:'missing'},{quote:'存在しない作業'},{source_id:'unauthorized'},{revision:999}]
    for(const altered of alterations){const fixture=sample();Object.assign(fixture.output.changes[0].evidence[0],altered);expect(inspectDetectionOutput(fixture.output,fixture.input).status).toBe('reject')}
    const fixture=sample();fixture.output.changes[0].assignee_id='someone-else'
    expect(inspectDetectionOutput(fixture.output,fixture.input).reasons).toContain('ASSIGNEE_NOT_CONFIRMED')
  })
  it('表示名・未確認所属・未承認ルールを信頼情報に昇格しない',()=>{
    const fixture=structuredClone(designDetectionFixtures[1]);fixture.input.sources[0].author_id='unverified-display-karin'
    expect(inspectDetectionOutput(fixture.output,fixture.input).reasons).toContain('SELF_IDENTITY_UNVERIFIED')
    const obligation=structuredClone(designDetectionFixtures[2]);obligation.input.trusted_context.participation_bindings=[]
    expect(inspectDetectionOutput(obligation.output,obligation.input).reasons).toContain('APPLICABILITY_UNVERIFIED')
    const rule=structuredClone(designDetectionFixtures[24]);rule.input.trusted_context.approved_rules=[]
    expect(inspectDetectionOutput(rule.output,rule.input).reasons).toContain('RULE_UNAPPROVED')
  })
  it('依頼を本人の約束に変換せず、未確認の既存対象と版競合を拒否',()=>{
    const fixture=sample();fixture.output.changes[0].obligation_state='committed'
    expect(inspectDetectionOutput(fixture.output,fixture.input).reasons).toContain('OBLIGATION_STATE_MISMATCH')
    const changed=structuredClone(designDetectionFixtures[16]);changed.input.trusted_context.existing_tasks[0].revision++
    expect(inspectDetectionOutput(changed.output,changed.input).reasons).toContain('REVISION_CONFLICT')
  })
  it('日付のみの期限を時刻へ変換せず、無効日付と引用にない期限原文を拒否',()=>{
    const fixture=sample();expect(fixture.output.changes[0].due.kind).toBe('date')
    fixture.output.changes[0].due.value='2026-02-30'
    expect(()=>parseDetectionOutput(JSON.stringify(fixture.output))).toThrow()
    const ungrounded=sample();ungrounded.output.changes[0].due.raw='異なる期限'
    expect(inspectDetectionOutput(ungrounded.output,ungrounded.input).reasons).toContain('DUE_UNGROUNDED')
  })
})
describe('別system呼び出しによる意味検証は承認ではない',()=>{
  function verification(change:DetectionChange):DetectionVerification{
    return {verdict:'entailed',checks:requiredDetectionClaims(change).map(field=>({field,verdict:'entailed',source_refs:['src-1:s1'],reason:'原文を照合した'}))}
  }
  it('行為・担当・現在有効性・期限すべての検証が必要',()=>{
    const fixture=sample(),valid=verification(fixture.output.changes[0])
    const parsed=parseDetectionVerification(JSON.stringify(valid),fixture.input)
    expect(detectionSemanticsPassed(fixture.output.changes[0],parsed)).toBe(true)
    expect(detectionSemanticsPassed(fixture.output.changes[0],{...valid,checks:valid.checks.filter(check=>check.field!=='active')})).toBe(false)
    expect(detectionSemanticsPassed(fixture.output.changes[0],{...valid,verdict:'unknown'})).toBe(false)
    expect(detectionSemanticsPassed(fixture.output.changes[0],{...valid,verdict:'contradicted'})).toBe(false)
  })
  it('検証器による架空参照・自己承認・矛盾した総合判定・重複fieldを拒否',()=>{
    const fixture=sample(),valid=verification(fixture.output.changes[0])
    expect(()=>parseDetectionVerification(JSON.stringify({...valid,approved:true}),fixture.input)).toThrow()
    expect(()=>parseDetectionVerification(JSON.stringify({...valid,checks:[{...valid.checks[0],source_refs:['fake:span']}]}),fixture.input)).toThrow()
    expect(()=>parseDetectionVerification(JSON.stringify({...valid,checks:[{...valid.checks[0],verdict:'unknown'}]}),fixture.input)).toThrow()
    expect(()=>parseDetectionVerification(JSON.stringify({...valid,checks:[valid.checks[0],valid.checks[0]]}),fixture.input)).toThrow()
  })
})
