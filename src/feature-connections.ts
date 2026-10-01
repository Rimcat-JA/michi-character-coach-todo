import { reduceAuthority } from './automation-control'
import type { FileBridgeGateway } from './file-bridge-types'
import type { LocalActionGateway } from './local-action-types'

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
