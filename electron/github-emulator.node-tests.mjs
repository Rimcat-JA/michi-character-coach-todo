import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createGitHubEmulator } from '../scripts/qa-github-emulator.mjs'
const { createGitHubPublisher, inspectGitHubRepository, githubPublicationDigest, githubContentHash } = createRequire(import.meta.url)('./github-publish.cjs')
async function publication(remote) {
  const repository = await inspectGitHubRepository({ token: remote.token, owner: 'owner', name: 'repo', branch: 'main', visibility: 'public' }, remote.fetchImpl)
  const publicId = randomUUID(), prefix = `records/2026/10/${publicId}`
  const files = [{ path: prefix + '.json', kind: 'record', content: '{"points":100}\n' }, { path: prefix + '.md', kind: 'record', content: '# Synthetic 100pt\n' }, { path: 'metrics/daily-points.json', kind: 'metrics', content: '{"points":100}\n' }].map(row => ({ ...row, sha256: githubContentHash(row.content) }))
  const manifest = { version: 1, exportId: randomUUID(), publicId, ownerId: 'fixture-owner', datasetId: randomUUID(), repository, configurationId: randomUUID(), authorizationRevision: 1, completionDigest: 'a'.repeat(64), evidenceDigest: 'b'.repeat(64), policyDigest: 'c'.repeat(64), policyRevision: 1, policyEpoch: 1, sourcePermissionRevision: 0, preparedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), recordDate: '2026-10-02', files: files.map(row=>({ ...row, path: row.path.replace('2026/10/', '2026/10/') })) }
  manifest.approvalDigest = githubPublicationDigest(manifest)
  const input = { manifest, completionId: randomUUID(), attemptId: randomUUID(), approvalDigest: manifest.approvalDigest }, journal = new Map()
  const client = createGitHubPublisher({ token: remote.token, repository, fetchImpl: remote.fetchImpl, verifyAuthority: async()=>true, verifyHumanApproval: async()=>true, readAttempt: async(repo,id,sequence=0)=>journal.get(repo+':'+id+':'+sequence), writeAttempt: async(value,exclusive)=>{const key=value.repositoryId+':'+value.completionId+':'+(value.manifest.publicationSequence??0);if(exclusive&&journal.has(key))throw Error('reserved');journal.set(key,structuredClone(value))} })
  return { input, client, repository, journal }
}
test('real Git objects preserve base_tree and turn 100 points into exactly one reachable commit', async()=>{
  const remote = await createGitHubEmulator()
  try { const { input, client, repository } = await publication(remote), result = await client.publish(input,{})
    assert.equal(result.state,'published');assert.equal(remote.git(['rev-list','--count',repository.headSha+'..'+remote.head()]),'1')
    assert.equal(remote.git(['show',remote.head()+':unrelated.txt']),'Unrelated synthetic content')
    assert.match(remote.git(['show',remote.head()+':'+input.manifest.files[0].path]),/100/)
    assert.equal(result.receipt.contributionGraph,'not_verified')
  } finally { await remote.dispose() }
})
test('a response lost after the ref write reconciles without another Git commit',async()=>{
  const remote=await createGitHubEmulator()
  try { const {input,client,repository}=await publication(remote);remote.state.drop='ref'
    assert.equal((await client.publish(input,{})).state,'unknown')
    assert.ok(await client.reconcile({completionId:input.completionId,exportId:input.manifest.exportId,attemptId:input.attemptId}))
    assert.equal(remote.git(['rev-list','--count',repository.headSha+'..'+remote.head()]),'1')
  } finally { await remote.dispose() }
})
test('empty fixture uses Contents initialization and rejects a second initialization',async()=>{
  const remote=await createGitHubEmulator({empty:true})
  try { const request=async()=>fetch(remote.endpoint+'/repos/owner/repo/contents/README.md',{method:'PUT',headers:{authorization:'Bearer '+remote.token,'content-type':'application/json'},body:JSON.stringify({branch:'main',message:'Initialize achievement records',content:Buffer.from('# Synthetic init\n').toString('base64')})})
    assert.equal((await request()).status,201);assert.equal((await request()).status,409);assert.equal(remote.git(['rev-list','--count','main']),'1')
  } finally { await remote.dispose() }
})

test('protected default stays untouched; a real dedicated PR is pending until its squash merge is verified',async()=>{
 const remote=await createGitHubEmulator({protectedBranch:true})
 try{const {input,client,repository}=await publication(remote),result=await client.publish(input,{})
  assert.equal(result.state,'pr_pending');assert.equal(remote.head(),repository.headSha);assert.equal(remote.state.pulls.length,1)
  assert.equal(remote.git(['rev-list','--count',repository.headSha+'..'+result.receipt.commitSha]),'1')
  assert.equal(remote.state.requests.some(row=>row.method==='PATCH'&&row.path.endsWith('/heads/main')),false)
  remote.merge(1)
  const receipt=await client.reconcile({completionId:input.completionId,exportId:input.manifest.exportId,attemptId:input.attemptId})
  assert.equal(receipt.publicationState,'published');assert.equal(receipt.commitSha,remote.head());assert.notEqual(receipt.commitSha,result.receipt.commitSha)
  assert.equal(remote.git(['show',remote.head()+':unrelated.txt']),'Unrelated synthetic content')
 }finally{await remote.dispose()}
})
test('lost PR creation response is read reconciled, never repeated; closing it without merge cannot publish',async()=>{
 const remote=await createGitHubEmulator({protectedBranch:true})
 try{const {input,client,repository}=await publication(remote);remote.state.drop='pr'
  assert.equal((await client.publish(input,{})).state,'unknown')
  const lookup={completionId:input.completionId,exportId:input.manifest.exportId,attemptId:input.attemptId}
  assert.equal((await client.reconcile(lookup)).publicationState,'pr_pending');assert.equal(remote.state.pulls.length,1)
  remote.state.pulls[0].state='closed'
  assert.equal((await client.reconcile(lookup)).code,'PR_CLOSED_UNMERGED');assert.equal(remote.head(),repository.headSha)
  assert.equal(remote.state.requests.filter(row=>row.method==='POST'&&row.path.endsWith('/pulls')).length,1)
 }finally{await remote.dispose()}
})

test('correction sequences each add one commit to the same record; lost response recovers and cancellation retains history',async()=>{
 const remote=await createGitHubEmulator()
 try{const {input,client,repository,journal}=await publication(remote);let result=await client.publish(input,{})
  for(const [sequence,points] of [[1,80],[2,0]]){
   const manifest={...input.manifest,publicationSequence:sequence,previousCommitSha:result.receipt.commitSha,previousFileBlobShas:result.receipt.files.filter(file=>file.path.startsWith('records/')).map(file=>({path:file.path,sha:file.sha})),files:input.manifest.files.map(file=>{const content=file.content.replaceAll('100',String(points));return {...file,content,sha256:githubContentHash(content)}})}
   manifest.approvalDigest=githubPublicationDigest(manifest)
   const correction={...input,manifest,approvalDigest:manifest.approvalDigest,attemptId:randomUUID()}
   if(sequence===1)remote.state.drop='ref'
   result=await client.publish(correction,{})
   if(sequence===1){assert.equal(result.state,'unknown');result={receipt:await client.reconcile({completionId:input.completionId,exportId:manifest.exportId,attemptId:correction.attemptId,publicationSequence:sequence})}}
   assert.ok(result.receipt);assert.equal(remote.git(['rev-list','--count',repository.headSha+'..'+remote.head()]),String(sequence+1))
   assert.match(remote.git(['show',remote.head()+':'+manifest.files[0].path]),new RegExp(':'+points+'}'))
  }
  assert.equal(journal.size,3);assert.match(remote.git(['show',repository.headSha+'..main','--',input.manifest.files[0].path]),/100/)
 }finally{await remote.dispose()}
})
test('correction cannot overwrite externally changed records or invent its previous private receipt',async()=>{
 const remote=await createGitHubEmulator()
 try{const {input,client}=await publication(remote),first=await client.publish(input,{})
  const manifest={...input.manifest,publicationSequence:1,previousCommitSha:first.receipt.commitSha,previousFileBlobShas:first.receipt.files.filter(file=>file.path.startsWith('records/')).map(file=>({path:file.path,sha:file.sha}))}
  manifest.approvalDigest=githubPublicationDigest(manifest)
  await remote.externalCommit({[manifest.files[0].path]:'External record\n'})
  const writes=remote.state.requests.filter(row=>row.method!=='GET').length
  await assert.rejects(client.publish({...input,manifest,attemptId:randomUUID(),approvalDigest:manifest.approvalDigest},{}),/PREVIOUS_RECORD_CHANGED/)
  assert.equal(remote.state.requests.filter(row=>row.method!=='GET').length,writes)
  manifest.previousCommitSha='f'.repeat(40);manifest.approvalDigest=githubPublicationDigest(manifest)
  await assert.rejects(client.publish({...input,manifest,attemptId:randomUUID(),approvalDigest:manifest.approvalDigest},{}),/CORRECTION_RECEIPT_MISSING/)
 }finally{await remote.dispose()}
})

test('contribution conditions are read only: email, unavailable permission, noreply, fork, date and private settings never mean reflected',async()=>{
 const {checkGitHubContribution}=createRequire(import.meta.url)('./github-contribution.cjs')
 for(const kind of ['verified','email-mismatch','403','noreply','fork','old','private','pr']){
  const remote=await createGitHubEmulator({protectedBranch:kind==='pr'})
  try{
   if(kind==='noreply')remote.state.authorEmail='7+owner@users.noreply.github.com'
   if(kind==='old')remote.state.authorDate='2020-01-01T00:00:00Z'
   const {input,client,repository,journal}=await publication(remote);await client.publish(input,{})
   if(kind==='email-mismatch')remote.state.email='different@example.test'
   if(['403','noreply'].includes(kind))remote.state.emailPermission=false
   if(kind==='fork')remote.state.fork=true
   if(kind==='private'){remote.state.private=true;repository.visibility='private'}
   const before=remote.state.requests.filter(row=>row.method!=='GET').length,attempt=[...journal.values()][0]
   const actual=await checkGitHubContribution({configuration:{repository,token:remote.token},attempt,fetchImpl:remote.fetchImpl})
   assert.equal(actual.status,['verified','noreply'].includes(kind)?'conditions_met':['email-mismatch','fork','old'].includes(kind)?'conditions_not_met':kind==='pr'?'pr_pending':'conditions_unknown',kind)
   assert.notEqual(actual.status,'reflected');assert.equal(remote.state.requests.filter(row=>row.method!=='GET').length,before)
  }finally{await remote.dispose()}
 }
})

test('initialized empty repository can create its protected PR; removing protection midway cannot bypass it',async()=>{
 const remote=await createGitHubEmulator({empty:true})
 try{
  await fetch(remote.endpoint+'/repos/owner/repo/contents/README.md',{method:'PUT',headers:{authorization:'Bearer '+remote.token,'content-type':'application/json'},body:JSON.stringify({branch:'main',message:'Initialize',content:Buffer.from('# Initialization\n').toString('base64')})})
  remote.state.protected=true
  const fetchOriginal=remote.fetchImpl;remote.fetchImpl=async(url,options)=>{const result=await fetchOriginal(url,options);if(options.method==='POST'&&new URL(url).pathname.endsWith('/git/refs'))remote.state.protected=false;return result}
  const {input,client,repository}=await publication(remote),result=await client.publish(input,{})
  assert.equal(result.state,'pr_pending');assert.equal(remote.head(),repository.headSha);assert.equal(remote.state.pulls.length,1)
  assert.equal(remote.state.requests.some(row=>row.method==='PATCH'&&row.path.endsWith('/heads/main')),false)
 }finally{await remote.dispose()}
})
test('a dedicated-branch collision is preserved without journal or HTTP mutation',async()=>{
 const remote=await createGitHubEmulator({protectedBranch:true})
 try{const {input,client,repository,journal}=await publication(remote),branch='michi-achievements/'+input.manifest.publicId
  await fetch(remote.endpoint+'/repos/owner/repo/git/refs',{method:'POST',headers:{authorization:'Bearer '+remote.token,'content-type':'application/json'},body:JSON.stringify({ref:'refs/heads/'+branch,sha:repository.headSha})})
  const count=remote.state.requests.filter(row=>row.method!=='GET').length
  await assert.rejects(client.publish(input,{}),/PUBLIC_BRANCH_ALREADY_EXISTS/)
  assert.equal(journal.size,0);assert.equal(remote.head(branch),repository.headSha);assert.equal(remote.state.requests.filter(row=>row.method!=='GET').length,count)
 }finally{await remote.dispose()}
})
