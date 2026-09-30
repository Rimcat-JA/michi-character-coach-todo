/** App-owned IPC values. Inbox JSON may describe a command, never authority or approval. */
export type FileBridgeField = 'title' | 'notes' | 'scheduled_date'
export type FileBridgeHost = 'chatgpt' | 'claude' | 'codex' | 'claude_code' | 'other'
export type FileBridgeRegistration = {
  schema_version: '1'; owner_id: string; dataset_id: string; policy_epoch: number; source_permission_revision: number; task_ids: string[]
  client: { id: string; dataset_id: string; intended_host: FileBridgeHost; transport: 'stdio'; status: 'active'; revision: number; grant_epoch: number
    grant: { keys: ('tasks:read' | 'tasks:prepare' | 'changes:submit' | 'commands:read')[]; project_ids: string[]; fields: FileBridgeField[]; mutation_mode: 'require_approval'; max_operations_per_day: number; max_schedule_shift_days: number; max_point_delta: 0; allow_external_context: false; allow_handoffs: false; expires_at: string } }
}
export type FileBridgeManifest = {
  schema_version: '1'; snapshot_id: string; owner_id: string; dataset_id: string; client_id: string; policy_epoch: number; source_permission_revision: number
  registration_revision: number; grant_epoch: number; generated_at: string; expires_at: string; view_path: 'views/tasks.active.json'; view_sha256: string; entity_revisions: Record<string, number>; registration_sha256: string
}
export type FileBridgeCommand = {
  schema_version: '1'; command_id: string; snapshot_id: string; expires_at: string; type: 'task.create' | 'task.update'; target_id: string | null; expected_revision: number | null
  payload: { title?: string; notes?: string; scheduled_date?: string | null }
}
export type FileBridgePrepared = {
  state: 'awaiting_approval'; command: FileBridgeCommand; digest: string; principal: { id: string; kind: 'external-agent' }; ownerId: string; datasetId: string
  policyEpoch: number; sourcePermissionRevision: number; snapshotId: string; expectedRevision: number | null; expiresAt: string
}
export type FileBridgeResult = {
  schema_version: '1'; command_id: string; digest: string; owner_id: string; dataset_id: string; client_id: string; state: 'applied' | 'failed' | 'unknown'
  receipt: { commandId: string; digest: string; taskIds: string[]; appliedAt: string } | null; finished_at: string
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
}
export type FileBridgeApplicationBinding = {
  reference: string; fileDigest: string; applicationDigest: string; ownerId: string; datasetId: string; policyEpoch: number; sourcePermissionRevision: number
}
export type FileBridgeLease = FileBridgeApplicationBinding & {
  version: 1; leaseId: string; clientId: string; registrationRevision: number; grantEpoch: number; expiresAt: string
}
/** Persisted atomically with tasks in db.commands, not a caller supplied success claim. */
export type FileBridgeApplicationReceipt = {
  version: 1; commandId: string; fileDigest: string; applicationDigest: string; ownerId: string; datasetId: string; clientId: string; policyEpoch: number; sourcePermissionRevision: number
  registrationRevision: number; grantEpoch: number; taskIds: string[]; appliedAt: string
}
export type FileBridgeSnapshotTask = { id: string; revision: number; title: string; notes: string; scheduledDate: string | null; containerId: string | null }
export interface FileBridgeGateway {
  mcpConfiguration?(): Promise<{mcpServers:{michi:{command:string;args:string[];env:{ELECTRON_RUN_AS_NODE:'1'}}}}>
  status(): Promise<FileBridgeStatus>
  configure(request: FileBridgeConfigure): Promise<FileBridgeStatus>
  disconnect(request: { clientId: string }): Promise<FileBridgeStatus>
  exportSnapshot(request: { tasks: FileBridgeSnapshotTask[] }): Promise<FileBridgeStatus>
  scanInbox(): Promise<{ status: FileBridgeStatus; entries: FileBridgeInboxEntry[] }>
  /** Main consumes a one-use native click, reserves the durable claim, then issues this lease. */
  authorizeApplication(request: FileBridgeApplicationBinding): Promise<FileBridgeLease>
  /** Main queries the designated renderer's actual DB receipt before signing the result. */
  recordApplied(request: { leaseId: string; reference: string; receipt: FileBridgeApplicationReceipt }): Promise<FileBridgeResult>
  cancelApplication(request: { leaseId: string; reference: string }): Promise<void>
  /** Decreases authority after restore or AI OFF; it cannot enable an external client. */
  invalidate(): Promise<void>
}
export type FileBridgeWindow = Window & { michiFileBridge?: FileBridgeGateway }
export const fileBridgeReceiptKey = (commandId: string) => `filebridge:applied:${commandId}`
export const fileBridgeScopeKey = (ownerId: string, datasetId: string) => `filebridge:scope:${ownerId}:${datasetId}`
