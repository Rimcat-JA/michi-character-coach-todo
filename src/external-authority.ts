import type { Settings } from './domain'
import type { ChangePrincipal } from './change-set'
import type { FileBridgeRegistration } from './file-bridge-types'
import { assertFileBridgeRegistration } from './file-bridge-contract'

export type CapabilityCheck = { checkedAt: string; surface: 'local_selftest'|'synthetic_host'|'real_host'; protocolVersion: string; auth: 'not_tested'|'verified_local'|'verified_synthetic'|'verified_real'|'failed'; read: CapabilityCheck['auth']; write: CapabilityCheck['auth']; revoke: CapabilityCheck['auth'] }
export type ExternalAIClient = { registration: FileBridgeRegistration; status: 'active'|'revoked'|'needs_reauth'; capabilityChecks: CapabilityCheck[]; shippingState: 'implemented'|'integration_verified'|'constrained' }
export type ExternalAIState = { version: 1; enabled: boolean; epoch: number; clients: ExternalAIClient[] }
export const defaultExternalAI = (): ExternalAIState => ({ version: 1, enabled: false, epoch: 0, clients: [] })
export function validateExternalAI(value: unknown): asserts value is ExternalAIState {
  const object = (row: unknown): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && !Array.isArray(row) && Object.getPrototypeOf(row) === Object.prototype)
  const exact = (row: Record<string, unknown>, keys: string[]) => Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key))
  const outcomes = ['not_tested', 'verified_local', 'verified_synthetic', 'verified_real', 'failed']
  if (!object(value) || !exact(value, ['version','enabled','epoch','clients']) || value.version !== 1 || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.epoch) || Number(value.epoch) < 0 || !Array.isArray(value.clients) || value.clients.length > 50) throw new Error('外部AIの設定が不正です')
  const ids = new Set<string>()
  for (const client of value.clients) {
    if (!object(client) || !exact(client, ['registration','status','capabilityChecks','shippingState']) || !['active','revoked','needs_reauth'].includes(String(client.status)) || !['implemented','integration_verified','constrained'].includes(String(client.shippingState)) || !Array.isArray(client.capabilityChecks) || client.capabilityChecks.length > 90) throw new Error('外部AIの接続が不正です')
    assertFileBridgeRegistration(client.registration)
    if (ids.has(client.registration.client.id)) throw new Error('外部AIの接続IDが重複しています')
    ids.add(client.registration.client.id)
    for (const check of client.capabilityChecks) {
      if (!object(check) || !exact(check,['checkedAt','surface','protocolVersion','auth','read','write','revoke']) || typeof check.checkedAt !== 'string' || !Number.isFinite(Date.parse(check.checkedAt)) || new Date(check.checkedAt).toISOString() !== check.checkedAt || !['local_selftest','synthetic_host','real_host'].includes(String(check.surface)) || typeof check.protocolVersion !== 'string' || check.protocolVersion.length > 40 || ['auth','read','write','revoke'].some(key => !outcomes.includes(String(check[key]))) || ['auth','read','write','revoke'].some(key => check[key] === 'verified_real' && check.surface !== 'real_host' || check[key] === 'verified_synthetic' && check.surface !== 'synthetic_host' || check[key] === 'verified_local' && check.surface !== 'local_selftest')) throw new Error('能力確認の記録が不正です')
    }
    if (client.shippingState === 'integration_verified' && !client.capabilityChecks.some(check => check.surface === 'real_host' && ['auth','read','write','revoke'].every(key => check[key] === 'verified_real'))) throw new Error('実host未確認の接続は確認済みにできません')
  }
}
export function externalAIFor(settings: Settings): ExternalAIState { const value = settings.externalAI ?? defaultExternalAI(); validateExternalAI(value); return value }
export function revokedExternalAI(settings: Settings): ExternalAIState {
  const value = externalAIFor(settings)
  if (!Number.isSafeInteger(value.epoch + 1)) throw new Error('外部AIの許可版が上限に達しています')
  return { ...value, enabled: false, epoch: value.epoch + 1, clients: value.clients.map(client => ({ ...client, status: 'revoked' })) }
}
/** The app coach, local REST automation and external coach have separate processing switches.
 * Client scope, registration, expiry and policy are checked by the trusted entrance on every call. */
export function processingAllowed(settings: Settings, principal: Pick<ChangePrincipal, 'kind'|'id'>): boolean {
  if (principal.kind === 'human') return true
  return principal.kind === 'external-agent' && !principal.id.startsWith('localapi:') ? externalAIFor(settings).enabled : settings.aiEnabled
}
export function processingEpoch(settings: Settings, principal: Pick<ChangePrincipal, 'kind'|'id'>): number {
  if (principal.kind === 'human') return 0
  return principal.kind === 'external-agent' && !principal.id.startsWith('localapi:') ? externalAIFor(settings).epoch : settings.aiConnectionEpoch ?? 0
}
export function authorityMatches(principal: Pick<ChangePrincipal,'id'|'kind'>, options: {coachOnly?: boolean; externalOnly?: boolean; clientId?: string}) {
  return options.clientId ? principal.kind === 'external-agent' && principal.id === options.clientId : options.coachOnly ? principal.kind === 'coach' : options.externalOnly ? principal.kind === 'external-agent' && !principal.id.startsWith('localapi:') : true
}
