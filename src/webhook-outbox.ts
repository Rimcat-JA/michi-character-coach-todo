import type { DBCore, DBCoreMutateRequest, Middleware } from 'dexie'
import type { Completion, Settings, Task } from './domain'
import type { IntegrationOutbox, IntegrationSettings, WebhookEvent } from './webhook-types'
import { isPrivilegedDatasetTransaction } from './dataset-guard'
import { changePolicyFor } from './change-set'
import { operationMode } from './automation-policy'

/** Capture successful task transitions in the very same IDB transaction, including nested task writers.
 * Restore/retention and schema upgrades never produce outbound events. No notes or source text enter it. */
export const webhookOutboxMiddleware: Middleware<DBCore> = {
  stack: 'dbcore', name: 'transactionalWebhookOutbox', level: 2,
  create: down => {
    const available = () => down.schema.tables.some(t => t.name === 'integrationOutbox')
    return {
      ...down,
      transaction: (stores, mode, options) => down.transaction(mode === 'readwrite' && stores.includes('tasks') && available() ? [...new Set([...stores, 'integrationOutbox', 'integrationSettings'])] : stores, mode, options),
      table: name => {
        const table = down.table(name)
        if (name !== 'tasks') return table
        return { ...table, mutate: async (req: DBCoreMutateRequest) => {
          if (!available() || isPrivilegedDatasetTransaction(req.trans) || (req.trans as unknown as IDBTransaction).mode === 'versionchange' || req.type !== 'add' && req.type !== 'put') return table.mutate(req)
          const trans = req.trans
          const config = await down.table('integrationSettings').get({ trans, key: 'main' }) as IntegrationSettings | undefined
          if (!config?.subscriptions?.length) return table.mutate(req)
          // Common command transactions already hold settings. Standalone task writes must not acquire it:
          // source retention locks settings, and must still finish while an unrelated task writer is open.
          // Main independently verifies the saved authority again before every outbound request.
          const stores = (trans as unknown as IDBTransaction).objectStoreNames
          const settings = stores.contains('settings') ? await down.table('settings').get({ trans, key: 'main' }) as Settings | undefined : undefined
          const policy = settings ? changePolicyFor(settings) : null
          if (settings && (!policy || !settings.aiEnabled || !policy.aiChangesEnabled || operationMode(policy, 'external.write') === 'deny' || config.ownerId !== settings.profileId || config.datasetId !== settings.datasetId || config.policyEpoch !== policy.epoch || config.sourcePermissionRevision !== policy.sourcePermissionRevision)) return table.mutate(req)
          const values = req.values as Task[], before = await Promise.all(values.map(value => table.get({ trans, key: value.id }) as Promise<Task | undefined>))
          const result = await table.mutate(req)
          const rows: IntegrationOutbox[] = []
          for (let i = 0; i < values.length; i++) {
            if (result.failures[i]) continue
            const task = values[i], old = before[i]
            if (task.deletedAt || old?.deletedAt) continue
            const event: WebhookEvent | null = !old ? 'task.created' : old.status === 'open' && task.status === 'completed' ? 'task.completed' : old.status === 'completed' && task.status === 'open' ? 'task.reopened' : null
            if (!event) continue
            const subscriptions = config.subscriptions.filter(sub => sub.events.includes(event) && sub.createdAt <= task.updatedAt)
            if (!subscriptions.length) continue
            let points = event === 'task.created' ? task.effectivePoints : null
            if (event === 'task.completed' && stores.contains('completions')) {
              const completions = down.table('completions'), index = completions.schema.indexes.find(index => index.name === 'taskId')!
              const found = await completions.query({ trans, values: true, limit: 1, query: { index, range: { type: 1, lower: task.id, upper: task.id, lowerOpen: false, upperOpen: false } } })
              points = (found.result[0] as Completion | undefined)?.netPoints ?? null
            }
            const id = crypto.randomUUID(), at = task.updatedAt
            rows.push({ id, at, state: 'pending', ownerId: config.ownerId, datasetId: config.datasetId, policyEpoch: config.policyEpoch, sourcePermissionRevision: config.sourcePermissionRevision, subscriptionIds: subscriptions.map(sub => sub.id), payload: { id, type: event, occurred_at: at, task_id: task.id, dataset_id: config.datasetId, points, ...(subscriptions.some(sub => sub.includeTitle) ? { title: task.title } : {}) } })
          }
          if (rows.length) {
            const saved = await down.table('integrationOutbox').mutate({ type: 'add', trans, values: rows })
            if (saved.numFailures) throw saved.failures[Object.keys(saved.failures).map(Number)[0]]
          }
          return result
        } }
      }
    }
  }
}
