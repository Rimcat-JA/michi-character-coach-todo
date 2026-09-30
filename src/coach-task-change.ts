import { addDays, validateDate, type Task } from './domain'
import { prepareTaskChanges, type ChangeContext, type PreparedChangeSet, type TaskChangePatch } from './change-set'

export type CoachTaskSnapshot = Pick<Task,'id'|'title'|'notes'|'scheduledDate'|'dueDate'|'revision'>
export type CoachTaskProposal = { targetId:string; targetRevision:number; patch:TaskChangePatch; reason:string }
export type CoachTaskChangeRequest = { model:string; message:string; task:CoachTaskSnapshot }
function record(value:unknown):value is Record<string,unknown>{return Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype)}
function exactKeys(value:Record<string,unknown>,keys:string[]){return Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))}
function checkSelection(task:CoachTaskSnapshot|undefined){
  if(!task||typeof task.id!=='string'||!task.id||!Number.isInteger(task.revision)||task.revision<1)throw new Error('変更するタスクを一つ選択してください')
}
export function requestsDeadlineChange(instruction:string){
  const text=instruction.replace(/(?:締め?切り|期限)(?:は|を)?(?:変えず(?:に)?|変更せず(?:に)?|そのまま|維持(?:して)?|変えない(?:で)?|変更しない(?:で)?|動かさず(?:に)?)/g,'')
  return /締め?切り|期限|dueDate|due_date/.test(text)
}
export function requestedScheduleDate(instruction:string,referenceDate:string):string|null|undefined{
  validateDate(referenceDate,'基準日')
  if(requestsDeadlineChange(instruction))throw new Error('本当の締め切りの変更は、タスク編集画面で期限を確認して行ってください')
  if(/予定日.*(?:解除|消して|空欄|未設定)|(?:予定|日程).*(?:外して|取り消して)/.test(instruction))return null
  if(/までに?/.test(instruction)&&!/予定日|実施日|日程/.test(instruction))throw new Error('予定日と締め切りのどちらを変えるか不明です。手動欄で予定日を確認してください')
  const dates=new Set<string>()
  if(/明日/.test(instruction))dates.add(addDays(referenceDate,1))
  if(/今日/.test(instruction))dates.add(referenceDate)
  for(const match of instruction.matchAll(/\d{4}-\d{2}-\d{2}/g)){validateDate(match[0],'予定日');dates.add(match[0])}
  if(dates.size>1)throw new Error('移動先の日付が複数あります。手動欄で予定日を一つ指定してください')
  return [...dates][0]
}
const notesRequested=(instruction:string)=>/メモ|ノート|説明|手順|補足|追記|書き加え|書き足|notes\b/i.test(instruction)
const scheduleRequested=(instruction:string)=>/(?:予定日|実施日|日程|延期|移し|移す|移動|ずら|動か)|(?:今日|明日|\d{4}-\d{2}-\d{2})(?:に|へ).*して/.test(instruction)
export function createCoachTaskRequest(task:CoachTaskSnapshot|undefined,instruction:string,model:string,referenceDate:string,timezone:string):CoachTaskChangeRequest{
  checkSelection(task)
  if(typeof instruction!=='string'||!instruction.trim()||instruction.length>4000)throw new Error('変更の相談文は1〜4000文字で入力してください')
  if(typeof model!=='string'||!/^[\w~./:-]{3,120}$/.test(model))throw new Error('モデルIDを確認してください')
  if(requestsDeadlineChange(instruction))throw new Error('本当の締め切りの変更は、タスク編集画面で期限を確認して行ってください')
  validateDate(referenceDate,'基準日')
  if(notesRequested(instruction)&&task!.notes.length>6000)throw new Error('長いメモの変更は、原文を保てるタスク編集画面で行ってください')
  return {model,message:`会話の基準日: ${referenceDate}\nタイムゾーン: ${timezone}\n本人の相談文（対象は添付した一つのタスクだけ）:\n${instruction}`,task:{id:task!.id,title:task!.title,notes:notesRequested(instruction)?task!.notes:'',scheduledDate:task!.scheduledDate,dueDate:task!.dueDate,revision:task!.revision}}
}
export function parseCoachTaskChange(answer:string,task:CoachTaskSnapshot|undefined,instruction:string,referenceDate:string):CoachTaskProposal{
  checkSelection(task)
  if(typeof answer!=='string'||answer.length>60000)throw new Error('コーチの変更案の大きさが不正です')
  let parsed:unknown
  try{parsed=JSON.parse(answer)}catch{throw new Error('コーチの変更案を読めませんでした。相談文と手動欄は残っています。')}
  if(!record(parsed)||!exactKeys(parsed,['patch','reason'])||!record(parsed.patch)||!Object.keys(parsed.patch).length||Object.keys(parsed.patch).some(field=>!['notes','scheduledDate'].includes(field))||typeof parsed.reason!=='string'||!parsed.reason.trim()||parsed.reason.length>1000)throw new Error('コーチの変更案の形式が不正です。メモと予定日だけを変更できます。')
  if(requestsDeadlineChange(instruction))throw new Error('本当の締め切りの変更は、タスク編集画面で期限を確認して行ってください')
  const patch:TaskChangePatch={}
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
  return {targetId:task!.id,targetRevision:task!.revision,patch,reason:parsed.reason.trim()}
}
export async function prepareCoachTaskChange(proposal:CoachTaskProposal,latest:CoachTaskSnapshot|undefined,context:ChangeContext):Promise<PreparedChangeSet>{
  checkSelection(latest)
  if(proposal.targetId!==latest!.id||proposal.targetRevision!==latest!.revision)throw new Error('選択したタスクまたは版が変わりました。新しい内容から変更案を作り直してください。')
  // Model prose is not an execution result. The preview uses a program-owned
  // description so even "saved already" in the model's reason cannot claim success.
  const fields=Object.keys(proposal.patch).map(field=>field==='notes'?'メモ':'予定日').join('・')
  return prepareTaskChanges([{taskId:latest!.id,expectedRevision:latest!.revision,patch:proposal.patch}],context,`選択したタスクの${fields}を変更するコーチ候補（まだ適用していません）`)
}
