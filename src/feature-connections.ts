import { reduceAuthority } from './automation-control'
import type { FileBridgeGateway } from './file-bridge-types'
import type { LocalActionGateway } from './local-action-types'
import type { NetworkPolicy } from './domain'
import type { NetworkPurpose, NetworkStatus } from './runtime-profile'

export type RowStopState = 'stopped' | 'unconfirmed' | 'not_available'
/** Providers without an implementation in this build: shown so nothing fake appears, with no toggle. */
export const UNPROVIDED_CONNECTIONS = ['LINE', 'Telegram', 'Discord', 'Slack', 'Gmail', 'Google Calendar', 'Microsoft（Teams・Outlook）'] as const
/** One row's stop; a rejection is reported as unconfirmed for that row only. */
export async function runRowStop(stop: () => Promise<unknown>): Promise<RowStopState> {
  try { return await stop() === 'not_available' ? 'not_available' : 'stopped' } catch { return 'unconfirmed' }
}
/** The OpenRouter AI row is the AI-processing stop: epoch bump plus revoking every epoch-bound connection; any failed revoke is reported as unconfirmed. */
export const stopAIProcessingRow = () => runRowStop(async () => { const result = await reduceAuthority('aiProcessing', 'connections'); if (result.errors.length) throw new AggregateError(result.errors) })
/** Local status reads only. The GitHub status is a live API request, so it runs only from the owner's check button. */
export function loadConnectionStatus(gateways: { fileBridge?: FileBridgeGateway; localActions?: LocalActionGateway }) { return Promise.allSettled([gateways.fileBridge?.status(), gateways.localActions?.status()]) }
/** N10: the gateway route per connection. Counters are this launch's main-process counts, never URLs or secrets. */
export function egressLine(policy: NetworkPolicy, network: NetworkStatus | null, purpose: NetworkPurpose) {
  const counter = network?.counters[purpose], counts = counter ? `（今回の起動後 送信${counter.attempts}回・設定で遮断${counter.blockedOffline}回）` : ''
  return `${policy === 'offline_only' ? 'オフライン専用のため送信前に遮断' : purpose==='webhook'?'本人が登録した送信条件だけ許可':'本人の操作時だけ許可'}${counts}`
}
