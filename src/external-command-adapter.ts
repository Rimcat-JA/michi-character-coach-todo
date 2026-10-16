import { db } from './db'
import type { ExternalChangeRequest } from './external-command-gate'
import { toTaskPatch } from './command-bus'
import type { TaskChangeRequest } from './change-set'
import { externalCommandEnvelope } from '../electron/external-command-envelope.mjs'
export { externalCommandEnvelope }
export async function resolvedExternalEnvelope(request: ExternalChangeRequest, commandId: string, ownerId: string) {
  const changes = request.operation === 'task.update' ? request.payload.changes as Record<string,unknown> : null
  let names: string[]|undefined
  if(changes && Object.hasOwn(changes,'labels')) {
    const ids = changes.labels as string[]
    if(ids.length > 30) fail('INVALID_LABELS')
    names = []
    for(const id of ids) { const label = await db.labelDefinitions.get(id); if(!label || label.ownerId !== ownerId) fail('LABEL_NOT_FOUND'); names.push(label.name) }
  }
  return externalCommandEnvelope(request,commandId,names)
}

function fail(code:string):never { throw Object.assign(Error(code),{code}) }
/** Exact catalog-to-bus conversion. Unsupported values never silently disappear. */
export async function externalTaskChanges(request:ExternalChangeRequest, ownerId:string):Promise<TaskChangeRequest[]> {
  const envelope=await resolvedExternalEnvelope(request,request.request_key,ownerId)
  if(envelope.type!=='task.update')fail('USER_INSTRUCTION_UNSUPPORTED')
  return [{taskId:envelope.target_id!,expectedRevision:envelope.expected_revision!,patch:toTaskPatch(envelope.payload)}]
}
