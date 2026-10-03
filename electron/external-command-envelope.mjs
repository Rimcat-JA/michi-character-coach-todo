import catalog from './contracts/plugin-tools.resolved.json' with {type:'json'}
import {assertSchema} from './plugin-schema.mjs'
const fail=code=>{throw Object.assign(Error(code),{code})}
export function externalCommandEnvelope(request,commandId){
 assertSchema(catalog.tools.find(tool=>tool.name==='coach_prepare_change').inputSchema,request)
 let type,payload
 if(request.operation==='task.create'){
  if(request.payload.score.mode!=='unset'||request.payload.project_id!=null)fail('FEATURE_NOT_IMPLEMENTED')
  type='task.create';payload=Object.fromEntries(Object.entries(request.payload).filter(([key])=>key!=='score'&&key!=='project_id'))
 }else if(request.operation==='task.score.set_manual'){
  type='task.update';payload={manual_points:request.payload.points}
 }else if(request.operation==='task.update'){
  type='task.update';payload={...request.payload.changes}
  if(Object.hasOwn(payload,'labels'))fail('FEATURE_NOT_IMPLEMENTED')
  if(Object.hasOwn(payload,'due')){
   if(payload.due.kind==='datetime')fail('FEATURE_NOT_IMPLEMENTED')
   const due=payload.due;delete payload.due;payload.due_date=due.kind==='date'?due.date:null
  }
 }else fail('FORBIDDEN_OPERATION')
 if(typeof payload.title==='string'&&!payload.title.trim())fail('TOOL_SCHEMA')
 return {schema_version:'1',command_id:commandId,type,target_id:request.task_id??null,expected_revision:request.expected_revision??null,payload,basis:{kind:'external_request',note:request.basis.kind==='external_request'?request.basis.note:`Verified app reference: ${request.basis.kind}`}}
}
