const { app, BrowserWindow, protocol, net, session } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

protocol.registerSchemesAsPrivileged([{ scheme: 'michi', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, allowServiceWorkers: true } }])

const base = path.resolve(__dirname, '..', 'dist')
const allowed = new Set(['michi:', 'file:', 'blob:', 'data:'])

app.whenReady().then(() => {
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
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('michi://app/')) event.preventDefault() })
  win.loadURL('michi://app/index.html')
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
