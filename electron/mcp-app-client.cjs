const net=require('node:net')
function fail(code){return Object.assign(Error(code),{code})}
async function createMCPAppClient(clientId,endpoint,credential){
 if(typeof clientId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(clientId)||typeof endpoint!=='string'||!/^\\\\\.\\pipe\\michi-[a-f0-9]{32}$/.test(endpoint)||typeof credential!=='string'||!/^[a-f0-9]{64}$/.test(credential))throw fail('APP_CONNECTION_CONFIG_INVALID')
 const socket=net.connect(endpoint),pending=new Map();let buffer=Buffer.alloc(0),closed=false,helloResolve,helloReject
 const hello=new Promise((resolve,reject)=>{helloResolve=resolve;helloReject=reject}),timer=setTimeout(()=>{helloReject(fail('APP_NOT_RUNNING'));socket.destroy()},5000)
 function terminate(code){if(closed)return;closed=true;clearTimeout(timer);helloReject(fail(code));for(const row of pending.values()){clearTimeout(row.timer);row.reject(fail(code))}pending.clear();socket.destroy()}
 socket.on('connect',()=>socket.write(JSON.stringify({clientId,credential})+'\n'))
 socket.on('error',()=>terminate('APP_NOT_RUNNING'));socket.on('close',()=>terminate('APP_NOT_RUNNING'))
 socket.on('data',bytes=>{
  buffer=Buffer.concat([buffer,bytes]);if(buffer.length>2*1024*1024)return terminate('APP_OUTPUT_LIMIT')
  let index;while((index=buffer.indexOf(10))>=0){const line=buffer.subarray(0,index);buffer=buffer.subarray(index+1);let reply
   try{reply=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line))}catch{return terminate('APP_PROTOCOL_INVALID')}
   if(reply.connected===true){clearTimeout(timer);helloResolve();continue}
   if(reply.error==='UNAUTHENTICATED')return terminate('UNAUTHENTICATED')
   const row=pending.get(reply.id);if(row){pending.delete(reply.id);clearTimeout(row.timer);row.resolve(reply)}
  }
 })
 try{await hello}catch(error){terminate(error.code);throw error}
 const route=async(message,{signal}={})=>{
  if(closed)throw fail('APP_NOT_RUNNING')
  if(signal?.aborted)throw fail('REQUEST_CANCELLED')
  const line=JSON.stringify(message)+'\n';if(Buffer.byteLength(line)>262144||socket.writableLength+Buffer.byteLength(line)>2*1024*1024)throw fail('APP_INPUT_LIMIT')
  if(!Object.hasOwn(message,'id')){socket.write(line);return null}
  if(pending.size>=64||pending.has(message.id))throw fail('APP_REQUEST_LIMIT')
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(message.id);reject(fail('APP_RESPONSE_TIMEOUT'))},15000);pending.set(message.id,{resolve,reject,timer});socket.write(line)})
 }
 route.close=()=>terminate('APP_NOT_RUNNING')
 return route
}
module.exports={createMCPAppClient}
