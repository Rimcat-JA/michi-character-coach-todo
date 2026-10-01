/// <reference types="node" />
import 'fake-indexeddb/auto'
import { createRequire } from 'node:module'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { captureSnapshot, restoreBackup } from './backup'
import { validateSnapshot } from './backup-validation'
import { createTask, newTaskInput } from './commands'
import { effectiveNetworkPolicy, migrateRuntimeProfile, runtimeChoicePending, setNetworkPolicy, standaloneProfile, validateRuntimeProfile, validateRuntimeProfileSchema } from './runtime-profile'

// Synthetic fake-indexeddb only: no device, account, network or model is contacted.
const { policyFromSettings } = createRequire(import.meta.url)('../electron/network-gateway.cjs') as { policyFromSettings: (settings: unknown, legacy?: boolean) => { policy: string; source: string } }
async function freshDevice(policy: 'offline_only' | 'explicit_online' | null) { await db.delete(); await db.open(); await ensureSettings(); if (policy) await setNetworkPolicy(policy) }
beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })
const dataset = '0b6a4f0e-5d1c-4e2a-9f3b-2c4d5e6f7a8b'
const base = { schema_version: '1', kind: 'standalone', dataset_id: dataset, authority: 'local', network_policy: 'offline_only', server_url: null }

describe('N10 runtime profile', () => {
  it('standaloneはauthority=localかつserver_url=nullだけを受け付ける（schemaのif/then）', () => {
    expect(() => validateRuntimeProfileSchema(base)).not.toThrow()
    expect(() => validateRuntimeProfileSchema({ ...base, network_policy: 'explicit_online' })).not.toThrow()
    for (const bad of [{ ...base, authority: 'server' }, { ...base, server_url: 'https://pc.example.invalid' }, { ...base, schema_version: '2' }, { ...base, network_policy: 'always' }, { ...base, dataset_id: 'not-a-uuid' }, { ...base, extra: true }, Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'server_url'))])
      expect(() => validateRuntimeProfileSchema(bad)).toThrow()
  })
  it('接続型はschema上authority=serverとhttps URLが必要で、この版では保存しない', () => {
    const hosted = { ...base, kind: 'hosted', authority: 'server', server_url: 'https://cloud.example.invalid' }
    expect(() => validateRuntimeProfileSchema(hosted)).not.toThrow()
    expect(() => validateRuntimeProfileSchema({ ...hosted, server_url: 'http://cloud.example.invalid' })).toThrow()
    expect(() => validateRuntimeProfileSchema({ ...hosted, authority: 'local' })).toThrow()
    expect(() => validateRuntimeProfileSchema({ ...hosted, server_url: null })).toThrow()
    expect(() => validateRuntimeProfile(hosted, dataset)).toThrow('未提供')
    expect(() => validateRuntimeProfile(base, 'cccccccc-1234-4234-8234-cccccccccccc')).toThrow('データセット')
  })
  it('新規datasetはアカウント・キー・URLなしで開始し、選ぶまでoffline_onlyとして扱う', async () => {
    const settings = (await db.settings.get('main'))!
    expect(settings.runtimeProfile).toBeUndefined()
    expect(runtimeChoicePending(settings)).toBe(true)
    expect(effectiveNetworkPolicy(settings)).toEqual({ policy: 'offline_only', source: 'legacy' })
    expect(Object.keys(settings).filter(key => /key|token|password|url|email|account/i.test(key))).toEqual([])
    await setNetworkPolicy('offline_only')
    const chosen = (await db.settings.get('main'))!
    expect(chosen.runtimeProfile).toEqual({ ...base, dataset_id: chosen.datasetId })
    expect(runtimeChoicePending(chosen)).toBe(false)
    expect((await db.audits.toArray()).map(row => row.operation)).toEqual(['runtime.network_policy'])
  })
  it('AIを設定済みの既存datasetはexplicit_onlineへ移行し、黙ってAIを止めない', async () => {
    await db.settings.update('main', { aiEnabled: true, aiModel: 'deepseek/deepseek-v4.1-flash' })
    expect(effectiveNetworkPolicy((await db.settings.get('main'))!).policy).toBe('explicit_online')
    expect(await migrateRuntimeProfile(false)).toBe(true)
    expect((await db.settings.get('main'))!.runtimeProfile?.network_policy).toBe('explicit_online')
    expect(await migrateRuntimeProfile(true)).toBe(false)
    expect((await db.audits.toArray()).map(row => row.operation)).toEqual(['runtime.migrate'])
  })
  it('AIを止めてモデルIDだけが残るdatasetは移行せず、初回の選択を出す（main・effectiveNetworkPolicyと同じ規則）', async () => {
    await db.settings.update('main', { aiEnabled: false, aiModel: 'synthetic/model' })
    const settings = (await db.settings.get('main'))!
    expect(effectiveNetworkPolicy(settings).policy).toBe('offline_only')
    expect(policyFromSettings(settings).policy).toBe('offline_only')
    expect(await migrateRuntimeProfile(false)).toBe(false)
    expect((await db.settings.get('main'))!.runtimeProfile).toBeUndefined()
    expect(runtimeChoicePending((await db.settings.get('main'))!)).toBe(true)
    expect(await db.audits.count()).toBe(0)
    // A saved key or a GitHub connection file on this PC still counts as configured.
    expect(await migrateRuntimeProfile(true)).toBe(true)
    expect((await db.settings.get('main'))!.runtimeProfile?.network_policy).toBe('explicit_online')
  })
  it('GitHubだけ設定済みでも移行し、未設定の新規datasetは移行しない', async () => {
    expect(await migrateRuntimeProfile(false)).toBe(false)
    expect((await db.settings.get('main'))!.runtimeProfile).toBeUndefined()
    expect(await migrateRuntimeProfile(true)).toBe(true)
    expect((await db.settings.get('main'))!.runtimeProfile?.network_policy).toBe('explicit_online')
  })
  it('壊れたprofileは通信を許可しない（fail closed）', async () => {
    const settings = (await db.settings.get('main'))!
    expect(effectiveNetworkPolicy({ ...settings, aiEnabled: true, runtimeProfile: { ...standaloneProfile(settings.datasetId, 'explicit_online'), dataset_id: dataset } })).toEqual({ policy: 'offline_only', source: 'invalid' })
  })
  it('設定はbackup validatorを往復し、別datasetのprofileを含むbackupを拒否する', async () => {
    await createTask({ ...newTaskInput(), title: 'オフラインで作成' })
    await setNetworkPolicy('explicit_online')
    const snapshot = await captureSnapshot()
    expect(() => validateSnapshot(snapshot)).not.toThrow()
    await db.delete(); await db.open(); await ensureSettings()
    await restoreBackup(snapshot)
    const restored = (await db.settings.get('main'))!
    expect(restored.runtimeProfile).toEqual(snapshot.settings[0].runtimeProfile)
    expect(restored.datasetId).toBe(snapshot.settings[0].datasetId)
    const bad = structuredClone(snapshot); bad.settings[0].runtimeProfile = { ...bad.settings[0].runtimeProfile!, dataset_id: dataset }
    expect(() => validateSnapshot(bad)).toThrow('データセット')
    const hosted = structuredClone(snapshot) as unknown as { settings: Record<string, unknown>[] }; hosted.settings[0].runtimeProfile = { ...base, dataset_id: snapshot.settings[0].datasetId, kind: 'hosted', authority: 'server', server_url: 'https://cloud.example.invalid' }
    expect(() => validateSnapshot(hosted as never)).toThrow('未提供')
  })
})

describe('N10 復元は端末の通信の許可を広げず、消さない', () => {
  it('explicit_onlineのバックアップを、後でoffline_onlyを選んだ端末へ復元してもoffline_onlyのまま（復元したdatasetへ結び直す）', async () => {
    await setNetworkPolicy('explicit_online')
    const snapshot = await captureSnapshot()
    await freshDevice('offline_only')
    await restoreBackup(snapshot)
    const after = (await db.settings.get('main'))!
    expect(after.datasetId).toBe(snapshot.settings[0].datasetId)
    expect(effectiveNetworkPolicy(after, true)).toEqual({ policy: 'offline_only', source: 'profile' })
    expect(after.runtimeProfile).toEqual({ ...base, dataset_id: snapshot.settings[0].datasetId })
    expect(policyFromSettings(after, true)).toEqual({ policy: 'offline_only', source: 'profile' })
    expect(runtimeChoicePending(after)).toBe(false)
    expect(await migrateRuntimeProfile(true)).toBe(false)
    const trace = (await db.audits.toArray()).filter(row => row.operation === 'runtime.network_policy' && JSON.parse(row.detail).reason === 'restore')
    expect(trace.map(row => JSON.parse(row.detail))).toEqual([{ kind: 'standalone', authority: 'local', network_policy: 'offline_only', previous: 'explicit_online', reason: 'restore' }])
  })
  it('offline_onlyのバックアップは、explicit_onlineの端末へ復元してもoffline_onlyになる（厳しい方）', async () => {
    await setNetworkPolicy('offline_only')
    const snapshot = await captureSnapshot()
    await freshDevice('explicit_online')
    await restoreBackup(snapshot)
    expect(effectiveNetworkPolicy((await db.settings.get('main'))!)).toEqual({ policy: 'offline_only', source: 'profile' })
  })
  it('profileのない旧バックアップ（AI有効）をoffline_onlyの端末へ復元しても、旧規則・起動時移行で通信を開けない', async () => {
    await db.settings.update('main', { aiEnabled: true, aiModel: 'synthetic/model' })
    const snapshot = await captureSnapshot()
    expect(snapshot.settings[0].runtimeProfile).toBeUndefined()
    await freshDevice('offline_only')
    await restoreBackup(snapshot)
    const after = (await db.settings.get('main'))!
    expect(after.runtimeProfile?.network_policy).toBe('offline_only')
    expect(runtimeChoicePending(after)).toBe(false)
    expect(policyFromSettings(after, true).policy).toBe('offline_only')
    expect(await migrateRuntimeProfile(true)).toBe(false)
    expect((await db.settings.get('main'))!.runtimeProfile?.network_policy).toBe('offline_only')
    expect((await db.audits.toArray()).some(row => row.operation === 'runtime.migrate')).toBe(false)
  })
  it('profileのない旧バックアップは、explicit_onlineを選んだ端末の選択を引き継ぎ、未選択の端末では未選択のまま', async () => {
    const snapshot = await captureSnapshot()
    await freshDevice('explicit_online')
    await restoreBackup(snapshot)
    expect((await db.settings.get('main'))!.runtimeProfile).toEqual({ ...base, network_policy: 'explicit_online', dataset_id: snapshot.settings[0].datasetId })
    await freshDevice(null)
    await restoreBackup(snapshot)
    expect((await db.settings.get('main'))!.runtimeProfile).toBeUndefined()
    expect(runtimeChoicePending((await db.settings.get('main'))!)).toBe(true)
  })
})
