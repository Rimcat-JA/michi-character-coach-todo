const fs=require('node:fs/promises'),path=require('node:path')
const {createScheduleRefresh}=require('./schedule-refresh.cjs')
const {onWindowClosed}=require('./on-window-closed.cjs')
const {createSchedulePrivateStore}=require('./schedule-private.cjs')
const {scheduleURL}=require('./schedule-network.cjs')
function scheduleQAFixtureMode(app,value=process.env.MICHI_QA_SCHEDULE_FIXTURES){
  if(app.isPackaged!==false||value!=='1')return false
  try{const fsSync=require('node:fs'),profile=fsSync.realpathSync(app.getPath('userData')),documents=fsSync.realpathSync(app.getPath('documents')),relative=path.relative(documents,profile),parts=relative.split(path.sep),index=parts.findIndex((name,i)=>name==='qa-reminders-profile'&&parts[i-1]==='work');return !relative.startsWith('..')&&!path.isAbsolute(relative)&&parts[0]==='Codex'&&index>=2}catch{return false}
}
function installScheduleRefreshIPC({ipcMain,dialog,win,app,safeStorage,gateway,assertFrame,readDatabase,qaLoopback=false}) {
  let ready=null
  const getContext=async()=>({settings:await readDatabase(win,'settings','main'),datasetState:await readDatabase(win,'datasetState','main'),calendarRules:await readDatabase(win,'calendarRules','main')})
  async function service(){ready??=(async()=>{const root=await fs.realpath(app.getPath('userData')),store=await createSchedulePrivateStore({directory:path.join(root,'schedule-sources-private'),safeStorage});return createScheduleRefresh({store,gateway,getContext,qaLoopback,pollMs:qaLoopback?1000:15000,onChanged:async candidate=>{if(!win.isDestroyed())win.webContents.send('michi:schedule-refresh-changed',candidate)},onStatus:async status=>{if(!win.isDestroyed())win.webContents.send('michi:schedule-refresh-status',status)},notify:async value=>{if(!win.isDestroyed())win.webContents.send('michi:schedule-refresh-notify',value)}})})().catch(error=>{ready=null;throw error});return ready}
  async function main(event){assertFrame(event);const current=await getContext();if(!current.settings||current.datasetState&&current.datasetState.mode!=='active')throw new Error('SCHEDULE_DATASET_INACTIVE');return current.settings}
  ipcMain.handle('michi:schedule-refresh',async(event,request)=>{
    const settings=await main(event),action=request?.action,keys=['list','start'].includes(action)?['action']:action==='configure'?['action','sourceId','format','kind','url','refreshPolicy','validFrom']:action==='acknowledge'?['action','id','bodySha256']:['action','id']
    if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).length!==keys.length||keys.some(key=>!Object.hasOwn(request,key)))throw new Error('SCHEDULE_REQUEST_INVALID')
    if(keys.includes('id')&&(typeof request.id!=='string'||!/^[a-f0-9-]{36}$/.test(request.id)))throw new Error('SCHEDULE_REQUEST_INVALID')
    const current=await service()
    if(action==='list')return current.list()
    if(action==='start'){current.start();return {qaFixture:qaLoopback}}
    if(action==='configure'){
      const calendar=await readDatabase(win,'calendarRules','main'),source=calendar?.sources?.find(row=>row.id===request.sourceId)
      if(calendar?.ownerId!==settings.profileId||calendar?.datasetId!==settings.datasetId||!source||source.caldav||source.acquisition?.provider==='caldav'||request.format==='ics'&&!source.ics||request.format!=='ics'&&!source.csv)throw new Error('SCHEDULE_SOURCE_REQUIRED')
      let filePath=null
      if(request.kind==='file'){if(request.url!==null)throw new Error('SCHEDULE_REQUEST_INVALID');const result=await dialog.showOpenDialog(win,{title:'本人が更新を確認する予定資料を選ぶ',properties:['openFile'],filters:[{name:'予定資料',extensions:[request.format==='ics'?'ics':request.format==='csv'?'csv':request.format==='pdf'?'pdf':'xlsx','tsv']}]});if(result.canceled)return null;filePath=result.filePaths[0]}
      else if(request.kind==='url'){const url=scheduleURL(request.url,qaLoopback);await gateway.assertAllowed('schedule');const result=await dialog.showMessageBox(win,{type:'question',title:'予定資料の取得先を許可',message:`${url.origin} から予定資料を取得します`,detail:`対象：${source.title}\nこのアプリの起動中だけ、選択した間隔で取得します。変更は確認待ちに置き、予定やタスクを自動変更しません。${qaLoopback&&url.protocol==='http:'?'\n合成サーバー（127.0.0.1）を使用する試験です。':''}`,buttons:['許可して登録','取消'],defaultId:1,cancelId:1,noLink:true});if(result.response!==0)return null}
      else throw new Error('SCHEDULE_REQUEST_INVALID')
      const latest=await main(event);if(latest.profileId!==settings.profileId||latest.datasetId!==settings.datasetId||(latest.changePolicy?.epoch??0)!==(settings.changePolicy?.epoch??0))throw new Error('SCHEDULE_AUTHORITY_CHANGED')
      const {action:_action,...input}=request;return current.configure({...input,filePath})
    }
    if(action==='refresh')return current.refresh(request.id)
    if(action==='candidate'){let value=await current.candidate(request.id);if(!value){await current.refresh(request.id);value=await current.candidate(request.id)}return value}
    if(action==='acknowledge'){if(typeof request.bodySha256!=='string'||!/^[a-f0-9]{64}$/.test(request.bodySha256))throw new Error('SCHEDULE_REQUEST_INVALID');return current.acknowledge(request.id,request.bodySha256)}
    if(action==='remove'){const confirmation=await dialog.showMessageBox(win,{type:'question',title:'予定資料の取得を停止',message:'この資料の更新取得を停止します。保存済みの予定とタスクは保持します。',buttons:['取得を停止','取消'],defaultId:1,cancelId:1,noLink:true});return confirmation.response===0?current.remove(request.id):false}
    throw new Error('SCHEDULE_REQUEST_INVALID')
  })
  const catchup=()=>{void ready?.then(current=>current.tick()).catch(()=>{})};app.on('activate',catchup)
  const powerMonitor=require('electron').powerMonitor;powerMonitor.on('resume',catchup)
  onWindowClosed(win,()=>{void ready?.then(current=>current.close()).catch(()=>{});app.removeListener('activate',catchup);powerMonitor.removeListener('resume',catchup)})
  return {getService:service}
}
module.exports={installScheduleRefreshIPC,scheduleQAFixtureMode}
