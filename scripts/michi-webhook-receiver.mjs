import crypto from 'node:crypto'
import http from 'node:http'
import { pathToFileURL } from 'node:url'

/** Reference-only loopback receiver. Supply the one-time hex secret via an environment variable.
 * Persist event ids in a production receiver; this mock keeps them only for its current process. */
export function createWebhookVerifier({secret,now=Date.now,maxEvents=10000}) {
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw Error('32-byte hex secret required')
  const seen=new Set(),key=Buffer.from(secret,'hex')
  return ({rawBody,signature,eventId})=>{
    const match=typeof signature==='string'&&/^t=(\d{1,12}),v1=([a-f0-9]{64})$/i.exec(signature)
    if(!match||Math.abs(now()/1000-Number(match[1]))>300)return {ok:false,code:'STALE_OR_INVALID_SIGNATURE',status:401}
    if(typeof rawBody!=='string'||Buffer.byteLength(rawBody)>65536)return {ok:false,code:'INVALID_BODY',status:400}
    const expected=crypto.createHmac('sha256',key).update(match[1]+'.'+rawBody).digest(),actual=Buffer.from(match[2],'hex')
    if(!crypto.timingSafeEqual(expected,actual))return {ok:false,code:'SIGNATURE_MISMATCH',status:401}
    let body;try{body=JSON.parse(rawBody)}catch{return {ok:false,code:'INVALID_BODY',status:400}}
    if(typeof eventId!=='string'||!/^[a-f0-9-]{36}$/i.test(eventId)||body.id!==eventId||!['task.created','task.completed','task.reopened','webhook.ping'].includes(body.type))return {ok:false,code:'EVENT_ID_MISMATCH',status:400}
    if(seen.has(eventId))return {ok:false,code:'DUPLICATE_EVENT',status:409}
    if(seen.size>=maxEvents)return {ok:false,code:'RECEIVER_CAPACITY',status:503}
    seen.add(eventId);return {ok:true,status:204,event:{id:body.id,type:body.type,occurred_at:body.occurred_at}}
  }
}
export async function startReceiver({secret,port=0,now=Date.now,onEvent=()=>{}}) {
  const verify=createWebhookVerifier({secret,now})
  const server=http.createServer({maxHeaderSize:8192},async(req,res)=>{
    if(req.socket.remoteAddress!=='127.0.0.1'||req.method!=='POST'||req.url!=='/webhook'||req.headers['content-type']!=='application/json'){res.writeHead(400);res.end();return}
    let size=0,chunks=[]
    try {for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>65536){res.writeHead(413);res.end();req.resume();return}chunks.push(chunk)}const rawBody=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)),result=verify({rawBody,signature:req.headers['michi-signature'],eventId:req.headers['michi-event-id']});if(result.ok)onEvent(result.event);res.writeHead(result.status);res.end(result.ok?'':JSON.stringify({code:result.code}))}catch{if(!res.headersSent){res.writeHead(400);res.end()}}
  })
  server.requestTimeout=10000;server.headersTimeout=10000
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)})
  return {url:'http://127.0.0.1:'+server.address().port+'/webhook',close:()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve())),verify}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const receiver=await startReceiver({secret:process.env.MICHI_WEBHOOK_SECRET??'',port:Number(process.env.MICHI_WEBHOOK_PORT??'8766'),onEvent:event=>process.stdout.write(JSON.stringify(event)+'\n')})
  process.stdout.write('Reference receiver: '+receiver.url+' (in-memory dedupe only)\n')
  process.once('SIGINT',()=>{void receiver.close().then(()=>process.exit(0))})
}
