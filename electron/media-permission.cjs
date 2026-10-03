function appURL(value) { try { const u=new URL(value);return u.protocol==='michi:'&&u.hostname==='app'&&!u.port&&!u.username&&!u.password } catch { return false } }
/** A short-lived native push-to-talk gesture, never a persisted microphone grant. */
function createMediaPermissionPolicy({getContents,now=Date.now}) {
  let proof=null
  function grant(event) { const contents=getContents();if(!contents||contents.isDestroyed()||event.sender!==contents||event.senderFrame!==contents.mainFrame||!appURL(event.senderFrame.url))return false;proof={at:now(),url:event.senderFrame.url,contents};return true }
  function valid(contents,details) { const current=getContents();return Boolean(proof&&current&&contents===current&&proof.contents===current&&!current.isDestroyed()&&details?.isMainFrame===true&&appURL(details.requestingUrl)&&details.requestingUrl===current.mainFrame.url&&proof.url===current.mainFrame.url&&now()>=proof.at&&now()-proof.at<=5000) }
  function check(contents,permission,origin,details) {return permission==='media'&&details?.mediaType==='audio'&&appURL(origin)&&valid(contents,details)}
  function request(contents,permission,details) { const allowed=permission==='media'&&Array.isArray(details?.mediaTypes)&&details.mediaTypes.length===1&&details.mediaTypes[0]==='audio'&&valid(contents,details);if(allowed)proof=null;return allowed }
  return {grant,check,request,clear:()=>{proof=null}}
}
function installMediaPermissionPolicy({session,ipcMain,win}) {
  const {onWindowClosed}=require('./on-window-closed.cjs')
  const policy=createMediaPermissionPolicy({getContents:()=>win.isDestroyed()?null:win.webContents})
  ipcMain.on('michi:voice-native-start',(event,value)=>{if(value===undefined)policy.grant(event)})
  ipcMain.on('michi:voice-native-stop',event=>{if(event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame)policy.clear()})
  session.setPermissionCheckHandler((contents,permission,origin,details)=>policy.check(contents,permission,origin,details))
  session.setPermissionRequestHandler((contents,permission,callback,details)=>callback(policy.request(contents,permission,details)))
  session.setDisplayMediaRequestHandler((_request,callback)=>callback(null))
  win.webContents.on('did-start-navigation',()=>policy.clear());win.on('hide',()=>policy.clear());onWindowClosed(win,()=>policy.clear())
}
module.exports={createMediaPermissionPolicy,installMediaPermissionPolicy}
