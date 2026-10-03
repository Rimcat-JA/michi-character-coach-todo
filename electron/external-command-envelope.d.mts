import type {ExternalChangeRequest} from '../src/external-command-gate'
import type {CommandEnvelope} from '../src/command-bus'
export function externalCommandEnvelope(request:ExternalChangeRequest,commandId:string):CommandEnvelope
