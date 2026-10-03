// Hidden code-only Chromium checks. No product UI, native clicks, account connections or acceptance claim.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const self = fileURLToPath(import.meta.url), root = path.resolve(path.dirname(self), '..')
if (!process.versions.electron) {
  const { build } = await import('vite')
  const out = path.join(root, 'qa-output', 'device-data', new Date().toISOString().replace(/[:.]/g, '-'))
  await build({ configFile: false, root, build: { outDir: out, emptyOutDir: false, lib: { entry: path.join(root, 'scripts/device-data-check.ts'), formats: ['es'], fileName: 'check' }, rollupOptions: { output: { inlineDynamicImports: true } } } })
  await fs.writeFile(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="./check.js"></script>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(createRequire(import.meta.url)('electron'), [self, out], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  process.exit(result.status ?? 1)
}
const { app, BrowserWindow, session } = await import('electron'), out = process.argv[2]
if (!out || !path.resolve(out).startsWith(path.join(root, 'qa-output', 'device-data') + path.sep)) throw Error('INVALID_OUTPUT')
app.setPath('userData', await fs.mkdtemp(path.join(os.tmpdir(), 'michi-device-data-')))
app.commandLine.appendSwitch('disable-background-networking')
const windows = [], timer = setTimeout(() => { console.error('DEVICE_DATA_TIMEOUT'); app.exit(1) }, 60000)
let requests = 0
const call = (win, method, ...args) => win.webContents.executeJavaScript(`window.deviceDataCheck.${method}(...${JSON.stringify(args)})`)
app.whenReady().then(async () => {
  try {
    for (const partition of ['device-A', 'device-B']) {
      session.fromPartition(partition).webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => { requests++; callback({ cancel: true }) })
      const win = new BrowserWindow({ show: false, webPreferences: { partition, sandbox: true, nodeIntegration: false, contextIsolation: true } })
      windows.push(win)
      await win.loadFile(path.join(out, 'index.html'))
      await call(win, 'ready')
    }
    const [a, b] = windows, first = await call(a, 'seed'), second = await call(b, 'acceptAndEdit', first)
    const handoff = await call(a, 'protect', second)
    const owner = await call(a, 'identity'), recipient = await call(b, 'identity')
    const sharing = await call(b, 'receiveAndExpire', await call(a, 'grantFile', recipient), owner)
    if (requests) throw Error('UNEXPECTED_NETWORK')
    const report = { scope: 'Hidden Chromium, two isolated partitions with real IndexedDB/WebCrypto. Synthetic consent fixtures and expiry clock. No native UI, smartphone, real second person or Windows DEV acceptance.', handoff, sharing, networkRequests: requests, electron: process.versions.electron, chrome: process.versions.chrome }
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report)); console.log('Report:', path.join(out, 'report.json'))
  } catch (error) { console.error(error); process.exitCode = 1 }
  finally { clearTimeout(timer); for (const win of windows) win.destroy(); app.exit(process.exitCode ?? 0) }
}).catch(error => { console.error(error); clearTimeout(timer); app.exit(1) })
