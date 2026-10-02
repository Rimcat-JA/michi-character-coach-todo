const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { createFileBridgeService } = require('./file-bridge-service.cjs')
const { readAppDatabase } = require('./app-db-reader.cjs')

function installFileBridgeIPC({ ipcMain, win, app, safeStorage }) {
  const nativeProofs = new Map()
  function assertMain(event) {
    if (win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !event.senderFrame.url.startsWith('michi://app/')) throw new Error('メイン画面以外からの外部接続操作を拒否しました')
  }
  ipcMain.on('michi:filebridge-native-proof', (event, proof) => {
    try {
      assertMain(event)
      if (!proof || Object.keys(proof).length !== 3 || typeof proof.nonce !== 'string' || !/^[a-f0-9-]{36}$/i.test(proof.nonce) || !['configure', 'approve', 'disconnect'].includes(proof.kind) || typeof proof.reference !== 'string' || proof.reference.length > 200) return
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
  async function service() {
    servicePromise ??= (async () => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('この端末では外部接続の署名鍵を安全に保存できません')
      const privateBase = path.join(app.getPath('userData'), 'local-agent-private'), agentDirectory = path.join(app.getPath('documents'), 'michi-agent-bridge')
      await fs.mkdir(privateBase, { recursive: true })
      const keyPath = path.join(privateBase, 'signing-key.bin'), configPath = path.join(privateBase, 'connection.bin')
      let signingKey
      try { signingKey = Buffer.from(safeStorage.decryptString(await fs.readFile(keyPath)), 'hex'); if (signingKey.length !== 32) throw new Error('署名鍵が不正です') }
      catch (error) { if (error.code !== 'ENOENT') throw error; signingKey = crypto.randomBytes(32); await fs.writeFile(keyPath, safeStorage.encryptString(signingKey.toString('hex')), { flag: 'wx', mode: 0o600 }) }
      return createFileBridgeService({ agentDirectory, journalDirectory: path.join(privateBase, 'journal'), signingKey,
        getSettings: async () => { const value = await readDB('settings', 'main'); if (!value) throw new Error('設定を読み込んでから接続してください'); return value },
        getTasks: ids => readDB('tasks', ids), getReceipt: key => readDB('commands', key),
        getRules: async ids => { const state = await readDB('calendarRules', 'main'); return Array.isArray(state?.rules) ? state.rules.filter(rule => ids.includes(rule.id)).map(rule => ({ id: rule.id, revision: rule.revision })) : [] },
        loadConfiguration: async () => { try { return JSON.parse(safeStorage.decryptString(await fs.readFile(configPath))) } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('保存済み接続を読めません') } },
        saveConfiguration: async value => { if (value === null) { await fs.rm(configPath, { force: true }); return }; const temporary = `${configPath}.${crypto.randomUUID()}.tmp`; await fs.writeFile(temporary, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600, flag: 'wx' }); try { await fs.rename(temporary, configPath) } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error } },
        verifyNativeProof: (kind, reference, nonce) => { const proof = nativeProofs.get(nonce); nativeProofs.delete(nonce); return Boolean(proof && proof.kind === kind && proof.reference === reference && Date.now() - proof.at <= 5000) }
      })
    })().catch(error => { servicePromise = null; throw error })
    return servicePromise
  }
  for (const method of ['status', 'configure', 'disconnect', 'exportSnapshot', 'scanInbox', 'authorizeApplication', 'authorizeAutomaticApplication', 'recordApplied', 'cancelApplication', 'recordRejected', 'invalidate']) {
    ipcMain.handle(`michi:filebridge-${method}`, async (event, envelope) => {
      assertMain(event)
      const current = await service()
      if (['configure', 'disconnect', 'authorizeApplication'].includes(method)) {
        if (!envelope || Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, 'request') || typeof envelope.proofNonce !== 'string') throw new Error('本人の接続確認ボタンから操作してください')
        return current[method](envelope.request, envelope.proofNonce)
      }
      if (['status', 'scanInbox', 'invalidate'].includes(method)) { if (envelope !== undefined) throw new Error('操作引数が不正です'); return current[method]() }
      return current[method](envelope)
    })
  }
  win.on('closed', () => { nativeProofs.clear() })
}
module.exports = { installFileBridgeIPC }
