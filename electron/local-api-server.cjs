const http=require('node:http'),crypto=require('node:crypto')
function fail(code,status=400){throw Object.assign(new Error(code),{code,status})}
function localAPIRequestBoundary(req,port){if(req.socket?.remoteAddress!=='127.0.0.1'||!['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host)||Object.hasOwn(req.headers,'origin')||Object.hasOwn(req.headers,'sec-fetch-site'))fail('REQUEST_ORIGIN_DENIED',403);if(req.rawHeaders){for(const name of ['host','authorization','idempotency-key','content-type'])if(req.rawHeaders.filter((v,i)=>i%2===0&&v.toLowerCase()===name).length>1)fail('DUPLICATE_HEADER')}if(typeof req.url!=='string'||!req.url.startsWith('/api/v1/')||req.url.length>2048)fail('NOT_FOUND',404)}
async function createLocalAPIServer({service,port=0}){
 if(!Number.isInteger(port)||port<0||port>65535)fail('PORT_INVALID')
 let actualPort=port
 const server=http.createServer({maxHeaderSize:8192,requestTimeout:10000,headersTimeout:10000,keepAliveTimeout:1000},async(req,res)=>{
  const meta={request_id:crypto.randomUUID(),server_time:new Date().toISOString(),schema_version:'1'}
  function send(status,body){if(res.destroyed)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','connection':'close'});res.end(JSON.stringify({...body,meta}))}
  try{
   localAPIRequestBoundary(req,actualPort)
   const url=new URL(req.url,'http://127.0.0.1:'+actualPort),p=url.pathname
   let scope
   if(req.method==='GET'&&(p==='/api/v1/tasks'||/^\/api\/v1\/tasks\/[a-f0-9-]{36}$/.test(p)))scope='tasks:read'
   else if(req.method==='POST'&&p==='/api/v1/commands')scope='tasks:create'
   else if(req.method==='GET'&&/^\/api\/v1\/commands\/[a-f0-9-]{36}$/.test(p))scope='commands:read'
   else fail('NOT_FOUND',404)
   const token=await service.authenticate(req.headers.authorization,scope)
   if(req.method==='GET'){
    if(req.headers['content-length']&&req.headers['content-length']!=='0'||req.headers['transfer-encoding'])fail('BODY_NOT_ALLOWED')
    if(p==='/api/v1/tasks'){if([...url.searchParams.keys()].some(k=>!['limit','cursor','updated_since'].includes(k))||[...url.searchParams.keys()].some(k=>url.searchParams.getAll(k).length!==1))fail('INVALID_QUERY',422);send(200,{data:await service.tasks(token,{limit:url.searchParams.has('limit')?Number(url.searchParams.get('limit')):50,cursor:url.searchParams.get('cursor'),updated_since:url.searchParams.get('updated_since')})})}
    else{if(url.search)fail('INVALID_QUERY',422);send(200,{data:p.includes('/tasks/')?await service.tasks(token,{id:p.split('/').at(-1)}):await service.getCommand(token,p.split('/').at(-1))})}
   }else{
    if(url.search)fail('INVALID_QUERY',422)
    if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))fail('CONTENT_TYPE_INVALID',415)
    if(req.headers['content-length']&&(!/^\d+$/.test(req.headers['content-length'])||Number(req.headers['content-length'])>65536))fail('BODY_TOO_LARGE',413)
    const chunks=[];let length=0;for await(const chunk of req.iterator({destroyOnReturn:false})){length+=chunk.length;if(length>65536)fail('BODY_TOO_LARGE',413);chunks.push(chunk)}
    let input;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))}catch{fail('INVALID_JSON')}
    const data=await service.submit(token,input,req.headers['idempotency-key']);send(data.state==='awaiting_approval'?202:200,{data})
   }
  }catch(e){const status=Number.isInteger(e.status)?e.status:503,code=typeof e.code==='string'&&/^[A-Z_]{1,80}$/.test(e.code)?e.code:'SERVICE_UNAVAILABLE';send(status,{error:{code,message:code,retryable:status===429||status===503,details:{}}})}
 })
 server.maxConnections=20;server.maxRequestsPerSocket=1
 server.on('clientError',(_error,socket)=>socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'))
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve()})});actualPort=server.address().port
 return {port:actualPort,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)})}
}
module.exports={createLocalAPIServer,localAPIRequestBoundary}
