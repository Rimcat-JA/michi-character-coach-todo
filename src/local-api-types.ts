export type LocalAPIToken = { tokenId: string; label: string; scopes: string[]; project_ids: string[]; ownerId: string; datasetId: string; policyEpoch: number; sourcePermissionRevision: number; grantEpoch: number; expiresAt: string; revokedAt: string | null; lastUsedAt: string | null }
export type LocalAPIStatus = { enabled: boolean; running: boolean; port: number; url: string | null; tokens: LocalAPIToken[] }
export type LocalAPICommand = { command_id: string; type: 'task.create'; payload: { title: string; notes?: string; scheduled_date?: string | null } }
export type LocalAPIPending = { tokenId: string; ownerId: string; datasetId: string; policyEpoch: number; sourcePermissionRevision: number; grantEpoch: number; digest: string; command: LocalAPICommand; expiresAt: string; projectId: string | null; label: string; receiptKey: string }
export type LocalAPILease = Omit<LocalAPIPending,'expiresAt'|'label'> & { id: string; expiresAt: number }
export type LocalAPIWindow = { request: (value: Record<string,unknown>)=>Promise<unknown>; invalidate: ()=>Promise<void> }
declare global { interface Window { michiLocalAPI?: LocalAPIWindow } }
