import type { CapabilityCheck } from './external-authority'
/** App-owned IPC values. Inbox JSON may describe a command, never authority or approval. */
/** due_date and manual_points are owner-value fields: every request waits for the owner's in-app value confirmation. */
export type FileBridgeField = 'title' | 'notes' | 'scheduled_date' | 'due_date' | 'manual_points'
export type FileBridgeGrantKey = 'tasks:read' | 'tasks:prepare' | 'changes:submit' | 'commands:read' | 'tasks:split' | 'routines:prepare' | 'history:read' | 'routines:read' | 'context:read' | 'detection:request' | 'detection:read' | 'handoff:prepare'
export type FileBridgeHost = 'chatgpt' | 'claude' | 'codex' | 'claude_code' | 'other'
export type FileBridgeRegistration = {
  schema_version: '1'; owner_id: string; dataset_id: string; policy_epoch: number; source_permission_revision: number; task_ids: string[]
  /** Owner-selected series an agent may propose recurrence changes for (grant key routines:prepare). */
  rule_ids?: string[]
  client: { id: string; dataset_id: string; intended_host: FileBridgeHost; transport: 'stdio'; status: 'active'; revision: number; grant_epoch: number
    grant: { keys: FileBridgeGrantKey[]; project_ids: string[]; fields: FileBridgeField[]; mutation_mode: 'require_approval' | 'auto_within_bounds'; max_operations_per_day: number; max_schedule_shift_days: number; max_point_delta: 0; allow_external_context: boolean; allow_handoffs: boolean; expires_at: string
      /** Present only for an owner-delegated automatic grant (notes/scheduled_date only, stricter than the grant). */
      automation?: { max_schedule_shift_days: number; max_operations_per_day: number } } }
}
export type FileBridgeManifest = {
  schema_version: '1'; snapshot_id: string; owner_id: string; dataset_id: string; client_id: string; policy_epoch: number; source_permission_revision: number
  registration_revision: number; grant_epoch: number; generated_at: string; expires_at: string; view_path: 'views/tasks.active.json'; view_sha256: string; entity_revisions: Record<string, number>; registration_sha256: string
}
export type FileBridgeTrigger = { kind: 'weekly'; weekdays: number[]; time: string } | { kind: 'monthly_business'; ordinal: number; from: 'start' | 'end'; time: string } | { kind: 'activity_relative'; activity_id: string; edge: 'start' | 'end'; offset_days: number; offset_minutes: number }
export type FileBridgeScope = { kind: 'all_uncompleted' } | { kind: 'this_and_future'; from_date: string } | { kind: 'this_instance'; generation_key: string }
export type FileBridgeCommand = {
  schema_version: '1'; command_id: string; snapshot_id: string; expires_at: string; type: 'task.create' | 'task.update' | 'task.split' | 'routine.change'; target_id: string | null; expected_revision: number | null
  payload: { title?: string; notes?: string; scheduled_date?: string | null; due_date?: string | null; manual_points?: number; children?: { title: string; points: number | null }[]; scope?: FileBridgeScope; definition?: { trigger: FileBridgeTrigger } }
  /** Self-declared labels only; the app never derives authority from them. */
  basis?: { kind: 'external_request'; note?: string }; via?: 'mcp_stdio'
}
export type FileBridgePrepared = {
  state: 'awaiting_approval'; command: FileBridgeCommand; digest: string; principal: { id: string; kind: 'external-agent' }; ownerId: string; datasetId: string
  policyEpoch: number; sourcePermissionRevision: number; snapshotId: string; expectedRevision: number | null; expiresAt: string
}
export type FileBridgeRejectedState = 'denied' | 'conflict' | 'expired' | 'rejected'
export type FileBridgeResult = {
  schema_version: '1'; command_id: string; digest: string; owner_id: string; dataset_id: string; client_id: string; state: 'applied' | 'failed' | 'unknown' | FileBridgeRejectedState
  receipt: { commandId: string; digest: string; taskIds: string[]; appliedAt: string } | null; finished_at: string
  /** Present exactly on denied/conflict/expired/rejected results; older results have none. */
  code?: string
}
export type FileBridgeStatus = {
  version: 1; available: boolean; connected: boolean; root: string | null; registration: FileBridgeRegistration | null; snapshot: FileBridgeManifest | null; results: FileBridgeResult[]; notice: string
}
export type FileBridgeInboxEntry =
  | { state: 'awaiting_approval'; filename: string; reference: string; prepared: FileBridgePrepared }
  | { state: 'finished'; filename: string; result: FileBridgeResult }
  | { state: 'rejected'; filename: string; error: string }
export type FileBridgeConfigure = {
  ownerId: string; datasetId: string; policyEpoch: number; sourcePermissionRevision: number; intendedHost: FileBridgeHost; taskIds: string[]; fields: FileBridgeField[]; lifetimeHours: number
  automation: { maxScheduleShiftDays: number; maxOperationsPerDay: number } | null
  allowSplit?: boolean; ruleIds?: string[]
  allowHistory?: boolean; allowRoutinePreview?: boolean; allowContextRead?: boolean; allowExternalContext?: boolean; allowDetection?: boolean; allowHandoffPrepare?: boolean; allowHandoffs?: boolean
  /** Propose brand-new series (scope=new). Existing-series changes still need ruleIds binding. */
  allowRoutineChange?: boolean
}
export type FileBridgeRevise={clientId:string;expectedRevision:number;taskIds:string[];fields:FileBridgeField[];expiresAt:string;automation:FileBridgeConfigure['automation'];maxScheduleShiftDays:number;maxOperationsPerDay:number;allowSplit:boolean;ruleIds:string[];allowHistory:boolean;allowRoutinePreview:boolean;allowContextRead:boolean;allowExternalContext:boolean;allowDetection:boolean;allowHandoffPrepare:boolean;allowHandoffs:boolean;allowRoutineChange:boolean}
export type FileBridgeApplicationBinding = {
  reference: string; fileDigest: string; applicationDigest: string; ownerId: string; datasetId: string; policyEpoch: number; sourcePermissionRevision: number
}
export type FileBridgeLease = FileBridgeApplicationBinding & {
  version: 1; leaseId: string; clientId: string; registrationRevision: number; grantEpoch: number; expiresAt: string; automatic: boolean
}
/** Persisted atomically with tasks in db.commands, not a caller supplied success claim. */
export type FileBridgeApplicationReceipt = {
  version: 1; commandId: string; fileDigest: string; applicationDigest: string; ownerId: string; datasetId: string; clientId: string; policyEpoch: number; sourcePermissionRevision: number
  registrationRevision: number; grantEpoch: number; taskIds: string[]; appliedAt: string
}
export type FileBridgeSnapshotTask = { id: string; revision: number; title: string; notes: string; scheduledDate: string | null; containerId: string | null }
export type FileBridgeSnapshotRule = { id: string; revision: number; title: string; trigger: FileBridgeTrigger }
export interface FileBridgeGateway {
  mcpConfiguration?(): Promise<{mcpServers:{michi:{command:string;args:string[];env:{ELECTRON_RUN_AS_NODE:'1'}}}}>
  selftest?(request:{clientId:string;mode:'read'|'revoke'}):Promise<{clientId:string;check:CapabilityCheck;code:string|null}>
  selectClient?(request: {clientId:string}): Promise<FileBridgeStatus>
  listConnections?(): Promise<FileBridgeStatus[]>
  status(): Promise<FileBridgeStatus>
  clientStatus?(request:{clientId:string}):Promise<FileBridgeStatus>
  scanClientInbox?(request:{clientId:string}):Promise<{status:FileBridgeStatus;entries:FileBridgeInboxEntry[]}>
  configure(request: FileBridgeConfigure): Promise<FileBridgeStatus>
  revise?(request:FileBridgeRevise):Promise<FileBridgeStatus>
  invalidateClient?(request:{clientId:string}):Promise<void>
  disconnect(request: { clientId: string }): Promise<FileBridgeStatus>
  exportSnapshot(request: { tasks: FileBridgeSnapshotTask[]; rules?: FileBridgeSnapshotRule[] }): Promise<FileBridgeStatus>
  scanInbox(): Promise<{ status: FileBridgeStatus; entries: FileBridgeInboxEntry[] }>
  /** Main consumes a one-use native click, reserves the durable claim, then issues this lease. */
  authorizeApplication(request: FileBridgeApplicationBinding): Promise<FileBridgeLease>
  /** No click: main verifies its own signed auto grant, bounds, quota and the N09 table before leasing. */
  authorizeAutomaticApplication?(request: FileBridgeApplicationBinding): Promise<FileBridgeLease>
  /** Main queries the designated renderer's actual DB receipt before signing the result. */
  recordApplied(request: { leaseId: string; reference: string; receipt: FileBridgeApplicationReceipt }): Promise<FileBridgeResult>
  /** With an outcome, main signs that rejection only if the DB holds no receipt; otherwise the receipt wins. */
  cancelApplication(request: { leaseId: string; reference: string; outcome?: { state: FileBridgeRejectedState; code: string } }): Promise<unknown>
  /** Terminal rejection of a scanned, unleased command so the agent sees the same code (K12). */
  recordRejected?(request: { reference: string; state: FileBridgeRejectedState; code: string }): Promise<FileBridgeResult>
  /** Decreases authority after restore or AI OFF; it cannot enable an external client. */
  invalidate(): Promise<void>
}
export type FileBridgeWindow = Window & { michiFileBridge?: FileBridgeGateway }
export const fileBridgeReceiptKey = (commandId: string, clientId?: string) => `filebridge:applied:${clientId?clientId+':':''}${commandId}`
export const fileBridgeScopeKey = (ownerId: string, datasetId: string, clientId?: string) => `filebridge:scope:${ownerId}:${datasetId}${clientId?':'+clientId:''}`
