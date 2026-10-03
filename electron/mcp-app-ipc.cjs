const crypto=require('node:crypto'),path=require('node:path')
const {createMCPCore}=require('./mcp-core.cjs'),{createMCPPipeServer}=require('./mcp-pipe-server.cjs')
const {createAppChangeDispatcher}=require('./mcp-app-changes.cjs')
const implemented=['coach_get_capabilities','coach_search_tasks','coach_get_task','coach_preview_score','coach_search_context','coach_prepare_change','coach_submit_change','coach_get_command_result','coach_get_history','coach_preview_routine','coach_prepare_routine_change','coach_prepare_detection_run','coach_get_detection_run','coach_prepare_handoff','coach_get_shared_context']
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
function installAppMCPIPC({ipcMain,win,app,getHub,assertMain,readDB}){
 const credentials=new Map(),pending=new Map();let starting=null,server=null,generation=0
 async function getContext(clientId){
  const settings=await readDB('settings','main'),status=await(await getHub()).clientStatus({clientId}),registration=status.registration
  const dataset=await readDB('datasetState','main')
  const client=settings?.externalAI?.clients?.find(row=>row.registration.client.id===clientId)
  return {registration,ownerId:settings?.profileId,datasetId:settings?.datasetId,externalEnabled:settings?.externalAI?.version===1&&settings.externalAI.enabled===true,externalEpoch:settings?.externalAI?.epoch,active:status.connected&&client?.status==='active'&&JSON.stringify(client.registration)===JSON.stringify(registration),frozen:(settings?.datasetMode??'active')!=='active'||(dataset?.mode??'active')!=='active',policyEpoch:settings?.changePolicy?.epoch??0,sourcePermissionRevision:settings?.changePolicy?.sourcePermissionRevision??0}
 }
 function dispatch(name,args,context){
  if(win.isDestroyed()||pending.size>=64)return Promise.reject(Object.assign(Error('APP_NOT_RUNNING'),{code:'APP_NOT_RUNNING'}))
  const requestId=crypto.randomUUID()
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(Object.assign(Error('APP_RESPONSE_TIMEOUT'),{code:'APP_RESPONSE_TIMEOUT'}))},10000);pending.set(requestId,{resolve,reject,timer});win.webContents.send('michi:app-mcp-request',{requestId,name,args,context})})
 }
 ipcMain.on('michi:app-mcp-response',(event,value)=>{
  try{assertMain(event);if(!value||Object.keys(value).length!==3||!uuid(value.requestId)||typeof value.code!=='string'&&value.code!==null)return;const row=pending.get(value.requestId);if(!row)return;pending.delete(value.requestId);clearTimeout(row.timer);if(value.code)row.reject(Object.assign(Error('TOOL_FAILED'),{code:/^[A-Z_]{1,80}$/.test(value.code)?value.code:'TOOL_FAILED'}));else row.resolve(value.data)}catch{/* Non-main-frame replies never reach a pending request. */}
 })
 async function listen(){
  if(server)return server
  if(!starting){const expected=generation;starting=(async()=>{
   const core=await createMCPCore({authenticate:async identity=>{
    if(!identity||!uuid(identity.clientId)||typeof identity.credential!=='string'||!/^[a-f0-9]{64}$/.test(identity.credential))return null
    const grant=credentials.get(identity.clientId)
    return grant&&crypto.timingSafeEqual(Buffer.from(grant.credential,'hex'),Buffer.from(identity.credential,'hex'))?grant:null
   },getContext,dispatch:createAppChangeDispatcher({getHub,readDB,dispatch}),implemented})
   const next=await createMCPPipeServer({handle:core.handle})
   if(expected!==generation||win.isDestroyed()){await next.close();throw Error('APP_NOT_RUNNING')}
   server=next;return next
  })().finally(()=>{starting=null})}
  return starting
 }
 ipcMain.handle('michi:app-mcp-configuration',async(event,request)=>{
  assertMain(event)
  if(!request||Object.keys(request).length!==1||!uuid(request.clientId))throw Error('CONFIG_INVALID')
  const expected=generation,context=await getContext(request.clientId)
  if(!context.active||!context.externalEnabled||context.frozen)throw Error('GRANT_REVOKED')
  const pipe=await listen(),latest=await getContext(request.clientId)
  if(expected!==generation||!latest.active||!latest.externalEnabled||latest.externalEpoch!==context.externalEpoch)throw Error('AUTHORITY_CHANGED')
  const credential=crypto.randomBytes(32).toString('hex'),registration=context.registration
  credentials.set(request.clientId,{clientId:request.clientId,credential,externalEpoch:context.externalEpoch,revision:registration.client.revision,grantEpoch:registration.client.grant_epoch})
  return {mcpServers:{michi:{command:process.execPath,args:[path.join(app.getAppPath(),'scripts','michi-mcp.mjs'),'--connect',request.clientId],env:{ELECTRON_RUN_AS_NODE:'1',MICHI_MCP_ENDPOINT:pipe.endpoint,MICHI_MCP_CREDENTIAL:credential}}},state:'implemented',limitations:['Windowsローカルの選択タスクと受信箱への変更案送信。アプリ再起動・設定の再表示で資格情報が変わります。','外部hostの実接続は未確認。']}
 })
 async function stop(){generation++;credentials.clear();for(const row of pending.values()){clearTimeout(row.timer);row.reject(Object.assign(Error('GRANT_REVOKED'),{code:'GRANT_REVOKED'}))}pending.clear();const current=server;server=null;if(current)await current.close()}
 win.on('closed',()=>{void stop()})
 return {stop,revoke:clientId=>credentials.delete(clientId)}
}
module.exports={installAppMCPIPC}
