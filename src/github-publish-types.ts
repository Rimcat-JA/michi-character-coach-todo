export type GitHubRepositoryTarget = {
  repositoryId: number; owner: string; name: string; defaultBranch: string; visibility: 'public' | 'private'
  headSha: string | null; protected: boolean; empty: boolean; ownerVerified: boolean; canPush: boolean; observedAt: string
}
export type GitHubGatewayStatus = { state: 'integration_not_configured' | 'awaiting_connection' | 'needs_initialization' | 'ready'; configurationId: string | null; authorizationRevision: number; repository: GitHubRepositoryTarget | null; notice: string; qaEmulator?: boolean }
export type GitHubInitializationProposal = { reference: string; digest: string; repository: GitHubRepositoryTarget; path: 'README.md'; content: string; sha256: string; expiresAt: string }
export type GitHubInitializationResult = { status: 'initialized' | 'unknown'; repository: GitHubRepositoryTarget | null }
export type GitHubPublishFile = { path: string; content: string; sha256: string; kind: 'record' | 'evidence' | 'metrics' | 'readme' }
export type GitHubPublishManifest = {
  version: 1; exportId: string; publicId: string; ownerId: string; datasetId: string
  repository: GitHubRepositoryTarget; configurationId: string; authorizationRevision: number
  completionDigest: string; evidenceDigest: string; policyDigest: string; policyRevision: number
  policyEpoch: number; sourcePermissionRevision: number; preparedAt: string; expiresAt: string; recordDate: string
  files: GitHubPublishFile[]; approvalDigest: string
  publicationSequence?: number; previousCommitSha?: string; previousFileBlobShas?: {path: string; sha: string}[]
}
export type GitHubContributionStatus = 'not_published' | 'pr_pending' | 'unverified' | 'conditions_met' | 'conditions_not_met' | 'conditions_unknown'
export type GitHubContributionCheck = {status: GitHubContributionStatus; reasons: string[]; checkedAt: string}
export type GitHubPublishRequest = { exportId: string; attemptId: string; approvalDigest: string }
export type GitHubPublishReceipt = {
  exportId: string; attemptId: string; approvalDigest: string; repositoryId: number; publicId: string
  commitSha: string; branch: string; recordPath: string; publishedAt: string; url: string
  contribution: 'pending' | 'unverified' | 'pr_pending' | 'conditions_met' | 'conditions_not_met' | 'conditions_unknown'; pullRequestUrl: string | null
}
export type GitHubPublishResult = { status: 'published' | 'pr_pending'; receipt: GitHubPublishReceipt } | { status: 'unknown' | 'failed'; code: string }
export type GitHubConfigurationInspection = { reference: string; digest: string; target: GitHubRepositoryTarget }
export type GitHubAchievementsGateway = {
  contribution?(input: {exportId: string}): Promise<GitHubContributionCheck>
  status(): Promise<GitHubGatewayStatus>
  /** Stored configuration only; makes no GitHub request. */
  storedStatus(): Promise<GitHubGatewayStatus>
  prepareInitialization?(): Promise<GitHubInitializationProposal>
  initializeEmpty?(input: { reference: string; digest: string }): Promise<GitHubInitializationResult>
  reconcileInitialization?(): Promise<GitHubInitializationResult>
  inspectConfiguration(input: { token: string; owner: string; name: string; branch: string; visibility: 'public' | 'private' }): Promise<GitHubConfigurationInspection>
  configure(input: { reference: string; digest: string }): Promise<GitHubGatewayStatus>
  publish(input: GitHubPublishRequest): Promise<GitHubPublishResult>
  recordReceipt(input: GitHubPublishRequest): Promise<void>
  reconcile(input: { exportId: string; attemptId: string }): Promise<GitHubPublishResult>
  disconnect(): Promise<GitHubGatewayStatus>
  invalidate(): Promise<void>
}
