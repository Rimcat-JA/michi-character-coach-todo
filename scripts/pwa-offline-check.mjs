// PWA offline acceptance harness (AT-N10-06/08/15 in Chromium emulation).
// Runs the built dist/ in Electron's Chromium against a throwaway 127.0.0.1 server and a fresh partition.
// This is Chromium(Electron) emulation on a PC: not a phone, not an OS-level network cut.
// Usage: npm run build && node scripts/pwa-offline-check.mjs
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const self = fileURLToPath(import.meta.url), root = path.resolve(path.dirname(self), '..'), dist = path.join(root, 'dist')
if (!process.versions.electron) {
  const electron = createRequire(import.meta.url)('electron')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(electron, [self, ...process.argv.slice(2)], { stdio: 'inherit', env })
  process.exit(result.status ?? 1)
}

const { app, BrowserWindow, session } = await import('electron')
const LABEL = 'Chromium(Electron)エミュレーション・PC'
const stamp = new Date().toISOString().replace(/[:.]/g, '-'), out = path.join(root, 'qa-output', 'pwa-offline', stamp)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pwa-offline-'))
app.setPath('userData', profile)
app.commandLine.appendSwitch('disable-background-networking')
const report = { label: LABEL, scope: '実機・OSのネットワーク遮断・スマホのテストではありません。dist をローカルHTTPで配信し、ElectronのChromiumで新しいpartitionを使って確認します。', startedAt: new Date().toISOString(), electron: process.versions.electron, chrome: process.versions.chrome, origin: null, steps: [], externalRequests: [], serverRequestsAfterStop: 0, screenshots: [] }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function step(id, name, run) {
  const started = Date.now()
  try { const detail = await run(); report.steps.push({ id, name, pass: true, ms: Date.now() - started, detail }); console.log(`PASS ${id} ${name}`) }
  catch (error) { report.steps.push({ id, name, pass: false, ms: Date.now() - started, detail: String(error?.stack ?? error) }); console.log(`FAIL ${id} ${name}: ${error?.message ?? error}`) }
}
async function until(check, label, timeout = 20000, interval = 200) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) { try { last = await check(); if (last) return last } catch (error) { last = error } await sleep(interval) }
  throw new Error(`timeout: ${label} (${last instanceof Error ? last.message : JSON.stringify(last)})`)
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' }
let stopped = false
const server = http.createServer((request, response) => {
  if (stopped) report.serverRequestsAfterStop++
  const relative = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '') || 'index.html'
  let file = path.resolve(dist, relative)
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html')
  response.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  fs.createReadStream(file).pipe(response)
})

app.whenReady().then(async () => {
  if (!fs.existsSync(path.join(dist, 'sw.js'))) throw new Error('dist/sw.js がありません。先に npm run build を実行してください')
  fs.mkdirSync(out, { recursive: true })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  report.origin = origin
  const partition = `persist:pwa-offline-${Date.now()}`, ses = session.fromPartition(partition)
  // Anything that is not the local test origin is recorded and cancelled: the app must not need it.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url)
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && url.origin !== origin) { report.externalRequests.push(url.host); callback({ cancel: true }); return }
    callback({})
  })
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const open = () => new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { partition, contextIsolation: true, sandbox: true, spellcheck: false } })
  const win = open()
  const js = async (code, target = win) => {
    const result = await target.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await (${code})}}catch(error){return {ok:false,error:String(error&&error.message||error)}}})()`, true)
    if (!result.ok) throw new Error(`${result.error} — in: ${code.slice(0, 120)}`)
    return result.value
  }
  const helpers = `window.__qa={find(text,selector='button'){return [...document.querySelectorAll(selector)].find(el=>(el.textContent||'').includes(text)||(el.getAttribute('aria-label')||'').includes(text))},click(text,selector='button'){const el=this.find(text,selector);if(!el)throw new Error('not found: '+text);if(el.disabled)throw new Error('disabled: '+text);el.scrollIntoView({block:'center'});el.click();return true},toast(){return document.querySelector('.toast')?.textContent||''},text(){return document.body.innerText},db(){return new Promise((resolve,reject)=>{const request=indexedDB.open('character-coach-v1');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const database=request.result,names=['tasks','completions','ledger','taskAttachments','settings'],tx=database.transaction(names,'readonly'),result={};for(const name of names){const query=tx.objectStore(name).getAll();query.onsuccess=()=>result[name]=query.result}tx.oncomplete=()=>{database.close();resolve({tasks:result.tasks.map(t=>({id:t.id,title:t.title,status:t.status,revision:t.revision,notes:t.notes})),completions:result.completions.length,ledger:result.ledger.reduce((n,e)=>n+e.delta,0),attachments:result.taskAttachments.length,profile:result.settings[0]?.runtimeProfile??null})}}})}};true`
  const ready = async target => { await until(() => js(`document.readyState==='complete'&&!!document.querySelector('.app-shell')`, target), 'app shell'); await target.webContents.executeJavaScript(helpers, true) }
  const typeInto = async (target, selector, text) => { await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('missing ${selector}');el.focus();if(el.setSelectionRange)el.setSelectionRange(el.value.length,el.value.length);return true})()`, target); target.webContents.insertText(text); await sleep(150) }
  const toast = async (target, text, label) => until(async () => { const value = await js('window.__qa.toast()', target); return value.includes(text) ? value : false }, label ?? text, 15000)
  const title = `オフライン確認 ${stamp.slice(11, 19)}`

  await step('1', '127.0.0.1から初回取得し、Service Workerがページを制御する', async () => {
    await win.loadURL(`${origin}/`)
    await ready(win)
    await until(() => js(`navigator.serviceWorker.ready.then(()=>true)`), 'serviceWorker.ready', 30000)
    if (!await js('!!navigator.serviceWorker.controller')) { win.webContents.reload(); await ready(win) }
    await until(() => js('!!navigator.serviceWorker.controller'), 'controller', 20000)
    const cached = await until(() => js(`caches.keys().then(async keys=>{let n=0;for(const key of keys)n+=(await (await caches.open(key)).keys()).length;return n})`), 'precache entries', 20000)
    return { controller: true, precacheEntries: cached }
  })
  await step('2', '初回カードで「この端末だけで始める」を選び、アカウント・キー・URLなしでdatasetを作る', async () => {
    await js(`window.__qa.click('この端末だけで始める')`)
    await toast(win, 'この端末だけで始めます')
    const data = await js('window.__qa.db()')
    if (data.profile?.network_policy !== 'offline_only' || data.profile.kind !== 'standalone' || data.profile.server_url !== null) throw new Error(JSON.stringify(data.profile))
    return { runtimeProfile: data.profile }
  })
  await step('3', 'オンライン中にタスクを作成する', async () => {
    await js(`window.__qa.click('新しいタスク')`)
    await typeInto(win, 'input[placeholder="何をしますか？"]', title)
    await js(`window.__qa.click('この端末に保存')`)
    await until(async () => (await js('window.__qa.db()')).tasks.some(task => task.title === title), 'task saved')
    return { title }
  })
  await step('4', 'サーバーを停止し、session.enableNetworkEmulation({offline:true})にする', async () => {
    stopped = true
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.() })
    ses.enableNetworkEmulation({ offline: true })
    return { serverStopped: true, emulatedOffline: true }
  })
  await step('5', 'オフラインで再読込し、SWキャッシュのshellと保存済みタスクで作成・完了できる', async () => {
    // A query string forces a real navigation; a hash-only change would stay in the same document.
    await win.loadURL(`${origin}/?offline-reload=1#tasks`)
    await ready(win)
    const controlled = await js('!!navigator.serviceWorker.controller'), online = await js('navigator.onLine')
    await until(async () => (await js('window.__qa.text()')).includes(title), 'saved task listed after offline reload')
    await js(`window.__qa.click('新しいタスク')`)
    await typeInto(win, 'input[placeholder="何をしますか？"]', `${title} 追加`)
    await js(`window.__qa.click('この端末に保存')`)
    await until(async () => (await js('window.__qa.db()')).tasks.some(task => task.title === `${title} 追加`), 'offline create')
    await js(`window.__qa.click(${JSON.stringify(`${title}を完了する`)})`)
    await toast(win, '完了を記録しました')
    const data = await js('window.__qa.db()')
    if (!controlled || data.completions !== 1) throw new Error(JSON.stringify({ controlled, data }))
    return { controlledByServiceWorker: controlled, navigatorOnLine: online, tasks: data.tasks.length, completions: data.completions, serverRequestsAfterStop: report.serverRequestsAfterStop }
  })
  await step('6', 'persist拒否を模擬し、拒否状態とバックアップ導線を表示する（入力は止めない）', async () => {
    await js(`(()=>{Object.defineProperty(navigator.storage,'persist',{configurable:true,value:async()=>false});Object.defineProperty(navigator.storage,'persisted',{configurable:true,value:async()=>false});return true})()`)
    await js(`window.__qa.click('設定を開く')`)
    await until(() => js(`!!document.querySelector('[data-storage-persisted]')`), 'storage card')
    await js(`window.__qa.click('保存保護を要求')`)
    const state = await until(async () => { const value = await js(`document.querySelector('[data-storage-persisted]').getAttribute('data-storage-persisted')`); return value === 'denied' ? value : false }, 'denied state')
    const text = await js('window.__qa.text()')
    for (const expected of ['保存保護は許可されませんでした', 'バックアップを書き出す', '入力はこれまでどおり続けられます', '未バックアップ変更数']) if (!text.includes(expected)) throw new Error(`missing ${expected}`)
    const backupEnabled = await js(`!window.__qa.find('バックアップを書き出す').disabled`)
    return { persisted: state, backupButtonEnabled: backupEnabled }
  })
  await step('7', '容量不足（CDPのquota上書き、強制されない場合はIDBObjectStore.addへの注入）で添付追加が失敗表示・既存行維持になる', async () => {
    const file = path.join(profile, 'quota-attachment.bin')
    fs.writeFileSync(file, Buffer.alloc(512 * 1024, 7))
    const openEditor = async () => {
      await until(async () => (await js('window.__qa.text()')).includes(`${title} 追加`), 'task list')
      await js(`[...document.querySelectorAll('.task-main')].find(el=>el.textContent.includes(${JSON.stringify(`${title} 追加`)})).click()`)
      await until(() => js(`!!document.querySelector('.editor input[type=file]')`), 'attachment input')
    }
    const attach = async () => {
      const { root: documentRoot } = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1 })
      const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: documentRoot.nodeId, selector: '.editor input[type=file]' })
      await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [file] })
    }
    const changed = (before, after) => after.attachments !== before.attachments || after.tasks.length !== before.tasks.length || after.completions !== before.completions || after.ledger !== before.ledger || JSON.stringify(after.tasks.map(task => [task.id, task.revision]).sort()) !== JSON.stringify(before.tasks.map(task => [task.id, task.revision]).sort())
    win.webContents.debugger.attach('1.3')
    try {
      // a) The real Chromium quota path via CDP. Recorded as observed; Chromium may reflect it in estimate() without enforcing it in IndexedDB.
      const cdpBefore = await js('window.__qa.db()')
      await win.webContents.debugger.sendCommand('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1 })
      await win.loadURL(`${origin}/?quota-check=1#tasks`)
      await ready(win)
      const estimate = await js('navigator.storage.estimate().then(value=>({quota:value.quota,usage:value.usage}))')
      await openEditor(); await attach()
      const cdpToast = await toast(win, '保存容量が不足しています', 'cdp quota toast').catch(() => null)
      const cdpAfter = await js('window.__qa.db()')
      await win.webContents.debugger.sendCommand('Storage.overrideQuotaForOrigin', { origin })
      const cdp = { estimateQuotaAfterOverride: estimate.quota, enforcedByIndexedDB: Boolean(cdpToast), attachmentWritten: cdpAfter.attachments > cdpBefore.attachments, existingRowsChanged: cdpToast ? changed(cdpBefore, cdpAfter) : null }
      if (cdpToast) { if (cdp.existingRowsChanged) throw new Error(JSON.stringify({ cdpBefore, cdpAfter })); await js(`window.__qa.click('キャンセル')`); return { method: 'cdp-quota-override', cdp, toast: cdpToast } }
      // b) Fallback: the same DOMException Chromium raises, thrown at IDBObjectStore.add/put for taskAttachments only.
      await js(`window.__qa.click('キャンセル')`)
      const before = await js('window.__qa.db()')
      await js(`(()=>{const add=IDBObjectStore.prototype.add,put=IDBObjectStore.prototype.put;window.__qaRestoreIDB=()=>{IDBObjectStore.prototype.add=add;IDBObjectStore.prototype.put=put;return true};const fail=store=>{if(store.name==='taskAttachments')throw new DOMException('The quota has been exceeded.','QuotaExceededError')};IDBObjectStore.prototype.add=function(...args){fail(this);return add.apply(this,args)};IDBObjectStore.prototype.put=function(...args){fail(this);return put.apply(this,args)};return true})()`)
      await openEditor(); await attach()
      const message = await toast(win, '保存容量が不足しています', 'injected quota toast')
      await js('window.__qaRestoreIDB()')
      const after = await js('window.__qa.db()'), editorOpen = await js(`!!document.querySelector('.editor')`)
      if (changed(before, after) || !editorOpen) throw new Error(JSON.stringify({ before, after, editorOpen }))
      await js(`window.__qa.click('キャンセル')`)
      return { method: 'injected-QuotaExceededError-at-IDBObjectStore', cdp, toast: message, attachmentsBefore: before.attachments, attachmentsAfter: after.attachments, tasks: after.tasks.length, completions: after.completions, editorStillOpen: editorOpen }
    } finally { try { win.webContents.debugger.detach() } catch { /* already detached */ } }
  })
  await step('8', '同じpartitionの二画面で同じrevisionを編集し、後の保存が競合になる', async () => {
    const second = open()
    try {
      await second.loadURL(`${origin}/#tasks`)
      await ready(second)
      const target = `${title} 追加`
      for (const view of [win, second]) {
        await js(`window.__qa.click('すべてのタスク')`, view)
        await until(async () => (await js('window.__qa.text()', view)).includes(target), 'list in both windows')
        await js(`[...document.querySelectorAll('.task-main')].find(el=>el.textContent.includes(${JSON.stringify(target)})).click()`, view)
        await until(() => js(`!!document.querySelector('.editor textarea')`, view), 'editor open')
      }
      await typeInto(win, '.editor textarea', '画面Aのメモ')
      await js(`window.__qa.click('この端末に保存')`)
      await until(async () => (await js('window.__qa.db()')).tasks.find(task => task.title === target)?.revision === 2, 'first save')
      await typeInto(second, '.editor textarea', '画面Bのメモ')
      await js(`window.__qa.click('この端末に保存')`, second)
      const message = await toast(second, '別の画面で更新されました', 'conflict toast')
      const saved = (await js('window.__qa.db()')).tasks.find(task => task.title === target)
      if (saved.revision !== 2 || saved.notes !== '画面Aのメモ') throw new Error(JSON.stringify(saved))
      const draftKept = await js(`document.querySelector('.editor textarea')?.value`, second)
      return { conflictToast: message, savedRevision: saved.revision, savedNotes: saved.notes, secondEditorDraftKept: draftKept === '画面Bのメモ' }
    } finally { second.destroy() }
  })
  await step('9', '390x844のデバイスエミュレーションで画面写しを撮る（レイアウト確認のみ）', async () => {
    await js(`document.querySelector('.editor') && window.__qa.click('キャンセル')`).catch(() => undefined)
    win.setContentSize(390, 844)
    win.webContents.enableDeviceEmulation({ screenPosition: 'mobile', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 2, viewSize: { width: 390, height: 844 }, scale: 1 })
    await win.loadURL(`${origin}/#today`)
    await ready(win)
    await sleep(800)
    const layout = await js(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})`)
    const shots = []
    for (const [name, click, scroll] of [['today', null, null], ['settings-storage', '設定を開く', '.storage-protection'], ['settings-capabilities', null, '.capability-view']]) {
      if (click) { await js(`window.__qa.click(${JSON.stringify(click)})`); await sleep(600) }
      if (scroll) { await js(`(()=>{document.querySelector(${JSON.stringify(scroll)}).scrollIntoView({block:'start'});return true})()`); await sleep(300) }
      const image = await win.webContents.capturePage()
      const file = path.join(out, `mobile-390x844-${name}.png`)
      fs.writeFileSync(file, image.toPNG())
      shots.push(path.relative(root, file))
    }
    report.screenshots.push(...shots)
    if (layout.scrollWidth > layout.width + 1) throw new Error(`horizontal overflow ${JSON.stringify(layout)}`)
    return { layout, screenshots: shots, note: 'レイアウト確認のみ。スマホ実機の受入ではありません' }
  })
  await step('10', 'アプリから127.0.0.1以外への通信要求がない', async () => {
    if (report.externalRequests.length) throw new Error(`external: ${[...new Set(report.externalRequests)].join(', ')}`)
    return { externalRequests: 0 }
  })

  report.finishedAt = new Date().toISOString()
  report.pass = report.steps.every(item => item.pass)
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`${report.pass ? 'ALL PASS' : 'FAILED'} — ${LABEL} — report: ${path.relative(root, path.join(out, 'report.json'))}`)
  BrowserWindow.getAllWindows().forEach(item => item.destroy())
  app.exit(report.pass ? 0 : 1)
}).catch(error => { console.error(error); app.exit(1) })
app.on('quit', () => { try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* Windows may still hold the profile */ } })
