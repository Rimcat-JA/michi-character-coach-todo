import { assertSchema } from '../electron/plugin-schema.mjs'
import catalog from '../electron/contracts/plugin-tools.resolved.json'
import { canonicalJSON } from './canonical'

export type ExternalBasis = {kind:'external_request';note:string}|{kind:'app_instruction'|'verified_detection'|'approved_rule_instance';reference_id:string}
export type ExternalChangeRequest = {request_key:string;operation:string;task_id?:string;expected_revision?:number;payload:Record<string,unknown>;basis:ExternalBasis}
/** Facts supplied by app authentication, current DB/grant and N09. Never populate from tool arguments. */
export type ExternalGateContext = {
  enabled:boolean;authenticated:boolean;tokenValid:boolean;audienceMatches:boolean;active:boolean;ownerMatches:boolean;datasetMatches:boolean;egressAllowed:boolean
  mutationsEnabled:boolean;scopes:readonly string[];fields:readonly string[];revision:number|null;mode:'deny'|'require_approval'|'auto_within_bounds'
  protectedFields:readonly string[];hardLockedFields:readonly string[];boundsAllowed:boolean;quotaAllowed:boolean
}
export type ExternalGateDecision='PLUGIN_DISABLED'|'UNAUTHENTICATED'|'WRONG_AUDIENCE'|'GRANT_REVOKED'|'NOT_FOUND'|'DISCLOSURE_DENIED'|'FORBIDDEN_OPERATION'|'AI_MUTATIONS_PAUSED'|'INSUFFICIENT_SCOPE'|'FIELD_DENIED'|'REVISION_CONFLICT'|'QUOTA_DENIED'|'POLICY_DENIED'|'UNVERIFIED_REFERENCE'|'AWAITING_APPROVAL'|'AUTO_ELIGIBLE'
export function assertExternalChangeRequest(value:unknown):asserts value is ExternalChangeRequest {
  assertSchema(catalog.tools.find(tool=>tool.name==='coach_prepare_change')!.inputSchema,value)
  const request=value as ExternalChangeRequest
  if(typeof request.payload.title==='string'&&!request.payload.title.trim()||request.payload.changes&&typeof request.payload.changes==='object'&&'title' in request.payload.changes&&typeof request.payload.changes.title==='string'&&!request.payload.changes.title.trim())throw Object.assign(Error('TOOL_SCHEMA'),{code:'TOOL_SCHEMA'})
}
export function externalRequestFields(request:ExternalChangeRequest):string[] {
  return request.operation==='task.update'?Object.keys(request.payload.changes as object):request.operation==='task.score.set_manual'?['points']:request.operation==='task.create'?['title',...Object.keys(request.payload).filter(key=>key!=='title'&&key!=='score'),...(request.payload.score&&(request.payload.score as {mode:string}).mode!=='unset'?['points']:[])]:['status']
}
export function externalBoundary(context:ExternalGateContext):ExternalGateDecision|null {
  if(!context.enabled)return 'PLUGIN_DISABLED'
  if(!context.authenticated||!context.tokenValid)return 'UNAUTHENTICATED'
  if(!context.audienceMatches)return 'WRONG_AUDIENCE'
  if(!context.active)return 'GRANT_REVOKED'
  if(!context.ownerMatches||!context.datasetMatches)return 'NOT_FOUND'
  return context.egressAllowed?null:'DISCLOSURE_DENIED'
}
/** Reference parity with explicit N09 restrictions: completion/deletion never delegated;
 * protected values always need current native owner confirmation, even with verified evidence. */
export function decideExternalCommand(request:ExternalChangeRequest,context:ExternalGateContext,verifyBasis:(request:ExternalChangeRequest)=>boolean=()=>false):ExternalGateDecision {
  const boundary=externalBoundary(context)
  if(boundary)return boundary
  if(!['task.create','task.update','task.score.set_manual'].includes(request.operation))return 'FORBIDDEN_OPERATION'
  if(!context.mutationsEnabled)return 'AI_MUTATIONS_PAUSED'
  if(!['tasks:prepare','changes:submit'].every(scope=>context.scopes.includes(scope)))return 'INSUFFICIENT_SCOPE'
  const fields=externalRequestFields(request)
  if(fields.some(field=>!context.fields.includes(field)))return 'FIELD_DENIED'
  if(request.operation!=='task.create'&&request.expected_revision!==context.revision)return 'REVISION_CONFLICT'
  if(!context.quotaAllowed)return 'QUOTA_DENIED'
  if(!['require_approval','auto_within_bounds'].includes(context.mode))return 'POLICY_DENIED'
  if(request.basis.kind!=='external_request'&&!verifyBasis(request))return 'UNVERIFIED_REFERENCE'
  if(context.mode==='require_approval'||!context.boundsAllowed||fields.some(field=>context.protectedFields.includes(field)||context.hardLockedFields.includes(field)||['title','due','points','labels','project_id'].includes(field)))return 'AWAITING_APPROVAL'
  // Existing verified detection is review-only; creating tasks is never an automatic plugin action.
  return request.operation==='task.update'?'AUTO_ELIGIBLE':'AWAITING_APPROVAL'
}
/** Exact action binding excludes only transport idempotency and evidence labels. */
export function externalActionJSON(request:ExternalChangeRequest):string {
  const {request_key:_key,basis:_basis,...action}=request
  return canonicalJSON(action)
}
