import {createRequire} from 'node:module'
import {once} from 'node:events'
const {createMCPFileClient,createMCPRouter,cancellationRequestId,MCP_LINE_LIMIT}=createRequire(import.meta.url)('../electron/mcp-file-client.cjs')
const {createMCPAppClient}=createRequire(import.meta.url)('../electron/mcp-app-client.cjs')
// Notifications bypass the bounded work queue so queued calls can be cancelled.
const MAX_QUEUED_REQUESTS=64,MAX_QUEUED_BYTES=2*1024*1024
try {
  const args=process.argv.slice(2);if(args.length!==2||!['--bridge','--connect'].includes(args[0])){const error=Error('Use the configuration selected in michi settings');error.code='MCP_USAGE';throw error}
  const route=args[0]==='--bridge'?createMCPRouter(await createMCPFileClient(args[1])):await createMCPAppClient(args[1],process.env.MICHI_MCP_ENDPOINT,process.env.MICHI_MCP_CREDENTIAL)
  let buffer=Buffer.alloc(0),queue=[],queueBytes=0,pumping=false,closed=false,ended=false
  const pending=new Map()
  const fatal=reason=>{if(closed)return;closed=true;route.close?.();process.exitCode=1;process.stderr.write(reason+'\n');for(const entry of pending.values())entry.controller.abort();pending.clear();queue=[];queueBytes=0;buffer=Buffer.alloc(0);process.stdin.destroy()}
  const send=async value=>{
    if(!value||closed)return
    if(!process.stdout.write(JSON.stringify(value)+'\n')){
      const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),5000)
      try{await once(process.stdout,'drain',{signal:timeout.signal})}catch{fatal('MCP output is not draining')}finally{clearTimeout(timer)}
    }
  }
  async function pump(){
    if(pumping||closed)return;pumping=true
    try{
      while(queue.length&&!closed){
        const entry=queue.shift();queueBytes-=entry.length
        try{if(!entry.controller.signal.aborted)await send(entry.error??await route(entry.value,{signal:entry.controller.signal}))}
        catch{if(!entry.controller.signal.aborted)await send({jsonrpc:'2.0',...(entry.id!==undefined?{id:entry.id}:{}),error:{code:-32603,message:'Request failed'}})}
        finally{if(pending.get(entry.id)===entry)pending.delete(entry.id)}
      }
    }finally{pumping=false;if(ended&&!queue.length&&!closed){closed=true;route.close?.()}}
  }
  function line(bytes){
    if(bytes.length>MCP_LINE_LIMIT){fatal('MCP line exceeds limit');return}
    let value,error
    try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{error={jsonrpc:'2.0',error:{code:-32700,message:'Parse error'}}}
    if(value&&typeof value==='object'&&!Array.isArray(value)&&!Object.hasOwn(value,'id')){
      const cancelledId=cancellationRequestId(value)
      if(cancelledId!==undefined)pending.get(cancelledId)?.controller.abort()
      // Lifecycle notifications wait behind initialize; only cancellation bypasses.
      if(value.method==='notifications/cancelled'){void route(value).catch(()=>{});return}
    }
    const id=value?.id,validId=typeof id==='string'&&id.length>0&&id.length<=200||Number.isSafeInteger(id)
    if(validId&&pending.has(id)){error={jsonrpc:'2.0',id,error:{code:-32600,message:'Request ID is already in flight'}};value=undefined}
    if(queue.length>=MAX_QUEUED_REQUESTS||queueBytes+bytes.length>MAX_QUEUED_BYTES){fatal('MCP request queue exceeds limit');return}
    const entry={value,error,id:validId&&!error?id:undefined,length:bytes.length,controller:new AbortController()}
    if(entry.id!==undefined)pending.set(entry.id,entry)
    queue.push(entry);queueBytes+=bytes.length
    if(!pumping)queueMicrotask(()=>void pump())
  }
  process.stdout.on('error',()=>fatal('MCP output is unavailable'))
  process.stdin.on('error',()=>fatal('MCP input is unavailable'))
  process.stdin.on('data',chunk=>{
    if(closed)return
    const input=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);let start=0
    for(let index=0;index<input.length;index++)if(input[index]===10){
      const part=input.subarray(start,index)
      if(buffer.length+part.length>MCP_LINE_LIMIT){fatal('MCP line exceeds limit');return}
      line(buffer.length?Buffer.concat([buffer,part]):part);buffer=Buffer.alloc(0);start=index+1
      if(closed)return
    }
    const tail=input.subarray(start)
    if(buffer.length+tail.length>MCP_LINE_LIMIT){fatal('MCP line exceeds limit');return}
    buffer=buffer.length?Buffer.concat([buffer,tail]):Buffer.from(tail)
  })
  process.stdin.on('end',()=>{
    if(closed)return;ended=true
    if(buffer.length){fatal('MCP stream ended with an unterminated message');return}
    void pump()
  })
} catch(error){process.stderr.write((typeof error.code==='string'&&/^[A-Z0-9_]{1,60}$/.test(error.code)?error.code:'BRIDGE_UNAVAILABLE')+'\n');process.exitCode=1}
