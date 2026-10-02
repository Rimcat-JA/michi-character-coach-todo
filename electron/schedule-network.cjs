const dns = require('node:dns/promises')
const https = require('node:https')
const http = require('node:http')
const net = require('node:net')
function fail(code) { const error = new Error(code); error.code = code; throw error }
function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number)
    return !(a===0 || a===10 || a===127 || a>=224 || a===169&&b===254 || a===172&&b>=16&&b<=31 || a===192&&(b===168 || b===0 || b===2 || b===88&&c===99) || a===100&&b>=64&&b<=127 || a===198&&(b===18 || b===19 || b===51&&c===100) || a===203&&b===0&&c===113)
  }
  if (net.isIP(address) === 6) {const normalized=new URL(`http://[${address}]/`).hostname.slice(1,-1);return /^[23][0-9a-f]{3}:/i.test(normalized) && !/^(?:2001:(?:db8|[0-9a-f]{1,2}|1[0-9a-f]{2}):|2002:|3fff:)/i.test(normalized)}
  return false
}
function scheduleURL(value, qaLoopback=false) {
  let url
  try { url = new URL(value) } catch { fail('SCHEDULE_URL_INVALID') }
  const qa = qaLoopback && url.protocol==='http:' && url.hostname==='127.0.0.1' && Boolean(url.port)
  if (typeof value!=='string' || value.length>2048 || !qa && (url.protocol!=='https:' || url.port && url.port!=='443') || url.username || url.password || url.hash) fail('SCHEDULE_HTTPS_REQUIRED')
  if (!qa && (url.hostname==='localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || net.isIP(url.hostname.replace(/^\[|\]$/g,'')) && !publicAddress(url.hostname.replace(/^\[|\]$/g,'')))) fail('SCHEDULE_PRIVATE_ADDRESS')
  return url
}
/** Resolve once per request, reject every private answer, and pin the socket lookup to an approved answer.
 * TLS verification and servername retain the original hostname. No proxy/environment routing is used. */
function createScheduleTransport({qaLoopback=false, lookup=dns.lookup, timeoutMs=15000}={}) {
  return async function fetchPinned(value, init={}) {
    const url=scheduleURL(value,qaLoopback), qa=url.protocol==='http:'
    const signal=init.signal, controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs)
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort()
    try {
      const answers = qa ? [{address:'127.0.0.1',family:4}] : await Promise.race([lookup(url.hostname.replace(/^\[|\]$/g,''),{all:true,verbatim:true}),new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('SCHEDULE_TIMEOUT')),{once:true}))])
      if (!Array.isArray(answers)||!answers.length||answers.some(row=>!qa&&!publicAddress(row.address))) fail('SCHEDULE_PRIVATE_ADDRESS')
      const chosen=answers[0]
      return await new Promise((resolve,reject)=>{
        const request=(qa?http:https).request(url,{method:init.method??'GET',headers:Object.fromEntries(new Headers(init.headers)),signal:controller.signal,agent:false,lookup:(_hostname,options,callback)=>callback(null,options?.all?[chosen]:chosen.address,chosen.family)},response=>{
          const headers=new Headers();for(let i=0;i<response.rawHeaders.length;i+=2)headers.append(response.rawHeaders[i],response.rawHeaders[i+1])
          const chunks=[];let size=0
          response.on('data',chunk=>{size+=chunk.length;if(size>25*1024*1024){response.destroy(new Error('SCHEDULE_RESPONSE_OVERSIZE'));return}chunks.push(chunk)})
          response.on('error',reject);response.on('end',()=>{try { resolve(new Response([204,205,304].includes(response.statusCode)?null:Buffer.concat(chunks),{status:response.statusCode,headers})) }catch(error){reject(error)}})
        })
        request.on('error',()=>reject(new Error(controller.signal.aborted?'SCHEDULE_TIMEOUT':'SCHEDULE_NETWORK_FAILED')))
        if(init.body!==undefined)request.write(init.body);request.end()
      })
    } finally { clearTimeout(timer);signal?.removeEventListener('abort',abort) }
  }
}
module.exports={publicAddress,scheduleURL,createScheduleTransport}
