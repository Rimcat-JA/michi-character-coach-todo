const crypto = require('node:crypto')
const path = require('node:path')
const { createOAuthLocalStore } = require('./oauth-local.cjs')
const { createMCPHttpServer } = require('./mcp-http-server.cjs')
const { createPrivateJSONStore } = require('./private-json-store.cjs')
const implemented = ['coach_get_capabilities', 'coach_search_tasks', 'coach_get_task', 'coach_preview_score', 'coach_search_context', 'coach_prepare_change', 'coach_submit_change', 'coach_get_command_result', 'coach_get_history', 'coach_preview_routine', 'coach_prepare_routine_change', 'coach_prepare_detection_run', 'coach_get_detection_run', 'coach_prepare_handoff', 'coach_get_shared_context']
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)

/** Opt-in loopback OAuth + Streamable-HTTP MCP. Off by default; tokens and registry live encrypted.
 * Bearer tokens reach only the tool core: approval and grant management have no HTTP endpoints. */
function installOAuthLocalIPC({ ipcMain, win, app, safeStorage, assertMain, readDB }) {
  const nativeProofs = new Map()
  ipcMain.on('michi:oauth-native-proof', (event, proof) => {
    try {
      assertMain(event)
      if (!proof || Object.keys(proof).length !== 3 || typeof proof.nonce !== 'string' || !/^[a-f0-9-]{36}$/i.test(proof.nonce) || !['oauth-enable', 'oauth-register', 'oauth-consent'].includes(proof.kind) || typeof proof.reference !== 'string' || proof.reference.length > 200) return
      for (const [id, item] of nativeProofs) if (Date.now() - item.at > 5000) nativeProofs.delete(id)
      if (nativeProofs.size < 100) nativeProofs.set(proof.nonce, { ...proof, at: Date.now() })
    } catch { /* Isolated preload only. */ }
  })
  function takeProof(kind, reference, nonce) {
    const proof = typeof nonce === 'string' ? nativeProofs.get(nonce) : null
    nativeProofs.delete(nonce)
    if (!proof || proof.kind !== kind || proof.reference !== reference || Date.now() - proof.at > 5000) throw new Error('本人の確認ボタンから操作してください')
  }
  let storePromise = null, serverPromise = null, runtimeEnabled = false
  const consentWaiters = new Map(), rpcPending = new Map()
  ipcMain.on('michi:app-mcp-response', (event, value) => {
    try {
      assertMain(event)
      if (!value || typeof value.requestId !== 'string') return
      const row = rpcPending.get(value.requestId)
      if (!row) return
      rpcPending.delete(value.requestId)
      clearTimeout(row.timer)
      if (value.code) row.reject(Object.assign(Error('TOOL_FAILED'), { code: /^[A-Z_]{1,80}$/.test(value.code) ? value.code : 'TOOL_FAILED' }))
      else row.resolve(value.data)
    } catch { /* Non-main-frame replies never reach a pending request. */ }
  })
  function dispatch(name, args, context) {
    if (win.isDestroyed() || rpcPending.size >= 64) return Promise.reject(Object.assign(Error('APP_NOT_RUNNING'), { code: 'APP_NOT_RUNNING' }))
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { rpcPending.delete(requestId); reject(Object.assign(Error('APP_RESPONSE_TIMEOUT'), { code: 'APP_RESPONSE_TIMEOUT' })) }, 10000)
      rpcPending.set(requestId, { resolve, reject, timer })
      win.webContents.send('michi:app-mcp-request', { requestId, name, args, context })
    })
  }
  async function store() {
    storePromise ??= (async () => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('この端末ではOAuth情報を安全に保存できません')
      const directory = path.join(app.getPath('userData'), 'oauth-local')
      const privateStore = await createPrivateJSONStore({ directory, safeStorage })
      return createOAuthLocalStore({ load: () => privateStore.load('oauth-local.bin', null), save: value => privateStore.save('oauth-local.bin', value) })
    })().catch(error => { storePromise = null; throw error })
    return storePromise
  }
  async function getGrant(clientId) {
    const settings = await readDB('settings', 'main')
    const dataset = await readDB('datasetState', 'main')
    // OAuth binds the same preregistered client record the owner manages in S24a.
    // Folder-connection liveness is irrelevant here; revocation flows through settings status.
    const client = settings?.externalAI?.clients?.find(row => row.registration.client.id === clientId)
    if (!client) return null
    const registration = client.registration
    return {
      registration, ownerId: settings?.profileId, datasetId: settings?.datasetId,
      enabled: runtimeEnabled && settings?.externalAI?.version === 1 && settings.externalAI.enabled === true,
      externalEpoch: settings?.externalAI?.epoch, active: client?.status === 'active',
      frozen: (settings?.datasetMode ?? 'active') !== 'active' || (dataset?.mode ?? 'active') !== 'active',
      policyEpoch: settings?.changePolicy?.epoch ?? 0, sourcePermissionRevision: settings?.changePolicy?.sourcePermissionRevision ?? 0,
    }
  }
  function requestConsent(pending) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { consentWaiters.delete(pending.id); resolve(false) }, 5 * 60000)
      consentWaiters.set(pending.id, { resolve, timer })
      if (!win.isDestroyed()) win.webContents.send('michi:oauth-consent-requested', { pendingId: pending.id, clientId: pending.clientId, redirectUri: pending.redirectUri, requestedAt: new Date().toISOString() })
    })
  }
  async function service() {
    serverPromise ??= (async () => {
      const oauth = await store()
      const server = createMCPHttpServer({ store: oauth, getGrant, dispatch, implemented, requestConsent })
      await server.listen()
      return server
    })().catch(error => { serverPromise = null; throw error })
    return serverPromise
  }
  async function stop() {
    runtimeEnabled = false
    for (const [id, waiter] of consentWaiters) { clearTimeout(waiter.timer); waiter.resolve(false); consentWaiters.delete(id) }
    if (serverPromise) { const server = await serverPromise.catch(() => null); serverPromise = null; if (server) await server.close() }
  }
  async function statusOf() {
    const oauth = await store()
    const clients = await oauth.clients()
    const settings = await readDB('settings', 'main')
    let endpoint = null, pending = []
    const server = serverPromise ? await serverPromise.catch(() => null) : null
    if (server) { endpoint = server.resource().slice(0, -'/mcp'.length); pending = server.pendingConsents() }
    return {
      enabled: runtimeEnabled, endpoint, pending,
      clients: clients.map(row => {
        const live = settings?.externalAI?.clients?.find(item => item.registration.client.id === row.clientId)
        return { ...row, registeredLabel: row.label, active: live?.status === 'active', intendedHost: live?.registration.client.intended_host ?? null }
      }),
    }
  }
  ipcMain.handle('michi:oauth-status', async event => { assertMain(event); return statusOf() })
  ipcMain.handle('michi:oauth-enable', async (event, envelope) => {
    assertMain(event)
    if (!envelope || Object.keys(envelope).length !== 2 || typeof envelope.enabled !== 'boolean' || typeof envelope.proofNonce !== 'string') throw new Error('本人の確認ボタンから操作してください')
    takeProof('oauth-enable', '', envelope.proofNonce)
    if (envelope.enabled) { runtimeEnabled = true; await service(); return statusOf() }
    await stop()
    return statusOf()
  })
  ipcMain.handle('michi:oauth-register', async (event, envelope) => {
    assertMain(event)
    if (!envelope || Object.keys(envelope).length !== 2 || !envelope.request || typeof envelope.proofNonce !== 'string') throw new Error('本人の確認ボタンから操作してください')
    const { clientId, label, redirectPath } = envelope.request
    if (!uuid(clientId)) throw new Error('共有先の接続が不正です')
    takeProof('oauth-register', clientId, envelope.proofNonce)
    const settings = await readDB('settings', 'main')
    const live = settings?.externalAI?.clients?.find(row => row.registration.client.id === clientId)
    if (!live || live.status !== 'active') throw new Error('有効な接続を選んでください')
    const oauth = await store()
    return oauth.register(clientId, label ?? live.registration.client.intended_host, redirectPath ?? '/callback')
  })
  ipcMain.handle('michi:oauth-unregister', async (event, envelope) => {
    assertMain(event)
    if (!envelope || Object.keys(envelope).length !== 2 || !envelope.request || typeof envelope.proofNonce !== 'string') throw new Error('本人の確認ボタンから操作してください')
    const { clientId } = envelope.request
    if (!uuid(clientId)) throw new Error('共有先の接続が不正です')
    takeProof('oauth-register', clientId, envelope.proofNonce)
    const oauth = await store()
    await oauth.unregister(clientId)
    return { unregistered: clientId }
  })
  ipcMain.handle('michi:oauth-consent', async (event, envelope) => {
    assertMain(event)
    if (!envelope || Object.keys(envelope).length !== 2 || !envelope.request || typeof envelope.proofNonce !== 'string') throw new Error('本人の確認ボタンから操作してください')
    const { pendingId, allow } = envelope.request
    if (typeof pendingId !== 'string' || typeof allow !== 'boolean') throw new Error('同意内容が不正です')
    takeProof('oauth-consent', pendingId, envelope.proofNonce)
    const waiter = consentWaiters.get(pendingId)
    if (!waiter) throw new Error('同意待ちが見つかりません')
    consentWaiters.delete(pendingId)
    clearTimeout(waiter.timer)
    waiter.resolve(allow)
    return { decided: allow }
  })
  win.on('closed', () => { void stop(); nativeProofs.clear() })
  return { stop, revokeClient: async clientId => { const oauth = await store().catch(() => null); if (oauth) await oauth.revokeClient(clientId).catch(() => {}) } }
}
module.exports = { installOAuthLocalIPC }
