import { db } from './db'
import { addTaskNote } from './materials'
import { changePolicyFor } from './change-set'
import { saveTaskWithScoreProvenance } from './score-assessment-save'
import type { TaskInput } from './commands'
import type { ScoreAcceptanceProvenance } from './score-assist'
import type { CaptureImportReceipt } from './web-capture-import'
export type CaptureTaskDraft = Readonly<{ sourceId:string; sourceRevision:number; quote:string; ownerId:string; datasetId:string; provenanceId:string; permissionRevision:number; policyEpoch:number; sourcePermissionRevision:number }>
const issued=new WeakSet<object>()
export async function prepareCaptureTask(receipt:CaptureImportReceipt):Promise<CaptureTaskDraft>{
 const s=(await db.settings.get('main'))!,source=await db.contextSources.get(receipt.sourceId),artifact=await db.sourceArtifacts.get(receipt.provenanceId),snapshot=await db.contextSnapshots.where('sourceId').equals(receipt.sourceId).filter(row=>row.revision===receipt.sourceRevision).first()
 if(!s||!source||source.deletedAt||source.ownerId!==s.profileId||source.latestRevision!==receipt.sourceRevision||!source.permissions.retain||source.retentionUntil&&Date.parse(source.retentionUntil)<=Date.now()||!snapshot||snapshot.sha256!==receipt.selectedSha256||!artifact||artifact.ownerId!==s.profileId||artifact.sourceId!==source.id||snapshot.text.length>50000)throw Error('保存済みの引用と保持権限を確認できません。')
 const provenance=JSON.parse(artifact.payload)
 if(!['web-selection','email-file'].includes(provenance.kind)||provenance.datasetId!==s.datasetId||provenance.selectedSha256!==snapshot.sha256)throw Error('引用の出典が一致しません。')
 const p=changePolicyFor(s),draft=Object.freeze({sourceId:source.id,sourceRevision:source.latestRevision,quote:snapshot.text,ownerId:s.profileId,datasetId:s.datasetId,provenanceId:artifact.id,permissionRevision:source.permissionRevision,policyEpoch:p.epoch,sourcePermissionRevision:p.sourcePermissionRevision});issued.add(draft);return draft
}
/** A blank editor remains manual: no title, point, schedule or deadline inference. */
export async function saveCaptureTask(input:TaskInput,accepted:ScoreAcceptanceProvenance|null,draft:CaptureTaskDraft){
 if(!issued.has(draft))throw Error('引用をアプリで確認し直してください。')
 return db.transaction('rw',[db.tasks,db.assessments,db.completions,db.ledger,db.routines,db.sessions,db.commands,db.audits,db.containers,db.settings,db.labelGroups,db.labelDefinitions,db.tripBundles,db.taskNotes,db.contextSources,db.contextSnapshots,db.sourceArtifacts],async()=>{
  const s=(await db.settings.get('main'))!,p=changePolicyFor(s),source=await db.contextSources.get(draft.sourceId)
  if(s.profileId!==draft.ownerId||s.datasetId!==draft.datasetId||p.epoch!==draft.policyEpoch||p.sourcePermissionRevision!==draft.sourcePermissionRevision||!source||source.deletedAt||source.permissionRevision!==draft.permissionRevision||source.latestRevision!==draft.sourceRevision||!source.permissions.retain||source.retentionUntil&&Date.parse(source.retentionUntil)<=Date.now())throw Error('引用の保持権限または本人設定が変わりました。')
  const id=await saveTaskWithScoreProvenance(null,input,accepted)
  const noteId=await addTaskNote(id,draft.quote,'source')
  await db.taskNotes.update(noteId,{sourceId:draft.sourceId,sourceRevision:draft.sourceRevision})
  return id
 })
}
