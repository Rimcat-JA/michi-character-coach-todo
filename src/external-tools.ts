import { db } from './db'
import { canonicalJSON } from './canonical'
import { changePolicyFor } from './change-set'
import { externalAIFor } from './external-authority'
import { calculateScore, emptyScore, type Task } from './domain'
import { ownerNotesForEgress } from './egress-policy'
import type { FileBridgeRegistration } from './file-bridge-types'
import catalog from '../electron/contracts/plugin-tools.resolved.json'
import { assertSchema } from '../electron/plugin-schema.mjs'

export type ExternalToolContext={registration:FileBridgeRegistration;ownerId:string;datasetId:string;externalEpoch:number;policyEpoch:number;sourcePermissionRevision:number}
function fail(code:string):never{throw Object.assign(Error(code),{code})}
export const implementedExternalTools=['coach_get_capabilities','coach_search_tasks','coach_get_task','coach_preview_score','coach_search_context','coach_prepare_change','coach_submit_change','coach_get_command_result','coach_get_history'] as const
function summary(task:Task,registration:FileBridgeRegistration){
 const fields=registration.client.grant.fields
 return {id:task.id,title:fields.includes('title')?task.title:'非共有',revision:task.revision,status:task.status,scheduled_date:fields.includes('scheduled_date')?task.scheduledDate:null,points:fields.includes('manual_points')?task.effectivePoints:null,score_mode:fields.includes('manual_points')?task.score.mode:'unset',source_state:'unverified'}
}
/** Main authenticates the caller; the renderer rechecks current app scope at the DB read.
 * No conversations, memory, source titles, source counts or keys are exposed by the read slice. */
export async function assertExternalToolAuthority(context:ExternalToolContext){
  const settings=await db.settings.get('main')
  if(!settings||settings.profileId!==context.ownerId||settings.datasetId!==context.datasetId)fail('NOT_FOUND')
  const external=externalAIFor(settings),client=external.clients.find(row=>row.registration.client.id===context.registration.client.id),policy=changePolicyFor(settings)
  if(!external.enabled)fail('PLUGIN_DISABLED')
  if(!client||client.status!=='active'||Date.parse(client.registration.client.grant.expires_at)<=Date.now())fail('GRANT_REVOKED')
  if(external.epoch!==context.externalEpoch||policy.epoch!==context.policyEpoch||policy.sourcePermissionRevision!==context.sourcePermissionRevision||canonicalJSON(client.registration)!==canonicalJSON(context.registration))fail('STALE_GRANT')
  if((settings.datasetMode??'active')!=='active'||((await db.datasetState.get('main'))?.mode??'active')!=='active')fail('DATASET_FROZEN')
  const registration=client.registration
  return {settings,registration,policy,external}
}
export async function dispatchExternalReadTool(name:string,args:Record<string,unknown>,context:ExternalToolContext):Promise<unknown>{
 const tool=catalog.tools.find(tool=>tool.name===name)
 if(!tool)fail('TOOL_NOT_FOUND')
 assertSchema(tool.inputSchema,args)
 return db.transaction('r',db.settings,db.tasks,db.datasetState,db.completions,db.sessions,async()=>{
  const {registration}=await assertExternalToolAuthority(context)
  if(!registration.client.grant.keys.includes('tasks:read'))fail('INSUFFICIENT_SCOPE')
  if(name==='coach_get_capabilities')return {enabled:true,operations:[...implementedExternalTools],limitations:['ローカルアプリの許可タスクのみ。資料・会話・記憶は非共有。','変更案は最新の書出しを使い、既存の受信箱と本人確認を経て保存します。引継ぎ・参照根拠は未対応。','新規の点数指定、ラベル、時刻付き期限は未対応。実host未確認。アプリ終了・取消で接続は無効になります。']}
  if(name==='coach_search_context')return {excerpts:[],coverage_note:'文脈の開示は許可されていません。資料の存在・件数・名称を返しません。'}
  if(name==='coach_preview_score'){
   const input=args.score as {mode:'manual'|'unset'|'formula';points?:number}
   if(input.mode==='formula')fail('UNSUPPORTED_RULE_VERSION') // The standalone formula has no catalog UUID rule registry yet.
   const score=calculateScore({...emptyScore(),mode:input.mode,manualPoints:input.points??null})
   return {effective_points:score.effective,lower_bound:score.lower,upper_bound:score.upper,warnings:[]}
  }
  if(name==='coach_get_task'){
   if(!registration.task_ids.includes(String(args.task_id)))fail('NOT_FOUND')
   const task=await db.tasks.get(String(args.task_id))
   if(!task||task.deletedAt)fail('NOT_FOUND')
   const notes=registration.client.grant.fields.includes('notes')?ownerNotesForEgress(task.notes).notes:''
   return {task:summary(task,registration),notes:notes.slice(0,4000),protected_fields:['title','due','points'],sources:[],notes_truncated:notes.length>4000}
  }
  if(name==='coach_search_tasks'){
   const filter=(args.filter??{}) as {query?:string;status?:string[];project_ids?:string[]},limit=Number(args.limit??20)
   const rows=(await db.tasks.bulkGet(registration.task_ids)).filter((row):row is Task=>Boolean(row&&!row.deletedAt)).sort((a,b)=>a.id.localeCompare(b.id))
   // Queries only compare disclosed fields; hidden title/notes cannot be used as an oracle.
   const filtered=rows.filter(task=>(!filter.query||[registration.client.grant.fields.includes('title')?task.title:'',registration.client.grant.fields.includes('notes')?ownerNotesForEgress(task.notes).notes:''].join('\n').toLocaleLowerCase().includes(filter.query.toLocaleLowerCase()))&&(!filter.status?.length||filter.status.includes(task.status))&&(!filter.project_ids?.length||filter.project_ids.includes(task.containerId??'')))
   if(filter.project_ids?.some(id=>!registration.client.grant.project_ids.includes(id)))fail('NOT_FOUND')
   let start=0
   if(args.cursor){const index=filtered.findIndex(task=>task.id===args.cursor);if(index<0)fail('CURSOR_INVALID');start=index+1}
   const page=filtered.slice(start,start+limit)
   return {items:page.map(task=>summary(task,registration)),next_cursor:start+page.length<filtered.length?page.at(-1)!.id:null}
  }
  if(name==='coach_get_history'){
    if(!registration.client.grant.keys.includes('history:read'))fail('INSUFFICIENT_SCOPE')
    const from=String(args.from??''),to=String(args.to??'')
    const groupBy=args.group_by===undefined||args.group_by===null?'none':String(args.group_by)
    const day=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value
    if(!day(from)||!day(to)||from>to)fail('INVALID_DATE_RANGE')
    if((Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86400000>366)fail('DATE_RANGE_TOO_WIDE')
    if(!['none','day','week','month'].includes(groupBy))fail('TOOL_SCHEMA')
    const allowed=new Set(registration.task_ids)
    const dateOf=(row: {localDate?:string|null;originalAt:string})=>row.localDate??row.originalAt.slice(0,10)
    const completions=(await db.completions.toArray()).filter(row=>row.currentAt&&allowed.has(row.taskId)&&dateOf(row)>=from&&dateOf(row)<=to)
    const sessions=(await db.sessions.toArray()).filter(row=>allowed.has(row.taskId)&&row.startedAt.slice(0,10)>=from&&row.startedAt.slice(0,10)<=to)
    let points=0,unknown=0,minutes=0
    for(const row of completions){if(row.netPoints===null)unknown++;else points+=row.netPoints}
    for(const row of sessions)minutes+=Number(row.minutes)||0
    const scope_note=`許可タスク${allowed.size}件の範囲の集計です。他のタスク・会話・記憶は含みません。`
    type Bucket={from:string;to:string;points:string;completed_count:number;unknown_score_count:number;work_minutes:number}
    const addDays=(date:string,days:number)=>{const d=new Date(`${date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)}
    const monthEnd=(month:string)=>{const [y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m,0)).toISOString().slice(0,10)}
    const weekKey=(date:string)=>{const d=new Date(`${date}T00:00:00Z`);const monday=new Date(d);monday.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return monday.toISOString().slice(0,10)}
    const buckets:Bucket[]=[]
    if(groupBy!=='none'){
     const keyOf=(date:string)=>groupBy==='day'?date:groupBy==='month'?date.slice(0,7):weekKey(date)
     const groups=new Map<string,{completions:typeof completions;sessions:typeof sessions}>()
     for(const row of completions){const key=keyOf(dateOf(row));let group=groups.get(key);if(!group){group={completions:[],sessions:[]};groups.set(key,group)}group.completions.push(row)}
     for(const row of sessions){const key=keyOf(row.startedAt.slice(0,10));let group=groups.get(key);if(!group){group={completions:[],sessions:[]};groups.set(key,group)}group.sessions.push(row)}
     for(const [key,group] of [...groups.entries()].sort(([a],[b])=>a<b?-1:1)){
      let bPoints=0,bUnknown=0,bMinutes=0
      for(const row of group.completions){if(row.netPoints===null)bUnknown++;else bPoints+=row.netPoints}
      for(const row of group.sessions)bMinutes+=Number(row.minutes)||0
      const range=groupBy==='day'?{from:key,to:key}:groupBy==='month'?{from:`${key}-01`,to:monthEnd(key)}:{from:key,to:addDays(key,6)}
      buckets.push({from:range.from,to:range.to,points:String(bPoints),completed_count:group.completions.length,unknown_score_count:bUnknown,work_minutes:bMinutes})
      if(buckets.length>=367)fail('BUCKET_LIMIT')
     }
    }
    return {from,to,points:String(points),completed_count:completions.length,unknown_score_count:unknown,work_minutes:minutes,scope_note,buckets}
   }
   return fail('FEATURE_NOT_IMPLEMENTED')
 })
}
