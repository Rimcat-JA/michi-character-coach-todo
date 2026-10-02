export type LocalActionParameter =
  | {type:'string';enum:string[];maxLength:number}
  | {type:'number';min:number;max:number}
  | {type:'boolean'}
export type LocalActionDefinitionInput = {title:string;executable:string;cwd:string;argv:(string|{param:string})[];schema:Record<string,LocalActionParameter>}
export type LocalActionAutomation = {events:('task.completed'|'work_session.logged')[];params:Record<string,string|number|boolean>;lowRisk:boolean;expiresAt:number;maxRunsPerHour:number;grantedAt:number;policyEpoch:number;sourcePermissionRevision:number}
export type LocalActionAutomationInspection = {reference:string;digest:string;actionId:string;definitionRevision:number;ownerId:string;datasetId:string;policyEpoch:number;sourcePermissionRevision:number;automation:LocalActionAutomation;expiresAt:number}
export type LocalActionDefinition = LocalActionDefinitionInput & {id:string;revision:number;ownerId:string;datasetId:string;deviceId:string;executableRoot:string;sha256:string;automation?:LocalActionAutomation}
export type LocalActionInspection = {version:1;reference:string;digest:string;ownerId:string;datasetId:string;deviceId:string;policyEpoch:number;sourcePermissionRevision:number;definition:LocalActionDefinition;expiresAt:number}
export type LocalActionReview = {requestId:string;digest:string;actionId:string;executable:string;argv:string[];cwd:string;expiresAt:number;approvalRequired:true;ownerId:string;datasetId:string;deviceId:string;policyEpoch:number;sourcePermissionRevision:number;definitionRevision:number}
export type LocalActionPrepared = {version:1;reference:string;event:'owner-click'|'task.completed'|'work_session.logged';review:LocalActionReview}
/** Signed by the main process after the OS reports its result; no task completion is inferred. */
export type LocalActionResult = {
  version:1;requestId:string;digest:string;ownerId:string;datasetId:string;deviceId:string;actionId:string;policyEpoch:number;sourcePermissionRevision:number;definitionRevision:number;startedAt:number
  status:'succeeded'|'failed'|'timed_out'|'canceled'|'unknown';exitCode:number|null;signal:string|null;output:string;outputTruncated:boolean;timedOut:boolean;completedAt:number;signature:string
}
export type LocalActionStatus = {version:1;available:boolean;enabled:boolean;ownerId:string;datasetId:string;deviceId:string;definitions:LocalActionDefinition[];results:LocalActionResult[];notice:string;pending?:LocalActionPrepared[];runs?:{actionId:string;event:'task.completed'|'work_session.logged';requestId:string;at:number}[]}
export interface LocalActionGateway {
  inspectAutomation?(request:{actionId:string;events:LocalActionAutomation['events'];params:Record<string,string|number|boolean>;lowRisk:boolean;expiresAt:number;maxRunsPerHour:number}):Promise<LocalActionAutomationInspection>
  configureAutomation?(request:{reference:string;digest:string}):Promise<boolean>
  revokeAutomation?(request:{actionId:string|null}):Promise<boolean>
  trigger?(request:{event:'task.completed'|'work_session.logged';factId:string}):Promise<{results:LocalActionResult[];pending:LocalActionPrepared[];skipped:string[]}>
  status():Promise<LocalActionStatus>
  /** Isolated preload proof on data-local-action-configure=inspect. Does not execute. */
  inspectDefinition(request:LocalActionDefinitionInput):Promise<LocalActionInspection>
  /** Native proof on data-local-action-configure=reference; this digest alone cannot approve. */
  configure(request:{reference:string;digest:string}):Promise<LocalActionStatus>
  remove(request:{actionId:string}):Promise<LocalActionStatus>
  prepare(request:{actionId:string;event:'owner-click';params:Record<string,string|number|boolean>}):Promise<LocalActionPrepared>
  /** Native proof on data-local-action-approve=reference. Main owns signatures and opaque grants. */
  execute(request:{reference:string;digest:string}):Promise<LocalActionResult>
  /** Compare the actual renderer db.commands receipt with the signed main result. Never executes. */
  recordReceipt(request:{requestId:string;digest:string}):Promise<void>
  invalidate():Promise<void>
}
export type LocalActionWindow=Window&{michiLocalActions?:LocalActionGateway}
export const localActionReceiptKey=(requestId:string)=>`localaction:result:${requestId}`
