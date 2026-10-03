import Dexie from 'dexie'
import { db } from './db'
import { contentDigest } from './canonical'
import { uid } from './domain'
import { assertExternalToolAuthority, type ExternalToolContext } from './external-tools'
import { changePolicyFor } from './change-set'
import { assertSchema } from '../electron/plugin-schema.mjs'
import catalog from '../electron/contracts/plugin-tools.resolved.json'

export type ExternalHandoffState = 'draft' | 'accepted' | 'rejected' | 'expired'
export type ExternalHandoff = {
  id: string; ownerId: string; datasetId: string; agentClientId: string; requestKey: string
  summary: string; targetTaskIds: string[]; state: ExternalHandoffState; revision: number
  acceptedNoteId: string | null; retentionUntil: string; createdAt: string
}
export type ContextShareRef =
  | { kind: 'task'; id: string; revision: number }
  | { kind: 'source-quote'; sourceId: string; snapshotRevision: number; spanId: string; quoteSha256: string }
export type ContextSharePackage = {
  id: string; ownerId: string; datasetId: string; recipientClientId: string
  refs: ContextShareRef[]; digest: string; expiresAt: string; revokedAt: string | null; createdAt: string
}
function fail(code: string): never { throw Object.assign(Error(code), { code }) }
const handoffKey = (id: string) => `externalhandoff:${id}`
const handoffRequestKey = (client: string, key: string) => `externalhandoffrequest:${client}:${key}`
export const HANDOFF_RETENTION_MS = 7 * 24 * 3600000
export const SHARE_EXPIRY_MS = 24 * 3600000

function trustedClick(event: Event) {
  if (!(event instanceof Event) || !event.isTrusted || !['click', 'submit'].includes(event.type)) throw new Error('本人がアプリの確認ボタンから操作してください')
}

/** Drops retention-expired drafts/packages. Accepted notes stay as ordinary task notes. */
export async function purgeExternalShares(now = Date.now()) {
  await db.transaction('rw', db.externalHandoffs, db.contextSharePackages, async () => {
    for (const row of await db.externalHandoffs.toArray()) {
      if (Date.parse(row.retentionUntil) <= now) await db.externalHandoffs.delete(row.id)
    }
    for (const row of await db.contextSharePackages.toArray()) {
      if (Date.parse(row.expiresAt) <= now) await db.contextSharePackages.delete(row.id)
    }
  })
}

async function assertHandoffCapacity(client: string, isNew: boolean) {
  const rows = await db.commands.toCollection().filter((row) => /^externalhandoff(request)?:/.test(row.key)).toArray()
  const own = rows.filter((row) => row.key.split(':')[1] === client)
  if (rows.length >= (isNew ? 14999 : 15000) || own.length >= (isNew ? 2999 : 3000)) fail('TOO_MANY_PROPOSALS')
  if (isNew) {
    const drafts = await db.externalHandoffs.where('agentClientId').equals(client).toArray()
    if (drafts.filter((row) => row.state === 'draft').length >= 100 || drafts.length >= 1000) fail('TOO_MANY_PROPOSALS')
  }
}

/** Catalog draft intake: descriptive only. Drafts never enter memory or tasks until native accept. */
export async function dispatchExternalHandoffTool(name: string, args: Record<string, unknown>, rawContext: ExternalToolContext) {
  if (name !== 'coach_prepare_handoff') fail('TOOL_NOT_FOUND')
  const tool = catalog.tools.find((item) => item.name === name)
  if (!tool) fail('TOOL_NOT_FOUND')
  assertSchema(tool.inputSchema, args)
  const context: ExternalToolContext = structuredClone(rawContext)
  const client = context.registration.client.id
  return db.transaction('rw', [db.settings, db.datasetState, db.tasks, db.commands, db.externalHandoffs, db.contextSharePackages], async () => {
    const { registration, settings } = await assertExternalToolAuthority(context)
    if (!registration.client.grant.keys.includes('handoff:prepare')) fail('INSUFFICIENT_SCOPE')
    if (!changePolicyFor(settings).aiChangesEnabled) fail('AI_MUTATIONS_PAUSED')
    const requestKey = String(args.request_key)
    const summary = String(args.summary ?? '')
    const taskIds = ((args.task_ids ?? []) as string[]).slice().sort()
    if (!summary.trim() || summary.length > 4000 || taskIds.length > 50) fail('TOOL_SCHEMA')
    for (const taskId of taskIds) {
      if (!registration.task_ids.includes(taskId)) fail('NOT_FOUND')
      const task = await db.tasks.get(taskId)
      if (!task || task.deletedAt) fail('NOT_FOUND')
    }
    const hash = await Dexie.waitFor(contentDigest({ requestKey, summary, taskIds, client }))
    const key = handoffRequestKey(client, requestKey)
    const prior = await db.commands.get(key)
    if (prior) {
      if (prior.hash !== hash) fail('IDEMPOTENCY_MISMATCH')
      const draft = await db.externalHandoffs.get(prior.resultId)
      if (!draft || draft.agentClientId !== client) fail('PLAN_NOT_FOUND')
      return publicHandoff(draft)
    }
    await assertHandoffCapacity(client, true)
    await purgeExternalShares()
    const createdAt = new Date().toISOString()
    const draft: ExternalHandoff = {
      id: uid(), ownerId: context.ownerId, datasetId: context.datasetId, agentClientId: client,
      requestKey, summary: summary.slice(0, 4000), targetTaskIds: taskIds, state: 'draft', revision: 1,
      acceptedNoteId: null, retentionUntil: new Date(Date.now() + HANDOFF_RETENTION_MS).toISOString(), createdAt,
    }
    await db.externalHandoffs.add(draft)
    await db.commands.add({ key: handoffKey(draft.id), hash: await Dexie.waitFor(contentDigest(draft)), resultId: draft.id, at: createdAt })
    await db.commands.add({ key, hash, resultId: draft.id, at: createdAt })
    return publicHandoff(draft)
  })
}

function publicHandoff(draft: ExternalHandoff) {
  return { handoff_id: draft.id, state: 'draft' as const, review_url: `michi://handoff/${draft.id}` }
}

/** Owner review surface: drafts labeled as unconfirmed external content. */
export async function listHandoffDrafts(): Promise<ExternalHandoff[]> {
  await purgeExternalShares()
  return (await db.externalHandoffs.toArray()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Native accept stores the summary as exactly one task note with external provenance. Twice stays one. */
export async function acceptHandoffDraft(id: string, expectedRevision: number, editedSummary: string | null, event: Event): Promise<string> {
  trustedClick(event)
  if (editedSummary !== null && (typeof editedSummary !== 'string' || !editedSummary.trim() || editedSummary.length > 4000)) throw new Error('要約は4000字以内で入力してください')
  return db.transaction('rw', db.settings, db.tasks, db.taskNotes, db.externalHandoffs, async () => {
    const settings = await db.settings.get('main')
    const draft = await db.externalHandoffs.get(id)
    if (!draft || !settings || draft.ownerId !== settings.profileId || draft.datasetId !== settings.datasetId) throw new Error('引継ぎが見つかりません')
    if (draft.revision !== expectedRevision) throw new Error('表示中の内容が変わりました。もう一度確認してください')
    if (draft.state === 'accepted') return draft.acceptedNoteId!
    if (draft.state !== 'draft') throw new Error('この引継ぎは受入できません')
    if (!draft.targetTaskIds.length) throw new Error('受入先のタスクがありません。対象のある引継ぎだけ受け入れられます')
    const task = await db.tasks.get(draft.targetTaskIds[0])
    if (!task || task.deletedAt) throw new Error('受入先のタスクがありません')
    const body = `外部AIからの引継ぎ（未確認）:\n${(editedSummary ?? draft.summary).slice(0, 4000)}`
    const noteId = uid()
    await db.taskNotes.add({ id: noteId, taskId: task.id, ownerId: draft.ownerId, kind: 'source', body, createdAt: new Date().toISOString() })
    await db.externalHandoffs.update(id, { state: 'accepted', revision: draft.revision + 1, acceptedNoteId: noteId })
    return noteId
  })
}

export async function rejectHandoffDraft(id: string, expectedRevision: number, event: Event): Promise<void> {
  trustedClick(event)
  const draft = await db.externalHandoffs.get(id)
  const settings = await db.settings.get('main')
  if (!draft || !settings || draft.ownerId !== settings.profileId || draft.datasetId !== settings.datasetId) throw new Error('引継ぎが見つかりません')
  if (draft.revision !== expectedRevision) throw new Error('表示中の内容が変わりました。もう一度確認してください')
  if (draft.state === 'rejected') return
  if (draft.state !== 'draft') throw new Error('この引継ぎは却下できません')
  await db.externalHandoffs.update(id, { state: 'rejected', revision: draft.revision + 1 })
}
