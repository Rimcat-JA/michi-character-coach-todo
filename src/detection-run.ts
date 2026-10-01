import Dexie from 'dexie'
import { canonicalJSON, contentDigest } from './canonical'
import { changePolicyFor } from './change-set'
import { assertOperationAllowed } from './automation-policy'
import { newTaskInput } from './commands'
import { emptyScore, uid, validateTaskDue, type Settings } from './domain'
import { deadlineClock } from './recurrence-phrase'
import { isTimeZone, localDateAt, localTimeAt } from './zoned-time'
import { normalizeSourceText, readSource, recordSourceSent, sourceSpans, sourceDb as db } from './source-library'
import { applyAssistedTasks, prepareAssistedTasks, type PreparedAssistedTasks } from './task-assist'
import { detectionClaims, detectionDeliveryMode, detectionSemanticsPassed, inspectDetectionOutput, parseDetectionOutput, parseDetectionVerification, type DetectionChange, type DetectionOutput, type DetectionRequest, type DetectionVerification } from './detection-contract'
import { loadCalendarRulesState } from './calendar-rules-save'
import { validateRoutineAssistCandidate, validateRoutineAssistSelection, validateRoutineInstructionPeriod, type RoutineAssistCandidate, type RoutineAssistInput } from './routine-assist'
import { applyRoutineAssistConfigurationFromUI, prepareSourceRoutineConfiguration, type PreparedRoutineAssistance, type RoutineSourceGuard } from './routine-assist-save'
import { verifiedRecurrenceTrigger } from './detection-recurrence-pattern'
import { detectionProvenanceNotes, quoteDigest } from './task-source-evidence'

export type DetectionSourceGuard = {sourceId:string;sourceRevision:number;snapshotRevision:number;permissionRevision:number;sha256:string}
export type DetectionIdentityOptions = {
  confirmedAliases:string[];authorIsOwner:boolean;existingTaskIds:string[]
  participationBindings?:DetectionRequest['trusted_context']['participation_bindings'];approvedRules?:DetectionRequest['trusted_context']['approved_rules']
}
export type PreparedDetection = {
  id:string;ownerId:string;datasetId:string;policyEpoch:number;sourcePermissionRevision:number;model:string;createdAt:string;expiresAt:string
  source:DetectionSourceGuard;request:DetectionRequest;digest:string
}
export type DetectionCandidate = {id:string;change:DetectionChange;verification:DetectionVerification|null;status:'ready-for-review'|'verification-rejected'|'verification-unavailable';reason:string}
export type DetectionRun = {
  version:1;id:string;ownerId:string;datasetId:string;policyEpoch:number;sourcePermissionRevision:number;source:DetectionSourceGuard
  detectorModel:string;verifierModel:string;independentModelHoldout:false;evaluationGate:'review-only';createdAt:string;expiresAt:string
  candidates:DetectionCandidate[];reviewItems:DetectionOutput['review_items'];ignored:DetectionOutput['ignored'];coverageNotice:string;digest:string
}
export type DetectionTransport = {
  detect:(payload:{model:string;request:DetectionRequest})=>Promise<string>
  verify:(payload:{model:string;request:DetectionRequest;change:DetectionChange})=>Promise<string>
}
export type DetectionEvidenceDraft = {sourceId:string;snapshotRevision:number;spanId:string;quote:string;quoteSha256:string;supports:string[]}
export type PreparedDetectionCreate = {runId:string;candidateId:string;sourceDigest:string;assisted:PreparedAssistedTasks;evidence:DetectionEvidenceDraft[];digest:string}
export type DetectionCreationReceipt = {runId:string;candidateId:string;taskIds:string[];digest:string;appliedAt:string}
const preparedRegistry=new Map<string,PreparedDetection>(),runRegistry=new Map<string,DetectionRun>(),creationRegistry=new Map<string,PreparedDetectionCreate>()
const recurrenceRegistry=new Map<string,{run:DetectionRun;candidateId:string;prepared:PreparedRoutineAssistance}>()
export function clearDetectionAuthority(){preparedRegistry.clear();runRegistry.clear();creationRegistry.clear();recurrenceRegistry.clear()}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.freeze(value);for(const nested of Object.values(value))freeze(nested)}return value}
function trustedClick(event:Event){
  if(!(event instanceof Event)||!event.isTrusted||!['click','submit'].includes(event.type))throw new Error('本人がアプリの確認ボタンから操作してください')
  try{const getter=Object.getOwnPropertyDescriptor(Event.prototype,'type')?.get;if(!getter||!['click','submit'].includes(getter.call(event)))throw new Error()}catch{throw new Error('本人がアプリの確認ボタンから操作してください')}
}
async function settings(){const value=await db.settings.get('main');if(!value)throw new Error('本人の設定がありません');return value}
async function sourceHash(text:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,'0')).join('')}
function validIdentity(options:DetectionIdentityOptions){
  if(!options||!Array.isArray(options.confirmedAliases)||options.confirmedAliases.length>20||options.confirmedAliases.some(alias=>typeof alias!=='string'||!alias.trim()||alias.length>100)||new Set(options.confirmedAliases).size!==options.confirmedAliases.length||typeof options.authorIsOwner!=='boolean'||!Array.isArray(options.existingTaskIds)||options.existingTaskIds.length>100||options.existingTaskIds.some(id=>typeof id!=='string'||!id||id.length>200)||new Set(options.existingTaskIds).size!==options.existingTaskIds.length)throw new Error('本人表記と照合する既存タスクを確認してください')
  for(const binding of options.participationBindings??[])if(!binding||typeof binding.id!=='string'||!binding.id||typeof binding.confirmed!=='boolean'||binding.description!==undefined&&typeof binding.description!=='string')throw new Error('資料本文から所属の確認を作れません')
  for(const rule of options.approvedRules??[])if(!rule||typeof rule.id!=='string'||!rule.id||typeof rule.active!=='boolean'||rule.description!==undefined&&typeof rule.description!=='string')throw new Error('資料本文からルールの承認を作れません')
  if((options.participationBindings?.length??0)>20||(options.approvedRules?.length??0)>20)throw new Error('所属とルールの照合は各20件以内です')
}
async function assertCurrent(value:Pick<PreparedDetection,'ownerId'|'datasetId'|'policyEpoch'|'sourcePermissionRevision'|'source'|'expiresAt'>,model:string):Promise<Settings>{
  const current=await settings(),policy=changePolicyFor(current)
  if(current.profileId!==value.ownerId||current.datasetId!==value.datasetId||!current.aiEnabled||current.aiModel!==model||policy.epoch!==value.policyEpoch||policy.sourcePermissionRevision!==value.sourcePermissionRevision||Date.parse(value.expiresAt)<=Date.now())throw new Error('本人・資料・利用許可または有効期限が変わりました。もう一度検出してください')
  const {source,snapshot}=await readSource(value.source.sourceId)
  const spansMatch=await Dexie.waitFor(Promise.all([contentDigest(snapshot.spans),contentDigest(sourceSpans(snapshot.id,snapshot.text))]))
  if(source.revision!==value.source.sourceRevision||source.latestRevision!==value.source.snapshotRevision||source.permissionRevision!==value.source.permissionRevision||snapshot.revision!==value.source.snapshotRevision||snapshot.sha256!==value.source.sha256||await Dexie.waitFor(sourceHash(snapshot.text))!==value.source.sha256||normalizeSourceText(snapshot.originalText)!==snapshot.text||spansMatch[0]!==spansMatch[1]||!source.permissions.index||!source.permissions.aiEgress||source.aiProvider!=='openrouter'||!source.allowedModels.includes(model))throw new Error('資料本文の版・ハッシュまたはAI送信許可が変わりました。もう一度検出してください')
  return current
}
/** Identity assertions come from the owner's trusted UI, never document text or model output. */
export async function prepareDetectionFromUI(sourceId:string,expectedRevision:number,model:string,options:DetectionIdentityOptions,event:Event):Promise<PreparedDetection>{
  trustedClick(event);validIdentity(options)
  if(typeof model!=='string'||!/^[\w~./:-]{3,120}$/.test(model))throw new Error('モデルIDを確認してください')
  const payload=await db.transaction('r',[db.settings,db.contextSources,db.contextSnapshots,db.tasks],async()=>{
    const current=await settings(),policy=changePolicyFor(current),{source,snapshot}=await readSource(sourceId)
    if(source.revision!==expectedRevision||!current.aiEnabled||!source.permissions.index||!source.permissions.aiEgress||!source.allowedModels.includes(model))throw new Error('選択資料とモデルへのAI送信は許可されていません')
    if(snapshot.text.length>50000||snapshot.spans.length>2000)throw new Error('義務検出は50,000文字・2,000行以内の資料で使えます')
    const tasks=await db.tasks.bulkGet(options.existingTaskIds)
    if(tasks.some(task=>!task||task.deletedAt))throw new Error('照合対象の既存タスクが変わりました')
    const guard={sourceId:source.id,sourceRevision:source.revision,snapshotRevision:snapshot.revision,permissionRevision:source.permissionRevision,sha256:snapshot.sha256}
    const request:DetectionRequest={trusted_context:{user_id:current.profileId,verified_actor_ids:[current.profileId],source_access:[source.id],ai_egress_allowed:true,coverage:'incomplete',participation_bindings:structuredClone(options.participationBindings??[]),approved_rules:structuredClone(options.approvedRules??[]),existing_tasks:tasks.map(task=>({id:task!.id,revision:task!.revision,title:task!.title,dueDate:task!.dueDate,assignee_id:current.profileId})),verified_reference_aliases:Object.fromEntries(options.confirmedAliases.map(alias=>[alias,current.profileId])),alias_scope:'本人がこの検出操作で明示確認した表記だけ。本文の表示名やCCから本人を推測しない。'},sources:[{source_id:source.id,revision:snapshot.revision,author_id:options.authorIsOwner?current.profileId:'unverified-import-author',sent_at:source.date,timezone:source.timezone,kind:'manual-import',spans:snapshot.spans.map(span=>({span_id:span.id,text:span.text}))}]}
    return {id:uid(),ownerId:current.profileId,datasetId:current.datasetId,policyEpoch:policy.epoch,sourcePermissionRevision:policy.sourcePermissionRevision,model,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+24*60*60*1000).toISOString(),source:guard,request}
  })
  const prepared=freeze({...payload,digest:await contentDigest(payload)})
  await assertCurrent(prepared,model)
  preparedRegistry.set(prepared.id,prepared)
  return prepared
}
export async function detectObligationsForSource(prepared:PreparedDetection,transport:DetectionTransport):Promise<DetectionRun>{
  if(preparedRegistry.get(prepared.id)!==prepared)throw new Error('この検出操作を本人の画面から準備してください')
  // The body-free send record is written before the source spans leave, so a failed reply still counts as a possible provider copy.
  await db.transaction('rw',[db.settings,db.contextSources,db.contextSnapshots,db.audits],async()=>{await assertCurrent(prepared,prepared.model);await recordSourceSent({id:prepared.source.sourceId,latestRevision:prepared.source.snapshotRevision,permissionRevision:prepared.source.permissionRevision},prepared.model,'source-detection')})
  const output=parseDetectionOutput(await transport.detect({model:prepared.model,request:structuredClone(prepared.request)}))
  await assertCurrent(prepared,prepared.model)
  const inspection=inspectDetectionOutput(output,prepared.request)
  if(inspection.status==='reject')throw new Error(`出典または義務の根拠が不正です: ${inspection.reasons.join(', ')}`)
  const candidates:DetectionCandidate[]=[]
  for(const change of output.changes){
    await assertCurrent(prepared,prepared.model)
    let verification:DetectionVerification|null=null,status:DetectionCandidate['status']='verification-unavailable',reason='意味検証を確認できません。登録には使えません。'
    try{
      verification=parseDetectionVerification(await transport.verify({model:prepared.model,request:structuredClone(prepared.request),change:structuredClone(change)}),prepared.request)
      const passed=detectionSemanticsPassed(change,verification)
      status=passed?'ready-for-review':'verification-rejected'
      reason=passed?'別の検証呼び出しで根拠を照合しました。同じモデルのため本人による確認が必要です。':'担当・現在有効性・内容の根拠が不足または矛盾しています。登録には使えません。'
    }catch{ /* No retry or automatic fallback: verification failure leaves only an Inbox observation. */ }
    await assertCurrent(prepared,prepared.model)
    candidates.push({id:uid(),change:structuredClone(change),verification,status,reason})
  }
  const payload={version:1 as const,id:prepared.id,ownerId:prepared.ownerId,datasetId:prepared.datasetId,policyEpoch:prepared.policyEpoch,sourcePermissionRevision:prepared.sourcePermissionRevision,source:prepared.source,detectorModel:prepared.model,verifierModel:prepared.model,independentModelHoldout:false as const,evaluationGate:detectionDeliveryMode('A1'),createdAt:new Date().toISOString(),expiresAt:prepared.expiresAt,candidates,reviewItems:structuredClone(output.review_items),ignored:structuredClone(output.ignored),coverageNotice:'選択して取り込んだ資料の範囲だけを確認しました。外部会話の全履歴、未取得の添付や期間は未確認です。0件でも義務がないとは確定しません。'}
  const run=freeze({...payload,digest:await contentDigest(payload)})
  const savedPayload=JSON.stringify(run)
  if(savedPayload.length>200000)throw new Error('検出候補が保存上限を超えました。資料を小さな範囲に分けて再検出してください。タスクは作成していません。')
  await db.transaction('rw',[db.settings,db.contextSources,db.contextSnapshots,db.sourceArtifacts],async()=>{
    await assertCurrent(prepared,prepared.model)
    await db.sourceArtifacts.put({id:`detection:${run.id}`,ownerId:run.ownerId,sourceId:run.source.sourceId,sourceRevision:run.source.snapshotRevision,permissionRevision:run.source.permissionRevision,kind:'candidate',payload:savedPayload,createdAt:run.createdAt})
  })
  runRegistry.set(run.id,run);preparedRegistry.delete(prepared.id)
  return run
}
export function isLiveDetectionRun(run:DetectionRun){return runRegistry.get(run.id)===run}
function registeredRun(run:DetectionRun){if(!isLiveDetectionRun(run))throw new Error('保存済み候補の承認権限は復元しません。資料をもう一度検出してください')}
function recurrenceCandidate(run:DetectionRun,candidateId:string){
  registeredRun(run)
  const candidate=run.candidates.find(item=>item.id===candidateId)
  if(!candidate||candidate.status!=='ready-for-review'||!candidate.verification||!detectionSemanticsPassed(candidate.change,candidate.verification)||candidate.change.action!=='define_recurrence'||!candidate.change.recurrence||!candidate.change.title?.trim())throw new Error('この候補は検証済みの周期定義として採用できません')
  if(!candidate.change.evidence.some(reference=>reference.supports.includes('recurrence')&&reference.quote.includes(candidate.change.recurrence!.raw)))throw new Error('周期の原文が検証対象の証拠引用と一致しません')
  return candidate
}
/** A datetime deadline is adopted only when its zone is valid, its offset agrees with that zone, and the quoted text states the same clock. */
export function groundedDetectionDeadline(due:DetectionChange['due'],fallbackZone:string|null):{dueAt:string;dueTimezone:string;dueDate:string;time:string}{
  const zone=due.timezone??fallbackZone
  if(due.kind!=='datetime'||typeof due.value!=='string'||!isTimeZone(zone)||!due.raw)throw new Error('時刻付き期限のタイムゾーンと原文を確認してください')
  const at=new Date(Date.parse(due.value)).toISOString(),literal=/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(due.value)!
  if(!/Z$/.test(due.value)&&(localDateAt(at,zone)!==literal[1]||localTimeAt(at,zone)!==literal[2]))throw new Error('期限の時刻とタイムゾーンが一致しません。原文を確認してください')
  let quoted:string|null=null
  try{quoted=deadlineClock(due.raw).time}catch{quoted=null}
  const time=localTimeAt(at,zone)
  if(quoted!==time)throw new Error('期限の原文に同じ時刻が明示されていません。原文を確認して手動編集してください')
  const result={dueAt:at,dueTimezone:zone,dueDate:localDateAt(at,zone),time}
  validateTaskDue(result);return result
}
/** A deadline the detector names counts only when it is a checked field and an evidence quote for 'due' contains its raw text. */
export const groundedDetectionDue=(change:DetectionChange)=>change.change_fields.includes('due')&&!!change.due.raw&&change.evidence.some(reference=>reference.supports.includes('due')&&reference.quote.includes(change.due.raw!))
export function detectionRecurrenceMessage(run:DetectionRun,candidateId:string){const candidate=recurrenceCandidate(run,candidateId);return `${candidate.change.title}\n${candidate.change.recurrence!.raw}`}
/** The owner supplies all calendar, participation, period and time selections.
 * Document text never becomes a current owner instruction or an approval token. */
export async function prepareDetectionRecurrenceFromUI(run:DetectionRun,candidateId:string,input:RoutineAssistInput,event:Event):Promise<PreparedRoutineAssistance>{
  trustedClick(event)
  const selected=recurrenceCandidate(run,candidateId),change=selected.change
  const datetimeDue=change.due.kind==='datetime'&&groundedDetectionDue(change)
  if(datetimeDue&&!input?.selection?.dueTime)throw new Error('時刻付き期限は周期の予定時刻へ置き換えません。原文の時刻を締め切り時刻として本人が選択してください')
  if(change.due.kind==='datetime'&&!datetimeDue)throw new Error('期限の時刻が検証済みの原文の根拠にありません。原文を確認して、締め切りは本人が手動で入力してください')
  await assertCurrent(run,run.detectorModel)
  if(input.message!==detectionRecurrenceMessage(run,candidateId)||input.targetRuleId!==null||input.expectedRuleRevision!==null)throw new Error('確認した周期の原文と新しい系列の対象が変わりました')
  const state=await loadCalendarRulesState()
  validateRoutineAssistSelection(input,state)
  const selection=input.selection
  // A quoted clock deadline becomes the step's deadline time only when the owner selected that same clock.
  if(datetimeDue){
    let grounded:ReturnType<typeof groundedDetectionDeadline>|null=null
    try{grounded=groundedDetectionDeadline(change.due,selection.timezone)}catch{grounded=null}
    if(!grounded||!selection.dueTime||grounded.time!==selection.dueTime||change.due.timezone!==null&&change.due.timezone!==selection.timezone)throw new Error('時刻付き期限は周期の予定時刻へ置き換えません。原文の時刻を締め切り時刻として本人が選択してください')
  }else if(selection.dueTime)throw new Error('原文にない締め切り時刻は追加しません')
  const options={startDate:selection.validFrom,dueTime:selection.dueTime??null,...(selection.nonexistentTime?{nonexistentTime:selection.nonexistentTime}:{}),...(selection.ambiguousTime?{ambiguousTime:selection.ambiguousTime}:{}),...(selection.unfinishedPolicy?{unfinishedPolicy:selection.unfinishedPolicy}:{})}
  const trigger=verifiedRecurrenceTrigger(change.recurrence!.raw,selection.time,options)
  for(const quote of new Set(change.evidence.filter(reference=>reference.supports.includes('recurrence')).map(reference=>reference.quote))){
    if(canonicalJSON(verifiedRecurrenceTrigger(quote,selection.time,options))!==canonicalJSON(trigger))throw new Error('周期の引用を短くして原文の条件を省略できません。本人が手動で確認してください')
    if(/今日|明日|明後日|昨日|来週|来月|今週|今月|来年|今年/.test(quote))throw new Error('資料の相対的な開始・終了日は原文の日時を確認して具体的な日付で手動入力してください')
    validateRoutineInstructionPeriod({...input,message:quote},true)
  }
  const candidate:RoutineAssistCandidate={input:structuredClone(input),definition:{title:change.title!,enabled:true,trigger,steps:[{key:'main',title:change.title!,kind:selection.stepKind,scheduledOffsetDays:selection.scheduledOffsetDays,dueOffsetDays:selection.dueOffsetDays,score:selection.stepKind==='task'?emptyScore():null,durationMinutes:selection.durationMinutes,...(selection.dueTime?{dueTime:selection.dueTime}:{})}]},notices:['検証済みの原文と本人の選択だけから、一つの周期を設定します。ポイントや準備作業は推定しません。発生回の作成は別の本人確認が必要です。']}
  validateRoutineAssistCandidate(candidate,state)
  // Citation content is the stable source identity: reimporting a selected quote
  // or changing an unrelated line must not create another copy of this series.
  // Snapshot SHA/revisions remain separate, mandatory currentness guards.
  const sourceIdentity=await contentDigest([...new Set(change.evidence.map(reference=>normalizeSourceText(reference.quote).trim()))].sort())
  const businessDigest=await contentDigest({sourceIdentity,contextId:selection.contextId,bindingId:selection.bindingId,calendarId:selection.calendarId,activityId:selection.activityId,stepKind:selection.stepKind})
  const source=await readSource(run.source.sourceId)
  const guard:RoutineSourceGuard={businessKey:`detection-recurrence-business:${run.ownerId}:${run.datasetId}:${businessDigest}`,candidateKey:`detection-recurrence:${run.ownerId}:${run.datasetId}:${run.id}:${candidateId}`,detail:{runId:run.id,candidateId,runDigest:run.digest,sourceIdentity,source:structuredClone(run.source),permissions:structuredClone(source.source.permissions),retentionUntil:source.source.retentionUntil,detectorModel:run.detectorModel,verifierModel:run.verifierModel,independentModelHoldout:false,verifiedClaims:selected.verification!.checks.map(check=>({field:check.field,verdict:check.verdict,source_refs:[...check.source_refs]}))},assertCurrent:async()=>{
    recurrenceCandidate(run,candidateId)
    await assertCurrent(run,run.detectorModel)
    const artifact=await db.sourceArtifacts.get(`detection:${run.id}`)
    if(!artifact||artifact.ownerId!==run.ownerId||artifact.sourceId!==run.source.sourceId||artifact.sourceRevision!==run.source.snapshotRevision||artifact.permissionRevision!==run.source.permissionRevision||artifact.kind!=='candidate'||artifact.payload!==JSON.stringify(run))throw new Error('検出候補が破棄または変更されました。もう一度検出してください')
  }}
  const prepared=await prepareSourceRoutineConfiguration(input,candidate,run.detectorModel,guard,event)
  recurrenceRegistry.set(prepared.id,{run,candidateId,prepared})
  return prepared
}
export async function applyDetectionRecurrenceFromUI(run:DetectionRun,candidateId:string,prepared:PreparedRoutineAssistance,confirmedDigest:string,event:Event):Promise<string>{
  trustedClick(event);recurrenceCandidate(run,candidateId)
  const registered=recurrenceRegistry.get(prepared.id)
  if(!registered||registered.run!==run||registered.candidateId!==candidateId||registered.prepared!==prepared||confirmedDigest!==prepared.digest)throw new Error('本人が確認した周期の設定案が変わりました')
  return applyRoutineAssistConfigurationFromUI(prepared,confirmedDigest,event)
}
export async function prepareDetectionCreate(run:DetectionRun,candidateId:string):Promise<PreparedDetectionCreate>{
  registeredRun(run);assertOperationAllowed(changePolicyFor(await assertCurrent(run,run.detectorModel)),'detection.register')
  const candidate=run.candidates.find(item=>item.id===candidateId)
  if(!candidate||candidate.status!=='ready-for-review'||!candidate.verification||!detectionSemanticsPassed(candidate.change,candidate.verification)||candidate.change.action!=='create')throw new Error('この候補は新規タスクとして登録できません。確認事項または既存タスクへの差分です。')
  // The source's recorded zone is the only trusted zone; Japanese text rarely names one, so a model-chosen zone is refused.
  const sourceZone=(await readSource(run.source.sourceId)).source.timezone,due=candidate.change.due
  if(candidate.change.change_fields.includes('due')&&due.kind==='datetime'&&due.timezone!==null&&due.timezone!==sourceZone)throw new Error('期限のタイムゾーンが資料のタイムゾーンと一致しません。原文を確認して手動編集してください')
  const deadline=candidate.change.change_fields.includes('due')&&due.kind==='datetime'?groundedDetectionDeadline({...due,timezone:sourceZone},sourceZone):null
  const duplicate=(await db.tasks.toArray()).some(task=>!task.deletedAt&&task.title.normalize('NFC').trim()===candidate.change.title!.normalize('NFC').trim())
  if(duplicate)throw new Error('同じ作業名の既存タスクがあります。新規作成せず既存タスクを確認してください')
  const input=newTaskInput(),evidence=candidate.change.evidence
  input.title=candidate.change.title!
  input.dueDate=deadline?deadline.dueDate:candidate.change.change_fields.includes('due')&&candidate.change.due.kind==='date'?candidate.change.due.value:null
  if(deadline){input.dueAt=deadline.dueAt;input.dueTimezone=deadline.dueTimezone}
  // Third-party quotes go to taskSourceEvidence (erased with the source), never into the task notes.
  input.notes=detectionProvenanceNotes(run.detectorModel,run.verifierModel,candidate.change.basis,candidate.change.obligation_state,run.id)
  if(evidence.some(reference=>reference.source_id!==run.source.sourceId||reference.revision!==run.source.snapshotRevision))throw new Error('候補の引用が検出した資料の版と一致しません')
  const evidenceRows=await Promise.all(evidence.map(async reference=>({sourceId:reference.source_id,snapshotRevision:reference.revision,spanId:reference.span_id,quote:reference.quote,quoteSha256:await quoteDigest(reference.quote),supports:[...reference.supports]})))
  const assisted=await prepareAssistedTasks([{input,notices:[],source:evidence.map(reference=>reference.quote).join('\n').slice(0,2000)}],'ai')
  const payload={runId:run.id,candidateId,sourceDigest:run.digest,assisted,evidence:evidenceRows}
  const prepared=freeze({...payload,digest:await contentDigest(payload)})
  creationRegistry.set(assisted.id,prepared)
  return prepared
}
/** Exact content + trusted human click. There is intentionally no autonomous apply API. */
export async function applyDetectionCreateFromUI(run:DetectionRun,prepared:PreparedDetectionCreate,confirmedDigest:string,event:Event):Promise<DetectionCreationReceipt>{
  trustedClick(event);registeredRun(run)
  if(creationRegistry.get(prepared.assisted.id)!==prepared||prepared.runId!==run.id||prepared.sourceDigest!==run.digest||prepared.digest!==confirmedDigest)throw new Error('確認した検出候補の内容が変わりました')
  const {digest,...payload}=prepared
  if(digest!==await contentDigest(payload))throw new Error('確認した検出候補の内容が変わりました')
  const all=[db.tasks,db.assessments,db.commands,db.audits,db.containers,db.settings,db.labelGroups,db.labelDefinitions,db.contextSources,db.contextSnapshots,db.sourceArtifacts,db.taskSourceEvidence]
  return db.transaction('rw',all,async()=>{
    assertOperationAllowed(changePolicyFor(await assertCurrent(run,run.detectorModel)),'detection.register')
    if(!await db.sourceArtifacts.get(`detection:${run.id}`))throw new Error('候補が破棄されました。もう一度検出してください')
    const existing=await db.commands.get(`assist:${prepared.assisted.id}`)
    if(!existing&&(await db.tasks.toArray()).some(task=>!task.deletedAt&&task.title.normalize('NFC').trim()===prepared.assisted.inputs[0].title.normalize('NFC').trim()))throw new Error('同じ作業が既に登録されています。既存タスクを確認してください')
    const ids=await applyAssistedTasks(prepared.assisted,prepared.assisted.digest),auditAt=new Date().toISOString(),auditId=`detection-approval:${prepared.assisted.id}`,owner=await settings()
    for(const [index,row] of prepared.evidence.entries())if(ids[0]&&!await db.taskSourceEvidence.get(`detection:${prepared.assisted.id}:${index}`))await db.taskSourceEvidence.add({id:`detection:${prepared.assisted.id}:${index}`,ownerId:owner.profileId,datasetId:owner.datasetId,taskId:ids[0],sourceId:row.sourceId,snapshotRevision:row.snapshotRevision,permissionRevision:run.source.permissionRevision,spanId:row.spanId,quote:row.quote,quoteSha256:row.quoteSha256,supports:[...row.supports],runId:run.id,candidateId:prepared.candidateId,createdAt:auditAt})
    if(!await db.audits.get(auditId))await db.audits.add({id:auditId,taskId:ids[0]??null,operation:'detection.approved',at:auditAt,detail:JSON.stringify({runId:run.id,candidateId:prepared.candidateId,digest:confirmedDigest,source:run.source,detectorModel:run.detectorModel,verifierModel:run.verifierModel,independentModelHoldout:false,approvedBy:run.ownerId,policyEpoch:run.policyEpoch,sourcePermissionRevision:run.sourcePermissionRevision,taskIds:ids})})
    return {runId:run.id,candidateId:prepared.candidateId,taskIds:ids,digest:confirmedDigest,appliedAt:auditAt}
  })
}
export async function discardDetectionRun(run:DetectionRun){
  await db.transaction('rw',[db.settings,db.sourceArtifacts],async()=>{if((await settings()).profileId!==run.ownerId)throw new Error('本人の候補ではありません');await db.sourceArtifacts.delete(`detection:${run.id}`)})
  runRegistry.delete(run.id)
  for(const [id,value] of creationRegistry)if(value.runId===run.id)creationRegistry.delete(id)
  for(const [id,value] of recurrenceRegistry)if(value.run.id===run.id)recurrenceRegistry.delete(id)
}
/** Persisted history is display-only; serialized review data cannot restore an approval. */
export async function savedDetectionRuns(ownerId:string):Promise<DetectionRun[]>{
  const artifacts=(await db.sourceArtifacts.where('ownerId').equals(ownerId).toArray()).filter(item=>item.kind==='candidate'&&item.id.startsWith('detection:')),runs:DetectionRun[]=[]
  for(const artifact of artifacts){try{
    if(artifact.payload.length>200000)continue
    const value:unknown=JSON.parse(artifact.payload)
    if(!validSavedRun(value)||value.ownerId!==ownerId||value.id!==artifact.id.slice('detection:'.length)||value.source.sourceId!==artifact.sourceId||value.source.snapshotRevision!==artifact.sourceRevision||value.source.permissionRevision!==artifact.permissionRevision)continue
    const {digest,...payload}=value;if(digest!==await contentDigest(payload))continue;runs.push(value)
  }catch{/* Malformed imported cache has no authority and is not rendered. */}}
  return runs.sort((left,right)=>right.createdAt.localeCompare(left.createdAt))
}
function validSavedRun(input:unknown):input is DetectionRun{
  const object=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype)
  const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))
  const text=(value:unknown,max=200)=>typeof value==='string'&&Boolean(value.trim())&&value.length<=max
  const integer=(value:unknown,min=0)=>Number.isSafeInteger(value)&&Number(value)>=min
  const date=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))
  const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
  if(!object(input)||!exact(input,['version','id','ownerId','datasetId','policyEpoch','sourcePermissionRevision','source','detectorModel','verifierModel','independentModelHoldout','evaluationGate','createdAt','expiresAt','candidates','reviewItems','ignored','coverageNotice','digest'])||input.version!==1||!text(input.id)||!text(input.ownerId)||!text(input.datasetId)||!integer(input.policyEpoch)||!integer(input.sourcePermissionRevision)||!text(input.detectorModel,120)||!text(input.verifierModel,120)||input.detectorModel!==input.verifierModel||input.independentModelHoldout!==false||input.evaluationGate!=='review-only'||!date(input.createdAt)||!date(input.expiresAt)||!text(input.coverageNotice,1000)||!digest(input.digest))return false
  if(!object(input.source)||!exact(input.source,['sourceId','sourceRevision','snapshotRevision','permissionRevision','sha256'])||!text(input.source.sourceId)||!integer(input.source.sourceRevision,1)||!integer(input.source.snapshotRevision,1)||!integer(input.source.permissionRevision,1)||!digest(input.source.sha256)||!Array.isArray(input.candidates)||input.candidates.length>50)return false
  const candidateIds=new Set<string>()
  for(const candidate of input.candidates){
    if(!object(candidate)||!exact(candidate,['id','change','verification','status','reason'])||!text(candidate.id)||candidateIds.has(candidate.id as string)||!['ready-for-review','verification-rejected','verification-unavailable'].includes(candidate.status as string)||!text(candidate.reason,2000))return false
    candidateIds.add(candidate.id as string)
    if(candidate.verification!==null){
      const verification=candidate.verification
      if(!object(verification)||!exact(verification,['verdict','checks'])||!['entailed','contradicted','unknown'].includes(verification.verdict as string)||!Array.isArray(verification.checks)||verification.checks.length>6)return false
      const fields=new Set<string>()
      for(const check of verification.checks){
        if(!object(check)||!exact(check,['field','verdict','source_refs','reason'])||!detectionClaims.includes(check.field as typeof detectionClaims[number])||fields.has(check.field as string)||!['entailed','contradicted','unknown'].includes(check.verdict as string)||!text(check.reason,1000)||!Array.isArray(check.source_refs)||check.source_refs.length>20||check.source_refs.some(ref=>!text(ref,600)))return false
        fields.add(check.field as string)
      }
    }
  }
  try{parseDetectionOutput(JSON.stringify({schema_version:'1',changes:input.candidates.map(candidate=>(candidate as Record<string,unknown>).change),review_items:input.reviewItems,ignored:input.ignored}))}catch{return false}
  return true
}
