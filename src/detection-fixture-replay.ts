import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { defaultSourcePermissions, importLocalSource } from './source-library'
import { prepareDetectionFromUI, type DetectionTransport, type PreparedDetection } from './detection-run'
import { requiredDetectionClaims, type DetectionChange, type DetectionOutput } from './detection-contract'
import type { DetectionFixture } from './detection-fixtures'

/** Replays the design pack's synthetic fixtures through the real pipeline. These are the design author's
 * expected outputs, not model observations: passing them says nothing about model accuracy. */
export const replayModel = 'synthetic/replay-model'
// Node fixture only: production uses the browser's native trusted click event.
export function humanClick(): Event { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
export type ReplayContext = { fixture: DetectionFixture; sourceId: string; prepared: PreparedDetection; taskIds: Map<string, string> }
const dateOf = (value: string | null) => value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '2026-10-01'
/** Imports the fixture text as one source, creates its existing tasks, and prepares a detection from the owner's UI. */
export async function prepareFixture(fixture: DetectionFixture, options: { bindingIds?: string[]; ruleIds?: string[]; keepFixtureBindings?: boolean } = {}): Promise<ReplayContext> {
  const settings = (await db.settings.get('main'))!, source = fixture.input.sources[0], context = fixture.input.trusted_context, date = dateOf(source.sent_at)
  const taskIds = new Map<string, string>()
  for (const task of context.existing_tasks) taskIds.set(task.id, await createTask({ ...newTaskInput(), title: task.title, dueDate: task.dueDate ?? null }))
  const sourceId = await importLocalSource({ title: `${fixture.id} 合成資料`, provider: 'local', externalId: null, conversation: null, author: null, sourceUrl: null, date, fromDate: date, toDate: date, timezone: source.timezone ?? 'Asia/Tokyo', text: source.spans.map(span => span.text).join('\n'), permissions: { ...defaultSourcePermissions(), aiEgress: true }, allowedModels: [settings.aiModel!, ...(settings.aiVerifierModel && settings.aiVerifierModel !== settings.aiModel ? [settings.aiVerifierModel] : [])], retentionUntil: null })
  const row = (await db.contextSources.get(sourceId))!
  const prepared = await prepareDetectionFromUI(sourceId, row.revision, settings.aiModel!, {
    confirmedAliases: Object.keys(context.verified_reference_aliases), authorIsOwner: source.author_id === context.user_id, existingTaskIds: [...taskIds.values()],
    ...(options.keepFixtureBindings === false ? {} : { participationBindings: context.participation_bindings.map(binding => ({ id: binding.id, confirmed: binding.confirmed, description: (binding as { scope?: string }).scope ?? binding.description ?? '' })), approvedRules: context.approved_rules.map(rule => ({ ...rule })) }),
    ...(options.bindingIds ? { bindingIds: options.bindingIds } : {}), ...(options.ruleIds ? { ruleIds: options.ruleIds } : {})
  }, humanClick())
  return { fixture, sourceId, prepared, taskIds }
}
/** Rewrites fixture ids (source, span, owner, existing task and revision) to the ones the app assigned. */
export function mapFixtureOutput(context: ReplayContext, output: DetectionOutput = context.fixture.output): DetectionOutput {
  const fixtureSource = context.fixture.input.sources[0], real = context.prepared.request.sources[0], owner = context.prepared.ownerId, user = context.fixture.input.trusted_context.user_id
  const span = (id: string) => real.spans[fixtureSource.spans.findIndex(item => item.span_id === id)]?.span_id ?? id
  const tasks = context.prepared.request.trusted_context.existing_tasks
  const change = (item: DetectionChange): DetectionChange => {
    const target = item.target_task_id ? context.taskIds.get(item.target_task_id) ?? item.target_task_id : null
    return { ...structuredClone(item), assignee_id: item.assignee_id === user ? owner : item.assignee_id, target_task_id: target, expected_revision: target ? tasks.find(task => task.id === target)?.revision ?? item.expected_revision : item.expected_revision, evidence: item.evidence.map(reference => ({ ...reference, source_id: reference.source_id === fixtureSource.source_id ? real.source_id : reference.source_id, revision: reference.source_id === fixtureSource.source_id ? real.revision : reference.revision, span_id: reference.source_id === fixtureSource.source_id ? span(reference.span_id) : reference.span_id })) }
  }
  return { schema_version: '1', changes: output.changes.map(change), review_items: output.review_items.map(item => ({ ...item, source_ids: item.source_ids.map(id => id === fixtureSource.source_id ? real.source_id : id) })), ignored: output.ignored.map(item => ({ ...item, source_id: item.source_id === fixtureSource.source_id ? real.source_id : item.source_id })) }
}
/** Synthetic verifier that entails every required claim it is asked about, i.e. a verifier that is as wrong as the detector. */
export function entailingVerifier(): DetectionTransport['verify'] {
  return async ({ change }) => JSON.stringify({ verdict: 'entailed', checks: requiredDetectionClaims(change).map(field => ({ field, verdict: 'entailed', source_refs: [...new Set(change.evidence.map(reference => `${reference.source_id}:${reference.span_id}`))], reason: '合成検証（常に支持と返す）' })) })
}
export function replayTransport(context: ReplayContext, output?: DetectionOutput | string): DetectionTransport {
  return { detect: async () => typeof output === 'string' ? output : JSON.stringify(mapFixtureOutput(context, output)), verify: entailingVerifier() }
}
