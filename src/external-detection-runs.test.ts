import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { bridgeHarness, resetApp } from './command-test-harness'
import { externalAIFor } from './external-authority'
import { dispatchExternalDetectionTool } from './external-detection-runs'
import type { ExternalToolContext } from './external-tools'
import { defaultSourcePermissions, importLocalSource } from './source-library'
import { detectObligationsForSource, prepareDetectionFromUI } from './detection-run'
import { requiredDetectionClaims, type DetectionClaim, type DetectionOutput } from './detection-contract'

const model = 'synthetic/coach-a'
function click() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }

function contextFor(registration: ExternalToolContext['registration'], ownerId: string, datasetId: string, epoch: number): ExternalToolContext {
  return {
    registration, ownerId, datasetId, externalEpoch: epoch,
    policyEpoch: registration.policy_epoch, sourcePermissionRevision: registration.source_permission_revision,
  }
}

async function source(text = 'Karinさん、2026年10月2日までに見積書を送ってください。') {
  return importLocalSource({
    title: '合成資料', provider: 'local', externalId: null, conversation: null, author: 'Karin',
    sourceUrl: null, date: '2026-10-01', fromDate: '2026-10-01', toDate: '2026-10-01', text,
    permissions: { ...defaultSourcePermissions(), aiEgress: true }, allowedModels: [model], retentionUntil: null,
  })
}

// Detection scope waits for a separate owner cost approval: prepare records the scope and an
// estimate, inference never starts here, and no send is recorded. Adoption stays owner-driven.
it('detection prepare records scope without inference or sends', async () => {
  await resetApp()
  const allowed = await createTask({ ...newTaskInput(), title: '許可タスク' })
  const sourceId = await source()
  const otherId = await source('別の資料です。')
  const h = await bridgeHarness({ taskIds: [allowed], fields: ['title'], allowDetection: true })
  try {
    const settings = (await db.settings.get('main'))!
    const registration = h.status().registration!
    const context = contextFor(registration, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    expect(registration.client.grant.keys).toEqual(expect.arrayContaining(['detection:request', 'detection:read']))
    const key = crypto.randomUUID()
    const prepared = await dispatchExternalDetectionTool('coach_prepare_detection_run', { request_key: key, context_ids: [sourceId] }, context) as {
      run_id: string; state: string; estimate_tokens: number; approval_url: null
    }
    expect(prepared.state).toBe('awaiting_cost_approval')
    expect(prepared.estimate_tokens).toBeGreaterThan(0)
    expect(prepared.approval_url).toBeNull()
    expect(await dispatchExternalDetectionTool('coach_prepare_detection_run', { request_key: key, context_ids: [sourceId] }, context)).toEqual(prepared)
    await expect(dispatchExternalDetectionTool('coach_prepare_detection_run', { request_key: key, context_ids: [otherId] }, context)).rejects.toThrow('IDEMPOTENCY_MISMATCH')
    // Nothing started: no run artifacts, no tasks, no ledger writes.
    expect(await db.sourceArtifacts.count()).toBe(0)
    expect(await db.tasks.count()).toBe(1)
    expect(await db.ledger.count()).toBe(0)
    // The prepared scope reads back as cost-approval-waiting with no output yet.
    const fetched = await dispatchExternalDetectionTool('coach_get_detection_run', { run_id: prepared.run_id }, context) as {
      run: { run_id: string; state: string }; output: null
    }
    expect(fetched.run).toMatchObject({ run_id: prepared.run_id, state: 'awaiting_cost_approval' })
    expect(fetched.output).toBeNull()
    // Unknown sources and missing scopes fail closed without leaking which check failed.
    await expect(dispatchExternalDetectionTool('coach_prepare_detection_run', { request_key: crypto.randomUUID(), context_ids: [crypto.randomUUID()] }, context)).rejects.toThrow('NOT_FOUND')
  } finally {
    await h.close()
  }
})

it('detection prepare needs the scope and a configured owner model', async () => {
  await resetApp()
  const allowed = await createTask({ ...newTaskInput(), title: '許可タスク' })
  const sourceId = await source()
  const h = await bridgeHarness({ taskIds: [allowed], fields: ['title'] })
  try {
    const settings = (await db.settings.get('main'))!
    const registration = h.status().registration!
    const context = contextFor(registration, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    expect(registration.client.grant.keys).not.toContain('detection:request')
    await expect(dispatchExternalDetectionTool('coach_prepare_detection_run', { request_key: crypto.randomUUID(), context_ids: [sourceId] }, context)).rejects.toThrow('INSUFFICIENT_SCOPE')
    await expect(dispatchExternalDetectionTool('coach_get_detection_run', { run_id: crypto.randomUUID() }, context)).rejects.toThrow('INSUFFICIENT_SCOPE')
  } finally {
    await h.close()
  }
  await resetApp()
  const task = await createTask({ ...newTaskInput(), title: '許可タスク' })
  const other = await source()
  const g = await bridgeHarness({ taskIds: [task], fields: ['title'], allowDetection: true })
  try {
    await db.settings.update('main', { aiEnabled: false })
    const settings = (await db.settings.get('main'))!
    const registration = g.status().registration!
    // Epoch/authority is unchanged; only the owner model setup is off.
    const context = contextFor(registration, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    await expect(dispatchExternalDetectionTool('coach_prepare_detection_run', { request_key: crypto.randomUUID(), context_ids: [other] }, context)).rejects.toThrow('AI_MODEL_NOT_CONFIGURED')
  } finally {
    await g.close()
  }
})

it('finished app detection runs read back review-only when still current and permitted', async () => {
  await resetApp()
  const allowed = await createTask({ ...newTaskInput(), title: '許可タスク' })
  const sourceId = await source()
  const h = await bridgeHarness({ taskIds: [allowed], fields: ['title'], allowDetection: true })
  try {
    const settings = (await db.settings.get('main'))!
    const registration = h.status().registration!
    const context = contextFor(registration, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    const row = await db.contextSources.get(sourceId)
    const prepared = await prepareDetectionFromUI(sourceId, row!.revision, model, { confirmedAliases: ['Karinさん'], authorIsOwner: false, existingTaskIds: [] }, click())
    const span = prepared.request.sources[0].spans[0]
    const change = {
      action: 'create', target_task_id: null, expected_revision: null, title: '見積書を送る', assignee_id: settings.profileId,
      basis: 'explicit_request', obligation_state: 'requested', change_fields: ['title', 'assignee', 'due'],
      due: { kind: 'date', value: '2026-10-02', timezone: 'Asia/Tokyo', raw: span.text }, recurrence: null,
      applicability_ref: null, rule_ref: null,
      evidence: [{ source_id: prepared.request.sources[0].source_id, revision: prepared.request.sources[0].revision, span_id: span.span_id, quote: span.text, supports: ['action', 'assignee', 'active', 'due'] }],
    }
    const output: DetectionOutput = { schema_version: '1', changes: [change as DetectionOutput['changes'][number]], review_items: [], ignored: [] }
    const ref = `${prepared.request.sources[0].source_id}:${prepared.request.sources[0].spans[0].span_id}`
    const transport = {
      detect: vi.fn(async () => JSON.stringify(output)),
      verify: vi.fn(async () => JSON.stringify({ verdict: 'entailed', checks: requiredDetectionClaims(change as never).map((field: DetectionClaim) => ({ field, verdict: 'entailed', source_refs: [ref], reason: '合成の原文を照合した' })) })),
    }
    const run = await detectObligationsForSource(prepared, transport)
    const fetched = await dispatchExternalDetectionTool('coach_get_detection_run', { run_id: run.id }, context) as {
      run: { run_id: string; state: string }; output: { schema_version: string; changes: { title: string | null }[] } | null
    }
    expect(fetched.run).toMatchObject({ run_id: run.id, state: 'completed' })
    expect(fetched.output?.schema_version).toBe('1')
    expect(fetched.output?.changes.map((item) => item.title)).toEqual(['見積書を送る'])
    // Serialized review data restores no approval: adopting still needs the owner UI flow.
    expect(await db.tasks.count()).toBe(1)
    // Unknown run ids fail closed.
    await expect(dispatchExternalDetectionTool('coach_get_detection_run', { run_id: crypto.randomUUID() }, context)).rejects.toThrow('NOT_FOUND')
  } finally {
    await h.close()
  }
})
