const {XMLParser,XMLValidator}=require('fast-xml-parser'),crypto=require('node:crypto')
const {scheduleURL}=require('./schedule-network.cjs')
const sha=value=>crypto.createHash('sha256').update(value).digest('hex'),array=value=>value===undefined?[]:Array.isArray(value)?value:[value]
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;')
function fail(code){throw new Error(code)}
const control=value=>[...value].some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127)
function safeXML(input){
  if(typeof input!=='string'||Buffer.byteLength(input)>3*1048576||/<!DOCTYPE|<!ENTITY/i.test(input)||/&(?!amp;|lt;|gt;|quot;|apos;|#\d{1,8};|#x[\da-fA-F]{1,8};)/.test(input)||XMLValidator.validate(input)!==true)fail('CALDAV_XML_INVALID')
  for(const match of input.matchAll(/xmlns(?::[\w.-]+)?\s*=\s*(["'])(.*?)\1/g))if(!['DAV:','urn:ietf:params:xml:ns:caldav','http://calendarserver.org/ns/'].includes(match[2]))fail('CALDAV_XML_NAMESPACE_INVALID')
  const stripped=input.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g,'').replace(/<!--[\s\S]*?-->/g,''),tags=[...stripped.matchAll(/<\/?[A-Za-z_][\w:.-]*(?:\s[^<>]*?)?\s*\/?>/g)];let depth=0
  if(tags.length>25000)fail('CALDAV_XML_BUDGET')
  for(const [tag]of tags){if(tag.startsWith('</'))depth--;else if(!tag.endsWith('/>'))depth++;if(depth<0||depth>20)fail('CALDAV_XML_DEPTH')}
  return new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',removeNSPrefix:true,parseTagValue:false,parseAttributeValue:false,trimValues:false,processEntities:true}).parse(input)
}
function multis(input){
  const root=safeXML(input).multistatus;if(!root||typeof root!=='object')fail('CALDAV_MULTISTATUS_REQUIRED')
  const rows=array(root.response);if(rows.length>1000)fail('CALDAV_OBJECT_LIMIT')
  const responses=rows.map(row=>{
    if(typeof row.href!=='string'||row.href.length>2048)fail('CALDAV_HREF_INVALID')
    const props={};let status=row.status?statusCode(row.status):200
    for(const part of array(row.propstat)){const code=statusCode(part.status);if(code===200){if(!part.prop||typeof part.prop!=='object')fail('CALDAV_PROP_INVALID');for(const [key,value]of Object.entries(part.prop)){if(Object.hasOwn(props,key))fail('CALDAV_DUPLICATE_PROP');props[key]=value}}else if(code!==404)fail('CALDAV_PROPERTY_ERROR')}
    if(!row.status&&!array(row.propstat).some(part=>statusCode(part.status)===200))status=404
    return {href:row.href,status,props}
  })
  return {responses,token:typeof root['sync-token']==='string'?root['sync-token']:null}
}
function statusCode(value){const match=/^HTTP\/\d(?:\.\d)? ([1-5]\d\d)(?: .*)?$/.exec(value??'');if(!match)fail('CALDAV_STATUS_INVALID');return Number(match[1])}
const propfind=properties=>`<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"><d:prop>${properties}</d:prop></d:propfind>`
/** No ambient transport/credentials: main injects the approved NetworkGateway route. */
function createCalDAVClient({url,username,password,fetchImpl,qaLoopback=false,clock=Date.now}) {
  const base=scheduleURL(url,qaLoopback)
  if(base.search||typeof username!=='string'||!username||username.length>300||username.includes(':')||control(username)||typeof password!=='string'||!password||password.length>1000||control(password)||typeof fetchImpl!=='function')fail('CALDAV_CONFIGURATION_INVALID')
  const authorization='Basic '+Buffer.from(username+':'+password).toString('base64'),cache=new Map(),approvals=new Map()
  let readCollection=null,writeCollection=null
  function target(value,collection=null){let resolved;try{resolved=new URL(value,base)}catch{fail('CALDAV_ORIGIN_BLOCKED')}if(resolved.origin!==base.origin||resolved.username||resolved.password||resolved.hash||resolved.search)fail('CALDAV_ORIGIN_BLOCKED');scheduleURL(resolved.href,qaLoopback);if(collection&&(!resolved.pathname.startsWith(collection.pathname)||resolved.pathname===collection.pathname))fail('CALDAV_COLLECTION_BLOCKED');return resolved}
  function objectTarget(value,collection){const resolved=target(value,collection),suffix=resolved.pathname.slice(collection.pathname.length);let decoded;try{decoded=decodeURIComponent(suffix)}catch{fail('CALDAV_HREF_INVALID')}if(!decoded||decoded.includes('/')||decoded.includes('\\')||control(decoded))fail('CALDAV_HREF_INVALID');return resolved}
  async function request(value,method,body=null,extra={}){
    const endpoint=target(value),headers=new Headers(extra);headers.set('Authorization',authorization);if(body!==null)headers.set('Content-Type',method==='PUT'?'text/calendar; charset=utf-8':'application/xml; charset=utf-8')
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000)
    try { const response=await fetchImpl(endpoint.href,{method,headers,body:body??undefined,signal:controller.signal,redirect:'error'});if(response.status>=300&&response.status<400)fail('CALDAV_REDIRECT_BLOCKED');if(response.status===429||response.status>=500){const error=new Error(`CALDAV_HTTP_${response.status}`);error.retryAfter=require('./schedule-refresh.cjs').retryAfter(response.headers,clock());throw error;}const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>3*1048576)fail('CALDAV_RESPONSE_BUDGET');let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{fail('CALDAV_UTF8_INVALID')}return {status:response.status,headers:response.headers,text} }
    catch(error){if(error?.code==='NETWORK_POLICY_OFFLINE')throw new Error('NETWORK_POLICY_OFFLINE');if(typeof error?.message==='string'&&/^CALDAV_[A-Z_\d]+$/.test(error.message))throw error;fail('CALDAV_NETWORK_FAILED')}
    finally{clearTimeout(timer)}
  }
  async function properties(value,body,depth='0'){const result=await request(value,'PROPFIND',propfind(body),{Depth:depth});if(result.status!==207)fail(`CALDAV_HTTP_${result.status}`);return multis(result.text)}
  async function discover(){
    const root=await properties(base.href,'<d:current-user-principal/>'),principal=root.responses.flatMap(row=>array(row.props['current-user-principal']?.href))[0]
    if(typeof principal!=='string')fail('CALDAV_PRINCIPAL_MISSING')
    const principalURL=target(principal),homeResponse=await properties(principalURL.href,'<c:calendar-home-set/>'),home=homeResponse.responses.flatMap(row=>array(row.props['calendar-home-set']?.href))[0]
    if(typeof home!=='string')fail('CALDAV_HOME_MISSING')
    const homeURL=target(home),collections=await properties(homeURL.href,'<d:resourcetype/><d:displayname/><cs:getctag/><d:sync-token/><c:supported-calendar-component-set/><d:current-user-privilege-set/>','1')
    const seen=new Set()
    return collections.responses.filter(row=>row.status===200&&row.props.resourcetype&&Object.hasOwn(row.props.resourcetype,'calendar')).map(row=>{
      const href=target(row.href);if(!href.pathname.startsWith(homeURL.pathname)||!href.pathname.endsWith('/')||seen.has(href.href))fail('CALDAV_COLLECTION_INVALID');seen.add(href.href)
      const components=array(row.props['supported-calendar-component-set']?.comp).map(comp=>comp['@_name']);if(!components.includes('VEVENT'))fail('CALDAV_VEVENT_UNSUPPORTED')
      const title=typeof row.props.displayname==='string'?row.props.displayname:'カレンダー';if(title.length>300||control(title))fail('CALDAV_DISPLAY_NAME_INVALID')
      return {href:href.href,title,ctag:typeof row.props.getctag==='string'?row.props.getctag:null,syncToken:typeof row.props['sync-token']==='string'?row.props['sync-token']:null,components}
    })
  }
  function selectCollections(read,write=null,dedicatedConfirmed=false){const selected=target(read);if(!selected.pathname.endsWith('/'))fail('CALDAV_COLLECTION_INVALID');if(write!==null){const selectedWrite=target(write);if(!dedicatedConfirmed||!selectedWrite.pathname.endsWith('/')||selectedWrite.href===selected.href)fail('CALDAV_DEDICATED_WRITE_REQUIRED');writeCollection=selectedWrite}else writeCollection=null;readCollection=selected;cache.clear();approvals.clear()}
  function readRequired(){if(!readCollection)fail('CALDAV_READ_COLLECTION_REQUIRED')}
  function etag(value){if(typeof value!=='string'||value.length>1000||(!/^"[^"]+"$/.test(value)||control(value)))fail('CALDAV_STRONG_ETAG_REQUIRED');return value}
  async function hydrate(rows){
    const needed=rows.filter(row=>row.status===200&&cache.get(row.href)?.etag!==row.props.getetag)
    if(needed.length){const body=`<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop>${needed.map(row=>`<d:href>${escape(objectTarget(row.href,readCollection).pathname)}</d:href>`).join('')}</c:calendar-multiget>`,result=await request(readCollection.href,'REPORT',body)
      if(result.status!==207)fail(`CALDAV_HTTP_${result.status}`);const returned=multis(result.text).responses,expected=new Set(needed.map(row=>objectTarget(row.href,readCollection).href))
      for(const row of returned){const href=objectTarget(row.href,readCollection).href;if(!expected.delete(href)||row.status!==200||typeof row.props['calendar-data']!=='string'||Buffer.byteLength(row.props['calendar-data'])>1048576)fail('CALDAV_MULTIGET_INCOMPLETE');cache.set(href,{href,etag:etag(row.props.getetag),data:row.props['calendar-data']})}
      if(expected.size)fail('CALDAV_MULTIGET_INCOMPLETE')
    }
  }
  async function full(mirror,from,to){
    const body=`<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${from}" end="${to}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,result=await request(readCollection.href,'REPORT',body)
    if(result.status!==207)fail(`CALDAV_HTTP_${result.status}`);const parsed=multis(result.text),rows=parsed.responses.map(row=>({...row,href:objectTarget(row.href,readCollection).href}))
    if(rows.some(row=>row.status!==200)||new Set(rows.map(row=>row.href)).size!==rows.length)fail('CALDAV_QUERY_INVALID')
    await hydrate(rows)
    // Omission in a time-range query is never an explicit deletion.
    const retained=new Map((mirror?.objects??[]).map(row=>[objectTarget(row.href,readCollection).href,row]))
    for(const row of rows)retained.set(row.href,{href:row.href,etag:etag(row.props.getetag)})
    // Rehydrate retained but omitted objects after restart; only GET 404 is an explicit deletion.
    const deleted=[]
    for(const [href,row]of retained)if(!cache.has(href)||!rows.some(item=>item.href===href)){const response=await request(href,'GET');if(response.status===404){deleted.push({href});retained.delete(href);continue}if(response.status!==200)fail(`CALDAV_HTTP_${response.status}`);if(Buffer.byteLength(response.text)>1048576)fail('CALDAV_OBJECT_BUDGET');cache.set(href,{href,etag:etag(response.headers.get('etag')),data:response.text});row.etag=cache.get(href).etag}
    if(retained.size>1000)fail('CALDAV_OBJECT_LIMIT')
    for(const href of [...cache.keys()])if(!retained.has(href))cache.delete(href)
    return {token:parsed.token,objects:[...retained.values()],deleted,fullResync:true,method:'calendar-query'}
  }
  async function sync(mirror={token:null,objects:[]},from='20260101T000000Z',to='20270101T000000Z'){
    readRequired();if(!/^\d{8}T\d{6}Z$/.test(from)||!/^\d{8}T\d{6}Z$/.test(to)||from>=to||!mirror||!Array.isArray(mirror.objects)||mirror.objects.length>1000||mirror.token!==null&&(typeof mirror.token!=='string'||mirror.token.length>2048))fail('CALDAV_SYNC_INPUT_INVALID')
    let result
    const body=`<d:sync-collection xmlns:d="DAV:"><d:sync-token>${escape(mirror.token??'')}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,response=await request(readCollection.href,'REPORT',body)
    if([403,409].includes(response.status)){if(!response.text.includes('valid-sync-token'))fail(`CALDAV_HTTP_${response.status}`);result=await full(mirror,from,to)}
    else if([404,405,501].includes(response.status))result=await full(mirror,from,to)
    else{
      if(response.status!==207)fail(`CALDAV_HTTP_${response.status}`);const parsed=multis(response.text);if(!parsed.token||parsed.token.length>2048)fail('CALDAV_SYNC_TOKEN_MISSING')
      const rows=parsed.responses.map(row=>({...row,href:objectTarget(row.href,readCollection).href}));if(new Set(rows.map(row=>row.href)).size!==rows.length||rows.some(row=>![200,404].includes(row.status)))fail('CALDAV_SYNC_RESPONSE_INVALID')
      const objects=new Map((mirror.objects??[]).map(row=>[objectTarget(row.href,readCollection).href,row])),deleted=[]
      for(const row of rows){if(row.status===404){objects.delete(row.href);cache.delete(row.href);deleted.push({href:row.href})}else objects.set(row.href,{href:row.href,etag:etag(row.props.getetag)})}
      if(objects.size>1000)fail('CALDAV_OBJECT_LIMIT');await hydrate([...objects.values()].map(row=>({href:row.href,status:200,props:{getetag:row.etag}})))
      result={token:parsed.token,objects:[...objects.values()],deleted,fullResync:mirror.token===null,method:'sync-collection'}
    }
    const objects=result.objects.map(row=>cache.get(row.href));if(objects.some(row=>!row))fail('CALDAV_MIRROR_INCOMPLETE')
    if(Buffer.byteLength(JSON.stringify(objects))>850000)fail('CALDAV_MIRROR_BUDGET')
    return {...result,objects,checkedAt:new Date(clock()).toISOString(),collection:readCollection.href}
  }
  async function prepareWrite({id,operation,data=null}){
    if(!writeCollection||!readCollection||writeCollection.href===readCollection.href)fail('CALDAV_WRITE_COLLECTION_BLOCKED')
    if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)||!['put','delete'].includes(operation)||operation==='put'&&(typeof data!=='string'||!data.startsWith('BEGIN:VCALENDAR')||Buffer.byteLength(data)>1048576)||operation==='delete'&&data!==null)fail('CALDAV_WRITE_INVALID')
    const href=objectTarget(`${writeCollection.href}michi-${sha(id)}.ics`,writeCollection),current=await request(href.href,'GET');if(![200,404].includes(current.status))fail(`CALDAV_HTTP_${current.status}`)
    const preview={token:crypto.randomUUID(),id,operation,href:href.href,before:current.status===200?current.text:null,etag:current.status===200?etag(current.headers.get('etag')):null,after:data,expiresAt:clock()+600000}
    if(approvals.size>=100)approvals.clear();approvals.set(preview.token,preview);return structuredClone(preview)
  }
  function writePreview(token){const value=approvals.get(token);if(!value||value.expiresAt<=clock())fail('CALDAV_WRITE_PREVIEW_EXPIRED');return structuredClone(value)}
  async function applyWrite(token,approve){const preview=writePreview(token);if(typeof approve!=='function'||await approve(structuredClone(preview))!==true)fail('CALDAV_NATIVE_APPROVAL_REQUIRED');if(approvals.get(token)!==undefined){approvals.delete(token)}else fail('CALDAV_WRITE_PREVIEW_EXPIRED');if(preview.expiresAt<=clock())fail('CALDAV_WRITE_PREVIEW_EXPIRED')
    const targetURL=objectTarget(preview.href,writeCollection),headers=preview.etag?{'If-Match':preview.etag}:{'If-None-Match':'*'}
    if(preview.operation==='delete'&&!preview.etag)return {state:'already_absent',href:preview.href}
    const response=await request(targetURL.href,preview.operation==='put'?'PUT':'DELETE',preview.after,headers)
    if(response.status===412){const current=await request(targetURL.href,'GET');if(![200,404].includes(current.status))fail(`CALDAV_HTTP_${current.status}`);if(preview.operation==='put'&&current.status===200&&sha(current.text)===sha(preview.after))return {state:'reconciled',href:preview.href,etag:etag(current.headers.get('etag'))};return {state:'conflict',href:preview.href,before:preview.before,current:current.status===200?current.text:null,after:preview.after,etag:current.status===200?etag(current.headers.get('etag')):null,newApprovalRequired:true}}
    if(preview.operation==='put'&&![200,201,204].includes(response.status)||preview.operation==='delete'&&![200,204].includes(response.status))fail(`CALDAV_HTTP_${response.status}`)
    return {state:preview.operation==='delete'?'deleted':'written',href:preview.href,etag:response.headers.get('etag')}
  }
  return {discover,selectCollections,sync,prepareWrite,writePreview,applyWrite}
}
module.exports={createCalDAVClient,safeXML,multis}
