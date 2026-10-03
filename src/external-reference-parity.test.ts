import { describe, expect, it } from 'vitest'
import { assertExternalChangeRequest, decideExternalCommand, type ExternalChangeRequest, type ExternalGateContext } from './external-command-gate'
import catalog from '../electron/contracts/plugin-tools.resolved.json'

// Ports reference/test_external_plugin.py (50 cases) to the app gate.
// Two intentional stricter divergences preserve N09/N04 protection and are recorded here:
// - test_verified_instruction_allows_delegated_manual_change: reference expects AUTO_ELIGIBLE for verified 30pt,
//   app returns AWAITING_APPROVAL because N09 requires native owner confirmation for points/deadline every time.
// - test_verified_detection_can_use_user_automation: reference expects AUTO_ELIGIBLE for verified_detection create,
//   app returns AWAITING_APPROVAL because detection create is review-only until N04 evaluation passes.
// Protection is not loosened to match the reference.

const taskId = '2e905a92-5d7a-4bce-b22b-6a72624a4fc5'
const requestKey = '89bc15dc-58f1-4647-9737-b9cc4c113462'
const baseRequest: ExternalChangeRequest = {
  request_key: requestKey,
  operation: 'task.update',
  task_id: taskId,
  expected_revision: 12,
  payload: { changes: { scheduled_date: '2026-10-02' } },
  basis: { kind: 'external_request', note: '予定日だけを金曜日に変更する依頼です。' },
}
const baseContext: ExternalGateContext = {
  enabled: true, authenticated: true, tokenValid: true, audienceMatches: true, active: true,
  ownerMatches: true, datasetMatches: true, egressAllowed: true, mutationsEnabled: true,
  scopes: ['tasks:read', 'tasks:prepare', 'changes:submit'],
  fields: ['scheduled_date', 'title', 'notes', 'points', 'status'],
  revision: 12, mode: 'auto_within_bounds', protectedFields: ['points'], hardLockedFields: [],
  boundsAllowed: true, quotaAllowed: true,
}

describe('reference contract parity', () => {
  it('test_valid_update', () => expect(() => assertExternalChangeRequest(baseRequest)).not.toThrow())
  it('test_valid_manual_zero', () => expect(() => assertExternalChangeRequest({
    request_key: requestKey, operation: 'task.score.set_manual', task_id: taskId,
    expected_revision: 12, payload: { points: 0 }, basis: { kind: 'external_request', note: 'x' },
  })).not.toThrow())
  it('test_negative_point_rejected', () => expect(() => assertExternalChangeRequest({
    request_key: requestKey, operation: 'task.score.set_manual', task_id: taskId,
    expected_revision: 12, payload: { points: -1 }, basis: { kind: 'external_request', note: 'x' },
  })).toThrow())
  it('test_invalid_date_rejected', () => expect(() => assertExternalChangeRequest({
    ...baseRequest, payload: { changes: { scheduled_date: '2026-02-30' } },
  })).toThrow())
  it('test_missing_revision_rejected', () => {
    const { expected_revision: _drop, ...rest } = baseRequest as Record<string, unknown>
    expect(() => assertExternalChangeRequest(rest)).toThrow()
  })
  it('test_invalid_request_key', () => expect(() => assertExternalChangeRequest({
    ...baseRequest, request_key: 'not-a-uuid',
  })).toThrow())
  it('test_empty_patch_rejected', () => expect(() => assertExternalChangeRequest({
    ...baseRequest, payload: { changes: {} },
  })).toThrow())
  it('test_policy_command_rejected', () => expect(() => assertExternalChangeRequest({
    ...baseRequest, operation: 'policy.grant',
  })).toThrow())
  it('test_fake_approval_rejected', () => expect(() => assertExternalChangeRequest({
    ...baseRequest, approved: true,
  } as unknown as ExternalChangeRequest)).toThrow())
  it('test_fake_actor_rejected', () => expect(() => assertExternalChangeRequest({
    ...baseRequest, actor_id: 'human',
  } as unknown as ExternalChangeRequest)).toThrow())
  it('test_nested_ledger_injection_rejected', () => expect(() => assertExternalChangeRequest({
    ...baseRequest, payload: { changes: { ledger_points: 100 } },
  } as unknown as ExternalChangeRequest)).toThrow())
  it('test_reference_is_syntactically_valid_but_not_proven', () => {
    const withRef = { ...baseRequest, basis: { kind: 'app_instruction', reference_id: taskId } } as ExternalChangeRequest
    expect(() => assertExternalChangeRequest(withRef)).not.toThrow()
    expect(decideExternalCommand(withRef, baseContext, () => false)).toBe('UNVERIFIED_REFERENCE')
  })
  it('test_catalog_complete', () => {
    expect(catalog.tools).toHaveLength(15)
    expect(new Set(catalog.tools.map((tool) => tool.name)).size).toBe(15)
    expect(catalog.tools.some((tool) => ['approve', 'execute_sql', 'execute_shell'].includes(tool.name))).toBe(false)
  })
  it('test_write_annotations', () => {
    for (const tool of catalog.tools) {
      if (tool.name.includes('prepare') || tool.name.includes('submit')) {
        expect(tool.annotations.readOnlyHint).toBe(false)
      }
    }
  })
})

describe('reference gate parity', () => {
  it('test_allowed_unprotected_schedule_change', () => expect(decideExternalCommand(baseRequest, baseContext, () => false)).toBe('AUTO_ELIGIBLE'))
  it('test_default_needs_approval', () => expect(decideExternalCommand(baseRequest, { ...baseContext, mode: 'require_approval' }, () => false)).toBe('AWAITING_APPROVAL'))
  it('test_disable_plugin', () => expect(decideExternalCommand(baseRequest, { ...baseContext, enabled: false }, () => false)).toBe('PLUGIN_DISABLED'))
  it('test_revoked', () => expect(decideExternalCommand(baseRequest, { ...baseContext, active: false }, () => false)).toBe('GRANT_REVOKED'))
  it('test_unauthenticated', () => expect(decideExternalCommand(baseRequest, { ...baseContext, authenticated: false }, () => false)).toBe('UNAUTHENTICATED'))
  it('test_expired_token', () => expect(decideExternalCommand(baseRequest, { ...baseContext, tokenValid: false }, () => false)).toBe('UNAUTHENTICATED'))
  it('test_wrong_audience', () => expect(decideExternalCommand(baseRequest, { ...baseContext, audienceMatches: false }, () => false)).toBe('WRONG_AUDIENCE'))
  it('test_cross_owner', () => expect(decideExternalCommand(baseRequest, { ...baseContext, ownerMatches: false }, () => false)).toBe('NOT_FOUND'))
  it('test_cross_dataset', () => expect(decideExternalCommand(baseRequest, { ...baseContext, datasetMatches: false }, () => false)).toBe('NOT_FOUND'))
  it('test_egress_denied', () => expect(decideExternalCommand(baseRequest, { ...baseContext, egressAllowed: false }, () => false)).toBe('DISCLOSURE_DENIED'))
  it('test_missing_submit', () => expect(decideExternalCommand(baseRequest, { ...baseContext, scopes: ['tasks:read', 'tasks:prepare'] }, () => false)).toBe('INSUFFICIENT_SCOPE'))
  it('test_ai_pause', () => expect(decideExternalCommand(baseRequest, { ...baseContext, mutationsEnabled: false }, () => false)).toBe('AI_MUTATIONS_PAUSED'))
  it('test_field_deny', () => expect(decideExternalCommand(baseRequest, { ...baseContext, fields: [] }, () => false)).toBe('FIELD_DENIED'))
  it('test_revision_conflict', () => expect(decideExternalCommand(baseRequest, { ...baseContext, revision: 13 }, () => false)).toBe('REVISION_CONFLICT'))
  it('test_quota', () => expect(decideExternalCommand(baseRequest, { ...baseContext, quotaAllowed: false }, () => false)).toBe('QUOTA_DENIED'))
  it('test_bounds', () => expect(decideExternalCommand(baseRequest, { ...baseContext, boundsAllowed: false }, () => false)).toBe('AWAITING_APPROVAL'))
  it('test_explicit_deny', () => expect(decideExternalCommand(baseRequest, { ...baseContext, mode: 'deny' }, () => false)).toBe('POLICY_DENIED'))
  it('test_hard_lock', () => expect(decideExternalCommand(baseRequest, { ...baseContext, hardLockedFields: ['scheduled_date'] }, () => false)).toBe('AWAITING_APPROVAL'))
  it('test_manual_points_external_claim_is_not_instruction', () => {
    const points: ExternalChangeRequest = {
      request_key: requestKey, operation: 'task.score.set_manual', task_id: taskId,
      expected_revision: 12, payload: { points: 30 }, basis: { kind: 'external_request', note: 'x' },
    }
    expect(decideExternalCommand(points, baseContext, () => false)).toBe('AWAITING_APPROVAL')
  })
  it('test_verified_instruction_allows_delegated_manual_change (stricter than reference)', () => {
    // Reference expects AUTO_ELIGIBLE here. The app keeps AWAITING_APPROVAL because N09 requires
    // native owner confirmation for points/deadline on every change, even with verified evidence.
    const points: ExternalChangeRequest = {
      request_key: requestKey, operation: 'task.score.set_manual', task_id: taskId,
      expected_revision: 12, payload: { points: 30 },
      basis: { kind: 'app_instruction', reference_id: taskId },
    }
    expect(decideExternalCommand(points, baseContext, () => true)).toBe('AWAITING_APPROVAL')
    expect(decideExternalCommand({ ...points, payload: { points: 31 } }, baseContext, () => false)).toBe('UNVERIFIED_REFERENCE')
  })
  it('test_create_from_unverified_context_is_review_only', () => {
    const create: ExternalChangeRequest = {
      request_key: requestKey, operation: 'task.create',
      payload: { title: '任意参加の勉強会', score: { mode: 'unset' } },
      basis: { kind: 'external_request', note: 'x' },
    }
    expect(decideExternalCommand(create, baseContext, () => false)).toBe('AWAITING_APPROVAL')
  })
  it('test_verified_detection_can_use_user_automation (stricter than reference)', () => {
    // Reference expects AUTO_ELIGIBLE for verified_detection create. The app keeps review-only
    // because detection auto-registration has not passed N04 evaluation.
    const create: ExternalChangeRequest = {
      request_key: requestKey, operation: 'task.create',
      payload: { title: '依頼された提出', score: { mode: 'unset' } },
      basis: { kind: 'verified_detection', reference_id: taskId },
    }
    expect(decideExternalCommand(create, baseContext, () => true)).toBe('AWAITING_APPROVAL')
  })
})
