import 'fake-indexeddb/auto'
import { readFile } from 'node:fs/promises'
import { beforeEach, expect, it, vi } from 'vitest'
import { buildCapsule } from '../extension/capture-core.js'
import { parseWebCaptureCapsule, parseWebCaptureFile, prepareWebCaptureImport, saveCaptureImportFromUI } from './web-capture-import'
import { prepareCaptureTask, saveCaptureTask } from './capture-task'
import { db, ensureSettings } from './db'
import { newTaskInput } from './commands'
import { captureSnapshot, restoreBackup } from './backup'
import { deleteSource } from './source-library'
import { taskEvidenceDisplay } from './task-source-evidence'
beforeEach(async()=>{await db.delete();await db.open();await ensureSettings()})
const capsule=()=>buildCapsule({title:'selected page',url:'https://user:secret@example.org/page#private',quote:'選んだ一文だけ。',timezone:'Asia/Tokyo',capturedAt:'2026-10-02T01:00:00.000Z'})
const file=(text:string,name='selection.json')=>{const bytes=new TextEncoder().encode(text);return {name,size:bytes.length,arrayBuffer:async()=>bytes.buffer}}
function click(){const e=new Event('click');Object.defineProperty(e,'isTrusted',{value:true});return e}
it('MV3 ships only the exact gesture/selection/download permissions and no history or remote execution',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url),'utf8'))
 expect(manifest.manifest_version).toBe(3)
 expect(manifest.permissions.sort()).toEqual(['activeTab','contextMenus','downloads','scripting'])
 for(const name of ['host_permissions','content_scripts','optional_permissions','optional_host_permissions','externally_connectable','web_accessible_resources'])expect(manifest).not.toHaveProperty(name)
 expect(manifest.content_security_policy.extension_pages).toContain("connect-src 'none'")
})
it('builder emits only approved capsule keys, removes credentials/fragment and reports unverified selected scope',()=>{
 const c=capsule();expect(parseWebCaptureCapsule(c)).toEqual(c)
 expect(c.url).toBe('https://example.org/page');expect(c.coverage).toEqual({complete:false,kind:'selected-quote'})
 expect(c.selection).toEqual({quote:'選んだ一文だけ。',start:0,end:8,coordinate:'selected-fragment-utf16'})
 expect(()=>buildCapsule({title:'x',url:'file:///private',quote:'selected'})).toThrow('http')
 expect(()=>buildCapsule({title:'x',url:'https://example.org',quote:' '})).toThrow('引用')
 expect(()=>buildCapsule({title:'x',url:'https://example.org',quote:'x'.repeat(50001)})).toThrow('引用')
})
it('file import rejects size, malformed JSON/UTF8, extra page/history data and complete coverage before writing',async()=>{
 expect(await parseWebCaptureFile(file(JSON.stringify(capsule())))).toEqual(capsule())
 await expect(parseWebCaptureFile(file('{broken'))).rejects.toThrow('JSON')
 await expect(parseWebCaptureFile({...file('{}'),size:120*1024+1})).rejects.toThrow('120KB')
 await expect(parseWebCaptureFile(file('{}','wrong.txt'))).rejects.toThrow('JSON')
 await expect(parseWebCaptureFile({name:'x.json',size:1,arrayBuffer:async()=>Uint8Array.of(255).buffer})).rejects.toThrow('UTF-8')
 for(const change of [{pageText:'unselected'},{history:['page A']},{coverage:{complete:true,kind:'selected-quote'}}])await expect(parseWebCaptureFile(file(JSON.stringify({...capsule(),...change})))).rejects.toThrow()
 expect(await db.contextSources.count()).toBe(0);expect(await db.tasks.count()).toBe(0)
})
it('manual handoff attaches only the selected source note, uses explicit blank input, and preserves points/ledger',async()=>{
 const preview=await prepareWebCaptureImport(capsule()),receipt=await saveCaptureImportFromUI(preview,click()),draft=await prepareCaptureTask(receipt)
 expect(await db.tasks.count()).toBe(0);expect(draft.quote).toBe(capsule().selection.quote)
 const id=await saveCaptureTask({...newTaskInput(),title:'本人の手動タイトル'},null,draft)
 expect(await db.tasks.get(id)).toMatchObject({title:'本人の手動タイトル',notes:'',effectivePoints:null,dueDate:null,scheduledDate:null,status:'open'})
 expect(await db.taskSourceEvidence.toArray()).toMatchObject([{taskId:id,sourceId:receipt.sourceId,quote:capsule().selection.quote}]);expect(await db.taskNotes.count()).toBe(0)
 expect(await db.ledger.count()).toBe(0);expect(await db.completions.count()).toBe(0)
 await expect(saveCaptureTask({...newTaskInput(),title:'clone'},null,{...draft})).rejects.toThrow('確認し直')
})
it('source revocation and note-storage failure abort the manual handoff atomically',async()=>{
 const preview=await prepareWebCaptureImport(capsule()),receipt=await saveCaptureImportFromUI(preview,click()),draft=await prepareCaptureTask(receipt)
 const spy=vi.spyOn(db.taskSourceEvidence,'add').mockRejectedValueOnce(Error('forced note failure'))
 await expect(saveCaptureTask({...newTaskInput(),title:'rollback'},null,draft)).rejects.toThrow('forced note')
 expect(await db.tasks.count()).toBe(0);expect(await db.taskSourceEvidence.count()).toBe(0);spy.mockRestore()
 await db.contextSources.update(receipt.sourceId,{deletedAt:new Date().toISOString()})
 await expect(saveCaptureTask({...newTaskInput(),title:'revoked'},null,draft)).rejects.toThrow('権限')
 expect(await db.tasks.count()).toBe(0)
})
it('source erasure and restore of an older backup erase copied source notes while keeping the manual task',async()=>{
 const preview=await prepareWebCaptureImport(capsule()),receipt=await saveCaptureImportFromUI(preview,click()),draft=await prepareCaptureTask(receipt)
 const id=await saveCaptureTask({...newTaskInput(),title:'本人の作業'},null,draft),snapshot=await captureSnapshot(),source=(await db.contextSources.get(receipt.sourceId))!
 const erased=await deleteSource(source.id,source.revision)
 expect(erased.erased.taskQuotes).toBe(1);expect(await db.taskSourceEvidence.count()).toBe(0);expect((await db.tasks.get(id))?.title).toBe('本人の作業')
 expect((await taskEvidenceDisplay((await db.tasks.get(id))!)).erasedSourceIds).toContain(source.id)
 await restoreBackup(snapshot)
 expect(await db.taskSourceEvidence.count()).toBe(0);expect(await db.tasks.get(id)).toBeDefined();expect(await db.ledger.count()).toBe(0)
})
it('long selected fragments preserve Unicode, order and the bounded backup evidence shape',async()=>{
 const quote='あ'.repeat(1999)+'🌸'+'続'.repeat(24000),value=buildCapsule({title:'long fragment',url:'https://example.org',quote,timezone:'Asia/Tokyo'})
 const receipt=await saveCaptureImportFromUI(await prepareWebCaptureImport(value),click()),draft=await prepareCaptureTask(receipt),id=await saveCaptureTask({...newTaskInput(),title:'manual'},null,draft)
 const rows=(await db.taskSourceEvidence.where('taskId').equals(id).toArray()).sort((a,b)=>a.id.localeCompare(b.id))
 expect(rows.every(row=>row.quote.length<=2000)).toBe(true);expect(rows.map(row=>row.quote).join('')).toBe(quote)
 await expect(captureSnapshot()).resolves.toBeDefined()
})
