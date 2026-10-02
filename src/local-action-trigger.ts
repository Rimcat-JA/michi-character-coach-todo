import Dexie from 'dexie'
import type {LocalActionWindow} from './local-action-types'
/** Register on the root transaction: rollback and nested transactions never dispatch early. No retry queue. */
export function localTriggerAfterCommit(event:'task.completed'|'work_session.logged',factId:string){
 let transaction=Dexie.currentTransaction
 if(!transaction)throw Error('イベントは保存トランザクション内で登録してください。')
 while(transaction.parent)transaction=transaction.parent
 transaction.on('complete',()=>{
  if(typeof window==='undefined'||typeof navigator!=='undefined'&&navigator.onLine===false)return
  try{void (window as LocalActionWindow).michiLocalActions?.trigger?.({event,factId}).catch(()=>{/* A PC-action failure cannot roll back a committed task. */})}catch{/* Do not queue a failed trigger. */}
 })
}
