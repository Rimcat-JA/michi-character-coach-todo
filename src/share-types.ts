/** I06 file-based sharing. Device-local tables: never part of a .coachbundle, and private keys are non-extractable CryptoKeys. */
export type ShareRole = 'viewer' | 'commenter' | 'editor'
export const SHARE_ROLES: ShareRole[] = ['viewer', 'commenter', 'editor']
export const SHARE_ROLE_LABEL: Record<ShareRole, string> = { viewer: '閲覧', commenter: 'コメント', editor: '編集の提案' }
export const SHARE_FIELDS = ['title', 'status', 'scheduled_date', 'due_date', 'effective_points'] as const
export type ShareField = typeof SHARE_FIELDS[number]
export const SHARE_FIELD_LABEL: Record<ShareField, string> = { title: 'タイトル', status: '状態', scheduled_date: '予定日', due_date: '締め切り', effective_points: 'ポイント' }
export type PublicJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string }
export type ShareCard = { format: 'michi-share-card'; version: 1; display_name: string; ecdsa_public_jwk: PublicJwk; ecdh_public_jwk: PublicJwk; fingerprint: string }
export type ShareIdentity = { id: 'main'; displayName: string; signKeys: CryptoKeyPair; dhKeys: CryptoKeyPair; card: ShareCard; createdAt: string }
/** A person's public card. relation says whether I share to them (recipient) or they share to me (owner). */
export type ShareContact = { id: string; displayName: string; card: ShareCard; relation: 'recipient' | 'owner'; verifiedAt: string | null; createdAt: string }
export type ResourceGrant = { id: string; ownerId: string; datasetId: string; resource: { kind: 'task'; id: string }; recipientId: string; role: ShareRole; authorizationEpoch: number; sequence: number; replySequence: number; sharedFields: ShareField[]; shareNote: string; createdAt: string; updatedAt: string; revokedAt: string | null; expiresAt?: string | null }
/** The only task content that leaves the owner's device. No notes, comments, attachments, history or source references. */
export type ShareProjection = { share_task_id: string; title?: string; status?: 'open' | 'completed'; scheduled_date?: string | null; due_date?: string | null; effective_points?: number | null }
export type SharedInbound = { id: string; ownerFp: string; ownerLabel: string; role: ShareRole; epoch: number; sequence: number; replySequence: number; sharedFields: ShareField[]; projection: ShareProjection | null; shareNote: string; receivedAt: string; revokedAt: string | null; expiresAt?: string | null }
export const PROPOSAL_FIELDS = ['title', 'scheduled_date'] as const
export type ProposalField = typeof PROPOSAL_FIELDS[number]
export type ShareProposal = { id: string; grantId: string; taskId: string; contactId: string; authorLabel: string; fields: Partial<Record<ProposalField, string | null>>; receivedAt: string; state: 'pending' | 'applied' | 'dismissed'; authorizationEpoch?: number }
