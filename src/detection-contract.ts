import { validateDate } from './domain'

export const detectionClaims = ['action','assignee','active','due','recurrence','target'] as const
export type DetectionClaim = typeof detectionClaims[number]
export type DetectionAction = 'create'|'update'|'cancel'|'report_completion'|'define_recurrence'
export type DetectionEvidence = {source_id:string;revision:number;span_id:string;quote:string;supports:DetectionClaim[]}
export type DetectionDue = {kind:'none'|'date'|'datetime'|'unresolved';value:string|null;timezone:string|null;raw:string|null}
export type DetectionChange = {
  action:DetectionAction;target_task_id:string|null;expected_revision:number|null;title:string|null;assignee_id:string|null
  basis:'explicit_request'|'self_commitment'|'documented_obligation'|'approved_rule';obligation_state:'requested'|'committed'|'required_by_rule'
  change_fields:('title'|'assignee'|'due'|'recurrence')[];due:DetectionDue
  recurrence:{expression:string;timezone:string;calendar_ref:string|null;raw:string}|null
  applicability_ref:string|null;rule_ref:string|null;evidence:DetectionEvidence[]
}
export type DetectionReview = {source_ids:string[];reason:'assignee_unknown'|'date_unknown'|'condition_unmet'|'conflict'|'coverage_incomplete'|'reference_unknown'|'rule_unknown';question:string}
export type DetectionOutput = {schema_version:'1';changes:DetectionChange[];review_items:DetectionReview[];ignored:{source_id:string;reason:string}[]}
export type DetectionRequest = {
  trusted_context:{
    user_id:string;verified_actor_ids:string[];source_access:string[];ai_egress_allowed:boolean;coverage:'complete'|'incomplete'
    participation_bindings:{id:string;confirmed:boolean;description?:string}[];approved_rules:{id:string;active:boolean;description?:string}[]
    existing_tasks:{id:string;revision:number;title:string;dueDate?:string|null;assignee_id?:string}[]
    verified_reference_aliases:Record<string,string>;alias_scope:string
  }
  sources:{source_id:string;revision:number;author_id:string;sent_at:string|null;timezone:string|null;kind:string;spans:{span_id:string;text:string}[]}[]
}
export type DetectionVerification = {verdict:'entailed'|'contradicted'|'unknown';checks:{field:DetectionClaim;verdict:'entailed'|'contradicted'|'unknown';source_refs:string[];reason:string}[]}
export type DetectionInspection = {status:'reject'|'review'|'structural_pass';reasons:string[]}

function object(value:unknown):value is Record<string,unknown>{return Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype)}
function keys(value:Record<string,unknown>,expected:string[]){return Object.keys(value).length===expected.length&&expected.every(key=>Object.hasOwn(value,key))}
function text(value:unknown,max=200){return typeof value==='string'&&value.length>0&&value.length<=max}
function nullableText(value:unknown,max=200){return value===null||text(value,max)}
function integer(value:unknown){return Number.isSafeInteger(value)&&Number(value)>=1}
function list(value:unknown,max:number,predicate:(item:unknown)=>boolean,unique=false){return Array.isArray(value)&&value.length<=max&&value.every(predicate)&&(!unique||new Set(value).size===value.length)}
function fail():never{throw new Error('義務検出のJSON形式が不正です。承認や権限を含む出力は受け付けません。')}
function due(value:unknown){
  if(!object(value)||!keys(value,['kind','value','timezone','raw'])||!['none','date','datetime','unresolved'].includes(value.kind as string)||!nullableText(value.value,100)||!nullableText(value.timezone,100)||!nullableText(value.raw,2000))return false
  if(['none','unresolved'].includes(value.kind as string)&&value.value!==null)return false
  if(value.kind==='date'){try{if(typeof value.value!=='string'||!value.value)return false;validateDate(value.value,'期限')}catch{return false}}
  if(value.kind==='datetime'&&(typeof value.value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.value)||!Number.isFinite(Date.parse(value.value))))return false
  if(value.kind==='datetime'){try{validateDate((value.value as string).slice(0,10),'期限')}catch{return false}}
  return true
}
function evidence(value:unknown){return object(value)&&keys(value,['source_id','revision','span_id','quote','supports'])&&text(value.source_id)&&integer(value.revision)&&text(value.span_id,300)&&text(value.quote,2000)&&list(value.supports,6,item=>detectionClaims.includes(item as DetectionClaim),true)&&(value.supports as unknown[]).length>0}
function change(value:unknown){
  if(!object(value)||!keys(value,['action','target_task_id','expected_revision','title','assignee_id','basis','obligation_state','change_fields','due','recurrence','applicability_ref','rule_ref','evidence']))return false
  if(!['create','update','cancel','report_completion','define_recurrence'].includes(value.action as string)||!nullableText(value.target_task_id)||value.expected_revision!==null&&!integer(value.expected_revision)||!nullableText(value.title,300)||!nullableText(value.assignee_id)||!['explicit_request','self_commitment','documented_obligation','approved_rule'].includes(value.basis as string)||!['requested','committed','required_by_rule'].includes(value.obligation_state as string)||!list(value.change_fields,4,item=>['title','assignee','due','recurrence'].includes(item as string),true)||!due(value.due)||!nullableText(value.applicability_ref)||!nullableText(value.rule_ref)||!list(value.evidence,20,evidence)||(value.evidence as unknown[]).length<1)return false
  return value.recurrence===null||object(value.recurrence)&&keys(value.recurrence,['expression','timezone','calendar_ref','raw'])&&text(value.recurrence.expression,2000)&&text(value.recurrence.timezone,100)&&nullableText(value.recurrence.calendar_ref)&&text(value.recurrence.raw,2000)
}
export function parseDetectionOutput(answer:string):DetectionOutput{
  if(typeof answer!=='string'||answer.length>250000)fail()
  let value:unknown
  try{value=JSON.parse(answer)}catch{fail()}
  if(!object(value)||!keys(value,['schema_version','changes','review_items','ignored'])||value.schema_version!=='1'||!list(value.changes,50,change))fail()
  if(!list(value.review_items,50,item=>object(item)&&keys(item,['source_ids','reason','question'])&&list(item.source_ids,50,id=>text(id),true)&&['assignee_unknown','date_unknown','condition_unmet','conflict','coverage_incomplete','reference_unknown','rule_unknown'].includes(item.reason as string)&&text(item.question,1000)))fail()
  if(!list(value.ignored,100,item=>object(item)&&keys(item,['source_id','reason'])&&text(item.source_id)&&['general_advice','hypothetical','optional','other_assignee','completed','canceled','event_only','quoted_example','injection','insufficient_context','duplicate','condition_unmet','wish'].includes(item.reason as string)))fail()
  return value as DetectionOutput
}
/** Structural and provenance checks do not establish semantic entailment. */
export function inspectDetectionOutput(output:DetectionOutput,request:DetectionRequest):DetectionInspection{
  parseDetectionOutput(JSON.stringify(output))
  const context=request.trusted_context,sources=new Map(request.sources.map(source=>[source.source_id,source])),existing=new Map(context.existing_tasks.map(task=>[task.id,task])),reasons=new Set<string>()
  if(!context.ai_egress_allowed)reasons.add('EGRESS_NOT_ALLOWED')
  for(const item of output.changes){
    const claims=new Set<DetectionClaim>()
    for(const reference of item.evidence){
      const source=sources.get(reference.source_id)
      if(!source||!context.source_access.includes(reference.source_id)){reasons.add('SOURCE_NOT_AUTHORIZED');continue}
      if(source.revision!==reference.revision){reasons.add('STALE_SOURCE');continue}
      const span=source.spans.find(span=>span.span_id===reference.span_id)
      if(!span||!span.text.includes(reference.quote)){reasons.add('QUOTE_NOT_FOUND');continue}
      reference.supports.forEach(claim=>claims.add(claim))
    }
    const structuralClaims:DetectionClaim[]=['action','assignee',...(['date','datetime'].includes(item.due.kind)&&item.change_fields.includes('due')?['due' as const]:[]),...(item.action==='define_recurrence'?['recurrence' as const]:[])]
    for(const claim of structuralClaims)if(!claims.has(claim))reasons.add('MISSING_CLAIM_EVIDENCE')
    if(item.assignee_id!==context.user_id)reasons.add('ASSIGNEE_NOT_CONFIRMED')
    const state={explicit_request:'requested',self_commitment:'committed',documented_obligation:'required_by_rule',approved_rule:'required_by_rule'}[item.basis]
    if(state!==item.obligation_state)reasons.add('OBLIGATION_STATE_MISMATCH')
    if(item.basis==='self_commitment'&&!item.evidence.some(reference=>context.verified_actor_ids.includes(sources.get(reference.source_id)?.author_id??'')))reasons.add('SELF_IDENTITY_UNVERIFIED')
    if(item.basis==='documented_obligation'&&!context.participation_bindings.some(binding=>binding.confirmed&&binding.id===item.applicability_ref))reasons.add('APPLICABILITY_UNVERIFIED')
    if(item.basis==='approved_rule'&&!context.approved_rules.some(rule=>rule.active&&rule.id===item.rule_ref))reasons.add('RULE_UNAPPROVED')
    if(['update','cancel','report_completion'].includes(item.action)){
      const task=existing.get(item.target_task_id??'')
      if(!task)reasons.add('TARGET_NOT_FOUND');else if(task.revision!==item.expected_revision)reasons.add('REVISION_CONFLICT')
    }else if(item.target_task_id!==null||item.expected_revision!==null)reasons.add('UNEXPECTED_TARGET')
    if(['create','define_recurrence'].includes(item.action)&&!item.title?.trim())reasons.add('TITLE_REQUIRED')
    if(item.action==='create'&&!item.change_fields.includes('title'))reasons.add('TITLE_FIELD_REQUIRED')
    if(item.change_fields.includes('due')&&['date','datetime'].includes(item.due.kind)&&(!item.due.raw||!item.evidence.some(reference=>reference.supports.includes('due')&&reference.quote.includes(item.due.raw!))))reasons.add('DUE_UNGROUNDED')
    if(item.change_fields.includes('due')&&['date','datetime'].includes(item.due.kind)&&!item.evidence.some(reference=>reference.supports.includes('due')&&/(?:まで|締め?切[り]?|締切|期限|\bby\b|\bdeadline\b|\bdue\b|no later than|\bbefore\b|截至|截止|之前|以前|最迟|最遲)/i.test(reference.quote)))reasons.add('DATE_ROLE_UNCONFIRMED')
    if(item.action==='define_recurrence'&&(!item.recurrence||!claims.has('recurrence')))reasons.add('RECURRENCE_UNGROUNDED')
  }
  for(const item of output.review_items)if(item.source_ids.some(id=>!sources.has(id)||!context.source_access.includes(id)))reasons.add('SOURCE_NOT_AUTHORIZED')
  for(const item of output.ignored)if(!sources.has(item.source_id)||!context.source_access.includes(item.source_id))reasons.add('SOURCE_NOT_AUTHORIZED')
  if(reasons.size)return {status:'reject',reasons:[...reasons].sort()}
  return output.review_items.length||context.coverage!=='complete'?{status:'review',reasons:['REVIEW_OR_COVERAGE_PENDING']}:{status:'structural_pass',reasons:['SEMANTIC_AND_POLICY_CHECKS_STILL_REQUIRED']}
}
export function requiredDetectionClaims(item:DetectionChange):DetectionClaim[]{
  return ['action','assignee','active',...(['date','datetime'].includes(item.due.kind)&&item.change_fields.includes('due')?['due']:[]),...(item.action==='define_recurrence'?['recurrence']:[]),...(['update','cancel','report_completion'].includes(item.action)?['target']:[])] as DetectionClaim[]
}
export function parseDetectionVerification(answer:string,request:DetectionRequest):DetectionVerification{
  if(typeof answer!=='string'||answer.length>50000)fail()
  let value:unknown
  try{value=JSON.parse(answer)}catch{fail()}
  const verdict=(input:unknown)=>['entailed','contradicted','unknown'].includes(input as string)
  const pairs=request.sources.flatMap(source=>source.spans.map(span=>({sourceId:source.source_id,spanId:span.span_id})))
  const refTargets=new Map<string,Set<string>>(),canonical=new Map<string,string>()
  const spanCounts=new Map<string,number>()
  for(const pair of pairs)spanCounts.set(pair.spanId,(spanCounts.get(pair.spanId)??0)+1)
  function add(ref:string,pair:{sourceId:string;spanId:string}){const identity=JSON.stringify([pair.sourceId,pair.spanId]),targets=refTargets.get(ref)??new Set<string>();targets.add(identity);refTargets.set(ref,targets);canonical.set(identity,`${pair.sourceId}:${pair.spanId}`)}
  for(const pair of pairs){
    add(`${pair.sourceId}:${pair.spanId}`,pair)
    // Some providers return the supplied span ID itself. Accept that spelling only
    // when it already names its source and is unique across the entire request.
    if(pair.spanId.startsWith(`${pair.sourceId}:`)&&spanCounts.get(pair.spanId)===1)add(pair.spanId,pair)
  }
  const knownRef=(ref:unknown)=>typeof ref==='string'&&refTargets.get(ref)?.size===1
  if(!object(value)||!keys(value,['verdict','checks'])||!verdict(value.verdict)||!list(value.checks,6,item=>object(item)&&keys(item,['field','verdict','source_refs','reason'])&&detectionClaims.includes(item.field as DetectionClaim)&&verdict(item.verdict)&&list(item.source_refs,20,knownRef,true)&&text(item.reason,1000)))fail()
  const result=value as DetectionVerification
  result.checks=result.checks.map(check=>({...check,source_refs:check.source_refs.map(ref=>canonical.get([...refTargets.get(ref)!][0])!)}))
  if(new Set(result.checks.map(check=>check.field)).size!==result.checks.length)fail()
  if(result.checks.some(check=>new Set(check.source_refs).size!==check.source_refs.length))fail()
  if(result.verdict==='entailed'&&result.checks.some(check=>check.verdict!=='entailed'||!check.source_refs.length))fail()
  return result
}
export function detectionSemanticsPassed(item:DetectionChange,verification:DetectionVerification){
  return verification.verdict==='entailed'&&requiredDetectionClaims(item).every(field=>verification.checks.some(check=>check.field===field&&check.verdict==='entailed'&&check.source_refs.length>0))
}
/** Authority changes delivery, never extraction facts. Same-model checks cannot open an automatic path. */
export function detectionDeliveryMode(_authority:'A1'|'A2'){return 'review-only' as const}
