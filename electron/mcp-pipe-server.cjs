const {spawn}=require('node:child_process')
const path=require('node:path'),crypto=require('node:crypto')
/** App-only, owner-SID ACL pipe. The Windows helper provides transport, not command authority. */
async function createMCPPipeServer({handle}){
 if(process.platform!=='win32')throw Object.assign(Error('WINDOWS_PIPE_ONLY'),{code:'WINDOWS_PIPE_ONLY'})
 const pipeName='michi-'+crypto.randomBytes(16).toString('hex'),sessions=new Map()
 const child=spawn(path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-File',path.join(__dirname,'mcp-pipe-relay.ps1'),'-PipeName',pipeName],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']})
 let closed=false,exited=false,buffer=Buffer.alloc(0),readyResolve,readyReject,stderrBytes=0,diagnostic='',startupFailure=''
 const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject}),timer=setTimeout(()=>{readyReject(Error('PIPE_START_TIMEOUT'));child.kill()},15000)
 const write=packet=>{if(closed)return;const line=JSON.stringify(packet)+'\n';if(Buffer.byteLength(line)+child.stdin.writableLength>2*1024*1024)throw Error('PIPE_OUTPUT_LIMIT');child.stdin.write(line)}
 const send=(sessionId,value)=>{if(value!==null)write({sessionId,line:JSON.stringify(value)})}
 const closeSession=sessionId=>{clearTimeout(sessions.get(sessionId)?.timer);sessions.delete(sessionId);write({sessionId,close:true})}
 child.stdin.on('error',()=>{child.kill()})
 child.stderr.on('data',bytes=>{stderrBytes+=bytes.length;if(stderrBytes>8192)return child.kill();diagnostic+=bytes.toString('utf8')})
 child.on('error',()=>readyReject(Error('PIPE_UNAVAILABLE')))
 child.on('close',exitCode=>{closed=true;exited=true;clearTimeout(timer);const startup=diagnostic.replaceAll('\0','').match(/MICHI_PIPE_STARTUP:([A-Za-z]{1,80}):([A-Za-z]{1,40}):(-?\d{1,12}):(CS\d{4})?/);const code=startup?`PIPE_UNAVAILABLE:${startup.slice(1).filter(Boolean).join(':')}`:/PSSecurityException|ScriptNotAllowed|UnauthorizedAccess/.test(diagnostic)?'PIPE_UNAVAILABLE:SCRIPT_POLICY':`PIPE_UNAVAILABLE:${startupFailure||'EXIT'}:${Number.isInteger(exitCode)?exitCode:'SIGNAL'}:${stderrBytes}`;diagnostic='';readyReject(Error(code));for(const session of sessions.values())clearTimeout(session.timer);sessions.clear()})
 function packet(value){
  if(value.kind==='ready'){
   if(value.protectedDacl!==true||value.ruleCount!==1||value.rejectRemoteClients!==true||typeof value.ownerSid!=='string'||value.ownerMatches!==true||value.ownerOnly!==true){startupFailure=`ACL_${value.protectedDacl===true?1:0}_${Number.isInteger(value.ruleCount)?value.ruleCount:-1}_${value.ownerMatches===true?1:0}_${value.ownerOnly===true?1:0}`;return child.kill()}
   clearTimeout(timer);readyResolve({ownerSid:value.ownerSid,sddl:value.sddl,protectedDacl:value.protectedDacl,ruleCount:value.ruleCount,ownerMatches:true,ownerOnly:true,rejectRemoteClients:true});return
  }
  if(value.kind==='connected'){
   if(sessions.size>=8)return child.kill()
   sessions.set(value.sessionId,{identity:null,queue:Promise.resolve(),pending:0,bytes:0,timer:setTimeout(()=>{closeSession(value.sessionId)},5000)});return
  }
  if(value.kind==='closed'){clearTimeout(sessions.get(value.sessionId)?.timer);sessions.delete(value.sessionId);return}
  if(value.kind!=='request'||typeof value.line!=='string')return child.kill()
  const session=sessions.get(value.sessionId);if(!session)return
  session.bytes+=Buffer.byteLength(value.line)
  if(++session.pending>64||session.bytes>2*1024*1024)return child.kill()
  session.queue=session.queue.then(async()=>{
   if(closed||!sessions.has(value.sessionId))return
   try{
    const message=JSON.parse(value.line)
    if(!session.identity){
     clearTimeout(session.timer)
     if(!message||Object.keys(message).length!==2||typeof message.clientId!=='string'||typeof message.credential!=='string'||message.credential.length!==64)throw Error('UNAUTHENTICATED')
     session.identity=Object.freeze(message)
     const result=await handle(session.identity,{jsonrpc:'2.0',id:'auth',method:'ping'})
     if(result.error){send(value.sessionId,{error:'UNAUTHENTICATED'});closeSession(value.sessionId);return}
     send(value.sessionId,{connected:true});return
    }
    send(value.sessionId,await handle(session.identity,message))
   }catch{send(value.sessionId,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'INVALID_REQUEST'}});if(!session.identity)closeSession(value.sessionId)}
   finally{session.pending--;session.bytes-=Buffer.byteLength(value.line)}
  }).catch(()=>{child.kill()})
 }
 child.stdout.on('data',bytes=>{
  if(closed)return
  buffer=Buffer.concat([buffer,bytes]);if(buffer.length>2*1024*1024)return child.kill()
  let index;while((index=buffer.indexOf(10))>=0){const line=buffer.subarray(0,index);buffer=buffer.subarray(index+1);try{packet(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line)))}catch{startupFailure='INVALID_HELPER_PACKET';child.kill();return}}
 })
 let acl;try{acl=await ready}catch(error){child.kill();throw error}
 return Object.freeze({endpoint:'\\\\.\\pipe\\'+pipeName,acl,close:async()=>{if(exited)return;closed=true;for(const session of sessions.values())clearTimeout(session.timer);sessions.clear();await new Promise(resolve=>{const stop=setTimeout(()=>{child.kill();resolve()},5000);child.once('close',()=>{clearTimeout(stop);resolve()});child.stdin.end();child.kill()})}})
}
module.exports={createMCPPipeServer}
