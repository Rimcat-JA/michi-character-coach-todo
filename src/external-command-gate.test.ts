import { expect, it } from 'vitest'
import { assertExternalChangeRequest, decideExternalCommand, type ExternalChangeRequest, type ExternalGateContext } from './external-command-gate'
const id='123e4567-e89b-42d3-a456-426614174000'
const request:ExternalChangeRequest={request_key:id,operation:'task.update',task_id:id,expected_revision:12,payload:{changes:{scheduled_date:'2026-10-04'}},basis:{kind:'external_request',note:'任意の依頼'}}
const context:ExternalGateContext={enabled:true,authenticated:true,tokenValid:true,audienceMatches:true,active:true,ownerMatches:true,datasetMatches:true,egressAllowed:true,mutationsEnabled:true,scopes:['tasks:prepare','changes:submit'],fields:['title','notes','scheduled_date','due','points','status'],revision:12,mode:'auto_within_bounds',protectedFields:['points'],hardLockedFields:[],boundsAllowed:true,quotaAllowed:true}
it('unprotected scheduling is eligible only within both delegated bounds and N09',()=>expect(decideExternalCommand(request,context)).toBe('AUTO_ELIGIBLE'))
const cases:[string,Partial<ExternalGateContext>,string][]=[
 ['disable_plugin',{enabled:false},'PLUGIN_DISABLED'],['revoked',{active:false},'GRANT_REVOKED'],['unauthenticated',{authenticated:false},'UNAUTHENTICATED'],['expired_token',{tokenValid:false},'UNAUTHENTICATED'],['wrong_audience',{audienceMatches:false},'WRONG_AUDIENCE'],['cross_owner',{ownerMatches:false},'NOT_FOUND'],['cross_dataset',{datasetMatches:false},'NOT_FOUND'],['egress_denied',{egressAllowed:false},'DISCLOSURE_DENIED'],['missing_submit',{scopes:['tasks:prepare']},'INSUFFICIENT_SCOPE'],['ai_pause',{mutationsEnabled:false},'AI_MUTATIONS_PAUSED'],['field_deny',{fields:[]},'FIELD_DENIED'],['revision_conflict',{revision:13},'REVISION_CONFLICT'],['quota',{quotaAllowed:false},'QUOTA_DENIED'],['bounds',{boundsAllowed:false},'AWAITING_APPROVAL'],['explicit_deny',{mode:'deny'},'POLICY_DENIED'],['hard_lock',{hardLockedFields:['scheduled_date']},'AWAITING_APPROVAL'],['default_needs_approval',{mode:'require_approval'},'AWAITING_APPROVAL']
]
it.each(cases)('reference gate: %s',(_name,patch,result)=>expect(decideExternalCommand(request,{...context,...patch})).toBe(result))
it('an external points claim and verified evidence both preserve N09 owner-value confirmation',()=>{
 const points={...request,operation:'task.score.set_manual',payload:{points:36}}
 expect(decideExternalCommand(points,context)).toBe('AWAITING_APPROVAL')
 expect(decideExternalCommand({...points,basis:{kind:'app_instruction',reference_id:id}},context,()=>true)).toBe('AWAITING_APPROVAL')
})
it.each(['app_instruction','verified_detection','approved_rule_instance'] as const)('unverified %s does not gain authority',kind=>expect(decideExternalCommand({...request,basis:{kind,reference_id:id}},context)).toBe('UNVERIFIED_REFERENCE'))
it.each(['task.complete','task.reopen','task.delete','task.restore','policy.grant','approval.issue'])('N09 denies %s before scope/revision',operation=>expect(decideExternalCommand({...request,operation},{...context,fields:[],revision:99})).toBe('FORBIDDEN_OPERATION'))
it('verified detection remains review-only for task creation',()=>expect(decideExternalCommand({request_key:id,operation:'task.create',payload:{title:'義務',score:{mode:'unset'}},basis:{kind:'verified_detection',reference_id:id}},context,()=>true)).toBe('AWAITING_APPROVAL'))
it.each([{approved:true},{actor_id:'human'},{request_key:'invalid'},{expected_revision:null},{payload:{changes:{}}},{payload:{changes:{ledger_points:100}}},{payload:{changes:{title:'  '}}},{payload:{changes:{scheduled_date:'2026-02-30'}}}])('schema rejects fabricated or invalid tool input %#',patch=>expect(()=>assertExternalChangeRequest({...request,...patch})).toThrow())
