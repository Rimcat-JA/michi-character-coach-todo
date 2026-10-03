const path = require('node:path')
const { createWebhookService } = require('./webhook-delivery.cjs')
const { onWindowClosed } = require('./on-window-closed.cjs')
function installWebhookIPC({ipcMain,win,app,safeStorage,gateway,assertFrame,readDatabase}) {
  const proofs=new Map(); let ready=null, closed=false
  ipcMain.on('michi:webhook-native-proof',(event,value)=>{try{assertFrame(event);if(!value||Object.keys(value).length!==2||typeof value.reference!=='string'||value.reference.length>100||!/^[a-f0-9-]{36}$/.test(value.nonce))return;for(const [id,p] of proofs)if(Date.now()-p.at>5000)proofs.delete(id);if(proofs.size<100)proofs.set(value.nonce,{...value,at:Date.now()})}catch{/* reject foreign frames */}})
  async function service(){ready??=createWebhookService({directory:path.join(app.getPath('userData'),'webhooks-private'),safeStorage,gateway,getContext:async()=>({settings:await readDatabase(win,'settings','main'),datasetState:await readDatabase(win,'datasetState','main')}),readDatabase:(table,key)=>readDatabase(win,table,key),verifyNativeProof:(reference,nonce)=>{const p=proofs.get(nonce);proofs.delete(nonce);return !!p&&p.reference===reference&&Date.now()-p.at<=5000}}).catch(e=>{ready=null;throw e});return ready}
  ipcMain.handle('michi:webhooks',async(event,value)=>{assertFrame(event);if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.action!=='string')throw new Error('WEBHOOK_REQUEST_INVALID');const keys=['status','invalidate'].includes(value.action)?['action']:['add','test'].includes(value.action)?['action','input','proofNonce']:['action','input'];if(Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new Error('WEBHOOK_REQUEST_INVALID');const s=await service();if(value.action==='status')return s.status();if(value.action==='add')return s.add(value.input,value.proofNonce);if(value.action==='test')return s.test(value.input,value.proofNonce);if(value.action==='revoke'){if(!value.input||Object.keys(value.input).length!==1)return Promise.reject(new Error('WEBHOOK_REQUEST_INVALID'));return s.revoke(value.input.id)}if(value.action==='invalidate')return s.invalidate();throw new Error('WEBHOOK_REQUEST_INVALID')})
  let timer=null
  win.webContents.once('did-finish-load',()=>{timer=setInterval(()=>{if(!closed)void service().then(s=>s.dispatch()).catch(()=>{/* show persisted delivery states; never assume success */})},5000);timer.unref()})
  onWindowClosed(win,()=>{closed=true;proofs.clear();if(timer)clearInterval(timer)})
}
module.exports={installWebhookIPC}
