import Dexie from 'dexie'
import { db } from './db'
import { contentDigest } from './canonical'
import { uid } from './domain'
import { assertExternalToolAuthority, type ExternalToolContext } from './external-tools'
import { detectionRunCurrent, detectionVerifierModel, savedDetectionRuns, type DetectionRun } from './detection-run'
import type { ContextSource } from './source-library'
import type { CalendarRulesState } from './calendar-resolver'
import { assertSchema } from '../electron/plugin-schema.mjs'
import catalog from '../electron/contracts/plugin-tools.resolved.json'

export type ExternalDetectionRequest = {
  version: 1; runId: string; requestKey: string; context: ExternalToolContext
  sourceIds: string[]; estimateTokens: number; createdAt: string; expiresAt: string
}
function fail(code: string): never { throw Object.assign(Error(code), { code }) }
const detectionPrepareKey = (client: string, key: string) => `externaldetectionprepare:${client}:${key}`
const detectionRunKey = (client: string, id: string) => `externaldetectionrun:${client}:${id}`

/** Bounded like change plans: capacity errors never evict old keys or remint records. */
async function assertDetectionCapacity(client: string, isNew: boolean) {
  const rows = await db.commands.toCollection().filter((row) => /^externaldetection(prepare|run):/.test(row.key)).toArray()
  const own = rows.filter((row) => row.key.split(':')[1] === client)
  if (rows.length >= (isNew ? 14999 : 15000) || own.length >= (isNew ? 2999 : 3000)) fail('TOO_MANY_PROPOSALS')
  if (isNew) {
    const runs = rows.filter((row) => row.key.startsWith(`externaldetectionrun:${client}:`))
    if (runs.length >= 1000) fail('TOO_MANY_PROPOSALS')
    let active = 0
    for (const row of runs) {
      let record: ExternalDetectionRequest
      try { record = JSON.parse(row.resultId) } catch { fail('PLAN_INVALID') }
      if (Date.parse(record.expiresAt) > Date.now()) active++
    }
    if (active >= 100) fail('TOO_MANY_PROPOSALS')
  }
}

export async function dispatchExternalDetectionTool(name: string, args: Record<string, unknown>, rawContext: ExternalToolContext) {
  const tool = catalog.tools.find((item) => item.name === name)
  if (!tool) fail('TOOL_NOT_FOUND')
  assertSchema(tool.inputSchema, args)
  const context: ExternalToolContext = structuredClone(rawContext)
  const client = context.registration.client.id
  if (name === 'coach_prepare_detection_run') {
    return db.transaction('rw', db.settings, db.datasetState, db.commands, db.contextSources, db.contextSnapshots, async () => {
      const { registration, settings } = await assertExternalToolAuthority(context)
      if (!registration.client.grant.keys.includes('detection:request')) fail('INSUFFICIENT_SCOPE')
      const requestKey = String(args.request_key)
      const sourceIds = (args.context_ids as string[]).slice().sort()
      // The detector/verifier models bound here come from the owner's own settings, never tool arguments.
      // Without a configured detector model there is no scope to validate: fail closed, do not guess.
      const detector = settings.aiModel ?? null
      const verifier = detectionVerifierModel(settings)
      if (!settings.aiEnabled || !detector || !verifier) fail('AI_MODEL_NOT_CONFIGURED')
      // Every selected source must currently permit indexing and AI egress to both models.
      // One NOT_FOUND covers missing, deleted, expired, unpermitted and foreign sources alike.
      // Sources are read in this same transaction: no cross-connection reads inside transactions.
      let chars = 0
      for (const sourceId of sourceIds) {
        const source = await db.contextSources.get(sourceId)
        const snapshot = source ? await db.contextSnapshots.get(`${sourceId}:${source.latestRevision}`) : undefined
        if (
          !source || !snapshot || snapshot.ownerId !== context.ownerId || snapshot.revision !== source.latestRevision ||
          source.ownerId !== context.ownerId || source.deletedAt || (source.retentionUntil && Date.parse(source.retentionUntil) <= Date.now()) ||
          !source.permissions.acquire || !source.permissions.retain || !source.permissions.index || !source.permissions.aiEgress ||
          source.aiProvider !== 'openrouter' || !source.allowedModels.includes(detector) || !source.allowedModels.includes(verifier) ||
          source.revision < 1 || snapshot.revision < 1
        ) fail('NOT_FOUND')
        chars += snapshot.text.length
      }
      if (chars > 50000) fail('SCOPE_TOO_LARGE')
      const hash = await Dexie.waitFor(contentDigest({ requestKey, sourceIds, client }))
      const key = detectionPrepareKey(client, requestKey)
      const prior = await db.commands.get(key)
      if (prior) {
        if (prior.hash !== hash) fail('IDEMPOTENCY_MISMATCH')
        const row = await db.commands.get(detectionRunKey(client, prior.resultId))
        if (!row) fail('PLAN_NOT_FOUND')
        const record = JSON.parse(row.resultId) as ExternalDetectionRequest
        if (row.hash !== await Dexie.waitFor(contentDigest(record)) || Date.parse(record.expiresAt) <= Date.now()) fail('PLAN_EXPIRED')
        return publicDetectionRequest(record)
      }
      await assertDetectionCapacity(client, true)
      const createdAt = new Date().toISOString()
      // Detection scope waits for a separate owner cost approval; inference never starts here and no send is recorded.
      const expiresAt = new Date(Math.min(Date.now() + 24 * 3600000, Date.parse(context.registration.client.grant.expires_at))).toISOString()
      const record: ExternalDetectionRequest = {
        version: 1, runId: uid(), requestKey, context, sourceIds,
        estimateTokens: Math.ceil(chars / 4), createdAt, expiresAt,
      }
      const digest = await Dexie.waitFor(contentDigest(record))
      await db.commands.add({ key: detectionRunKey(client, record.runId), hash: digest, resultId: JSON.stringify(record), at: createdAt })
      await db.commands.add({ key, hash, resultId: record.runId, at: createdAt })
      return publicDetectionRequest(record)
    })
  }
  if (name === 'coach_get_detection_run') {
    // Read-only: sequential current-state reads, no transaction. Every branch fails closed.
    const { registration, settings } = await assertExternalToolAuthority(context)
    if (!registration.client.grant.keys.includes('detection:read')) fail('INSUFFICIENT_SCOPE')
    const runId = String(args.run_id)
    // Own prepared scope first: still waiting for owner cost approval, no output yet.
    const own = await db.commands.get(detectionRunKey(client, runId))
    if (own) {
      const record = JSON.parse(own.resultId) as ExternalDetectionRequest
      if (own.hash !== await contentDigest(record) || record.context.registration.client.id !== client) fail('NOT_FOUND')
      if (Date.parse(record.expiresAt) <= Date.now()) fail('PLAN_EXPIRED')
      return { run: { run_id: record.runId, state: 'awaiting_cost_approval', estimate_tokens: record.estimateTokens, approval_url: null }, output: null }
    }
    // Otherwise a finished app detection run, disclosed review-only when still current and permitted.
    // Serialized review data never restores an approval; adoption stays owner-driven in the app UI.
    // Persisted runs live on the source store: read outside any main-db transaction.
    const runs = await savedDetectionRuns(context.ownerId)
    const run = runs.find((item) => item.id === runId) as DetectionRun | undefined
    if (!run || run.ownerId !== context.ownerId || run.datasetId !== context.datasetId) fail('NOT_FOUND')
    const sources = await db.contextSources.where('ownerId').equals(context.ownerId).toArray()
    const calendar = await db.calendarRules.get('main')
    if (!detectionRunCurrent(run, settings, sources as ContextSource[], calendar as CalendarRulesState | null | undefined, Date.now())) fail('NOT_FOUND')
    return {
      run: { run_id: run.id, state: 'completed', estimate_tokens: null, approval_url: null },
      output: {
        schema_version: '1',
        changes: run.candidates.filter((candidate) => candidate.status === 'ready-for-review').map((candidate) => candidate.change).slice(0, 50),
        review_items: run.reviewItems,
        ignored: run.ignored,
      },
    }
  }
  return fail('FEATURE_NOT_IMPLEMENTED')
}

function publicDetectionRequest(record: ExternalDetectionRequest) {
  return { run_id: record.runId, state: 'awaiting_cost_approval', estimate_tokens: record.estimateTokens, approval_url: null }
}
