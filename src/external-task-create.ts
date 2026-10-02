import { db } from './db'
import { uid } from './domain'
import { newTaskInput } from './commands'
import { ChangeSetError, changePolicyFor } from './change-set'
import { operationMode } from './automation-policy'
import { prepareAssistedTasks, applyAssistedTasks, type PreparedAssistedTasks } from './task-assist'
import { registerCommandType, validateTaskPayload, type CommandField } from './command-bus'
function trustedClick(event: Event) { if (!(event instanceof Event) || !event.isTrusted || Object.getOwnPropertyDescriptor(Event.prototype, 'type')!.get!.call(event) !== 'click') throw new ChangeSetError('HUMAN_APPROVAL_REQUIRED', '本人の確認ボタンから承認してください') }
/** N02 creation through the bus; external creations always wait for the owner. */
const trustedCreateApprovals=new WeakSet<object>()
registerCommandType({
  type:'task.create',
  validate(envelope){validateTaskPayload(envelope.payload,['title','notes','scheduled_date']);if(envelope.target_id!==null||envelope.expected_revision!==null||!Object.hasOwn(envelope.payload,'title'))throw new ChangeSetError('INVALID_TARGET','新規作成に対象を指定できません')},
  async prepare(envelope,actor){
    const current=(await db.settings.get('main'))!,policy=changePolicyFor(current)
    if(current.profileId!==actor.ownerId||current.datasetId!==actor.datasetId)throw new ChangeSetError('UNAUTHORIZED','この領域の変更は許可されていません')
    if(actor.principal.kind!=='human'&&(!current.aiEnabled||!policy.aiChangesEnabled||operationMode(policy,'task.text')==='deny'))throw new ChangeSetError('CHANGES_STOPPED','AIによる変更は停止しています')
    if(actor.grant&&Object.keys(envelope.payload).some(field=>!actor.grant!.fields.includes(field as CommandField)))throw new ChangeSetError('UNAUTHORIZED','この接続で許可していない項目です')
    const payload=envelope.payload as {title:string;notes?:string;scheduled_date?:string|null}
    const input={...newTaskInput(),containerId:actor.creationContainerId??null,title:payload.title,notes:payload.notes??'',scheduledDate:payload.scheduled_date??null}
    const entrance=actor.entrance==='api'?'api' as const:actor.entrance==='mcp'?'mcp' as const:'file' as const,assisted=await prepareAssistedTasks([{input,notices:[],source:`外部エージェント ${actor.principal.id} / コマンド ${envelope.command_id}`}],'ai',{kind:'external-agent',id:actor.principal.id,entrance,commandId:envelope.command_id})
    return {body:{assisted},expiresAt:assisted.expiresAt,reason:'外部エージェントからの新規作成（点数・締め切りは未設定）'}
  },
  decide(prepared,current){const policy=changePolicyFor(current);return prepared.actor.principal.kind!=='human'&&(!current.aiEnabled||!policy.aiChangesEnabled||operationMode(policy,'task.text')==='deny')?{status:'denied',reason:'AIによる変更は停止しています',protectedFields:[]}:{status:'awaiting_approval',reason:'新しい作業は本人が内容を確認して登録します',protectedFields:[]}},
  async approve(_prepared,event){trustedClick(event);const token=Object.freeze({id:uid()});trustedCreateApprovals.add(token);return token},
  async apply(prepared,approval){
    if(!approval||typeof approval!=='object'||!trustedCreateApprovals.has(approval))throw new ChangeSetError('HUMAN_APPROVAL_REQUIRED','新しい作業は本人が確認してください')
    trustedCreateApprovals.delete(approval)
    const assisted=(prepared.body as {assisted:PreparedAssistedTasks}).assisted,taskIds=await applyAssistedTasks(assisted,assisted.digest)
    return {changeSetId:assisted.id,digest:assisted.digest,taskIds,appliedAt:new Date().toISOString()}
  },
})
