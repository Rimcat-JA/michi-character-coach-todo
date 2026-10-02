import type { ExternalChangeRequest } from './external-command-gate'
import { toTaskPatch } from './command-bus'
import type { TaskChangeRequest } from './change-set'
import { externalCommandEnvelope } from '../electron/external-command-envelope.mjs'
export { externalCommandEnvelope }

function fail(code:string):never { throw Object.assign(Error(code),{code}) }
/** Exact catalog-to-bus conversion. Unsupported values never silently disappear. */
export function externalTaskChanges(request:ExternalChangeRequest):TaskChangeRequest[] {
  const envelope=externalCommandEnvelope(request,request.request_key)
  if(envelope.type!=='task.update')fail('USER_INSTRUCTION_UNSUPPORTED')
  return [{taskId:envelope.target_id!,expectedRevision:envelope.expected_revision!,patch:toTaskPatch(envelope.payload)}]
}
