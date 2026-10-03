// Test-only harness (imported by *.test.ts): the real main-process file bridge service, local bridge and
// stdio MCP client/router on a temp folder, wired to the fake-indexeddb app DB. No network, no accounts.
// Native clicks are simulated with trusted-looking events; this is not a real-device check.
import { createRequire } from 'node:module'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { db, ensureSettings } from './db'
import { clearChangeSetAuthority } from './change-set'
import { clearCommandAuthority, commandOutcome, type CommandOutcome } from './command-bus'
import { clearTaskSplitAuthority } from './task-split-change'
import { createFileBridgeController, type FileBridgeController } from './file-bridge-commands'
import type { FileBridgeField, FileBridgeGateway, FileBridgeStatus } from './file-bridge-types'

const require = createRequire(import.meta.url)
const { createFileBridgeHub } = require('../electron/file-bridge-hub.cjs') as { createFileBridgeHub: (options: Record<string, unknown>) => Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> }
const { createMCPFileClient, createMCPRouter } = require('../electron/mcp-file-client.cjs') as { createMCPFileClient: (root: string) => Promise<unknown>; createMCPRouter: (client: unknown) => (message: unknown) => Promise<{ result?: { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> } } | null> }

/** Node has no trusted events; this stands in for the preload-verified native click. */
export function click(type = 'click') { const event = new Event(type); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
export async function resetApp(model = 'synthetic/coach-a') {
  clearChangeSetAuthority(); clearCommandAuthority(); clearTaskSplitAuthority()
  await db.delete(); await db.open(); await ensureSettings(); await db.settings.update('main', { externalAI: {version:1,enabled:true,epoch:0,clients:[]}, aiEnabled: true, aiModel: model })
  return (await db.settings.get('main'))!
}
const clone = <T>(value: T): T => value === undefined ? value : structuredClone(value)
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }
export type BridgeHarness = Awaited<ReturnType<typeof bridgeHarness>>
/** Connects a file/MCP entrance exactly as the Windows app does, minus Electron IPC and the OS click. */
export async function bridgeHarness(options: { taskIds: string[]; fields: FileBridgeField[]; allowSplit?: boolean; ruleIds?: string[]; automation?: { maxScheduleShiftDays: number; maxOperationsPerDay: number } | null; allowHistory?: boolean; allowRoutinePreview?: boolean; allowContextRead?: boolean; allowExternalContext?: boolean; allowDetection?: boolean; allowHandoffPrepare?: boolean; allowHandoffs?: boolean }) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'michi-k12-'))
  const nonces = new Map<string, { kind: string; reference: string }>(); let configuration: unknown = null
  const proof = (kind: string, reference = '') => { const nonce = randomUUID(); nonces.set(nonce, { kind, reference }); return nonce }
  const service = await createFileBridgeHub({
    agentDirectory: join(root, 'agents'), journalDirectory: join(root, 'private'), signingKey: randomBytes(32),
    getSettings: async () => clone(await db.settings.get('main')), getTasks: async (ids: string[]) => clone((await db.tasks.bulkGet(ids)).filter(Boolean)), getReceipt: async (key: string) => clone(await db.commands.get(key)),
    getRules: async (ids: string[]) => ((await db.calendarRules.get('main'))?.rules ?? []).filter(rule => ids.includes(rule.id)).map(rule => ({ id: rule.id, revision: rule.revision })),
    loadConfiguration: async () => clone(configuration), saveConfiguration: async (value: unknown) => { configuration = clone(value) },
    verifyNativeProof: (kind: string, reference: string, nonce: string) => { const item = nonces.get(nonce); nonces.delete(nonce); return Boolean(item && item.kind === kind && item.reference === reference) },
  })
  const call = async <T>(method: string, ...args: unknown[]) => clone(await service[method](...args.map(clone))) as T
  const gateway: FileBridgeGateway = {
    status: () => call('status'),clientStatus:request=>call('clientStatus',request),scanClientInbox:request=>call('scanClientInbox',request), selectClient: request => call('selectClient',request), listConnections:()=>call('listConnections'), configure: request => call('configure', request, proof('configure')), disconnect: request => call('disconnect', request, proof('disconnect', request.clientId)),
    revise:request=>call('revise',request,proof('revise',request.clientId)),invalidateClient:request=>call('invalidateClient',request),
    exportSnapshot: request => call('exportSnapshot', request), scanInbox: () => call('scanInbox'),
    authorizeApplication: binding => call('authorizeApplication', binding, proof('approve', binding.reference)), authorizeAutomaticApplication: binding => call('authorizeAutomaticApplication', binding),
    recordApplied: request => call('recordApplied', request), cancelApplication: request => call('cancelApplication', request), recordRejected: request => call('recordRejected', request), invalidate: () => call('invalidate'),
  }
  const controller: FileBridgeController = createFileBridgeController(gateway)
  await controller.configure({ intendedHost: 'codex', taskIds: options.taskIds, fields: options.fields, lifetimeHours: 24, ...(options.allowSplit ? { allowSplit: true } : {}), ...(options.ruleIds?.length ? { ruleIds: options.ruleIds } : {}), ...(options.allowHistory ? { allowHistory: true } : {}), ...(options.allowRoutinePreview ? { allowRoutinePreview: true } : {}), ...(options.allowContextRead ? { allowContextRead: true } : {}), ...(options.allowExternalContext ? { allowExternalContext: true } : {}), ...(options.allowDetection ? { allowDetection: true } : {}), ...(options.allowHandoffPrepare ? { allowHandoffPrepare: true } : {}), ...(options.allowHandoffs ? { allowHandoffs: true } : {}), automation: options.automation ?? null }, click())
  let status: FileBridgeStatus = await controller.exportSnapshot(click())
  let rpcId = 0, mcp: ((message: unknown) => Promise<unknown>) | null = null
  async function router() { mcp ??= createMCPRouter(await createMCPFileClient(status.root!)) as (message: unknown) => Promise<unknown>; return mcp }
  return {
    root, controller, gateway, service,
    status: () => status,
    async refreshSnapshot() { status = await controller.exportSnapshot(click()); mcp = null; return status },
    /** A hand-written .ready.json in the inbox (the file entrance). */
    async writeCommand(command: Record<string, unknown>) {
      const value = { schema_version: '1', command_id: randomUUID(), snapshot_id: status.snapshot!.snapshot_id, expires_at: new Date(Date.now() + 3600000).toISOString(), basis: { kind: 'external_request' }, ...command }
      await writeFile(join(status.root!, 'inbox', `${value.command_id}.ready.json`), JSON.stringify(value)); return value as Record<string, unknown> & { command_id: string }
    },
    /** A real MCP tools/call through the router and file client (the stdio entrance without the process). */
    async mcpCall(name: string, args: Record<string, unknown>) {
      const reply = await (await router())({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { _meta: meta, name, arguments: args } }) as { result: { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> } }
      return reply.result
    },
    async mcpTools() { const reply = await (await router())({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: { _meta: meta } }) as { result: { tools: { name: string }[] } }; return reply.result.tools.map(tool => tool.name) },
    snapshotId: () => status.snapshot!.snapshot_id,
    async close() { const resolved = await realpath(root); if (resolved.startsWith(await realpath(tmpdir())) && resolved.includes('michi-k12-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) },
  }
}
/** Shared {state, code} view of any thrown error, as each entrance reports it. */
export async function outcomeOf<T>(work: () => Promise<T>): Promise<{ state: CommandOutcome['state']; code: string | null; value?: T }> {
  try { return { state: 'applied', code: null, value: await work() } }
  catch (error) { const outcome = commandOutcome(error); return { state: outcome.state, code: outcome.code } }
}
