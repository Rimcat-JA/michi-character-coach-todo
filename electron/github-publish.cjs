const crypto = require('node:crypto')
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key))
const uuid = value => typeof value==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
const sha256 = value => typeof value==='string' && /^[a-f0-9]{64}$/.test(value)
const gitSha = value => typeof value==='string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
const timestamp = value => typeof value==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value
function fail(code,status) { const error=new Error(code);error.code=code;if(status)error.status=status;throw error }
function canonical(value) { if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;if(plain(value))return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;fail('INVALID_INPUT') }
const digest=value=>crypto.createHash('sha256').update(canonical(value)).digest('hex')
const contentHash=value=>crypto.createHash('sha256').update(value,'utf8').digest('hex')
const blobSha=(content,algorithm='sha1')=>{const data=Buffer.from(content,'utf8');return crypto.createHash(algorithm).update(Buffer.from(`blob ${data.length}\0`)).update(data).digest('hex')}
const label=value=>typeof value==='string'&&/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/.test(value)&&!value.includes('..')
function validBranch(value){return typeof value==='string'&&value.length<=200&&/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value)&&!value.includes('..')&&!value.includes('//')&&!value.endsWith('/')&&!value.endsWith('.')&&!value.endsWith('.lock')&&!value.split('/').some(part=>part.startsWith('.'))}
function validateRepository(value,{allowEmpty=false}={}){
  if(!exact(value,['repositoryId','owner','name','defaultBranch','visibility','headSha','protected','empty','ownerVerified','canPush','observedAt'])||!Number.isSafeInteger(value.repositoryId)||value.repositoryId<1||!label(value.owner)||!label(value.name)||!validBranch(value.defaultBranch)||!['public','private'].includes(value.visibility)||!(allowEmpty&&value.empty===true?value.headSha===null:gitSha(value.headSha)&&value.empty===false)||typeof value.protected!=='boolean'||value.ownerVerified!==true||value.canPush!==true||!timestamp(value.observedAt))fail('REPOSITORY_INVALID')
}
function validateManifest(value){
  if(!exact(value,['version','exportId','repository','configurationId','authorizationRevision','completionDigest','evidenceDigest','policyDigest','policyRevision','ownerId','datasetId','policyEpoch','sourcePermissionRevision','preparedAt','expiresAt','publicId','recordDate','files','approvalDigest'])||value.version!==1||!uuid(value.exportId)||!uuid(value.publicId)||!uuid(value.configurationId)||typeof value.ownerId!=='string'||!value.ownerId||value.ownerId.length>200||!uuid(value.datasetId)||['completionDigest','evidenceDigest','policyDigest','approvalDigest'].some(key=>!sha256(value[key]))||['policyRevision','policyEpoch','sourcePermissionRevision','authorizationRevision'].some(key=>!Number.isSafeInteger(value[key])||value[key]<0)||!timestamp(value.preparedAt)||!timestamp(value.expiresAt)||Date.parse(value.expiresAt)<=Date.parse(value.preparedAt)||Date.parse(value.expiresAt)-Date.parse(value.preparedAt)>86400000||typeof value.recordDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value.recordDate)||!Number.isFinite(Date.parse(value.recordDate))||new Date(value.recordDate).toISOString().slice(0,10)!==value.recordDate||!Array.isArray(value.files)||value.files.length<2||value.files.length>12)fail('MANIFEST_INVALID')
  if(value.approvalDigest!==publicationDigest(value))fail('DIGEST_INVALID')
  validateRepository(value.repository)
  const base=`records/${value.recordDate.slice(0,4)}/${value.recordDate.slice(5,7)}/${value.publicId}`,paths=new Set();let size=0,records=0
  for(const file of value.files){
    if(!exact(file,['path','content','sha256','kind'])||typeof file.path!=='string'||typeof file.content!=='string'||file.content.length>100000||file.content.includes('\0')||!sha256(file.sha256)||contentHash(file.content)!==file.sha256||paths.has(file.path))fail('FILE_INVALID')
    paths.add(file.path);size+=Buffer.byteLength(file.content)
    if(file.kind==='record'){if(![`${base}.md`,`${base}.json`].includes(file.path))fail('PATH_NOT_GRANTED');records++}
    else if(file.kind==='evidence'){if(!/^assets\/evidence\/[a-f0-9]{64}\.txt$/.test(file.path)||file.path!==`assets/evidence/${file.sha256}.txt`)fail('PATH_NOT_GRANTED')}
    else if(file.kind==='metrics'){if(!['metrics/daily-points.json','metrics/points-heatmap.svg'].includes(file.path))fail('PATH_NOT_GRANTED')}
    else if(file.kind==='readme'){if(file.path!=='README.md')fail('PATH_NOT_GRANTED')}
    else fail('PATH_NOT_GRANTED')
    if(/(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-(?:or-v1-)?[A-Za-z0-9_-]{12,}|-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----|\bBearer\s+\S+|X-Amz-(?:Credential|Signature|Security-Token)=|[?&](?:access_token|token|signature|sig)=|\b[A-Za-z]:[\\/]|\bfile:\/\/)/i.test(file.content))fail('SECRET_DETECTED')
    if(file.path.endsWith('.svg')&&/<(?:script|foreignObject|image|use)\b|(?:href|on\w+)\s*=|url\s*\(/i.test(file.content))fail('UNSAFE_PUBLIC_ASSET')
  }
  if(records!==2||size>250000)fail('FILE_BUDGET')
}
function publicationDigest(value){const unsigned={...value};delete unsigned.approvalDigest;return digest(unsigned)}

/** This client has one fixed HTTPS origin. URLs in responses are never followed. */
function createGitHubHTTP({token,owner,name,fetchImpl=globalThis.fetch}){
  if(typeof token!=='string'||token.length<20||token.length>1000||!/^[A-Za-z0-9_]+$/.test(token)||!label(owner)||!label(name)||typeof fetchImpl!=='function')fail('CONNECTION_INVALID')
  const prefix=`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  return async(method,suffix='',body)=>{
    const comparison=typeof suffix==='string'&&/^\/compare\/(?:[a-f0-9]{40}|[a-f0-9]{64})\.\.\.(?:[a-f0-9]{40}|[a-f0-9]{64})\?per_page=1$/.test(suffix)
    const userEndpoint=suffix==='/user'||suffix==='/user/emails'
    if(!['GET','POST','PATCH','PUT'].includes(method)||method==='PUT'&&suffix!=='/contents/README.md'||userEndpoint&&method!=='GET'||typeof suffix!=='string'||suffix.includes('://')||suffix.includes('..')&&!comparison||suffix.includes('#')||suffix.includes('\\')||!/^\/(?:user|repos\/)/.test(userEndpoint?suffix:prefix+suffix))fail('ENDPOINT_INVALID')
    const url=`https://api.github.com${userEndpoint?suffix:prefix+suffix}`
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000)
    try{
      let response
      try{response=await fetchImpl(url,{method,headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2026-03-10','User-Agent':'michi-character-coach','Content-Type':'application/json'},redirect:'error',signal:controller.signal,...(body===undefined?{}:{body:JSON.stringify(body)})})}catch{fail('HTTP_UNKNOWN')}
      if(response.url&&response.url!==url||response.status>=300&&response.status<400)fail('REDIRECT_REJECTED',response.status)
      if(!Number.isInteger(response.status)||response.status<100||response.status>599)fail('RESPONSE_INVALID')
      if(response.status<200||response.status>=300)fail(`GITHUB_${response.status}`,response.status)
      if(response.headers?.get?.('content-length')&&Number(response.headers.get('content-length'))>1024*1024)fail('RESPONSE_TOO_LARGE')
      let raw=''
      if(response.body?.getReader){const reader=response.body.getReader();let total=0;const pieces=[];try{while(true){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>1024*1024){await reader.cancel();fail('RESPONSE_TOO_LARGE')}pieces.push(Buffer.from(value))}try{raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(pieces,total))}catch{fail('RESPONSE_INVALID')}}finally{reader.releaseLock()}}
      else {raw=await response.text();if(Buffer.byteLength(raw)>1024*1024)fail('RESPONSE_TOO_LARGE')}
      try{return JSON.parse(raw)}catch{fail('RESPONSE_INVALID')}
    }finally{clearTimeout(timer)}
  }
}
async function inspectGitHubRepository({token,owner,name,branch,visibility},fetchImpl,now=Date.now){
  if(!validBranch(branch)||!['public','private'].includes(visibility))fail('CONNECTION_INVALID')
  const request=createGitHubHTTP({token,owner,name,fetchImpl}),user=await request('GET','/user'),repo=await request('GET')
  if(!plain(user)||!Number.isSafeInteger(user.id)||!label(user.login)||!plain(repo)||!Number.isSafeInteger(repo.id)||repo.owner?.id!==user.id||repo.owner?.login?.toLowerCase()!==owner.toLowerCase()||user.login.toLowerCase()!==owner.toLowerCase()||repo.name?.toLowerCase()!==name.toLowerCase()||repo.default_branch!==branch||repo.visibility!==visibility||repo.private!==(visibility==='private')||repo.archived||repo.disabled||repo.permissions?.push!==true)fail('REPOSITORY_NOT_OWNED_OR_WRITABLE')
  let detail,ref
  try{detail=await request('GET',`/branches/${encodeURIComponent(branch)}`);ref=await request('GET',`/git/ref/heads/${encodeURIComponent(branch)}`)}catch(error){
    if(repo.size!==0||![404,409].includes(error.status))throw error
    const target={repositoryId:repo.id,owner:repo.owner.login,name:repo.name,defaultBranch:branch,visibility,headSha:null,protected:false,empty:true,ownerVerified:true,canPush:true,observedAt:new Date(now()).toISOString()}
    validateRepository(target,{allowEmpty:true});return target
  }
  if(detail.name!==branch||typeof detail.protected!=='boolean'||ref.ref!==`refs/heads/${branch}`||ref.object?.type!=='commit'||!gitSha(ref.object.sha))fail('BRANCH_INVALID')
  return {repositoryId:repo.id,owner:repo.owner.login,name:repo.name,defaultBranch:branch,visibility,headSha:ref.object.sha,protected:detail.protected,empty:false,ownerVerified:true,canPush:true,observedAt:new Date(now()).toISOString()}
}

/** The private journal reserves one repository/completion before any HTTP mutation. */
function createGitHubPublisher({token,repository,readAttempt,writeAttempt,verifyAuthority,verifyHumanApproval,fetchImpl,now=Date.now}){
  validateRepository(repository)
  const request=createGitHubHTTP({token,owner:repository.owner,name:repository.name,fetchImpl}),flights=new Map()
  const sameTarget=target=>target.repositoryId===repository.repositoryId&&target.owner===repository.owner&&target.name===repository.name&&target.defaultBranch===repository.defaultBranch&&target.visibility===repository.visibility
  async function currentTarget(){const target=await inspectGitHubRepository({token,owner:repository.owner,name:repository.name,branch:repository.defaultBranch,visibility:repository.visibility},fetchImpl,now);if(!sameTarget(target))fail('REPOSITORY_CHANGED');return target}
  async function authority(manifest){if(Date.parse(manifest.expiresAt)<=now()||await verifyAuthority(manifest)!==true)fail('AUTHORITY_CHANGED')}
  async function unusedRecords(manifest,target){for(const file of manifest.files.filter(file=>file.kind==='record')){try{await request('GET',`/contents/${file.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(target.headSha)}`);fail('PUBLIC_RECORD_ALREADY_EXISTS')}catch(error){if(error.status!==404)throw error}}}
  async function reconcileAttempt(attempt){
    if(attempt?.pullRequestBranch)return prPublisher().reconcile(attempt)
    if(!attempt||!gitSha(attempt.commitSha))return null
    const manifest=attempt.manifest,target=await currentTarget(),commit=await request('GET',`/git/commits/${attempt.commitSha}`)
    if(commit.sha!==attempt.commitSha||commit.tree?.sha!==attempt.treeSha||!Array.isArray(commit.parents)||commit.parents.length!==1||commit.parents[0].sha!==attempt.parentSha)fail('COMMIT_MISMATCH')
    if(target.headSha!==attempt.commitSha){const compare=await request('GET',`/compare/${attempt.commitSha}...${target.headSha}?per_page=1`);if(compare.base_commit?.sha!==attempt.commitSha||compare.merge_base_commit?.sha!==attempt.commitSha||compare.head_commit?.sha!==target.headSha||compare.status!=='ahead'||compare.behind_by!==0)fail('COMMIT_NOT_REACHABLE')}
    const files=[]
    for(const file of manifest.files){const expected=blobSha(file.content,attempt.commitSha.length===64?'sha256':'sha1'),record=await request('GET',`/contents/${file.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(attempt.commitSha)}`);if(record.type!=='file'||record.path!==file.path||record.sha!==expected)fail('RECORD_MISMATCH');if(file.kind==='record'||file.kind==='evidence'){const current=await request('GET',`/contents/${file.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(target.headSha)}`);if(current.type!=='file'||current.path!==file.path||current.sha!==expected)fail('CURRENT_RECORD_MISMATCH')}files.push({path:file.path,sha:record.sha,sha256:file.sha256})}
    return {version:1,exportId:manifest.exportId,attemptId:attempt.attemptId,approvalDigest:attempt.approvalDigest,repositoryId:repository.repositoryId,owner:repository.owner,name:repository.name,branch:repository.defaultBranch,visibility:repository.visibility,publicId:manifest.publicId,commitSha:attempt.commitSha,headSha:target.headSha,files,verifiedAt:new Date(now()).toISOString(),contributionGraph:'not_verified'}
  }
  async function reconcile({completionId,exportId,attemptId}){
    if(!uuid(completionId)||!uuid(exportId)||!uuid(attemptId))fail('INVALID_INPUT')
    const attempt=await readAttempt(repository.repositoryId,completionId)
    if(!attempt||attempt.manifest.exportId!==exportId||attempt.attemptId!==attemptId)fail('ATTEMPT_MISSING')
    if(attempt.state==='published')return structuredClone(attempt.receipt)
    const receipt=await reconcileAttempt(attempt)
    if(receipt){if(!attempt.pullRequestBranch)await writeAttempt({...attempt,state:'published',receipt},false);return receipt}
    return null
  }
  async function publish({manifest,completionId,attemptId,approvalDigest},proof){
    validateManifest(manifest)
    if(!uuid(completionId)||!uuid(attemptId)||!sameTarget(manifest.repository)||approvalDigest!==publicationDigest(manifest))fail('PUBLICATION_INVALID')
    const key=`${repository.repositoryId}:${completionId}`
    if(flights.has(key))fail('PUBLICATION_IN_FLIGHT')
    const work=publishOnce({manifest:structuredClone(manifest),completionId,attemptId,approvalDigest},proof)
    flights.set(key,work)
    try{return await work}finally{flights.delete(key)}
  }
  async function publishOnce(input,proof){
    const {manifest,completionId,attemptId,approvalDigest}=input
    if(await verifyHumanApproval({approvalDigest,exportId:manifest.exportId,attemptId,repositoryId:repository.repositoryId,ownerId:manifest.ownerId,datasetId:manifest.datasetId},proof)!==true)fail('HUMAN_APPROVAL_REQUIRED')
    await authority(manifest)
    const prior=await readAttempt(repository.repositoryId,completionId)
    if(prior){if(prior.approvalDigest!==approvalDigest||prior.manifest.exportId!==manifest.exportId)fail('COMPLETION_ALREADY_RESERVED');if(prior.state==='published')return {state:'published',receipt:structuredClone(prior.receipt)};fail('ATTEMPT_ALREADY_USED')}
    let target=await currentTarget()
    if(target.protected)return prPublisher().publish(input,target)
    await unusedRecords(manifest,target)
    let attempt={version:1,repositoryId:repository.repositoryId,completionId,attemptId,approvalDigest,manifest,state:'preparing',parentSha:null,treeSha:null,commitSha:null,receipt:null,startedAt:new Date(now()).toISOString(),phase:'reserved'}
    await writeAttempt(attempt,true)
    const save=async patch=>{attempt={...attempt,...patch};await writeAttempt(attempt,false)}
    async function mutation(method,suffix,body){await authority(manifest);if((await currentTarget()).protected)fail('PROTECTED_BRANCH_CHANGED');await save({phase:suffix});await authority(manifest);return request(method,suffix,body)}
    try{
      const blobs=[]
      for(const file of manifest.files){const value=await mutation('POST','/git/blobs',{content:file.content,encoding:'utf-8'}),expected=blobSha(file.content,target.headSha.length===64?'sha256':'sha1');if(value.sha!==expected)fail('BLOB_MISMATCH');blobs.push({path:file.path,mode:'100644',type:'blob',sha:expected})}
      for(let conflict=0;conflict<5;conflict++){
        target=await currentTarget();await authority(manifest)
        if(target.protected){await save({state:'pr_pending'});return {state:'pr_pending',receipt:null,reason:'PROTECTED_BRANCH_REQUIRES_SEPARATE_PR'}}
        await unusedRecords(manifest,target)
        const parent=await request('GET',`/git/commits/${target.headSha}`);if(parent.sha!==target.headSha||!gitSha(parent.tree?.sha))fail('PARENT_INVALID')
        await save({parentSha:target.headSha})
        const tree=await mutation('POST','/git/trees',{base_tree:parent.tree.sha,tree:blobs});if(!gitSha(tree.sha))fail('TREE_INVALID');await save({treeSha:tree.sha})
        const commit=await mutation('POST','/git/commits',{message:`Record achievement ${manifest.publicId}`,tree:tree.sha,parents:[target.headSha]});if(!gitSha(commit.sha)||commit.tree?.sha!==tree.sha||commit.parents?.length!==1||commit.parents[0].sha!==target.headSha)fail('COMMIT_MISMATCH');await save({commitSha:commit.sha,state:'committing'})
        try{const updated=await mutation('PATCH',`/git/refs/heads/${encodeURIComponent(repository.defaultBranch)}`,{sha:commit.sha,force:false});if(updated.object?.sha!==commit.sha||updated.ref!==`refs/heads/${repository.defaultBranch}`)fail('REF_MISMATCH')}
        catch(error){
          if(![409,422].includes(error.status))throw error
          const latest=await currentTarget()
          if(latest.headSha===target.headSha){await save({state:'pr_pending'});return {state:'pr_pending',receipt:null,reason:'REF_WRITE_REQUIRES_REVIEW'}}
          if(conflict===4){await save({state:'failed'});return {state:'failed',receipt:null,reason:'CONFLICT_LIMIT'}}
          continue
        }
        const receipt=await reconcileAttempt(attempt);if(!receipt)fail('RECEIPT_UNCONFIRMED');await save({state:'published',receipt});return {state:'published',receipt}
      }
      fail('CONFLICT_LIMIT')
    }catch(error){await save({state:'unknown'}).catch(()=>{});return {state:'unknown',receipt:null,reason:typeof error.code==='string'&&/^[A-Z0-9_]{1,60}$/.test(error.code)?error.code:'PUBLICATION_UNKNOWN'}}
  }
  function prPublisher(){return require('./github-pr-publish.cjs').createGitHubPRPublisher({request,repository,writeAttempt,currentTarget,authority,unusedRecords,now})}
  return Object.freeze({publish,reconcile})
}
module.exports={createGitHubPublisher,inspectGitHubRepository,createGitHubHTTP,validateGitHubPublicationManifest:validateManifest,validateGitHubRepository:validateRepository,githubPublicationDigest:publicationDigest,githubValueDigest:digest,canonicalGitHubJSON:canonical,githubContentHash:contentHash,githubBlobSha:blobSha}
