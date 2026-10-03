import { dispatchExternalReadTool, type ExternalToolContext } from './external-tools'
import { dispatchExternalChangeTool } from './external-change-plans'
import { processExternalSubmission } from './external-auto-submission'
import type { FileBridgeWindow } from './file-bridge-types'
type AppMCPRequest={requestId:string;name:string;args:Record<string,unknown>;context:ExternalToolContext}
export type AppMCPGateway={onRequest:(callback:(request:AppMCPRequest)=>void)=>()=>void;respond:(response:{requestId:string;code:string|null;data:unknown})=>void;configuration:(request:{clientId:string})=>Promise<unknown>}
export function installExternalToolsRuntime(){
 const gateway=(window as Window&{michiAppMCP?:AppMCPGateway}).michiAppMCP
 if(!gateway)return ()=>{}
 return gateway.onRequest(request=>{const dispatch=['coach_prepare_change','coach_submit_change'].includes(request.name)?dispatchExternalChangeTool:dispatchExternalReadTool;const bridge=(window as FileBridgeWindow).michiFileBridge;const work=request.name==='michi_process_catalog_submission'&&bridge?processExternalSubmission(request.args,request.context,bridge):dispatch(request.name,request.args,request.context);void work.then(data=>gateway.respond({requestId:request.requestId,code:null,data})).catch(error=>gateway.respond({requestId:request.requestId,code:typeof error.code==='string'?error.code:'TOOL_FAILED',data:null}))})
}
