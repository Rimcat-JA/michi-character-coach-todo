// Headless code benchmark; does not launch or interact with the product UI.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {createRequire} from 'node:module'
const self=fileURLToPath(import.meta.url),root=path.resolve(path.dirname(self),'..')
if(!process.versions.electron){
 const {build}=await import('vite'),out=path.join(root,'qa-output','retrieval-10000',new Date().toISOString().replace(/[:.]/g,'-'))
 await build({configFile:false,root,build:{outDir:out,emptyOutDir:false,lib:{entry:path.join(root,'scripts/retrieval-benchmark.ts'),formats:['es'],fileName:'benchmark'},rollupOptions:{output:{inlineDynamicImports:true}}}})
 await fs.writeFile(path.join(out,'index.html'),'<!doctype html><meta charset="utf-8"><script type="module" src="./benchmark.js"></script>')
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 const result=spawnSync(createRequire(import.meta.url)('electron'),[self,out],{cwd:root,env,stdio:'inherit',windowsHide:true})
 process.exit(result.status??1)
}
const {app,BrowserWindow,session}=await import('electron'),out=process.argv[2]
if(!out||!path.resolve(out).startsWith(path.join(root,'qa-output','retrieval-10000')+path.sep))throw Error('INVALID_OUTPUT')
app.setPath('userData',await fs.mkdtemp(path.join(os.tmpdir(),'michi-retrieval-benchmark-')))
app.commandLine.appendSwitch('disable-background-networking')
let win,requests=0
const timer=setTimeout(()=>{console.error('BENCHMARK_TIMEOUT (120s)');app.exit(1)},120000)
console.log('BENCH starting Chromium')
app.whenReady().then(async()=>{
console.log('BENCH Chromium ready')
try{
 session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_detail,callback)=>{requests++;callback({cancel:true})})
 win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true}})
 win.webContents.on('console-message',event=>{if(event.message?.startsWith('BENCH'))console.log(event.message)})
 await win.loadFile(path.join(out,'index.html'))
 const report=await win.webContents.executeJavaScript('window.benchmarkPromise')
 if(requests||report.tasks||report.ledger)throw Error('UNEXPECTED_EFFECT')
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify({...report,electron:process.versions.electron,chrome:process.versions.chrome,networkRequests:requests},null,2))
 console.log(JSON.stringify(report));console.log('Report:',path.join(out,'report.json'))
}catch(error){console.error(error);process.exitCode=1}finally{clearTimeout(timer);win?.destroy();app.exit(process.exitCode??0)}
}).catch(error=>{console.error(error);clearTimeout(timer);app.exit(1)})
