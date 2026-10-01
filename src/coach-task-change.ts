import { addDays, validateDate, type ScoreMode, type Task } from './domain'
import { prepareTaskChanges, type ChangeContext, type PreparedChangeSet, type TaskChangePatch } from './change-set'
import type { VerifiedTaskInstruction } from './task-user-instruction'
import { db } from './db'
import { loadTaskEgress, recordEgressAudit, type TaskEgress } from './egress-policy'

export type CoachTaskSnapshot = Pick<Task,'id'|'title'|'notes'|'scheduledDate'|'dueDate'|'revision'> & { scoreMode?:ScoreMode; manualPoints?:number|null }
export type CoachTaskProposal = { targetId:string; targetRevision:number; patch:TaskChangePatch; reason:string }
export type CoachTaskChangeRequest = { model:string; message:string; task:CoachTaskSnapshot & {scoreMode:ScoreMode;manualPoints:number|null} }
function record(value:unknown):value is Record<string,unknown>{return Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype)}
function exactKeys(value:Record<string,unknown>,keys:string[]){return Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))}
function checkSelection(task:CoachTaskSnapshot|undefined){
  if(!task||typeof task.id!=='string'||!task.id||!Number.isInteger(task.revision)||task.revision<1)throw new Error('変更するタスクを一つ選択してください')
}
export function requestsDeadlineChange(instruction:string){
  const text=instruction.replace(/(?:締め?切り|期限)(?:は|を)?(?:変えず(?:に)?|変更せず(?:に)?|そのまま|維持(?:して)?|変えない(?:で)?|変更しない(?:で)?|動かさず(?:に)?)/g,'')
  return /締め?切り|期限|dueDate|due_date/.test(text)
}
// 「今日は無理」 states the person's condition, not a target date.
const conditionOnly=/(?:今日|本日|明日)は?(?:もう)?(?:無理|むり|できない|できなさそう|厳しい|きびしい|きつい|難しい|休み|休む|疲れ(?:た|てる|ている|てて)?)(?:(?:なので|ので|だから|から|けど|けれど|し)[、。,，\s]?|(?=[、。,，\s]|$))/g
// Relative dates this reader does not parse must never collapse to 今日/明日.
const unreadRelative=/明後日|あさって|明々後日|しあさって|来週|再来週|\d+日後/
const unreadError='この日付の言い方は読み取れません。手動欄で予定日を指定してください'
export function requestedScheduleDate(instruction:string,referenceDate:string):string|null|undefined{
  validateDate(referenceDate,'基準日')
  instruction=instruction.replace(conditionOnly,'')
  if(requestsDeadlineChange(instruction)&&!/予定日|実施日|日程/.test(instruction))throw new Error('予定日と締め切りは別の変更項目です。予定日を明示してください')
  if(/予定日.*(?:解除|消して|空欄|未設定)|(?:予定|日程).*(?:外して|取り消して)/.test(instruction))return null
  if(/までに?/.test(instruction)&&!/予定日|実施日|日程/.test(instruction))throw new Error('予定日と締め切りのどちらを変えるか不明です。手動欄で予定日を確認してください')
  if(unreadRelative.test(instruction))throw new Error(unreadError)
  const dates=new Set<string>()
  if(/明日/.test(instruction))dates.add(addDays(referenceDate,1))
  if(/今日/.test(instruction))dates.add(referenceDate)
  for(const match of instruction.matchAll(/\d{4}-\d{2}-\d{2}/g)){validateDate(match[0],'予定日');dates.add(match[0])}
  if(dates.size>1)throw new Error('移動先の日付が複数あります。手動欄で予定日を一つ指定してください')
  return [...dates][0]
}
function negatedField(instruction:string,field:string){
  return new RegExp(`(?:${field})(?:には|は|を|に|の変更は)?[^。；;、,\\n]{0,30}(?:変えず|変更せず|変えない|変更しない|そのまま|維持|触らない|触らず|動かさず|書き換えない|編集しない)`,'i').test(instruction)
}
const notesRequested=(instruction:string)=>/メモ|ノート|説明|手順|補足|追記|書き加え|書き足|notes\b/i.test(instruction)&&!negatedField(instruction,'メモ|ノート|説明|手順|補足|notes\\b')
const scheduleRequested=(instruction:string)=>/(?:予定日|実施日|日程|延期|移し|移す|移動|ずら|動か)|(?:今日|明日|\d{4}-\d{2}-\d{2})(?:に|へ).*して/.test(instruction)
const titleRequested=(instruction:string)=>/タイトル|タスク名|作業名|title\b/i.test(instruction)&&/変更|変え|改名|修正|短く|長く|にして|にする/.test(instruction)&&!negatedField(instruction,'タイトル|タスク名|作業名|title\\b')
const pointsRequested=(instruction:string)=>/ポイント|\d+\s*pt\b|\d+\s*点/i.test(instruction.normalize('NFKC'))&&!negatedField(instruction.normalize('NFKC'),'ポイント|\\d+\\s*pt\\b|\\d+\\s*点')
export function requestedManualPoints(instruction:string,currentPoints:number|null|undefined):number|undefined{
  if(!pointsRequested(instruction))return undefined
  const normalized=instruction.normalize('NFKC')
  if(/変更しない|変えない|そのまま|維持|触らない|しないで|不要|ではない|じゃない/.test(normalized))throw new Error('ポイントを変更する明示的な指示を確認してください')
  if(/半分|倍|見積|見積も|推定|自動|適当|おまかせ|計算|くらい|ぐらい|程度|以下|以上|[〜～]|\d+\.\d+\s*(?:pt|ポイント|点)|[+\-−]\s*\d+\s*(?:pt|ポイント|点)/i.test(normalized))throw new Error('変更後の必要ポイントを具体的な整数で指定してください。推定値は手動値にしません。')
  const transition=normalized.match(/(\d+)\s*(?:pt|ポイント|点)\s*(?:から|を|→|->)\s*(\d+)\s*(?:pt|ポイント|点)/i)
  if(transition){if(currentPoints!==Number(transition[1]))throw new Error('指示の変更前ポイントが選択タスクと一致しません'); const values=[...normalized.matchAll(/(\d+)\s*(?:pt|ポイント|点)/gi)];if(values.length!==2)throw new Error('変更後のポイントを一つ指定してください');const points=Number(transition[2]);if(!Number.isSafeInteger(points)||points>100000)throw new Error('ポイントは0〜100000の整数です');return points}
  const found=[...normalized.matchAll(/(\d+)\s*(?:pt|ポイント|点)/gi)]
  if(found.length!==1||/(?:^|\s)-\d/.test(normalized))throw new Error('変更後のポイントを一つ指定してください')
  const points=Number(found[0][1]);if(!Number.isSafeInteger(points)||points>100000)throw new Error('ポイントは0〜100000の整数です');return points
}
export function requestedDeadlineDate(instruction:string,referenceDate:string):string|null|undefined{
  validateDate(referenceDate,'基準日')
  if(!requestsDeadlineChange(instruction))return undefined
  if(/変更しない|変えない|そのまま|維持|触らない|しないで|不要|ではない|じゃない/.test(instruction))throw new Error('本当の締め切りを変更する指示を確認してください')
  if(/(?:締め?切り|期限).*(?:解除|消して|空欄|未設定)/.test(instruction))return null
  if(unreadRelative.test(instruction))throw new Error(unreadError)
  const dates=new Set<string>()
  if(/明日/.test(instruction))dates.add(addDays(referenceDate,1))
  if(/今日/.test(instruction))dates.add(referenceDate)
  for(const match of instruction.matchAll(/\d{4}-\d{2}-\d{2}/g)){validateDate(match[0],'期限');dates.add(match[0])}
  if(dates.size!==1)throw new Error('本当の締め切りを一つ確定できません。本人の期限欄で確認してください')
  return [...dates][0]
}
export function createCoachTaskRequest(task:CoachTaskSnapshot|undefined,instruction:string,model:string,referenceDate:string,timezone:string):CoachTaskChangeRequest{
  checkSelection(task)
  if(typeof instruction!=='string'||!instruction.trim()||instruction.length>4000)throw new Error('変更の相談文は1〜4000文字で入力してください')
  if(typeof model!=='string'||!/^[\w~./:-]{3,120}$/.test(model))throw new Error('モデルIDを確認してください')
  validateDate(referenceDate,'基準日')
  try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format()}catch{throw new Error('会話のタイムゾーンが不正です')}
  if(notesRequested(instruction)&&task!.notes.length>6000)throw new Error('長いメモの変更は、原文を保てるタスク編集画面で行ってください')
  return {model,message:`会話の基準日: ${referenceDate}\nタイムゾーン: ${timezone}\n本人の相談文（対象は添付した一つのタスクだけ）:\n${instruction}`,task:{id:task!.id,title:task!.title,notes:notesRequested(instruction)?task!.notes:'',scheduledDate:task!.scheduledDate,dueDate:task!.dueDate,revision:task!.revision,scoreMode:pointsRequested(instruction)?task!.scoreMode??'unset':'unset',manualPoints:pointsRequested(instruction)?task!.manualPoints??null:null}}
}
/** The AI payload gets egress-filtered notes: source quotes stay home because a notes patch would copy them back. */
export async function prepareCoachTaskRequest(task:Task,instruction:string,model:string,referenceDate:string,timezone:string):Promise<{request:CoachTaskChangeRequest;egress:TaskEgress}>{
  const destination={kind:'ai-model' as const,route:'coach-task-change' as const,model},egress=await loadTaskEgress(task,destination)
  if(egress.notesWithheld&&notesRequested(instruction))throw new Error('このメモには資料由来の可能性がある旧形式の引用が残っているためAIへ送りません。メモの変更はタスク編集画面で本人が行ってください')
  const request=createCoachTaskRequest({id:task.id,title:task.title,notes:egress.notes,scheduledDate:task.scheduledDate,dueDate:task.dueDate,revision:task.revision,scoreMode:task.score.mode,manualPoints:task.score.mode==='manual'||task.score.mode==='allocated'?task.score.manualPoints:null},instruction,model,referenceDate,timezone)
  await db.transaction('rw',db.audits,()=>recordEgressAudit(destination,[{taskId:task.id,egress:request.task.notes?egress:{...egress,notes:'',withheldQuotes:0,notesWithheld:false}}]))
  return {request,egress}
}
export function parseCoachTaskChange(answer:string,task:CoachTaskSnapshot|undefined,instruction:string,referenceDate:string):CoachTaskProposal{
  checkSelection(task)
  if(typeof answer!=='string'||answer.length>60000)throw new Error('コーチの変更案の大きさが不正です')
  let parsed:unknown
  try{parsed=JSON.parse(answer)}catch{throw new Error('コーチの変更案を読めませんでした。相談文と手動欄は残っています。')}
  if(!record(parsed)||!exactKeys(parsed,['patch','reason'])||!record(parsed.patch)||!Object.keys(parsed.patch).length||Object.keys(parsed.patch).some(field=>!['title','notes','scheduledDate','dueDate','manualPoints'].includes(field))||typeof parsed.reason!=='string'||!parsed.reason.trim()||parsed.reason.length>1000)throw new Error('コーチの変更案の形式が不正です。許可した既存タスクの項目だけを変更できます。')
  const patch:TaskChangePatch={}
  if(Object.hasOwn(parsed.patch,'title')){
    if(!titleRequested(instruction)||typeof parsed.patch.title!=='string'||!parsed.patch.title.trim()||parsed.patch.title.length>300)throw new Error('タイトル変更の本人指示と候補を確認してください')
    patch.title=parsed.patch.title.trim()
  }
  if(Object.hasOwn(parsed.patch,'notes')){
    if(typeof parsed.patch.notes!=='string'||parsed.patch.notes.length>50000)throw new Error('メモ候補は50,000文字以内の文章にしてください')
    if(!notesRequested(instruction))throw new Error('予定の移動だけの相談にはメモ変更を含めません。必要ならメモ変更を指定してください。')
    patch.notes=parsed.patch.notes
  }
  if(Object.hasOwn(parsed.patch,'scheduledDate')){
    if(parsed.patch.scheduledDate!==null&&typeof parsed.patch.scheduledDate!=='string')throw new Error('予定日の候補が不正です')
    validateDate(parsed.patch.scheduledDate as string|null,'予定日')
    const requested=requestedScheduleDate(instruction,referenceDate)
    if(!scheduleRequested(instruction))throw new Error('予定日を変更する指示が不明です。手動欄で確認してください。')
    if(requested===undefined)throw new Error('移動先の日付を一つに確定できません。手動欄で予定日を指定してください。')
    if(requested!==parsed.patch.scheduledDate)throw new Error('予定日候補が相談文の日付と一致しません。手動欄で確認してください。')
    patch.scheduledDate=parsed.patch.scheduledDate as string|null
  }
  if(Object.hasOwn(parsed.patch,'dueDate')){
    if(parsed.patch.dueDate!==null&&typeof parsed.patch.dueDate!=='string')throw new Error('期限候補が不正です')
    validateDate(parsed.patch.dueDate as string|null,'期限')
    const requested=requestedDeadlineDate(instruction,referenceDate)
    if(requested===undefined||requested!==parsed.patch.dueDate)throw new Error('期限候補が本人の明示した締め切りと一致しません')
    patch.dueDate=parsed.patch.dueDate as string|null
  }
  if(Object.hasOwn(parsed.patch,'manualPoints')){
    if(!Number.isInteger(parsed.patch.manualPoints)||Number(parsed.patch.manualPoints)<0||Number(parsed.patch.manualPoints)>100000)throw new Error('ポイント候補が不正です')
    const requested=requestedManualPoints(instruction,task!.manualPoints)
    if(requested===undefined||requested!==parsed.patch.manualPoints)throw new Error('ポイント候補が本人の指定値と一致しません')
    patch.manualPoints=parsed.patch.manualPoints as number
  }
  return {targetId:task!.id,targetRevision:task!.revision,patch,reason:parsed.reason.trim()}
}
export async function prepareCoachTaskChange(proposal:CoachTaskProposal,latest:CoachTaskSnapshot|undefined,context:ChangeContext,instruction:VerifiedTaskInstruction|null=null):Promise<PreparedChangeSet>{
  checkSelection(latest)
  if(proposal.targetId!==latest!.id||proposal.targetRevision!==latest!.revision)throw new Error('選択したタスクまたは版が変わりました。新しい内容から変更案を作り直してください。')
  // Model prose is not an execution result. The preview uses a program-owned
  // description so even "saved already" in the model's reason cannot claim success.
  const labels={title:'タイトル',notes:'メモ',scheduledDate:'予定日',dueDate:'本当の締め切り',manualPoints:'本人指定ポイント'}
  const fields=Object.keys(proposal.patch).map(field=>labels[field as keyof typeof labels]).join('・')
  return prepareTaskChanges([{taskId:latest!.id,expectedRevision:latest!.revision,patch:proposal.patch}],context,`選択したタスクの${fields}を変更するコーチ候補（まだ適用していません）`,instruction)
}
/** AI-free reading of a reply such as 「今日は無理、明日に移して」: scheduledDate only, never the real deadline. */
export function scheduleOnlyPatch(task:Pick<Task,'scheduledDate'>,instruction:string,referenceDate:string):{scheduledDate?:string;notice:string}{
  if(!instruction.trim())return{notice:''}
  if(requestsDeadlineChange(instruction))return{notice:'本当の締め切りの変更は、期限欄で本人が日付を指定して確認します。予定日だけの移動なら予定日を指定してください。'}
  try{
    const date=requestedScheduleDate(instruction,referenceDate)
    if(typeof date!=='string'||!scheduleRequested(instruction))return{notice:'相談文から予定日を一つに決められませんでした。予定日欄で指定してください。'}
    if(date===task.scheduledDate)return{notice:`予定日はすでに ${date} です。`}
    return{scheduledDate:date,notice:`相談文から予定日だけを ${date} に入れました（締め切りは変えません）。まだ適用していません。`}
  }catch(error){return{notice:error instanceof Error?error.message:String(error)}}
}
