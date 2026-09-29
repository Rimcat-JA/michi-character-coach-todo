const { app, BrowserWindow, protocol, net, session, ipcMain, safeStorage } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

protocol.registerSchemesAsPrivileged([{ scheme: 'michi', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, allowServiceWorkers: true } }])

const base = path.resolve(__dirname, '..', 'dist')
const allowed = new Set(['michi:', 'file:', 'blob:', 'data:'])
const keyPath = () => path.join(app.getPath('userData'), 'openrouter-key.bin')
let sessionKey = null
let chatInFlight = false

function assertAppFrame(event) {
  if (!event.senderFrame?.url.startsWith('michi://app/')) throw new Error('アプリ外からの操作を拒否しました')
}

async function loadKey() {
  if (sessionKey) return sessionKey
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    sessionKey = safeStorage.decryptString(await fs.readFile(keyPath()))
    return sessionKey
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error('保存済みAPIキーを読み込めません。設定画面から再登録してください')
  }
}

async function chatWithOpenRouter({ model, message, selectedTask }) {
  if (typeof model !== 'string' || !/^[\w~./:-]{3,120}$/.test(model)) throw new Error('モデルIDを確認してください')
  if (typeof message !== 'string' || !message.trim() || message.length > 6000) throw new Error('送信文は1〜6000文字で入力してください')
  if (selectedTask !== null && selectedTask !== undefined && (typeof selectedTask !== 'string' || selectedTask.length > 6000)) throw new Error('選択タスクの情報が不正です')
  const key = await loadKey()
  if (!key) throw new Error('OpenRouterのAPIキーを設定してください')
  let response
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-OpenRouter-Title': 'michi Character Coach ToDo' },
      body: JSON.stringify({ model, max_tokens: 800, messages: [
        { role: 'system', content: 'あなたは日本語のToDoコーチです。ユーザーが明示的に選んだタスク情報と送信した文章だけを扱います。それ以外の保存済みタスク、資料、予定へのアクセスはありません。タスクの作成・編集・完了を実行したと主張しないでください。資料にない義務や締切を創作せず、不明な点は確認してください。簡潔かつ親切に答えてください。' },
        { role: 'user', content: selectedTask ? `選択したタスク情報:\n${selectedTask}\n\n相談:\n${message.trim()}` : message.trim() }
      ] }),
      signal: AbortSignal.timeout(45000)
    })
  } catch {
    throw new Error('OpenRouterへ接続できませんでした。ネットワークを確認してください')
  }
  if (!response.ok) throw new Error(`OpenRouterの応答エラー（HTTP ${response.status}）。キーとモデルIDを確認してください`)
  const body = await response.json()
  const answer = body?.choices?.[0]?.message?.content
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('OpenRouterから文章の回答を受け取れませんでした')
  return answer.trim().slice(0, 12000)
}

app.whenReady().then(() => {
  ipcMain.handle('michi:ai-status', async event => {
    assertAppFrame(event)
    return { secureStorage: safeStorage.isEncryptionAvailable(), configured: Boolean(await loadKey()) }
  })
  ipcMain.handle('michi:ai-save-key', async (event, value) => {
    assertAppFrame(event)
    if (!safeStorage.isEncryptionAvailable()) throw new Error('この端末でAPIキーを安全に保存できません')
    if (typeof value !== 'string' || value.length < 20 || value.length > 500 || /\s/.test(value)) throw new Error('APIキーの形式を確認してください')
    await fs.writeFile(keyPath(), safeStorage.encryptString(value), { mode: 0o600 })
    sessionKey = value
    return true
  })
  ipcMain.handle('michi:ai-delete-key', async event => {
    assertAppFrame(event)
    sessionKey = null
    await fs.rm(keyPath(), { force: true })
    return true
  })
  ipcMain.handle('michi:ai-chat', async (event, request) => {
    assertAppFrame(event)
    if (!request || typeof request !== 'object') throw new Error('送信内容が不正です')
    if (chatInFlight) throw new Error('前のAI応答を待っています')
    chatInFlight = true
    try { return await chatWithOpenRouter(request) }
    finally { chatInFlight = false }
  })
  protocol.handle('michi', request => {
    const url = new URL(request.url)
    if (url.host !== 'app') return new Response('Not found', { status: 404 })
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    const file = path.resolve(base, relative)
    if (file !== base && !file.startsWith(base + path.sep)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString())
  })

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try { callback({ cancel: !allowed.has(new URL(details.url).protocol) }) }
    catch { callback({ cancel: true }) }
  })
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))

  const win = new BrowserWindow({
    width: 1280, height: 830, minWidth: 380, minHeight: 550,
    backgroundColor: '#f7f7fb', title: 'michi — キャラクターコーチToDo',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, preload: path.join(__dirname, 'preload.cjs') }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('michi://app/')) event.preventDefault() })
  win.loadURL('michi://app/index.html')
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
