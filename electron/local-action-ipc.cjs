const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { createLocalActionCoordinator } = require('./local-action-service.cjs')

function installLocalActionIPC({ ipcMain, win, app, safeStorage }) {
  const nativeProofs = new Map()
  function assertMain(event) { if (win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !event.senderFrame.url.startsWith('michi://app/')) throw new Error('本人のメイン画面以外からPC操作を受け付けません') }
  ipcMain.on('michi:localaction-native-proof', (event, proof) => {
    try {
      assertMain(event)
      if (!proof || Object.keys(proof).length !== 3 || !['configure', 'approve'].includes(proof.kind) || typeof proof.reference !== 'string' || proof.reference.length > 200 || typeof proof.nonce !== 'string' || !/^[a-f0-9-]{36}$/i.test(proof.nonce)) return
      for (const [id, item] of nativeProofs) if (Date.now() - item.at > 5000) nativeProofs.delete(id)
      if (nativeProofs.size < 100) nativeProofs.set(proof.nonce, { ...proof, at: Date.now() })
    } catch { /* Native click proofs are sent only by the isolated preload. */ }
  })
  async function readDB(table, key) {
    if (win.isDestroyed()) throw new Error('本人のメイン画面を開いてください')
    return win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const request=indexedDB.open('character-coach-v1');request.onerror=()=>reject(new Error('保存領域を開けません'));request.onsuccess=()=>{const database=request.result;if(!database.objectStoreNames.contains(${JSON.stringify(table)})){database.close();reject(new Error('保存領域が未初期化です'));return}const transaction=database.transaction(${JSON.stringify(table)}),query=transaction.objectStore(${JSON.stringify(table)}).get(${JSON.stringify(key)});let value;query.onsuccess=()=>{value=query.result};transaction.oncomplete=()=>{database.close();resolve(value??null)};transaction.onerror=()=>{database.close();reject(new Error('保存領域を読めません'))}}})`, false)
  }
  let coordinatorPromise = null
  async function coordinator() {
    coordinatorPromise ??= (async () => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('この端末ではPC操作の署名鍵を安全に保存できません')
      const privateBase = path.join(app.getPath('userData'), 'local-actions-private'), journalDirectory = path.join(privateBase, 'journal')
      await fs.mkdir(journalDirectory, { recursive: true })
      async function load(name, fallback) { try { return JSON.parse(safeStorage.decryptString(await fs.readFile(path.join(privateBase, name)))) } catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('PC操作の保存設定を読み込めません') } }
      async function save(name, value) {
        const target = path.join(privateBase, name)
        if (value === null) { await fs.rm(target, { force: true }); return }
        const temporary = `${target}.${crypto.randomUUID()}.tmp`
        await fs.writeFile(temporary, safeStorage.encryptString(JSON.stringify(value)), { flag: 'wx', mode: 0o600 })
        try { await fs.rename(temporary, target) } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error }
      }
      let key = await load('signing-key.bin', null), deviceId = await load('device-id.bin', null)
      if (key === null) { key = crypto.randomBytes(32).toString('hex'); await save('signing-key.bin', key) }
      if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new Error('PC操作の署名鍵が不正です')
      if (deviceId === null) { deviceId = crypto.randomUUID(); await save('device-id.bin', deviceId) }
      if (typeof deviceId !== 'string' || !/^[a-f0-9-]{36}$/i.test(deviceId)) throw new Error('端末の識別子が不正です')
      return createLocalActionCoordinator({ signingKey: Buffer.from(key, 'hex'), deviceId, journalDirectory,
        getSettings: async () => { const value = await readDB('settings', 'main'); if (!value) throw new Error('本人の設定を読み込んでからPC操作を設定してください'); return value },
        getReceipt: key => readDB('commands', key), loadConfiguration: () => load('definitions.bin', null), saveConfiguration: value => save('definitions.bin', value), loadResults: () => load('results.bin', []), saveResults: value => save('results.bin', value),
        verifyNativeProof: (kind, reference, nonce) => { const proof = nativeProofs.get(nonce); nativeProofs.delete(nonce); return Boolean(proof && proof.kind === kind && proof.reference === reference && Date.now() - proof.at <= 5000) }
      })
    })().catch(error => { coordinatorPromise = null; throw error })
    return coordinatorPromise
  }
  for (const method of ['status', 'inspectDefinition', 'configure', 'remove', 'prepare', 'execute', 'recordReceipt', 'invalidate']) ipcMain.handle(`michi:localaction-${method}`, async (event, envelope) => {
    assertMain(event)
    const current = await coordinator()
    if (['inspectDefinition', 'configure', 'remove', 'execute'].includes(method)) {
      if (!envelope || Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, 'request') || typeof envelope.proofNonce !== 'string') throw new Error('本人のPC操作確認ボタンから操作してください')
      return current[method](envelope.request, envelope.proofNonce)
    }
    if (['status', 'invalidate'].includes(method)) { if (envelope !== undefined) throw new Error('操作引数が不正です'); return current[method]() }
    return current[method](envelope)
  })
  win.on('closed', () => { nativeProofs.clear() })
}
module.exports = { installLocalActionIPC }
