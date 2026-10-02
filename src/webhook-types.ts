export type WebhookEvent = 'task.created' | 'task.completed' | 'task.reopened'
export type WebhookAuthority = { ownerId: string; datasetId: string; policyEpoch: number; sourcePermissionRevision: number }
export type WebhookSubscription = WebhookAuthority & { id: string; url: string; events: WebhookEvent[]; includeTitle: boolean; loopback: boolean; createdAt: string; revokedAt: string | null }
/** Device-local public metadata; secrets and URLs are held only by main. Neither table is backed up. */
export type IntegrationSettings = WebhookAuthority & { id: 'main'; subscriptions: Pick<WebhookSubscription, 'id' | 'events' | 'includeTitle' | 'createdAt'>[] }
export type IntegrationOutbox = WebhookAuthority & { id: string; at: string; state: 'pending'; subscriptionIds: string[]; payload: { id: string; type: WebhookEvent; occurred_at: string; task_id: string; dataset_id: string; points: number | null; title?: string } }
export type WebhookDelivery = { id: string; subscriptionId: string; eventId: string; event: string; state: string; attempts: number; nextAt: number | null; updatedAt: string; httpStatus?: number; error?: string }
export type WebhookStatus = { subscriptions: WebhookSubscription[]; deliveries: WebhookDelivery[]; settledEventIds: string[]; notice: string }
export type WebhookGateway = { request(value: { action: string; input?: unknown }): Promise<unknown>; invalidate(): Promise<void> }
declare global { interface Window { michiWebhooks?: WebhookGateway } }
