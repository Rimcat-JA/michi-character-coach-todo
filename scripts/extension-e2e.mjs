// Manual, headless, installed-Chrome QA only. Never changes the owner's daily profile.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))
const chromeFlag=process.argv.indexOf('--chrome'),outputFlag=process.argv.indexOf('--output')
const candidates=chromeFlag>=0?[process.argv[chromeFlag+1]]:process.platform==='win32'?[path.join(process.env.PROGRAMFILES??'C:\\Program Files','Google','Chrome','Application','chrome.exe'),path.join(process.env.LOCALAPPDATA??'','Google','Chrome','Application','chrome.exe')]:['/usr/bin/google-chrome','/usr/bin/chromium']
let executable
for(const candidate of candidates){if(candidate&&await fs.stat(candidate).then(s=>s.isFile()).catch(()=>false)){executable=candidate;break}}
if(!executable)throw Error('Installed Chrome not found. Pass --chrome <absolute executable>.')
const scratch=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'michi-extension-qa-')),extensionPath=path.join(scratch,'extension'),profilePath=path.join(scratch,'profile')
await fs.cp(path.join(root,'extension'),extensionPath,{recursive:true})
const manifest=JSON.parse(await fs.readFile(path.join(extensionPath,'manifest.json'),'utf8'))
assert.equal(manifest.host_permissions,undefined)
// Only this temporary QA copy bypasses the native activeTab gesture for automation.
manifest.host_permissions=['http://127.0.0.1/*']
await fs.writeFile(path.join(extensionPath,'manifest.json'),JSON.stringify(manifest))
await fs.appendFile(path.join(extensionPath,'background.js'),'\nglobalThis.michiQACaptureSelection=captureSelection;\n')
const fixture=http.createServer(async(req,res)=>{
 const file=req.url==='/a'?'capture-a.html':req.url==='/b'?'capture-b.html':null
 if(!file){res.writeHead(404);res.end();return}
 res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(await fs.readFile(path.join(root,'scripts','fixtures',file)))
})
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve))
const origin='http://127.0.0.1:'+fixture.address().port
const child=spawn(executable,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-features=Translate','--remote-debugging-pipe','--enable-unsafe-extension-debugging','--user-data-dir='+profilePath,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe','pipe','pipe']})
let nextId=1,buffer=Buffer.alloc(0),stderr=''
child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-4000)})
const waits=new Map()
child.stdio[4].on('data',bytes=>{
 buffer=Buffer.concat([buffer,bytes]);let separator
 while((separator=buffer.indexOf(0))>=0){const raw=buffer.subarray(0,separator);buffer=buffer.subarray(separator+1);if(!raw.length)continue;const message=JSON.parse(raw.toString());const pending=waits.get(message.id);if(pending){waits.delete(message.id);clearTimeout(pending.timer);if(message.error)pending.reject(Error(message.error.message));else pending.resolve(message.result)}}
})
const request=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=nextId++,timer=setTimeout(()=>{waits.delete(id);reject(Error('Chrome CDP timeout: '+method))},15000);waits.set(id,{resolve,reject,timer});child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0')})
child.on('error',error=>{for(const pending of waits.values()){clearTimeout(pending.timer);pending.reject(error)}waits.clear()})
const evaluate=async(sessionId,expression)=>{const result=await request('Runtime.evaluate',{expression:'Promise.race([(async()=>('+expression+'))(),new Promise((_,reject)=>setTimeout(()=>reject(Error("QA evaluation expired")),5000))])',awaitPromise:true,returnByValue:true},sessionId);if(result.exceptionDetails)throw Error(result.exceptionDetails.text+': '+(result.exceptionDetails.exception?.description??''));return result.result.value}
try{
 const {id:extensionId}=await request('Extensions.loadUnpacked',{path:extensionPath})
 const {targetId}=await request('Target.createTarget',{url:origin+'/a'}),{sessionId}=await request('Target.attachToTarget',{targetId,flatten:true})
 await request('Page.enable',{},sessionId)
 await request('Page.navigate',{url:origin+'/b'},sessionId)
 for(let attempt=0;attempt<100;attempt++){if(await evaluate(sessionId,"!!document.getElementById('selected')").catch(()=>false))break;await new Promise(r=>setTimeout(r,50))}
 await evaluate(sessionId,"(()=>{const range=document.createRange();range.selectNodeContents(document.getElementById('selected'));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return selection.toString()})()")
 let worker
 for(let attempt=0;attempt<100&&!worker;attempt++){worker=(await request('Target.getTargets')).targetInfos.find(t=>t.type==='service_worker'&&t.url==='chrome-extension://'+extensionId+'/background.js');if(!worker)await new Promise(r=>setTimeout(r,50))}
 if(!worker)throw Error('Extension worker unavailable')
 const workerSession=(await request('Target.attachToTarget',{targetId:worker.targetId,flatten:true})).sessionId
 await request('Runtime.enable',{},workerSession);await request('Runtime.runIfWaitingForDebugger',{},workerSession)
 for(let attempt=0;attempt<100;attempt++){if(await evaluate(workerSession,"typeof globalThis.michiQACaptureSelection==='function'"))break;await new Promise(r=>setTimeout(r,50))}
 const tabId=await evaluate(workerSession,`(await chrome.tabs.query({})).find(t=>t.url===${JSON.stringify(origin+'/b')}).id`)
 const result=await evaluate(workerSession,`globalThis.michiQACaptureSelection(${tabId})`)
 assert.equal(result.capsule.selection.quote,'選んだ一文だけ。')
 assert.equal(result.capsule.coverage.complete,false)
 const raw=JSON.stringify(result.capsule)
 assert.equal(raw.includes('PAGE_A_'),false);assert.equal(raw.includes('UNSELECTED'),false);assert.equal(raw.includes('OTHER_PARAGRAPH'),false)
 assert.equal(await evaluate(workerSession,"typeof chrome.history"),'undefined')
 if(outputFlag>=0){const output=path.resolve(process.argv[outputFlag+1]);await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(result.capsule,null,2),'utf8')}
 process.stdout.write(JSON.stringify({passed:true,extensionPermissions:manifest.permissions,qaCopyHostPermission:true,nativeActiveTabGestureVerified:false,selectedCharacters:result.capsule.selection.quote.length,historyAPIAvailable:false})+'\n')
}catch(error){process.stderr.write('QA Chrome diagnostics: '+stderr+'\n');throw error}
finally{
 for(const pending of waits.values())clearTimeout(pending.timer)
 await request('Browser.close').catch(()=>{});await new Promise(resolve=>{if(child.exitCode!==null)resolve();else{child.once('exit',resolve);setTimeout(()=>{child.kill();resolve()},3000)}})
 await new Promise(resolve=>fixture.close(resolve))
 // Only the fixed, realpath-resolved mkdtemp directory created by this script is removed.
 const target=await fs.realpath(scratch),tempRoot=await fs.realpath(os.tmpdir());if(path.dirname(target)!==tempRoot||!path.basename(target).startsWith('michi-extension-qa-'))process.stderr.write('QA cleanup path mismatch; preserved scratch directory.\n')
 else
 await fs.rm(target,{recursive:true,force:true})
}
