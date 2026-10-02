import 'fake-indexeddb/auto'
import {beforeEach,expect,it,vi} from 'vitest'
import {db,ensureSettings} from './db'
import {createTask,newTaskInput,completeTask,undoCompletion} from './commands'
import {changePolicyFor} from './change-set'
import {captureSnapshot,restoreBackup} from './backup'
import {allowWhileFrozen} from './dataset-guard'
beforeEach(async()=>{await db.delete();await db.open();await ensureSettings();await db.settings.update('main',{aiEnabled:true})})
async function enable(includeTitle=false){const s=(await db.settings.get('main'))!,p=changePolicyFor(s);await db.integrationSettings.put({id:'main',ownerId:s.profileId,datasetId:s.datasetId,policyEpoch:p.epoch,sourcePermissionRevision:p.sourcePermissionRevision,subscriptions:[{id:crypto.randomUUID(),events:['task.created','task.completed','task.reopened'],includeTitle,createdAt:new Date(Date.now()-1000).toISOString()}]})}
it('task creation/completion/undo capture exact facts once in the business transaction, no quotes or notes',async()=>{
 await enable();const id=await createTask({...newTaskInput(),title:'private title',notes:'secret quote',score:{...newTaskInput().score,mode:'manual',manualPoints:25}})
 let task=(await db.tasks.get(id))!;await completeTask(id,task.revision,'complete');task=(await db.tasks.get(id))!;await completeTask(id,task.revision,'already-completed');await undoCompletion(id,task.revision,'undo')
 const rows=await db.integrationOutbox.toArray();expect(rows.map(row=>row.payload.type).sort()).toEqual(['task.completed','task.created','task.reopened']);expect(rows.find(row=>row.payload.type==='task.completed')?.payload.points).toBe(25)
 expect(JSON.stringify(rows.map(row=>row.payload))).not.toMatch(/secret quote|private title|notes|source/);expect(await db.ledger.toArray()).toHaveLength(2)
})
it('outer failure rolls back completion, ledger and outbox together',async()=>{
 await enable();const id=await createTask({...newTaskInput(),title:'rollback'}),task=(await db.tasks.get(id))!,before=await db.integrationOutbox.count()
 const original=db.audits.add.bind(db.audits),spy=vi.spyOn(db.audits,'add').mockRejectedValueOnce(Error('after task mutation'))
 await expect(completeTask(id,task.revision)).rejects.toThrow('after task mutation');spy.mockImplementation(original);spy.mockRestore()
 expect(await db.integrationOutbox.count()).toBe(before);expect((await db.tasks.get(id))?.status).toBe('open');expect(await db.completions.count()).toBe(0);expect(await db.ledger.count()).toBe(0)
})
it('OFF, authority changes and privileged restore produce no outbox; local outbox is excluded from backup',async()=>{
 await createTask({...newTaskInput(),title:'OFF'});expect(await db.integrationOutbox.count()).toBe(0)
 await enable(true);const id=await createTask({...newTaskInput(),title:'explicitly public'});expect((await db.integrationOutbox.toArray())[0].payload.title).toBe('explicitly public')
 const backup=await captureSnapshot();expect(backup).not.toHaveProperty('integrationOutbox');expect(backup).not.toHaveProperty('integrationSettings')
 const count=await db.integrationOutbox.count();await restoreBackup(backup);expect(await db.integrationOutbox.count()).toBe(count)
 await db.transaction('rw',db.tasks,async()=>{allowWhileFrozen();await db.tasks.update(id,{title:'restored edit'})});expect(await db.integrationOutbox.count()).toBe(count)
 const s=(await db.settings.get('main'))!;await db.settings.update('main',{changePolicy:{...changePolicyFor(s),epoch:99}});await createTask({...newTaskInput(),title:'authority changed'});expect(await db.integrationOutbox.count()).toBe(count)
})
