import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createGitHubPublisher, createGitHubHTTP, inspectGitHubRepository, githubPublicationDigest, githubContentHash, githubBlobSha, validateGitHubPublicationManifest } = require('./github-publish.cjs')
const now = () => Date.parse('2026-10-01T10:00:00.000Z')
const id = () => crypto.randomUUID(), token = 'synthetic_dedicated_token_1234567890'
function fixture() {
  const repository = {repositoryId:42,owner:'tester',name:'achievements',defaultBranch:'main',visibility:'public',headSha:'1'.repeat(40),protected:false,empty:false,ownerVerified:true,canPush:true,observedAt:new Date(now()).toISOString()}
  const publicId=id(), base=`records/2026/10/${publicId}`
  const files=[{path:base+'.json',content:JSON.stringify({id:publicId,points:100})+'\n',kind:'record'},{path:base+'.md',content:'# Public synthetic achievement\n\n100pt\n',kind:'record'},{path:'metrics/daily-points.json',content:'{"values":[{"date":"2026-10-01","points":100}]}\n',kind:'metrics'}].map(file=>({...file,sha256:githubContentHash(file.content)}))
  const manifest={version:1,exportId:id(),repository,configurationId:id(),authorizationRevision:1,completionDigest:'a'.repeat(64),evidenceDigest:'b'.repeat(64),policyDigest:'c'.repeat(64),policyRevision:1,ownerId:'synthetic-owner',datasetId:id(),policyEpoch:1,sourcePermissionRevision:0,preparedAt:'2026-10-01T09:59:00.000Z',expiresAt:'2026-10-01T10:30:00.000Z',publicId,recordDate:'2026-10-01',files}
  manifest.approvalDigest=githubPublicationDigest(manifest)
  return {repository,manifest,completionId:id(),attemptId:id(),approvalDigest:manifest.approvalDigest}
}
/** In-memory Git object/ref model; no network, credentials, or live repositories. */
function fakeGit(repository) {
  const calls=[], blobs=new Map(), trees=new Map([['2'.repeat(40),new Map([['unrelated.txt',githubBlobSha('keep')]])]]), commits=new Map([[repository.headSha,{sha:repository.headSha,tree:{sha:'2'.repeat(40)},parents:[]}]]), state={head:repository.headSha,visibility:'public',protected:false,ownerId:7,canPush:true,conflicts:0,lostResponse:false,receiptTamper:false}
  let sequence=3
  const sha=()=>String(sequence++).padStart(40,'0')
  const response=(url,body,status=200)=>({status,url,headers:{get:()=>null},text:async()=>JSON.stringify(body)})
  async function fetch(url,options) {
    assert.equal(new URL(url).origin,'https://api.github.com');assert.equal(options.redirect,'error');assert.equal(options.headers['X-GitHub-Api-Version'],'2026-03-10')
    const path=new URL(url).pathname, method=options.method, body=options.body?JSON.parse(options.body):null
    calls.push({path,method,body})
    if(path==='/user')return response(url,{id:7,login:'tester'})
    const prefix='/repos/tester/achievements';assert.ok(path.startsWith(prefix));const suffix=path.slice(prefix.length)
    if(suffix==='')return response(url,{id:42,owner:{id:state.ownerId,login:'tester'},name:'achievements',default_branch:'main',visibility:state.visibility,private:state.visibility==='private',archived:false,disabled:false,permissions:{push:state.canPush}})
    if(suffix==='/branches/main')return response(url,{name:'main',protected:state.protected})
    if(suffix==='/git/ref/heads/main')return response(url,{ref:'refs/heads/main',object:{type:'commit',sha:state.head}})
    if(method==='GET'&&suffix.startsWith('/git/commits/'))return response(url,commits.get(suffix.slice('/git/commits/'.length))??{},commits.has(suffix.slice('/git/commits/'.length))?200:404)
    if(method==='POST'&&suffix==='/git/blobs'){const hash=githubBlobSha(body.content);blobs.set(hash,body.content);return response(url,{sha:hash},201)}
    if(method==='POST'&&suffix==='/git/trees'){assert.ok(trees.has(body.base_tree));const tree=new Map(trees.get(body.base_tree));for(const entry of body.tree){assert.equal(entry.mode,'100644');assert.equal(entry.type,'blob');assert.ok(blobs.has(entry.sha));tree.set(entry.path,entry.sha)}const hash=sha();trees.set(hash,tree);return response(url,{sha:hash},201)}
    if(method==='POST'&&suffix==='/git/commits'){assert.equal(body.parents.length,1);assert.ok(commits.has(body.parents[0]));assert.ok(trees.has(body.tree));assert.equal(body.author,undefined);assert.equal(body.committer,undefined);const hash=sha(),value={sha:hash,tree:{sha:body.tree},parents:body.parents.map(sha=>({sha}))};commits.set(hash,value);return response(url,value,201)}
    if(method==='PATCH'&&suffix==='/git/refs/heads/main'){assert.equal(body.force,false);if(state.conflicts){state.conflicts--;const previous=commits.get(state.head),hash=sha();commits.set(hash,{sha:hash,tree:previous.tree,parents:[{sha:state.head}]});state.head=hash;return response(url,{},409)}state.head=body.sha;if(state.lostResponse){state.lostResponse=false;throw new Error('Synthetic network disconnect after actual ref write')}return response(url,{ref:'refs/heads/main',object:{type:'commit',sha:state.head}})}
    if(method==='GET'&&suffix.startsWith('/contents/')){const commit=commits.get(new URL(url).searchParams.get('ref'));const filePath=decodeURIComponent(suffix.slice('/contents/'.length)),hash=commit&&trees.get(commit.tree.sha)?.get(filePath);return response(url,{type:'file',path:filePath,sha:state.receiptTamper?'f'.repeat(40):hash},hash?200:404)}
    if(method==='GET'&&suffix.startsWith('/compare/')){const [base,head]=suffix.slice('/compare/'.length).split('...');let cursor=head,reached=false;for(let n=0;n<100;n++){if(cursor===base){reached=true;break}cursor=commits.get(cursor)?.parents[0]?.sha;if(!cursor)break}return response(url,{base_commit:{sha:base},merge_base_commit:{sha:reached?base:'e'.repeat(40)},head_commit:{sha:head},status:reached?'ahead':'diverged',behind_by:reached?0:1})}
    throw new Error(`Unimplemented fake endpoint ${method} ${suffix}`)
  }
  return {fetch,calls,state,trees,commits,sha}
}
function publisher(input, remote, overrides={}) {
  const journal=new Map(), writes=[], proof={};let authority=true
  const readAttempt=async(repo,completion)=>structuredClone(journal.get(`${repo}:${completion}`)??null)
  const writeAttempt=async(value,exclusive)=>{const key=`${value.repositoryId}:${value.completionId}`;if(exclusive&&journal.has(key))throw new Error('Already reserved');journal.set(key,structuredClone(value));writes.push(structuredClone(value))}
  const instance=createGitHubPublisher({token,repository:input.repository,readAttempt,writeAttempt,verifyAuthority:async()=>authority,verifyHumanApproval:async(_,candidate)=>candidate===proof,fetchImpl:remote.fetch,now,...overrides})
  return {instance,proof,journal,writes,setAuthority:value=>authority=value}
}
test('100 points create one reachable commit with base_tree, preserving unrelated files and the durable reservation precedes mutation',async()=>{
  const input=fixture(),remote=fakeGit(input.repository),host=publisher(input,remote);const originalFetch=remote.fetch
  const guarded=createGitHubPublisher({token,repository:input.repository,readAttempt:async()=>host.journal.values().next().value??null,writeAttempt:async(value)=>host.journal.set('reserved',structuredClone(value)),verifyAuthority:async()=>true,verifyHumanApproval:async(_,proof)=>proof===host.proof,fetchImpl:async(url,options)=>{if(options.method!=='GET')assert.ok(host.journal.size,'private attempt exists before HTTP mutation');return originalFetch(url,options)},now})
  const result=await guarded.publish(input,host.proof)
  assert.equal(result.state,'published');assert.equal(result.receipt.contributionGraph,'not_verified');assert.equal(remote.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/git/commits')).length,1)
  assert.equal(remote.trees.get(remote.commits.get(remote.state.head).tree.sha).get('unrelated.txt'),githubBlobSha('keep'))
  assert.ok(result.receipt.files.every(file=>/^[a-f0-9]{40}$/.test(file.sha)))
})
test('fake JSON approval and changed local authority stop before any remote mutation',async()=>{
  const input=fixture(),remote=fakeGit(input.repository),host=publisher(input,remote)
  await assert.rejects(host.instance.publish(input,{approved:true}),/HUMAN_APPROVAL_REQUIRED/);host.setAuthority(false);await assert.rejects(host.instance.publish(input,host.proof),/AUTHORITY_CHANGED/)
  assert.equal(remote.calls.filter(call=>call.method!=='GET').length,0)
})
test('expiry or authority changes while metadata is read are rechecked after the durable phase and before HTTP write',async()=>{
 for(const kind of ['expiry','authority']){const input=fixture(),remote=fakeGit(input.repository),original=remote.fetch;let clock=now(),refs=0,allowed=true
  remote.fetch=async(url,options)=>{const response=await original(url,options);if(url.includes('/git/ref/heads/')&&++refs===2){if(kind==='expiry')clock=Date.parse(input.manifest.expiresAt);else allowed=false}return response}
  const host=publisher(input,remote,{now:()=>clock,verifyAuthority:async()=>allowed}),result=await host.instance.publish(input,host.proof)
  assert.equal(result.state,'unknown');assert.equal(result.reason,'AUTHORITY_CHANGED');assert.equal(remote.calls.filter(call=>call.method!=='GET').length,0);assert.equal([...host.journal.values()][0].state,'unknown');assert.equal(await host.instance.reconcile({completionId:input.completionId,exportId:input.manifest.exportId,attemptId:input.attemptId}),null)
 }
})
test('strict manifest rejects arbitrary paths, extra flags, altered content, and secrets',()=>{
  const input=fixture();validateGitHubPublicationManifest(input.manifest)
  for(const change of [m=>m.approved=true,m=>m.files[0].path='../escape',m=>m.files[0].content+='tamper',m=>{m.files[0].content='github_pat_synthetic_secret_1234567890123';m.files[0].sha256=githubContentHash(m.files[0].content)}]){const manifest=structuredClone(input.manifest);change(manifest);manifest.approvalDigest=githubPublicationDigest(manifest);assert.throws(()=>validateGitHubPublicationManifest(manifest))}
})
test('repository ownership, visibility, push permission, redirects and selected branch are verified',async()=>{
  const input=fixture(),remote=fakeGit(input.repository),params={token,owner:'tester',name:'achievements',branch:'main',visibility:'public'}
  assert.equal((await inspectGitHubRepository(params,remote.fetch,now)).repositoryId,42)
  for(const [key,value]of [['ownerId',8],['visibility','private'],['canPush',false]]){const previous=remote.state[key];remote.state[key]=value;await assert.rejects(inspectGitHubRepository(params,remote.fetch,now));remote.state[key]=previous}
  await assert.rejects(createGitHubHTTP({token,owner:'tester',name:'achievements',fetchImpl:async()=>({status:200,url:'https://evil.invalid/secret'})})('GET'),/REDIRECT_REJECTED/)
})
test('lost ref response becomes unknown, never auto-retries, and read-only reconciliation confirms persisted commit',async()=>{
  const input=fixture(),remote=fakeGit(input.repository),host=publisher(input,remote);remote.state.lostResponse=true
  const result=await host.instance.publish(input,host.proof);assert.equal(result.state,'unknown');const before=remote.calls.filter(call=>call.method!=='GET').length
  await assert.rejects(host.instance.publish(input,host.proof),/ATTEMPT_ALREADY_USED/);assert.equal(remote.calls.filter(call=>call.method!=='GET').length,before)
  const receipt=await host.instance.reconcile({completionId:input.completionId,exportId:input.manifest.exportId,attemptId:input.attemptId});assert.equal(receipt.commitSha,remote.state.head);assert.equal(remote.calls.filter(call=>call.method!=='GET').length,before)
  const repeat=await host.instance.publish(input,host.proof);assert.equal(repeat.receipt.commitSha,receipt.commitSha);assert.equal(remote.calls.filter(call=>call.method!=='GET').length,before)
})
test('unknown attempt before commit SHA remains reserved and cannot repeat mutation',async()=>{
  const input=fixture(),remote=fakeGit(input.repository),original=remote.fetch;remote.fetch=async(url,options)=>{if(options.method==='POST')throw new Error('Synthetic timeout before known response');return original(url,options)}
  const host=publisher(input,remote);assert.equal((await host.instance.publish(input,host.proof)).state,'unknown');assert.equal(await host.instance.reconcile({completionId:input.completionId,exportId:input.manifest.exportId,attemptId:input.attemptId}),null);await assert.rejects(host.instance.publish(input,host.proof),/ATTEMPT_ALREADY_USED/)
})
test('conflicts rebuild trees against newest parent and stop at five attempts without force push',async()=>{
  for(const conflicts of [2,6]){const input=fixture(),remote=fakeGit(input.repository),host=publisher(input,remote);remote.state.conflicts=conflicts;const result=await host.instance.publish(input,host.proof);assert.equal(result.state,conflicts===2?'published':'failed');assert.equal(remote.calls.filter(call=>call.method==='PATCH').length,Math.min(conflicts+1,5));const commits=remote.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/git/commits'));assert.equal(new Set(commits.map(call=>call.body.parents[0])).size,commits.length)}
})
test('protected branch metadata read failure cannot invent a PR receipt or mutate anything',async()=>{const input=fixture(),remote=fakeGit(input.repository),host=publisher(input,remote);remote.state.protected=true;await assert.rejects(host.instance.publish(input,host.proof),/HTTP_UNKNOWN/);assert.equal(remote.calls.filter(call=>call.method!=='GET').length,0);assert.equal(host.journal.size,0)})
test('an existing public record cannot be overwritten by a newly approved completion',async()=>{const input=fixture(),remote=fakeGit(input.repository),host=publisher(input,remote),tree=remote.trees.get(remote.commits.get(remote.state.head).tree.sha);tree.set(input.manifest.files[0].path,githubBlobSha('Existing independent record'));await assert.rejects(host.instance.publish(input,host.proof),/PUBLIC_RECORD_ALREADY_EXISTS/);assert.equal(remote.calls.filter(call=>call.method!=='GET').length,0);assert.equal(host.journal.size,0)})
test('a concurrent new record discovered after a ref conflict is preserved without overwrite',async()=>{const input=fixture(),remote=fakeGit(input.repository),original=remote.fetch,foreign=githubBlobSha('Independent concurrent record');remote.state.conflicts=1;remote.fetch=async(url,options)=>{const response=await original(url,options);if(options.method==='PATCH'&&response.status===409){const commit=remote.commits.get(remote.state.head),tree=remote.sha(),rows=new Map(remote.trees.get(commit.tree.sha));rows.set(input.manifest.files[0].path,foreign);remote.trees.set(tree,rows);commit.tree={sha:tree}}return response};const host=publisher(input,remote),result=await host.instance.publish(input,host.proof);assert.equal(result.state,'unknown');assert.equal(result.reason,'PUBLIC_RECORD_ALREADY_EXISTS');assert.equal(remote.calls.filter(call=>call.method==='PATCH').length,1);assert.equal(remote.trees.get(remote.commits.get(remote.state.head).tree.sha).get(input.manifest.files[0].path),foreign)})
test('mismatched record or unreachable commit fails confirmation and remains unknown',async()=>{const input=fixture(),remote=fakeGit(input.repository),host=publisher(input,remote);remote.state.receiptTamper=true;assert.equal((await host.instance.publish(input,host.proof)).state,'unknown');await assert.rejects(host.instance.reconcile({completionId:input.completionId,exportId:input.manifest.exportId,attemptId:input.attemptId}),/RECORD_MISMATCH/);remote.state.receiptTamper=false;remote.state.head=input.repository.headSha;await assert.rejects(host.instance.reconcile({completionId:input.completionId,exportId:input.manifest.exportId,attemptId:input.attemptId}),/COMMIT_NOT_REACHABLE/)})
test('later metrics changes do not hide an already reachable immutable record',async()=>{const input=fixture(),remote=fakeGit(input.repository),host=publisher(input,remote);remote.state.lostResponse=true;await host.instance.publish(input,host.proof);const parent=remote.state.head,tree=remote.sha(),head=remote.sha(),rows=new Map(remote.trees.get(remote.commits.get(parent).tree.sha));rows.set('metrics/daily-points.json','9'.repeat(40));remote.trees.set(tree,rows);remote.commits.set(head,{sha:head,tree:{sha:tree},parents:[{sha:parent}]});remote.state.head=head;const receipt=await host.instance.reconcile({completionId:input.completionId,exportId:input.manifest.exportId,attemptId:input.attemptId});assert.equal(receipt.commitSha,parent);assert.equal(receipt.headSha,head)})
