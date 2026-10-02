import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import {createRequire} from 'node:module'
import crypto from 'node:crypto'
const {createMCPPipeServer}=createRequire(import.meta.url)('./mcp-pipe-server.cjs')
test('Windows owner-only ACL pipe authenticates independent sessions and closes with the app', {skip:process.platform!=='win32'}, async t=>{
 const credential=crypto.randomBytes(32).toString('hex'),clientId=crypto.randomUUID();let active=true
 const server=await createMCPPipeServer({handle:async(identity,message)=>identity.credential===credential&&identity.clientId===clientId&&active?{jsonrpc:'2.0',id:message.id,result:{clientId}}:{jsonrpc:'2.0',id:message.id,error:{code:-32000,message:'UNAUTHENTICATED'}}})
 t.after(()=>server.close())
 assert.equal(server.acl.protectedDacl,true);assert.equal(server.acl.ruleCount,1);assert.match(server.acl.sddl,/D:P\(A;/);assert.equal(server.acl.sddl.includes(';;;WD)'),false)
 assert.equal(server.acl.rejectRemoteClients,true)
 async function peer(secret){
  const socket=net.connect(server.endpoint),lines=[],waiters=[];let buffer=''
  socket.on('data',bytes=>{buffer+=bytes.toString('utf8');let i;while((i=buffer.indexOf('\n'))>=0){const line=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);const waiter=waiters.shift();if(waiter)waiter(line);else lines.push(line)}})
  socket.on('error',()=>{})
  const next=()=>lines.length?Promise.resolve(lines.shift()):new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('PIPE_REPLY_TIMEOUT')),5000);waiters.push(value=>{clearTimeout(timer);resolve(value)})})
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject)})
  socket.write(JSON.stringify({clientId,credential:secret})+'\n')
  return {socket,next,hello:await next()}
 }
 const wrong=await peer('0'.repeat(64));assert.equal(wrong.hello.error,'UNAUTHENTICATED');wrong.socket.destroy()
 const a=await peer(credential),b=await peer(credential);t.after(()=>{a.socket.destroy();b.socket.destroy()})
 assert.equal(a.hello.connected,true);assert.equal(b.hello.connected,true)
 a.socket.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n');assert.equal((await a.next()).result.clientId,clientId)
 b.socket.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})+'\n');assert.equal((await b.next()).id,2)
 active=false;a.socket.write(JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/list'})+'\n');assert.equal((await a.next()).error.message,'UNAUTHENTICATED')
 await server.close()
 await assert.rejects(new Promise((resolve,reject)=>{const socket=net.connect(server.endpoint);socket.once('error',reject);socket.once('connect',()=>{socket.destroy();resolve()})}))
})
test('other platforms do not silently replace owner-only Windows pipe with an unprotected endpoint',{skip:process.platform==='win32'},async()=>{
 await assert.rejects(createMCPPipeServer({handle:()=>{}}),error=>error.code==='WINDOWS_PIPE_ONLY')
})
