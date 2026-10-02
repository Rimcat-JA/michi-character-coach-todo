import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createGitHubEmulator } from '../scripts/qa-github-emulator.mjs'
const { createGitHubInitializer } = createRequire(import.meta.url)('./github-initialize.cjs')
const { inspectGitHubRepository } = createRequire(import.meta.url)('./github-publish.cjs')
async function setup(remote) {
  const repository=await inspectGitHubRepository({token:remote.token,owner:'owner',name:'repo',branch:'main',visibility:'public'},remote.fetchImpl)
  let journal=null,active=true
  const options={configuration:{id:randomUUID(),repository,token:remote.token,ownerId:'fixture',datasetId:randomUUID()},fetchImpl:remote.fetchImpl,readInitialization:async()=>journal,writeInitialization:async(value,exclusive)=>{if(exclusive&&journal)throw Error('reserved');journal=structuredClone(value)},verifyAuthority:async()=>active}
  return { service:createGitHubInitializer(options), restart:()=>createGitHubInitializer(options), stop:()=>active=false, journal:()=>journal }
}
test('empty initialization requires the exact proposal and native proof and writes only one README commit',async()=>{
  const remote=await createGitHubEmulator({empty:true})
  try{const item=await setup(remote);assert.equal(item.service!==null,true)
    let proposal=await item.service.prepare();await assert.rejects(item.service.initialize({...proposal,digest:'wrong'},async()=>true),/INITIALIZATION_INVALID/)
    await assert.rejects(item.service.initialize({reference:proposal.reference,digest:proposal.digest},async()=>false),/NATIVE/);assert.equal(remote.head(),null)
    proposal=await item.service.prepare();const result=await item.service.initialize({reference:proposal.reference,digest:proposal.digest},async()=>true)
    assert.equal(result.status,'initialized');assert.equal(remote.git(['rev-list','--count','main']),'1');assert.equal(remote.git(['ls-tree','--name-only','main']),'README.md')
    await assert.rejects(item.service.prepare(),/NOT_EMPTY/)
  }finally{await remote.dispose()}
})
test('lost initialization response is reserved across restart and read-only reconciliation creates no duplicate',async()=>{
  const remote=await createGitHubEmulator({empty:true})
  try{const item=await setup(remote),proposal=await item.service.prepare();remote.state.drop='initialize'
    assert.equal((await item.service.initialize({reference:proposal.reference,digest:proposal.digest},async()=>true)).status,'unknown');assert.equal(item.journal().state,'unknown')
    const restarted=item.restart();assert.equal((await restarted.reconcile()).status,'initialized');assert.equal(remote.git(['rev-list','--count','main']),'1')
  }finally{await remote.dispose()}
})
test('authority loss or a concurrent non-empty repository stops initialization before any PUT',async()=>{
  for(const mode of ['frozen','external']){const remote=await createGitHubEmulator({empty:true})
    try{const item=await setup(remote),proposal=await item.service.prepare();if(mode==='frozen')item.stop();else await remote.externalCommit({'unrelated.txt':'Keep'})
      await assert.rejects(item.service.initialize({reference:proposal.reference,digest:proposal.digest},async()=>true))
      assert.equal(remote.state.requests.some(row=>row.method==='PUT'),false)
    }finally{await remote.dispose()}
  }
})
