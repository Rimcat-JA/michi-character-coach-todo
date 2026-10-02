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
export const implementedExternalTools=['coach_get_capabilities','coach_search_tasks','coach_get_task','coach_preview_score','coach_search_context'] as const
function summary(task:Task,registration:FileBridgeRegistration){
 const fields=registration.client.grant.fields
 return {id:task.id,title:fields.includes('title')?task.title:'非共有',revision:task.revision,status:task.status,scheduled_date:fields.includes('scheduled_date')?task.scheduledDate:null,points:fields.includes('manual_points')?task.effectivePoints:null,score_mode:fields.includes('manual_points')?task.score.mode:'unset',source_state:'unverified'}
}
/** Main authenticates the caller; the renderer rechecks current app scope at the DB read.
 * No conversations, memory, source titles, source counts or keys are exposed by the read slice. */
export async function dispatchExternalReadTool(name:string,args:Record<string,unknown>,context:ExternalToolContext):Promise<unknown>{
 const tool=catalog.tools.find(tool=>tool.name===name)
 if(!tool)fail('TOOL_NOT_FOUND')
 assertSchema(tool.inputSchema,args)
 return db.transaction('r',db.settings,db.tasks,async()=>{
  const settings=await db.settings.get('main')
  if(!settings||settings.profileId!==context.ownerId||settings.datasetId!==context.datasetId)fail('NOT_FOUND')
  const external=externalAIFor(settings),client=external.clients.find(row=>row.registration.client.id===context.registration.client.id),policy=changePolicyFor(settings)
  if(!external.enabled)fail('PLUGIN_DISABLED')
  if(!client||client.status!=='active'||Date.parse(client.registration.client.grant.expires_at)<=Date.now())fail('GRANT_REVOKED')
  if(external.epoch!==context.externalEpoch||policy.epoch!==context.policyEpoch||policy.sourcePermissionRevision!==context.sourcePermissionRevision||canonicalJSON(client.registration)!==canonicalJSON(context.registration))fail('STALE_GRANT')
  if((settings.datasetMode??'active')!=='active')fail('DATASET_FROZEN')
  const registration=client.registration
  if(!registration.client.grant.keys.includes('tasks:read'))fail('INSUFFICIENT_SCOPE')
  if(name==='coach_get_capabilities')return {enabled:true,operations:[...implementedExternalTools],limitations:['ローカルアプリの許可タスクのみ。資料・会話・記憶は非共有。','この読み取り段階では変更・引継ぎツールを提供しません。','実host未確認。アプリ終了・取消で接続は無効になります。']}
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
  return fail('FEATURE_NOT_IMPLEMENTED')
 })
}
