import { dispatchExternalReadTool, type ExternalToolContext } from './external-tools'
type AppMCPRequest={requestId:string;name:string;args:Record<string,unknown>;context:ExternalToolContext}
export type AppMCPGateway={onRequest:(callback:(request:AppMCPRequest)=>void)=>()=>void;respond:(response:{requestId:string;code:string|null;data:unknown})=>void;configuration:(request:{clientId:string})=>Promise<unknown>}
export function installExternalToolsRuntime(){
 const gateway=(window as Window&{michiAppMCP?:AppMCPGateway}).michiAppMCP
 if(!gateway)return ()=>{}
 return gateway.onRequest(request=>{void dispatchExternalReadTool(request.name,request.args,request.context).then(data=>gateway.respond({requestId:request.requestId,code:null,data})).catch(error=>gateway.respond({requestId:request.requestId,code:typeof error.code==='string'?error.code:'TOOL_FAILED',data:null}))})
}
