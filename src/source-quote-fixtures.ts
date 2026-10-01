import { db } from './db'
import { defaultChangePolicy } from './change-set'
import { defaultSourcePermissions, importLocalSource, type SourcePermissions } from './source-library'
import { applyDetectionCreateFromUI, detectObligationsForSource, prepareDetectionCreate, prepareDetectionFromUI, type DetectionTransport, type PreparedDetection } from './detection-run'
import { requiredDetectionClaims, type DetectionChange } from './detection-contract'

/** Synthetic fixtures only: no network, no real Slack export, no real model. */
export const quoteModel = 'synthetic/allowed-model'
export const otherModel = 'synthetic/unlisted-model'
export const secretQuote = '顧客ZETAの非公開見積を2026年10月2日までに送ってください。'
// Node fixture only: production uses the browser's native trusted click event.
export function humanClick(): Event { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
export async function enableSyntheticAI(model = quoteModel) { await db.settings.update('main', { aiEnabled: true, aiModel: model, changePolicy: defaultChangePolicy() }) }
export function syntheticTransport(value: PreparedDetection, title = '非公開見積を送る'): DetectionTransport {
  const source = value.request.sources[0], span = source.spans.find(item => item.text.includes('までに'))!
  const change: DetectionChange = { action: 'create', target_task_id: null, expected_revision: null, title, assignee_id: value.ownerId, basis: 'explicit_request', obligation_state: 'requested', change_fields: ['title', 'assignee', 'due'], due: { kind: 'date', value: '2026-10-02', timezone: 'Asia/Tokyo', raw: span.text }, recurrence: null, applicability_ref: null, rule_ref: null, evidence: [{ source_id: source.source_id, revision: source.revision, span_id: span.span_id, quote: span.text, supports: ['action', 'assignee', 'active', 'due'] }] }
  return {
    detect: async () => JSON.stringify({ schema_version: '1', changes: [change], review_items: [], ignored: [] }),
    verify: async ({ change: checked }) => JSON.stringify({ verdict: 'entailed', checks: requiredDetectionClaims(checked).map(field => ({ field, verdict: 'entailed', source_refs: [`${source.source_id}:${span.span_id}`], reason: '合成の原文を照合した' })) })
  }
}
export async function importWorkSlack(options: { text?: string; permissions?: Partial<SourcePermissions>; allowedModels?: string[]; retentionUntil?: string | null; conversation?: string; fromDate?: string; toDate?: string } = {}) {
  return importLocalSource({ title: '仕事Slackの選択export', provider: 'slack', externalId: `C-${crypto.randomUUID()}`, conversation: options.conversation ?? '仕事チャンネル', author: null, sourceUrl: null, date: options.toDate ?? '2026-10-01', fromDate: options.fromDate ?? '2026-09-01', toDate: options.toDate ?? '2026-10-01', text: options.text ?? `上司: 次の件をお願いします\n${secretQuote}`, permissions: { ...defaultSourcePermissions(), aiEgress: true, ...options.permissions }, allowedModels: options.allowedModels ?? [quoteModel], retentionUntil: options.retentionUntil === undefined ? null : options.retentionUntil })
}
/** Real detection → verification → owner adoption path, as the Inbox does it. */
export async function adoptDetectedTask(sourceId?: string, title?: string) {
  const id = sourceId ?? await importWorkSlack(), row = await db.contextSources.get(id), settings = await db.settings.get('main')
  const prepared = await prepareDetectionFromUI(id, row!.revision, settings!.aiModel!, { confirmedAliases: [], authorIsOwner: false, existingTaskIds: [] }, humanClick())
  const run = await detectObligationsForSource(prepared, syntheticTransport(prepared, title))
  const confirmation = await prepareDetectionCreate(run, run.candidates[0].id)
  const receipt = await applyDetectionCreateFromUI(run, confirmation, confirmation.digest, humanClick())
  return { sourceId: id, taskId: receipt.taskIds[0], run, receipt }
}
