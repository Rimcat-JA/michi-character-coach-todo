export type LocalActionParameter =
  | {type:'string';enum:string[];maxLength:number}
  | {type:'number';min:number;max:number}
  | {type:'boolean'}
export type LocalActionDefinitionInput = {title:string;executable:string;cwd:string;argv:(string|{param:string})[];schema:Record<string,LocalActionParameter>}
export type LocalActionDefinition = LocalActionDefinitionInput & {id:string;revision:number;ownerId:string;datasetId:string;deviceId:string;executableRoot:string;sha256:string}
export type LocalActionInspection = {version:1;reference:string;digest:string;ownerId:string;datasetId:string;deviceId:string;policyEpoch:number;sourcePermissionRevision:number;definition:LocalActionDefinition;expiresAt:number}
export type LocalActionReview = {requestId:string;digest:string;actionId:string;executable:string;argv:string[];cwd:string;expiresAt:number;approvalRequired:true;ownerId:string;datasetId:string;deviceId:string;policyEpoch:number;sourcePermissionRevision:number;definitionRevision:number}
export type LocalActionPrepared = {version:1;reference:string;event:'owner-click';review:LocalActionReview}
/** Signed by the main process after the OS reports its result; no task completion is inferred. */
export type LocalActionResult = {
  version:1;requestId:string;digest:string;ownerId:string;datasetId:string;deviceId:string;actionId:string;policyEpoch:number;sourcePermissionRevision:number;definitionRevision:number;startedAt:number
  status:'succeeded'|'failed'|'timed_out'|'canceled'|'unknown';exitCode:number|null;signal:string|null;output:string;outputTruncated:boolean;timedOut:boolean;completedAt:number;signature:string
}
export type LocalActionStatus = {version:1;available:boolean;enabled:boolean;ownerId:string;datasetId:string;deviceId:string;definitions:LocalActionDefinition[];results:LocalActionResult[];notice:string}
export interface LocalActionGateway {
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
