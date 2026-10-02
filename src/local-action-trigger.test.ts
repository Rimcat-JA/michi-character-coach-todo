import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import {beforeEach,afterEach,expect,it,vi} from 'vitest'
import {db,ensureSettings} from './db'
import {createTask,newTaskInput,completeTask,logSession} from './commands'
beforeEach(async()=>{await db.delete();await db.open();await ensureSettings()})
afterEach(()=>vi.unstubAllGlobals())
it('task completion emits only committed fact id, replay and parent rollback emit nothing, rejection leaves ledger intact',async()=>{
 const trigger=vi.fn(async()=>{throw Error('synthetic failed trigger')});vi.stubGlobal('window',{michiLocalActions:{trigger}})
 const id=await createTask({...newTaskInput(),title:'本人の25pt',score:{...newTaskInput().score,mode:'manual',manualPoints:25}})
 await db.transaction('rw',db.tables,async()=>{await completeTask(id,1,'first');expect(trigger).not.toHaveBeenCalled()})
 await new Promise(resolve=>setTimeout(resolve,0))
 const completion=(await db.completions.where('taskId').equals(id).first())!
 expect(trigger).toHaveBeenCalledExactlyOnceWith({event:'task.completed',factId:completion.id})
 await completeTask(id,1,'first');expect(trigger).toHaveBeenCalledOnce();expect((await db.ledger.toArray()).reduce((sum,r)=>sum+r.delta,0)).toBe(25)
 const other=await createTask({...newTaskInput(),title:'rollback'})
 await expect(db.transaction('rw',db.tables,async()=>{await completeTask(other,1);throw Error('rollback outer')})).rejects.toThrow('rollback outer')
 expect((await db.tasks.get(other))?.status).toBe('open');expect(trigger).toHaveBeenCalledOnce()
})
it('work-session trigger uses only actual committed id and no offline retry queue',async()=>{
 const trigger=vi.fn(async()=>({results:[],pending:[],skipped:[]}));vi.stubGlobal('window',{michiLocalActions:{trigger}})
 const id=await createTask({...newTaskInput(),title:'作業'}),at=new Date().toISOString()
 await logSession(id,at,at,'synthetic-session');await new Promise(resolve=>setTimeout(resolve,0))
 expect(trigger).toHaveBeenCalledExactlyOnceWith({event:'work_session.logged',factId:'synthetic-session'})
 vi.stubGlobal('navigator',{onLine:false});await logSession(id,at,at,'offline-session')
 expect(trigger).toHaveBeenCalledOnce();expect(await db.sessions.count()).toBe(2)
 expect(Dexie.currentTransaction).toBeNull()
})
