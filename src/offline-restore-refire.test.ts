/// <reference types="node" />
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput } from './commands'
import { emptyScore } from './domain'
import { addTaskAttachment } from './materials'
import { achievementDB, approveAchievementFromUI, clearAchievementAuthority, createAchievementEvidenceFromUI, prepareAchievementExport, reconcileAchievementExports, saveAchievementPolicyFromUI } from './achievements-save'
import { achievementTestGateway } from './achievements-test-fixtures'
import type { GitHubAchievementsGateway, GitHubGatewayStatus } from './github-publish-types'
import { captureSnapshot, restoreBackup } from './backup'
import { createReminder, dispatchDueReminders, pendingOSReminder } from './reminders'
import { catchUpRoutines } from './routine-catchup'
import { setNetworkPolicy } from './runtime-profile'

// Synthetic: fake GitHub gateway and the real main-process NetworkGateway module with a recording fetch.
// Nothing reaches GitHub, OpenRouter or the OS notification center.
const require = createRequire(import.meta.url)
const { createNetworkGateway, policyFromSettings } = require('../electron/network-gateway.cjs') as { policyFromSettings: (settings: unknown) => { policy: string }; createNetworkGateway: (options: { getPolicy: () => Promise<{ policy: string }>; fetchImpl: typeof fetch }) => { fetch: (purpose: string, url: string, init?: RequestInit) => Promise<Response>; status: () => { counters: Record<string, { attempts: number; blockedOffline: number }> } } }
function nativeClick() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
function gateway() {
  const status: GitHubGatewayStatus = structuredClone(achievementTestGateway)
  const publish = vi.fn(async () => ({ status: 'failed' as const, code: 'SHOULD_NOT_RUN' })), reconcile = vi.fn(async () => ({ status: 'unknown' as const, code: 'SHOULD_NOT_RUN' }))
  const api: GitHubAchievementsGateway = { status: vi.fn(async () => structuredClone(status)), storedStatus: vi.fn(async () => ({ ...structuredClone(status), state: 'awaiting_connection' as const })), inspectConfiguration: async () => { throw new Error('synthetic only') }, configure: async () => structuredClone(status), publish, recordReceipt: vi.fn(async () => undefined), reconcile, disconnect: async () => ({ ...status, state: 'integration_not_configured', configurationId: null, repository: null }), invalidate: vi.fn(async () => undefined) } as unknown as GitHubAchievementsGateway
  return { api, publish, reconcile }
}
beforeEach(async () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 1, 10, 0)); clearAchievementAuthority(); await db.delete(); await db.open(); await ensureSettings() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('AT-N10-17/18/20 復元で過去の実績・通知・外部投稿を再発火しない', () => {
  it.each(['queued', 'committing'] as const)('完了済み・公開%sの実績と通知予約を新しいdatasetへ復元しても、GitHub通信0・OS通知0・加点なし', async state => {
    const network = vi.fn(); vi.stubGlobal('fetch', network)
    const recorder = vi.fn(async () => new Response('{}'))
    const egress = createNetworkGateway({ getPolicy: async () => policyFromSettings(await db.settings.get('main')), fetchImpl: recorder as unknown as typeof fetch })
    const github = gateway()
    await db.settings.update('main', { notifications: true })
    const policyId = await saveAchievementPolicyFromUI({ threshold: 40, allowedCategoryIds: [], allowedEvidenceKinds: ['artifact_file', 'user_statement', 'code_link'], requireAttachment: true, enabled: true }, nativeClick(), github.api)
    const taskId = await createTask({ ...newTaskInput(), title: '公開候補の作業', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
    const reminderTask = await createTask({ ...newTaskInput(), title: '通知予約の作業' })
    const attachmentId = await addTaskAttachment(taskId, new File(['synthetic bytes'], 'evidence.txt', { type: 'text/plain' }))
    await completeTask(taskId, 1)
    const completion = (await db.completions.where('taskId').equals(taskId).first())!
    const evidenceId = await createAchievementEvidenceFromUI({ completionId: completion.id, kind: 'artifact_file', attachmentId, publicText: '本人が選んだ公開説明', publicReviewed: true }, nativeClick())
    const exportId = await approveAchievementFromUI(await prepareAchievementExport(completion.id, policyId, { title: '公開用の題名', body: '公開用の説明', evidenceIds: [evidenceId], includePastCompletion: false, correctionReason: '' }, github.api), nativeClick(), github.api)
    const reminderAt = new Date(Date.now() + 60 * 60000)
    await createReminder('once', reminderTask, reminderAt.toISOString(), ['in-app', 'os'], new Date())
    const [event] = await dispatchDueReminders(reminderAt)
    expect(event).toBeDefined()
    const snapshot = await captureSnapshot(), row = snapshot.achievementExports!.find(item => item.id === exportId)!
    row.state = state
    if (state === 'committing') Object.assign(row, { attemptId: crypto.randomUUID(), attemptStartedAt: new Date().toISOString(), attemptCount: 1 })
    const ledgerTotal = (await db.ledger.toArray()).reduce((sum, entry) => sum + entry.delta, 0), completions = await db.completions.toArray()

    // A different, freshly installed profile restores the bundle while offline_only.
    await db.delete(); await db.open(); await ensureSettings(); await setNetworkPolicy('offline_only')
    await restoreBackup(snapshot)
    // The bundle was taken before any choice; this device's offline_only choice survives the restore and drives the gateway.
    expect(snapshot.settings[0].runtimeProfile).toBeUndefined()
    expect((await db.settings.get('main'))!.runtimeProfile?.network_policy).toBe('offline_only')
    await catchUpRoutines()
    await reconcileAchievementExports()
    const due = await dispatchDueReminders(new Date(reminderAt.getTime() + 60000)), payloads = []
    for (const item of [event, ...due]) { const payload = await pendingOSReminder(item, new Date(reminderAt.getTime() + 60000)); if (payload) payloads.push(payload) }
    // A publish attempt from a restored row would have to pass the gateway; nothing called it.
    expect(payloads).toEqual([])
    expect(github.publish).not.toHaveBeenCalled()
    expect(github.reconcile).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
    expect(recorder).not.toHaveBeenCalled()
    expect(egress.status().counters.github).toMatchObject({ attempts: 0 })
    expect((await achievementDB.achievementExports.get(exportId))?.state).toBe(state === 'committing' ? 'unknown' : 'awaiting_review')
    expect((await achievementDB.achievementExports.get(exportId))?.approvedAt).toBeNull()
    expect((await db.ledger.toArray()).reduce((sum, entry) => sum + entry.delta, 0)).toBe(ledgerTotal)
    expect(await db.completions.toArray()).toEqual(completions)
    const intents = (await db.settings.get('main'))!.notificationState?.intents ?? []
    expect(intents.flatMap(intent => intent.deliveries).filter(delivery => delivery.destinationId === 'os' && ['sending', 'accepted_by_provider'].includes(delivery.state))).toEqual([])
    // Restoring the same bundle again adds no second completion or award.
    await restoreBackup(snapshot)
    expect(await db.completions.count()).toBe(completions.length)
    expect((await db.ledger.toArray()).reduce((sum, entry) => sum + entry.delta, 0)).toBe(ledgerTotal)
  })
})
