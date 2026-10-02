// Dedicated branches remain dedicated even if default-branch protection changes.
const {githubBlobSha}=require('./github-publish.cjs')
const sha=value=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
function fail(code){const error=new Error(code);error.code=code;throw error}
function createGitHubPRPublisher({request,repository,writeAttempt,currentTarget,authority,unusedRecords,now=Date.now}){
 async function verifyFiles(manifest,commitSha,currentSha){const files=[];for(const file of manifest.files){const expected=githubBlobSha(file.content,commitSha.length===64?'sha256':'sha1');for(const ref of new Set([commitSha,...(file.kind==='record'||file.kind==='evidence'?[currentSha]:[])])){const actual=await request('GET',`/contents/${file.path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`);if(actual.type!=='file'||actual.path!==file.path||actual.sha!==expected)fail('PR_RECORD_MISMATCH')}files.push({path:file.path,sha:expected,sha256:file.sha256})}return files}
 async function reconcile(attempt){
  if(!sha(attempt.branchCommitSha))return null
  const target=await currentTarget(),manifest=attempt.manifest,branch=attempt.pullRequestBranch
  const matches=attempt.pullRequestNumber?[await request('GET',`/pulls/${attempt.pullRequestNumber}`)]:await request('GET',`/pulls?head=${encodeURIComponent(repository.owner+':'+branch)}&state=all&per_page=100`)
  if(!Array.isArray(matches)||matches.length!==1)return null
  const pull=matches[0]
  if(!Number.isSafeInteger(pull.number)||pull.number<1||pull.head?.ref!==branch||pull.head.sha!==attempt.branchCommitSha||pull.base?.ref!==repository.defaultBranch||!['open','closed'].includes(pull.state))fail('PR_MISMATCH')
  if(pull.state==='closed'&&pull.merged!==true){await writeAttempt({...attempt,state:'failed',receipt:null,reason:'PR_CLOSED_UNMERGED'},false);return {publicationState:'failed',code:'PR_CLOSED_UNMERGED'}}
  let commitSha=attempt.branchCommitSha,publicationState='pr_pending'
  if(pull.merged===true){
   if(pull.state!=='closed'||!sha(pull.merge_commit_sha))fail('PR_MERGE_UNCONFIRMED')
   commitSha=pull.merge_commit_sha;publicationState='published'
   if(commitSha!==target.headSha){const comparison=await request('GET',`/compare/${commitSha}...${target.headSha}?per_page=1`);if(comparison.base_commit?.sha!==commitSha||comparison.head_commit?.sha!==target.headSha||comparison.merge_base_commit?.sha!==commitSha||comparison.status!=='ahead'||comparison.behind_by!==0)fail('PR_MERGE_NOT_REACHABLE')}
  }
  const commit=await request('GET',`/git/commits/${commitSha}`)
  if(commit.sha!==commitSha||!sha(commit.tree?.sha))fail('COMMIT_MISMATCH')
  if(publicationState==='pr_pending'&&(commit.tree.sha!==attempt.treeSha||commit.parents?.length!==1||commit.parents[0].sha!==attempt.parentSha))fail('COMMIT_MISMATCH')
  const files=await verifyFiles(manifest,commitSha,publicationState==='published'?target.headSha:commitSha)
  const receipt={version:1,publicationState,exportId:manifest.exportId,attemptId:attempt.attemptId,approvalDigest:attempt.approvalDigest,repositoryId:repository.repositoryId,owner:repository.owner,name:repository.name,branch:publicationState==='published'?repository.defaultBranch:branch,visibility:repository.visibility,publicId:manifest.publicId,commitSha,headSha:target.headSha,files,verifiedAt:new Date(now()).toISOString(),contributionGraph:'not_verified',pullRequestUrl:`https://github.com/${repository.owner}/${repository.name}/pull/${pull.number}`}
  await writeAttempt({...attempt,state:publicationState,pullRequestNumber:pull.number,commitSha,treeSha:commit.tree.sha,parentSha:commit.parents?.[0]?.sha??null,receipt},false)
  return receipt
 }
 async function publish(input,target){
  const {manifest,completionId,attemptId,approvalDigest}=input,branch=`michi-achievements/${manifest.publicId}${manifest.publicationSequence?'-r'+manifest.publicationSequence:''}`
  // A colliding branch belongs to someone else; never update or force it.
  try{await request('GET',`/git/ref/heads/${encodeURIComponent(branch)}`);fail('PUBLIC_BRANCH_ALREADY_EXISTS')}catch(error){if(error.status!==404){error.beforeReservation=true;throw error}}
  try{await unusedRecords(manifest,target)}catch(error){error.beforeReservation=true;throw error}
  let attempt={version:1,repositoryId:repository.repositoryId,completionId,attemptId,approvalDigest,manifest,state:'preparing',parentSha:target.headSha,treeSha:null,commitSha:null,receipt:null,startedAt:new Date(now()).toISOString(),phase:'reserved',pullRequestBranch:branch,branchCommitSha:null,pullRequestNumber:null}
  await writeAttempt(attempt,true)
  const save=async patch=>{attempt={...attempt,...patch};await writeAttempt(attempt,false)}
  async function mutation(method,suffix,body){await authority(manifest);await currentTarget();await save({phase:suffix});await authority(manifest);return request(method,suffix,body)}
  try{
   const created=await mutation('POST','/git/refs',{ref:`refs/heads/${branch}`,sha:target.headSha});if(created.ref!==`refs/heads/${branch}`||created.object?.sha!==target.headSha)fail('REF_MISMATCH')
   const blobs=[]
   for(const file of manifest.files){const expected=githubBlobSha(file.content,target.headSha.length===64?'sha256':'sha1'),actual=await mutation('POST','/git/blobs',{content:file.content,encoding:'utf-8'});if(actual.sha!==expected)fail('BLOB_MISMATCH');blobs.push({path:file.path,mode:'100644',type:'blob',sha:expected})}
   const parent=await request('GET',`/git/commits/${target.headSha}`);if(parent.sha!==target.headSha||!sha(parent.tree?.sha))fail('PARENT_INVALID')
   const tree=await mutation('POST','/git/trees',{base_tree:parent.tree.sha,tree:blobs});if(!sha(tree.sha))fail('TREE_INVALID');await save({treeSha:tree.sha})
   const commit=await mutation('POST','/git/commits',{message:`Record achievement ${manifest.publicId}`,tree:tree.sha,parents:[target.headSha]});if(!sha(commit.sha)||commit.tree?.sha!==tree.sha||commit.parents?.length!==1||commit.parents[0].sha!==target.headSha)fail('COMMIT_MISMATCH');await save({commitSha:commit.sha,branchCommitSha:commit.sha,state:'committing'})
   const existing=await request('GET',`/git/ref/heads/${encodeURIComponent(branch)}`);if(existing.ref!==`refs/heads/${branch}`||existing.object?.sha!==target.headSha)fail('PUBLIC_BRANCH_CHANGED')
   const updated=await mutation('PATCH',`/git/refs/heads/${encodeURIComponent(branch)}`,{sha:commit.sha,force:false});if(updated.object?.sha!==commit.sha||updated.ref!==`refs/heads/${branch}`)fail('REF_MISMATCH')
   let summary='本人が承認した公開recordと正味ポイント。内部タスク・会話・証拠原本は含みません。'
   try{const record=JSON.parse(manifest.files.find(file=>file.kind==='record'&&file.path.endsWith('.json')).content);if(typeof record.title==='string'&&typeof record.summary==='string')summary+='\n\n'+(record.title+'\n\n'+record.summary).slice(0,3000).replace(/[<>&`*_[\]#\\]/g,char=>'\\'+char)}catch{/* Generic approval summary for older records. */}
   const pull=await mutation('POST','/pulls',{title:`Achievement ${manifest.publicId}`,head:branch,base:repository.defaultBranch,body:summary});if(!Number.isSafeInteger(pull.number)||pull.number<1)fail('PR_INVALID');await save({pullRequestNumber:pull.number,state:'pr_pending'})
   const receipt=await reconcile(attempt);if(!receipt)fail('PR_UNCONFIRMED');return {state:receipt.publicationState,receipt}
  }catch(error){await save({state:'unknown'}).catch(()=>{});return {state:'unknown',receipt:null,reason:attempt.phase==='/pulls'&&error.status===403?'PR_WRITE_PERMISSION_REQUIRED':typeof error.code==='string'&&/^[A-Z0-9_]{1,60}$/.test(error.code)?error.code:'PUBLICATION_UNKNOWN'}}
 }
 return {publish,reconcile}
}
module.exports={createGitHubPRPublisher}
