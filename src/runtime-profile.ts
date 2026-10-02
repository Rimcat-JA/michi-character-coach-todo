import { db } from './db'
import { uid, type NetworkPolicy, type RuntimeProfile, type Settings } from './domain'

export type NetworkPurpose = 'openrouter' | 'github' | 'webhook'
export type NetworkCounter = { attempts: number; blockedOffline: number; blockedHost: number; failed: number }
export type NetworkStatus = { policy: NetworkPolicy; source: string; checkedAt: string | null; counters: Record<NetworkPurpose, NetworkCounter>; legacyOnlineConfigured: boolean }
declare global { interface Window { michiNetwork?: { status: () => Promise<NetworkStatus> } } }

const KEYS = ['schema_version', 'kind', 'dataset_id', 'authority', 'network_policy', 'server_url'] as const
const POLICIES: NetworkPolicy[] = ['offline_only', 'explicit_online']
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
function httpsUri(value: unknown) { if (typeof value !== 'string' || !value.startsWith('https://')) return false; try { return new URL(value).protocol === 'https:' } catch { return false } }

/** Mirrors contracts/runtime-profile.schema.json, including its if/then/else on kind. */
export function validateRuntimeProfileSchema(value: unknown): void {
  if (!record(value) || Object.keys(value).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(value, key))) throw new Error('runtime profileの項目が不正です')
  if (value.schema_version !== '1' || !['standalone', 'personal-pc', 'hosted'].includes(value.kind as string) || !uuid(value.dataset_id) || !['local', 'server'].includes(value.authority as string) || !POLICIES.includes(value.network_policy as NetworkPolicy) || !(value.server_url === null || typeof value.server_url === 'string')) throw new Error('runtime profileの値が不正です')
  if (value.kind === 'standalone' ? value.authority !== 'local' || value.server_url !== null : value.authority !== 'server' || !httpsUri(value.server_url)) throw new Error('端末単独ではauthority=local・server_url=null、接続型ではauthority=server・https URLが必要です')
}
/** What this build can store: schema-valid, standalone only, bound to the current dataset. */
export function validateRuntimeProfile(value: unknown, datasetId: string): asserts value is RuntimeProfile {
  validateRuntimeProfileSchema(value)
  const profile = value as unknown as RuntimeProfile
  if (profile.kind !== 'standalone') throw new Error('サーバー接続型のruntimeはこの版では未提供です')
  if (profile.dataset_id !== datasetId) throw new Error('runtime profileのデータセットが一致しません')
}
export function standaloneProfile(datasetId: string, network_policy: NetworkPolicy): RuntimeProfile {
  const profile: RuntimeProfile = { schema_version: '1', kind: 'standalone', dataset_id: datasetId, authority: 'local', network_policy, server_url: null }
  validateRuntimeProfile(profile, datasetId)
  return profile
}
/** Same rule as electron/network-gateway.cjs policyFromSettings: invalid fails closed, missing keeps configured AI working. */
export function effectiveNetworkPolicy(settings: Pick<Settings, 'datasetId' | 'aiEnabled' | 'runtimeProfile'>, legacyOnlineConfigured = false): { policy: NetworkPolicy; source: 'profile' | 'legacy' | 'invalid' } {
  if (settings.runtimeProfile === undefined) return { policy: settings.aiEnabled || legacyOnlineConfigured ? 'explicit_online' : 'offline_only', source: 'legacy' }
  try { validateRuntimeProfile(settings.runtimeProfile, settings.datasetId); return { policy: settings.runtimeProfile.network_policy, source: 'profile' } }
  catch { return { policy: 'offline_only', source: 'invalid' } }
}
export const runtimeChoicePending = (settings: Pick<Settings, 'runtimeProfile'>) => settings.runtimeProfile === undefined
export const networkPolicyLabel = (policy: NetworkPolicy) => policy === 'offline_only' ? 'オフライン専用（このアプリから外部へ通信しない）' : '必要な時だけ通信を許可（本人が許可した外部AI・連携のみ）'

async function writeProfile(policy: NetworkPolicy, operation: string, onlyIfMissing: boolean): Promise<boolean> {
  if (!POLICIES.includes(policy)) throw new Error('通信の許可が不正です')
  return db.transaction('rw', db.settings, db.audits, async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('本人の設定がありません')
    if (onlyIfMissing && settings.runtimeProfile !== undefined) return false
    const previous = settings.runtimeProfile?.network_policy ?? null, at = new Date().toISOString()
    await db.settings.put({ ...settings, runtimeProfile: standaloneProfile(settings.datasetId, policy) })
    await db.audits.add({ id: uid(), taskId: null, operation, at, detail: JSON.stringify({ kind: 'standalone', authority: 'local', network_policy: policy, previous }) })
    return true
  })
}
/** Owner choice from the first-run card or settings. Never changes data authority, only this app's egress. */
export async function setNetworkPolicy(policy: NetworkPolicy): Promise<void> { await writeProfile(policy, 'runtime.network_policy', false) }
/** Existing datasets with AI enabled, a saved key or GitHub already configured keep online use; nothing is sent by this migration.
 * Same predicate as effectiveNetworkPolicy: a model ID left behind after AI was turned off is not online use. */
export async function migrateRuntimeProfile(legacyOnlineConfigured: boolean): Promise<boolean> {
  const settings = await db.settings.get('main')
  if (!settings || settings.runtimeProfile !== undefined || !(settings.aiEnabled === true || legacyOnlineConfigured)) return false
  return writeProfile('explicit_online', 'runtime.migrate', true)
}
export async function networkStatus(): Promise<NetworkStatus | null> {
  if (typeof window === 'undefined' || !window.michiNetwork) return null
  try { return await window.michiNetwork.status() } catch { return null }
}
