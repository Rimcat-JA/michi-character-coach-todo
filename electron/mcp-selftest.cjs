const { spawn } = require('node:child_process')
const path = require('node:path')
const protocolVersion = '2025-11-25'
/** Read-only subprocess diagnostic. It does not register a real host or call an AI model. */
async function runMCPFileSelftest({ executable, scriptPath, root, expectRevoked = false, appRunning = true, signal }) {
  const base = { checkedAt: new Date().toISOString(), surface: 'local_selftest', protocolVersion, auth: 'not_tested', read: 'not_tested', write: 'not_tested', revoke: 'not_tested' }
  const failed = expectRevoked ? { ...base, revoke: 'failed' } : { ...base, read: 'failed' }
  if (!appRunning || signal?.aborted) return { ...base, code: 'APP_NOT_RUNNING' }
  if (![executable,scriptPath,root].every(value => typeof value === 'string' && path.isAbsolute(value)) || !/^[a-f0-9-]{36}$/.test(path.basename(root))) return { ...base, code: 'SELFTEST_CONFIG_INVALID' }
  const requests = [
    {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion,capabilities:{},clientInfo:{name:'michi-local-selftest',version:'1.0'}}},
    {jsonrpc:'2.0',method:'notifications/initialized'},
    {jsonrpc:'2.0',id:2,method:'tools/list',params:{}},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'michi_snapshot',arguments:{}}}
  ]
  let result
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn(executable,[scriptPath,'--bridge',root],{shell:false,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','pipe']})
      const stdout=[],stderr=[];let count=0,errorCount=0,bounded=true,timedOut=false
      const timer=setTimeout(()=>{timedOut=true;child.kill()},5000)
      const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true})
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort)}
      child.stdout.on('data',data=>{count+=data.length;if(count>1024*1024){bounded=false;child.kill()}else stdout.push(data)})
      child.stderr.on('data',data=>{errorCount+=data.length;if(errorCount>8192){bounded=false;child.kill()}else stderr.push(data)})
      child.on('error',error=>{cleanup();reject(error)})
      child.on('close',code=>{cleanup();try{resolve({code,stdout:new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(stdout)),stderr:new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(stderr)),bounded,timedOut})}catch{reject(Error('SELFTEST_UTF8'))}})
      child.stdin.on('error',()=>{});child.stdin.end(requests.map(JSON.stringify).join('\n')+'\n')
    })
  } catch { return {...failed,code:'SELFTEST_START_FAILED'} }
  if (signal?.aborted) return {...base,code:'APP_NOT_RUNNING'}
  if (!result.bounded || result.timedOut) return {...failed,code:result.timedOut?'SELFTEST_TIMEOUT':'SELFTEST_OUTPUT_LIMIT'}
  if (expectRevoked) return result.code!==0 && /\bCONNECTION_REVOKED\b/.test(result.stderr) && !result.stdout.trim() ? {...base,revoke:'verified_local',code:null} : {...base,revoke:'failed',code:'SELFTEST_REVOCATION_FAILED'}
  try {
    const replies=result.stdout.trim().split('\n').map(JSON.parse)
    if (result.code!==0 || result.stderr.trim() || replies.length!==3 || replies.some((reply,i)=>reply.jsonrpc!=='2.0'||reply.id!==i+1||reply.error||reply.result?.isError) || replies[0].result.protocolVersion!==protocolVersion) throw Error()
    const names=replies[1].result.tools.map(tool=>tool.name), snapshot=replies[2].result.structuredContent
    if (names.length<4 || names.length>6 || new Set(names).size!==names.length || !['michi_snapshot','michi_propose_update','michi_propose_create','michi_command_result'].every(name=>names.includes(name)) || names.some(name=>!['michi_snapshot','michi_propose_update','michi_propose_create','michi_command_result','michi_propose_split','michi_propose_routine_change'].includes(name)) || snapshot.manifest.client_id!==path.basename(root) || snapshot.signatureVerifiedByClient!==false || !Array.isArray(snapshot.tasks) || snapshot.tasks.length>100) throw Error()
    return {...base,read:'verified_local',code:null}
  } catch { return {...base,read:'failed',code:'SELFTEST_PROTOCOL_FAILED'} }
}
module.exports = { runMCPFileSelftest }
