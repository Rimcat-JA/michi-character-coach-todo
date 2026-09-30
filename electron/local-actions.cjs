// Trusted main-process boundary. No renderer/model controls registration or keys.
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn: nativeSpawn } = require('node:child_process')

const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_RUN_MS = 30_000
const MAX_REQUEST_MS = 60_000
const MAX_APPROVAL_MS = 5 * 60_000
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const HASH = /^[a-f0-9]{64}$/
const requestKeys = ['version','requestId','nonce','issuedAt','expiresAt','ownerId','datasetId','deviceId','policyEpoch','sourcePermissionRevision','definitionRevision','actionId','event','params','signature']

function fail(code) { const error = new Error(code); error.code = code; throw error }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value)) }
function exact(value, keys, required = keys) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value,key))) fail('INVALID_INPUT')
}
function integer(value) { return Number.isSafeInteger(value) && value >= 0 }
function token(value) { if (typeof value !== 'string' || !TOKEN.test(value)) fail('INVALID_INPUT'); return value }
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key)+':'+canonical(value[key])).join(',') + '}'
  fail('INVALID_INPUT')
}
function clone(value) { return JSON.parse(canonical(value)) }
function freeze(value) { if(value && typeof value==='object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex') }
function sign(value, key, domain) { return crypto.createHmac('sha256',key).update(domain+'\n'+canonical(value)).digest('hex') }
function keyCheck(key) { if (!Buffer.isBuffer(key) || key.length < 32) fail('INVALID_SIGNING_KEY') }
function signLocalActionRequest(input, key) {
  keyCheck(key)
  const body = clone(input); delete body.signature
  return { ...body, signature: sign(body,key,'local-action-request-v1') }
}
function verifyLocalActionResult(result,key) {
  keyCheck(key)
  if(!object(result)||typeof result.signature!=='string'||!HASH.test(result.signature)) return false
  const body = clone(result);delete body.signature
  return crypto.timingSafeEqual(Buffer.from(result.signature,'hex'),Buffer.from(sign(body,key,'local-action-result-v1'),'hex'))
}
function inside(candidate,root) { const relative=path.relative(root,candidate); return relative==='' || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative)) }
async function safePath(candidate,{directory=false,root}={}) {
  if(typeof candidate!=='string'||!path.isAbsolute(candidate)||candidate.includes('\0')) fail('INVALID_PATH')
  const resolved=path.resolve(candidate)
  // Disallow UNC/network and alternate data streams on Windows.
  if(process.platform==='win32' && (/^[\\/]{2}/.test(resolved) || resolved.slice(2).includes(':'))) fail('INVALID_PATH')
  if(root&&!inside(resolved,root)) fail('PATH_OUTSIDE_ALLOWLIST')
  const base=path.parse(resolved).root
  let current=base
  for(const part of resolved.slice(base.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,part)
    const stat=await fs.lstat(current)
    if(stat.isSymbolicLink()) fail('UNSAFE_PATH_LINK')
    if(!stat.isDirectory() && stat.nlink !== 1) fail('UNSAFE_PATH_LINK')
  }
  const real=await fs.realpath(resolved)
  if(path.relative(resolved,real)!=='' || (root&&!inside(real,root))) fail('UNSAFE_PATH_LINK')
  const stat=await fs.lstat(real)
  if(directory?!stat.isDirectory():!stat.isFile()) fail('INVALID_PATH_TYPE')
  return { path:real,stat }
}
async function executableIdentity(definition) {
  const checked=await safePath(definition.executable,{root:definition.executableRoot})
  if(process.platform==='win32' && path.extname(checked.path).toLowerCase()!=='.exe') fail('UNSAFE_EXECUTABLE')
  if(/\.(?:cmd|bat|ps1|sh|com)$/i.test(checked.path)) fail('UNSAFE_EXECUTABLE')
  const content=await fs.readFile(checked.path)
  if(crypto.createHash('sha256').update(content).digest('hex')!==definition.sha256) fail('EXECUTABLE_CHANGED')
  return {dev:checked.stat.dev,ino:checked.stat.ino,size:checked.stat.size,mtimeMs:checked.stat.mtimeMs,ctimeMs:checked.stat.ctimeMs}
}
function validateSchema(schema) {
  if(!object(schema)||Object.keys(schema).length>32) fail('INVALID_REGISTRATION')
  for(const [name,rule] of Object.entries(schema)) {
    token(name);exact(rule,['type','enum','min','max','maxLength','roots','directory'],['type'])
    if(!['string','number','boolean','path'].includes(rule.type)) fail('INVALID_REGISTRATION')
    const keys={string:['type','enum','maxLength'],number:['type','enum','min','max'],boolean:['type','enum'],path:['type','roots','directory']}[rule.type]
    if(Object.keys(rule).some(key=>!keys.includes(key)))fail('INVALID_REGISTRATION')
    if(rule.type==='number' && (!Number.isFinite(rule.min)||!Number.isFinite(rule.max)||rule.min>rule.max)) fail('INVALID_REGISTRATION')
    if(rule.type==='string' && (!integer(rule.maxLength)||rule.maxLength<1||rule.maxLength>4096)) fail('INVALID_REGISTRATION')
    if(rule.enum!==undefined && (!Array.isArray(rule.enum)||!rule.enum.length||rule.enum.length>100||rule.enum.some(v=>!['string','number','boolean'].includes(typeof v)))) fail('INVALID_REGISTRATION')
    if(rule.enum?.some(value=>typeof value!==rule.type||(rule.type==='number'&&!Number.isFinite(value))))fail('INVALID_REGISTRATION')
    if(rule.type==='path' && (!Array.isArray(rule.roots)||!rule.roots.length||rule.roots.some(v=>typeof v!=='string'||!path.isAbsolute(v)))) fail('INVALID_REGISTRATION')
    if(rule.directory!==undefined&&typeof rule.directory!=='boolean') fail('INVALID_REGISTRATION')
  }
}
async function validateRegistration(input) {
  exact(input,['id','revision','ownerId','datasetId','deviceId','executable','executableRoot','sha256','cwd','schema','argv','lowRisk','delegation'],['id','revision','ownerId','datasetId','deviceId','executable','executableRoot','sha256','cwd','schema','argv'])
  const def=clone(input)
  for(const name of ['id','ownerId','datasetId','deviceId']) token(def[name])
  if(!integer(def.revision)||def.revision<1||!HASH.test(def.sha256)||!Array.isArray(def.argv)||def.argv.length>64) fail('INVALID_REGISTRATION')
  if(def.lowRisk!==undefined&&typeof def.lowRisk!=='boolean') fail('INVALID_REGISTRATION')
  validateSchema(def.schema)
  def.executableRoot=(await safePath(def.executableRoot,{directory:true})).path
  def.cwd=(await safePath(def.cwd,{directory:true})).path
  if(/^(?:cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32|wmic|sh|bash|zsh|dash)(?:\.exe)?$/i.test(path.basename(def.executable)))fail('UNSAFE_EXECUTABLE')
  const used=new Set()
  for(const [index,arg] of def.argv.entries()) {
    if(typeof arg==='string') {if(arg.length>4096||/[\0\r\n]/.test(arg)) fail('INVALID_REGISTRATION')}
    else {exact(arg,['param']);if(!Object.hasOwn(def.schema,arg.param)) fail('INVALID_REGISTRATION');used.add(arg.param)}
    // Interpreters may run only owner-registered literal code, never a remote
    // parameter occupying an eval/command/script expression slot.
    if(index>0&&typeof arg!=='string'&&typeof def.argv[index-1]==='string'&&/^(?:-[ec]|--eval|--command|-command|-encodedcommand|\/c|\/k)$/i.test(def.argv[index-1]))fail('UNSAFE_EXECUTABLE')
  }
  if(Object.keys(def.schema).some(name=>!used.has(name))) fail('INVALID_REGISTRATION')
  for(const rule of Object.values(def.schema)) if(rule.type==='path') rule.roots=await Promise.all(rule.roots.map(async root=>(await safePath(root,{directory:true})).path))
  if(def.delegation!==undefined) {
    exact(def.delegation,['ownerId','policyEpoch','sourcePermissionRevision','events','expiresAt'])
    if(def.lowRisk!==true||def.delegation.ownerId!==def.ownerId||!integer(def.delegation.policyEpoch)||!integer(def.delegation.sourcePermissionRevision)||!integer(def.delegation.expiresAt)||!Array.isArray(def.delegation.events)||!def.delegation.events.length) fail('INVALID_DELEGATION')
    def.delegation.events.forEach(token)
  }
  def.identity=await executableIdentity(def)
  return freeze(def)
}
async function argumentsFor(def,params) {
  exact(params,Object.keys(def.schema))
  const values={}
  for(const [name,rule] of Object.entries(def.schema)) {
    const value=params[name]
    if(rule.enum&&!rule.enum.includes(value)) fail('INVALID_ARGUMENT')
    if(rule.type==='number' && (typeof value!=='number'||!Number.isFinite(value)||value<rule.min||value>rule.max)) fail('INVALID_ARGUMENT')
    if(rule.type==='boolean' && typeof value!=='boolean') fail('INVALID_ARGUMENT')
    if(rule.type==='string' && (typeof value!=='string'||value.length>rule.maxLength||/^[\s-]|[\0\r\n;&|<>`$]/.test(value))) fail('INVALID_ARGUMENT')
    if(rule.type==='path') {
      if(typeof value!=='string') fail('INVALID_ARGUMENT')
      const root=rule.roots.find(candidate=>path.isAbsolute(value)&&inside(path.resolve(value),candidate))
      if(!root) fail('PATH_OUTSIDE_ALLOWLIST')
      values[name]=(await safePath(value,{root,directory:rule.directory===true})).path
    } else values[name]=String(value)
  }
  return def.argv.map(arg=>typeof arg==='string'?arg:values[arg.param])
}
function redactedOutput(value,key) {
  // Fail closed on credential-shaped values and terminal control sequences.
  return value.replaceAll(key.toString('hex'),'[redacted]').replaceAll(key.toString('base64'),'[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|Bearer\s+[^\s]+)\b/gi,'[redacted]')
    .replace(/((?:api[_ -]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,'$1[redacted]')
    .split('').filter(character=>{const code=character.charCodeAt(0);return code===9||code===10||code===13||(code>=32&&code!==127)}).join('')
}
async function createLocalActionService(options) {
  if(!object(options)) fail('INVALID_CONFIGURATION')
  keyCheck(options.signingKey)
  const signingKey=Buffer.from(options.signingKey)
  if(typeof options.getCurrentContext!=='function'||!Array.isArray(options.registrations)||options.registrations.length>100) fail('INVALID_CONFIGURATION')
  const journal=(await safePath(options.journalDirectory,{directory:true})).path
  const definitions=new Map()
  for(const registration of options.registrations) {
    const def=await validateRegistration(registration)
    if(definitions.has(def.id)) fail('INVALID_REGISTRATION')
    definitions.set(def.id,def)
  }
  const now=options.now??Date.now,launch=options.spawn??nativeSpawn
  const grants=new WeakMap(),pending=new Map()
  let authorityGeneration=0
  const resultFor=body=>freeze({...body,signature:sign(body,signingKey,'local-action-result-v1')})
  const signedClaim=body=>({...body,claimSignature:sign(body,signingKey,'local-action-claim-v1')})
  function checkClaim(record) {
    if(!object(record)||typeof record.claimSignature!=='string'||!HASH.test(record.claimSignature))fail('INVALID_JOURNAL')
    const body={...record};delete body.claimSignature
    if(!crypto.timingSafeEqual(Buffer.from(record.claimSignature,'hex'),Buffer.from(sign(body,signingKey,'local-action-claim-v1'),'hex')))fail('INVALID_JOURNAL')
    return body
  }
  async function verify(input) {
    exact(input,requestKeys)
    // Bound untrusted data before canonicalization (no graphs, arrays or objects
    // inside params). A transport should also bound its raw request body.
    if(!object(input.params)||Object.keys(input.params).length>32||Object.values(input.params).some(value=>!['string','number','boolean'].includes(typeof value)||(typeof value==='string'&&value.length>4096)||(typeof value==='number'&&!Number.isFinite(value))))fail('INVALID_ARGUMENT')
    for(const name of requestKeys.filter(name=>name!=='params')) if(!['number','string'].includes(typeof input[name]))fail('INVALID_INPUT')
    const request=clone(input)
    if(request.version!==1||typeof request.signature!=='string'||!HASH.test(request.signature)) fail('INVALID_SIGNATURE')
    const body={...request};delete body.signature
    if(Buffer.byteLength(canonical(body))>64*1024) fail('INVALID_INPUT')
    if(!crypto.timingSafeEqual(Buffer.from(request.signature,'hex'),Buffer.from(sign(body,signingKey,'local-action-request-v1'),'hex'))) fail('INVALID_SIGNATURE')
    for(const name of ['requestId','nonce','ownerId','datasetId','deviceId','actionId','event']) token(request[name])
    for(const name of ['issuedAt','expiresAt','policyEpoch','sourcePermissionRevision','definitionRevision']) if(!integer(request[name])) fail('INVALID_INPUT')
    const stamp=now()
    if(request.issuedAt>stamp||request.expiresAt<=stamp||request.expiresAt<=request.issuedAt||request.expiresAt-request.issuedAt>MAX_REQUEST_MS) fail('REQUEST_EXPIRED')
    const context=await options.getCurrentContext()
    if(!context||context.enabled!==true) fail('LOCAL_ACTIONS_DISABLED')
    for(const name of ['ownerId','datasetId','deviceId','policyEpoch','sourcePermissionRevision']) if(context[name]!==request[name]) fail('AUTHORITY_CHANGED')
    const def=definitions.get(request.actionId)
    if(!def) fail('UNREGISTERED_ACTION')
    for(const name of ['ownerId','datasetId','deviceId']) if(def[name]!==request[name]) fail('AUTHORITY_CHANGED')
    if(def.revision!==request.definitionRevision) fail('DEFINITION_CHANGED')
    const argv=await argumentsFor(def,request.params)
    const identity=await executableIdentity(def)
    if(canonical(identity)!==canonical(def.identity)) fail('EXECUTABLE_CHANGED')
    await safePath(def.cwd,{directory:true})
    return {request,def,argv,digest:digest(body)}
  }
  function automatic(verified) {
    const grant=verified.def.delegation,req=verified.request
    return verified.def.lowRisk===true&&grant&&grant.expiresAt>now()&&grant.ownerId===req.ownerId&&grant.policyEpoch===req.policyEpoch&&grant.sourcePermissionRevision===req.sourcePermissionRevision&&grant.events.includes(req.event)
  }
  async function prepare(envelope) {
    const v=await verify(envelope)
    return freeze({requestId:v.request.requestId,digest:v.digest,actionId:v.def.id,executable:v.def.executable,argv:v.argv,cwd:v.def.cwd,expiresAt:v.request.expiresAt,approvalRequired:!automatic(v),ownerId:v.request.ownerId,datasetId:v.request.datasetId,deviceId:v.request.deviceId,policyEpoch:v.request.policyEpoch,sourcePermissionRevision:v.request.sourcePermissionRevision,definitionRevision:v.def.revision})
  }
  async function approve(envelope,appProof) {
    const reviewed=await prepare(envelope)
    const expiresAt=Math.min(now()+MAX_APPROVAL_MS,reviewed.expiresAt)
    if(typeof options.verifyHumanApproval!=='function'||await options.verifyHumanApproval({...reviewed,expiresAt},appProof)!==true) fail('HUMAN_APPROVAL_REQUIRED')
    // Re-read policy after an asynchronous genuine-click proof validation.
    const current=await prepare(envelope)
    if(current.digest!==reviewed.digest) fail('AUTHORITY_CHANGED')
    const grant=Object.freeze({digest:reviewed.digest,expiresAt})
    grants.set(grant,{digest:reviewed.digest,expiresAt,generation:authorityGeneration})
    return grant
  }
  async function journalPath(name) {
    await safePath(journal,{directory:true})
    return path.join(journal,name)
  }
  async function readJournal(name) {
    const filename=await journalPath(name)
    try { await safePath(filename,{root:journal});return JSON.parse(await fs.readFile(filename,'utf8')) }
    catch(error) {if(error.code==='ENOENT')return null;throw error}
  }
  async function claim(name,body) {
    const filename=await journalPath(name)
    let handle
    try {handle=await fs.open(filename,'wx',0o600);await handle.writeFile(canonical(body));await handle.sync()}
    catch(error) {if(error.code==='EEXIST')return false;throw error}
    finally {await handle?.close()}
    return true
  }
  async function complete(name,result) {
    const filename=await journalPath(name),temporary=await journalPath('.'+crypto.randomUUID()+'.tmp')
    let handle
    try {handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(canonical(result));await handle.sync();await handle.close();handle=null;await fs.rename(temporary,filename)}
    finally {await handle?.close();await fs.unlink(temporary).catch(()=>{})}
  }
  function run(v) {
    return new Promise(resolve=>{
      let child,finished=false,timer,total=0,truncated=false,timedOut=false,spawnFailed=false
      const chunks=[]
      const done=(exitCode,signal)=>{
        if(finished)return;finished=true;clearTimeout(timer)
        let output=redactedOutput(Buffer.concat(chunks).toString('utf8'),signingKey)
        if(Buffer.byteLength(output)>MAX_OUTPUT_BYTES) {
          truncated=true;output=Buffer.from(output).subarray(0,MAX_OUTPUT_BYTES).toString('utf8')
          while(Buffer.byteLength(output)>MAX_OUTPUT_BYTES)output=output.slice(0,-1)
        }
        resolve({exitCode:Number.isInteger(exitCode)?exitCode:null,signal:typeof signal==='string'?signal:null,output,outputTruncated:truncated,timedOut,status:spawnFailed?'failed':timedOut?'timed_out':exitCode===0?'succeeded':'failed'})
      }
      const collect=chunk=>{
        const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk)),remaining=MAX_OUTPUT_BYTES-total
        if(remaining>0){const kept=buffer.subarray(0,remaining);chunks.push(kept);total+=kept.length}
        if(buffer.length>remaining){truncated=true;try{child?.kill('SIGKILL')}catch{spawnFailed=true;done(null,null)}}
      }
      try {
        // Never inherit PATH, credentials, NODE_OPTIONS, arbitrary cwd or stdin.
        const env={LANG:'C.UTF-8',TZ:'UTC'}
        if(process.platform==='win32') env.SystemRoot=path.join(path.parse(process.execPath).root,'Windows')
        child=launch(v.def.executable,v.argv,{cwd:v.def.cwd,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],detached:false,timeout:MAX_RUN_MS,killSignal:'SIGKILL'})
        child.stdout?.on('data',collect);child.stderr?.on('data',collect)
        child.once('error',()=>{spawnFailed=true;done(null,null)})
        child.once('close',done)
        timer=setTimeout(()=>{timedOut=true;try{child.kill('SIGKILL')}catch{/* Limit result is still recorded if the OS reports an already-gone child. */}done(null,'SIGKILL')},MAX_RUN_MS)
      } catch {spawnFailed=true;done(null,null)}
    })
  }
  async function execute(envelope,approval=null) {
    const v=await verify(envelope),req=v.request
    const name=digest({ownerId:req.ownerId,datasetId:req.datasetId,requestId:req.requestId})+'.json'
    const existing=await readJournal(name)
    if(existing) {
      if(existing.digest!==v.digest) fail('REPLAY_MISMATCH')
      if(pending.has(name)) return pending.get(name).promise
      if(existing.signature) {if(!verifyLocalActionResult(existing,signingKey))fail('INVALID_JOURNAL');return freeze(existing)}
      // A prior process may have died after launch. Never blindly launch again.
      const unknown=resultFor({...checkClaim(existing),status:'unknown',exitCode:null,signal:null,output:'',outputTruncated:false,timedOut:false,completedAt:now()})
      await complete(name,unknown);return unknown
    }
    if(pending.has(name)) {
      const inflight=pending.get(name)
      if(inflight.digest!==v.digest)fail('REPLAY_MISMATCH')
      return inflight.promise
    }
    const grant=grants.get(approval)
    if(!automatic(v)&&(!grant||grant.digest!==v.digest||grant.expiresAt<=now()||grant.generation!==authorityGeneration)) fail('HUMAN_APPROVAL_REQUIRED')
    const promise=(async()=>{
      // Claim before launching; durable nonce is global within this device journal.
      const nonceName='nonce-'+digest({nonce:req.nonce})+'.json'
      const nonceClaim=signedClaim({digest:v.digest,requestId:req.requestId})
      if(!await claim(nonceName,nonceClaim)) {const prev=checkClaim(await readJournal(nonceName));if(prev.digest!==v.digest||prev.requestId!==req.requestId)fail('NONCE_REPLAY')}
      const record={version:1,requestId:req.requestId,digest:v.digest,ownerId:req.ownerId,datasetId:req.datasetId,deviceId:req.deviceId,actionId:req.actionId,policyEpoch:req.policyEpoch,sourcePermissionRevision:req.sourcePermissionRevision,definitionRevision:req.definitionRevision,startedAt:now()}
      if(!await claim(name,signedClaim(record))) {const prev=await readJournal(name);if(prev?.digest!==v.digest)fail('REPLAY_MISMATCH');fail('REQUEST_ALREADY_CLAIMED')}
      // Final policy, executable, args, expiry recheck after filesystem work.
      try {
        const latest=await verify(envelope)
        if(latest.digest!==v.digest||(!automatic(latest)&&(!grant||grant.expiresAt<=now()||grant.generation!==authorityGeneration))) fail('AUTHORITY_CHANGED')
        const result=resultFor({...record,...await run(latest),completedAt:now()})
        await complete(name,result);return result
      } catch(error) {
        const result=resultFor({...record,status:'canceled',exitCode:null,signal:null,output:'',outputTruncated:false,timedOut:false,completedAt:now()})
        await complete(name,result);throw error
      }
    })()
    pending.set(name,{digest:v.digest,promise})
    try{return await promise}finally{pending.delete(name)}
  }
  return Object.freeze({prepare,approve,execute,clearAuthorities(){authorityGeneration+=1}})
}

module.exports={createLocalActionService,signLocalActionRequest,verifyLocalActionResult,MAX_OUTPUT_BYTES,MAX_RUN_MS,MAX_REQUEST_MS,MAX_APPROVAL_MS}
