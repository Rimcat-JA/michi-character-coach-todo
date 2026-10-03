const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { createFileBridgeHub, revokeStoredCopy } = require('./file-bridge-hub.cjs')
const { createPrivateJSONStore } = require('./private-json-store.cjs')
const { runMCPFileSelftest } = require('./mcp-selftest.cjs')
const { installAppMCPIPC } = require('./mcp-app-ipc.cjs')
const { readAppDatabase } = require('./app-db-reader.cjs')

function installFileBridgeIPC({ ipcMain, win, app, safeStorage }) {
  const nativeProofs = new Map()
  function assertMain(event) {
    if (win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !event.senderFrame.url.startsWith('michi://app/')) throw new Error('メイン画面以外からの外部接続操作を拒否しました')
  }
  ipcMain.on('michi:filebridge-native-proof', (event, proof) => {
    try {
      assertMain(event)
      if (!proof || Object.keys(proof).length !== 3 || typeof proof.nonce !== 'string' || !/^[a-f0-9-]{36}$/i.test(proof.nonce) || !['configure', 'approve', 'disconnect','revise'].includes(proof.kind) || typeof proof.reference !== 'string' || proof.reference.length > 200) return
      for (const [id, item] of nativeProofs) if (Date.now() - item.at > 5000) nativeProofs.delete(id)
      if (nativeProofs.size < 100) nativeProofs.set(proof.nonce, { ...proof, at: Date.now() })
    } catch { /* The isolated preload is the only producer of native click proofs. */ }
  })
  async function readDB(table, key) {
    return readAppDatabase(win, table, key)
  }
  let servicePromise = null
  ipcMain.handle('michi:filebridge-mcpConfiguration', async event => {
    assertMain(event)
    const current = await (await service()).status()
    if (!current.connected || !current.root || !current.snapshot) throw new Error('選択したタスクを書き出してからMCP設定を確認してください')
    return { mcpServers: { michi: { command: process.execPath, args: [path.join(app.getAppPath(), 'scripts', 'michi-mcp.mjs'), '--bridge', current.root], env: { ELECTRON_RUN_AS_NODE: '1' } } } }
  })
  let selftestRunning = false
  const diagnosticAbort = new AbortController()
  ipcMain.handle('michi:filebridge-selftest', async (event, request) => {
    assertMain(event)
    if (!request || Object.keys(request).length!==2 || typeof request.clientId!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.clientId) || !['read','revoke'].includes(request.mode)) throw new Error('自己診断の対象が不正です')
    if (selftestRunning) throw new Error('自己診断を実行中です')
    selftestRunning = true
    try {
      let root
      if (request.mode==='read') {
        const current=await (await service()).clientStatus({clientId:request.clientId})
        if (!current.connected || !current.snapshot) throw new Error('選択したタスクを書き出してから自己診断してください')
        root=current.root
      } else {
        root=path.join(app.getPath('documents'),'michi-agent-bridge',request.clientId)
        // A revocation check may only inspect a known retired client and cannot return task content.
        const settings=await readDB('settings','main')
        if (!settings?.externalAI?.clients?.some(client=>client.registration?.client?.id===request.clientId&&client.status==='revoked')) throw new Error('取り消した接続を選んでください')
      }
      const {code,...check}=await runMCPFileSelftest({executable:process.execPath,scriptPath:path.join(app.getAppPath(),'scripts','michi-mcp.mjs'),root,expectRevoked:request.mode==='revoke',appRunning:!win.isDestroyed(),signal:diagnosticAbort.signal})
      return {clientId:request.clientId,check,code}
    } finally {selftestRunning=false}
  })
  async function service() {
    servicePromise ??= (async () => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('この端末では外部接続の署名鍵を安全に保存できません')
      const privateBase = path.join(app.getPath('userData'), 'local-agent-private'), agentDirectory = path.join(app.getPath('documents'), 'michi-agent-bridge')
      await fs.mkdir(privateBase, { recursive: true })
      const store = await createPrivateJSONStore({directory:privateBase,safeStorage})
      const legacy = await store.load('connection.bin')
      if (legacy) { await revokeStoredCopy(agentDirectory,legacy); await store.save('connection.bin',null) }
      let key = await store.load('hub-key.bin')
      if (!key) { key = {version:1,hex:crypto.randomBytes(32).toString('hex')}; await store.save('hub-key.bin',key,true) }
      if (Object.keys(key).length!==2 || key.version!==1 || typeof key.hex!=='string' || !/^[a-f0-9]{64}$/.test(key.hex)) throw new Error('署名鍵が不正です')
      const signingKey = Buffer.from(key.hex,'hex')
      return createFileBridgeHub({ agentDirectory, journalDirectory: path.join(privateBase, 'journal'), signingKey,
        getSettings: async () => { const value = await readDB('settings', 'main'); if (!value) throw new Error('設定を読み込んでから接続してください'); return value },
        getTasks: ids => readDB('tasks', ids), getReceipt: key => readDB('commands', key),
        getRules: async ids => { const state = await readDB('calendarRules', 'main'); return Array.isArray(state?.rules) ? state.rules.filter(rule => ids.includes(rule.id)).map(rule => ({ id: rule.id, revision: rule.revision })) : [] },
        loadConfiguration: async () => store.load('connections-v2.bin'),
        saveConfiguration: async value => store.save('connections-v2.bin',value),
        verifyNativeProof: (kind, reference, nonce) => { const proof = nativeProofs.get(nonce); nativeProofs.delete(nonce); return Boolean(proof && proof.kind === kind && proof.reference === reference && Date.now() - proof.at <= 5000) }
      })
    })().catch(error => { servicePromise = null; throw error })
    return servicePromise
  }
  for (const method of ['status', 'clientStatus', 'scanClientInbox', 'listConnections', 'selectClient', 'configure','revise', 'disconnect','invalidateClient', 'exportSnapshot', 'scanInbox', 'authorizeApplication', 'authorizeAutomaticApplication', 'recordApplied', 'cancelApplication', 'recordRejected', 'invalidate']) {
    ipcMain.handle(`michi:filebridge-${method}`, async (event, envelope) => {
      assertMain(event)
      if (method === 'invalidate') await appMCP.stop()
      if (method === 'disconnect') appMCP.revoke(envelope?.request?.clientId)
      if (method === 'revise') appMCP.revoke(envelope?.request?.clientId)
      if (method === 'invalidateClient') appMCP.revoke(envelope?.clientId)
      const current = await service()
      if (['configure', 'disconnect', 'authorizeApplication'].includes(method)) {
        if (!envelope || Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, 'request') || typeof envelope.proofNonce !== 'string') throw new Error('本人の接続確認ボタンから操作してください')
        return current[method](envelope.request, envelope.proofNonce)
      }
      if(method==='revise'){
        if(!envelope||Object.keys(envelope).length!==2||!Object.hasOwn(envelope,'request')||envelope.proofNonce!==null&&typeof envelope.proofNonce!=='string')throw Error('CONFIG_INVALID')
        return current.revise(envelope.request,envelope.proofNonce)
      }
      if (['status', 'listConnections', 'scanInbox', 'invalidate'].includes(method)) { if (envelope !== undefined) throw new Error('操作引数が不正です'); return current[method]() }
      return current[method](envelope)
    })
  }
  const appMCP = installAppMCPIPC({ipcMain,win,app,getHub:service,assertMain,readDB})
  win.on('closed', () => { nativeProofs.clear(); diagnosticAbort.abort() })
}
module.exports = { installFileBridgeIPC }
