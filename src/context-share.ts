import Dexie from 'dexie'
import { db } from './db'
import { contentDigest } from './canonical'
import { uid } from './domain'
import { assertExternalToolAuthority, type ExternalToolContext } from './external-tools'
import { externalAIFor } from './external-authority'
import { purgeExternalShares, SHARE_EXPIRY_MS, type ContextSharePackage, type ContextShareRef } from './external-handoffs'
import { assertSchema } from '../electron/plugin-schema.mjs'
import catalog from '../electron/contracts/plugin-tools.resolved.json'

function fail(code: string): never { throw Object.assign(Error(code), { code }) }
function trustedClick(event: Event) {
  if (!(event instanceof Event) || !event.isTrusted || !['click', 'submit'].includes(event.type)) throw new Error('本人がアプリの確認ボタンから操作してください')
}

/** Owner shares tasks/quotes with one specific client. Explicit per-package consent; 24h expiry. */
export async function shareContextPackage(
  request: { recipientClientId: string; taskIds: string[]; sourceQuotes: { sourceId: string; snapshotRevision: number; spanId: string }[] },
  event: Event,
): Promise<string> {
  trustedClick(event)
  if (!Array.isArray(request.taskIds) || request.taskIds.length > 50 || new Set(request.taskIds).size !== request.taskIds.length) throw new Error('共有するタスクは50件以内で選んでください')
  if (!Array.isArray(request.sourceQuotes) || request.sourceQuotes.length > 20) throw new Error('共有する引用は20件以内で選んでください')
  return db.transaction('rw', [db.settings, db.tasks, db.contextSources, db.contextSnapshots, db.contextSharePackages, db.externalHandoffs], async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('本人の設定がありません')
    const external = externalAIFor(settings)
    if (!external.enabled) throw new Error('外部AIが停止しています')
    const recipient = external.clients.find((row) => row.registration.client.id === request.recipientClientId)
    if (!recipient || recipient.status !== 'active') throw new Error('共有先の接続が有効ではありません')
    if (!recipient.registration.client.grant.allow_handoffs) throw new Error('共有先が受取を許可していません')
    const refs: ContextShareRef[] = []
    for (const taskId of request.taskIds) {
      const task = await db.tasks.get(taskId)
      if (!task || task.deletedAt || task.id !== taskId) throw new Error('共有するタスクを確認してください')
      refs.push({ kind: 'task', id: task.id, revision: task.revision })
    }
    for (const quote of request.sourceQuotes) {
      const source = await db.contextSources.get(quote.sourceId)
      const snapshot = source ? await db.contextSnapshots.get(`${quote.sourceId}:${quote.snapshotRevision}`) : undefined
      if (
        !source || !snapshot || source.ownerId !== settings.profileId || source.deletedAt ||
        (source.retentionUntil && Date.parse(source.retentionUntil) <= Date.now()) ||
        !source.permissions.acquire || !source.permissions.retain || !source.permissions.index || !source.permissions.aiEgress ||
        !snapshot.spans.some((span) => span.id === quote.spanId)
      ) throw new Error('共有する引用を確認してください')
      const span = snapshot.spans.find((item) => item.id === quote.spanId)!
      refs.push({
        kind: 'source-quote', sourceId: source.id, snapshotRevision: snapshot.revision, spanId: span.id,
        quoteSha256: await Dexie.waitFor(contentDigest(span.text)),
      })
    }
    const createdAt = new Date().toISOString()
    const record: ContextSharePackage = {
      id: uid(), ownerId: settings.profileId, datasetId: settings.datasetId, recipientClientId: request.recipientClientId,
      refs, digest: await Dexie.waitFor(contentDigest({ recipient: request.recipientClientId, refs })),
      expiresAt: new Date(Date.now() + SHARE_EXPIRY_MS).toISOString(), revokedAt: null, createdAt,
    }
    await db.contextSharePackages.add(record)
    await purgeExternalShares()
    return record.id
  })
}

export async function revokeContextSharePackage(id: string, event: Event): Promise<void> {
  trustedClick(event)
  const settings = await db.settings.get('main')
  const record = await db.contextSharePackages.get(id)
  if (!record || !settings || record.ownerId !== settings.profileId || record.datasetId !== settings.datasetId) throw new Error('共有が見つかりません')
  if (!record.revokedAt) await db.contextSharePackages.update(id, { revokedAt: new Date().toISOString() })
}

export async function listContextSharePackages(): Promise<ContextSharePackage[]> {
  await purgeExternalShares()
  return (await db.contextSharePackages.toArray()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Recipient-only fetch: exact package, unexpired, unrevoked, every ref re-checked. Any failure denies the whole package without leaking counts or titles. */
export async function dispatchSharedContextTool(name: string, args: Record<string, unknown>, rawContext: ExternalToolContext) {
  if (name !== 'coach_get_shared_context') fail('TOOL_NOT_FOUND')
  const tool = catalog.tools.find((item) => item.name === name)
  if (!tool) fail('TOOL_NOT_FOUND')
  assertSchema(tool.inputSchema, args)
  const context: ExternalToolContext = structuredClone(rawContext)
  await assertExternalToolAuthority(context)
  if (!context.registration.client.grant.allow_handoffs) fail('SHARE_UNAVAILABLE')
  const record = await db.contextSharePackages.get(String(args.package_id))
  if (
    !record || record.recipientClientId !== context.registration.client.id ||
    record.ownerId !== context.ownerId || record.datasetId !== context.datasetId ||
    record.revokedAt || Date.parse(record.expiresAt) <= Date.now() ||
    record.digest !== await contentDigest({ recipient: record.recipientClientId, refs: record.refs })
  ) fail('SHARE_UNAVAILABLE')
  const tasks: { id: string; title: string; revision: number; status: string; scheduled_date: string | null; points: number | null; score_mode: string; source_state: string }[] = []
  const excerpts: { id: string; revision: number; text: string; source_url: string | null; trust: string; coverage_note: string }[] = []
  for (const ref of record.refs) {
    if (ref.kind === 'task') {
      const task = await db.tasks.get(ref.id)
      if (!task || task.deletedAt) fail('SHARE_UNAVAILABLE')
      tasks.push({
        id: task.id, title: task.title.slice(0, 300), revision: task.revision, status: task.status,
        scheduled_date: task.scheduledDate, points: task.effectivePoints, score_mode: task.score.mode, source_state: 'unverified',
      })
    } else {
      const source = await db.contextSources.get(ref.sourceId)
      const snapshot = source ? await db.contextSnapshots.get(`${ref.sourceId}:${ref.snapshotRevision}`) : undefined
      const span = snapshot?.spans.find((item) => item.id === ref.spanId)
      if (
        !source || !snapshot || !span || source.ownerId !== context.ownerId || source.deletedAt ||
        (source.retentionUntil && Date.parse(source.retentionUntil) <= Date.now()) ||
        !source.permissions.acquire || !source.permissions.retain || !source.permissions.index || !source.permissions.aiEgress ||
        span.id !== ref.spanId || await contentDigest(span.text) !== ref.quoteSha256
      ) fail('SHARE_UNAVAILABLE')
      excerpts.push({
        id: source.id, revision: snapshot.revision, text: span.text.slice(0, 4000),
        source_url: source.sourceUrl ?? null,
        trust: source.provider === 'local' ? 'user_shared' : 'unverified_external',
        coverage_note: '本人がこの共有のために選んだ引用です。資料全体の存在・件数を表しません。',
      })
    }
  }
  if (tasks.length > 50 || excerpts.length > 20) fail('SHARE_UNAVAILABLE')
  return { id: record.id, tasks, excerpts, expires_at: record.expiresAt }
}
