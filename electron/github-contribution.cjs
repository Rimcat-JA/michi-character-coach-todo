const {createGitHubHTTP}=require('./github-publish.cjs')
// REST metadata can establish conditions, never this commit's independent graph credit.
async function checkGitHubContribution({configuration,attempt,fetchImpl,now=Date.now}){
 const checkedAt=new Date(now()).toISOString(),result=(status,reasons)=>({status,reasons,checkedAt})
 if(!attempt)return result('not_published',['NO_PUBLICATION_RECEIPT'])
 if(attempt.state==='pr_pending')return result('pr_pending',['PR_NOT_MERGED'])
 if(attempt.state!=='published'||!attempt.receipt)return result('conditions_unknown',['PUBLICATION_UNCONFIRMED'])
 const repository=configuration.repository,request=createGitHubHTTP({token:configuration.token,owner:repository.owner,name:repository.name,fetchImpl}),reasons=[]
 try{
  const repo=await request('GET'),user=await request('GET','/user'),commit=await request('GET',`/git/commits/${attempt.receipt.commitSha}`)
  if(repo.id!==repository.repositoryId||repo.owner?.id!==user.id||repo.owner?.login!==user.login||repo.name!==repository.name||repo.visibility!==repository.visibility||repo.default_branch!==repository.defaultBranch||commit.sha!==attempt.receipt.commitSha||typeof repo.fork!=='boolean'||typeof repo.private!=='boolean')return result('conditions_unknown',['REPOSITORY_OR_COMMIT_CHANGED'])
  if(repo.fork)reasons.push('FORK_REPOSITORY')
  const ref=await request('GET',`/git/ref/heads/${encodeURIComponent(repo.default_branch)}`)
  if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref.object?.sha??''))return result('conditions_unknown',['DEFAULT_BRANCH_UNCONFIRMED'])
  if(ref.object.sha!==commit.sha){const compare=await request('GET',`/compare/${commit.sha}...${ref.object.sha}?per_page=1`);if(compare.base_commit?.sha!==commit.sha||compare.head_commit?.sha!==ref.object.sha||compare.merge_base_commit?.sha!==commit.sha||compare.status!=='ahead'||compare.behind_by!==0)reasons.push('NOT_ON_DEFAULT_BRANCH')}
  const date=Date.parse(commit.author?.date),email=commit.author?.email
  if(!Number.isFinite(date)||typeof email!=='string'||!email)return result('conditions_unknown',['AUTHOR_UNCONFIRMED'])
  if(date>now()||date<now()-365*86400000)reasons.push('OUTSIDE_CURRENT_GRAPH_PERIOD')
  let attributed=false,emailKnown=false
  try{const emails=await request('GET','/user/emails');if(!Array.isArray(emails)||emails.length>100)return result('conditions_unknown',['EMAILS_UNCONFIRMED']);emailKnown=true;attributed=emails.some(row=>row.verified===true&&typeof row.email==='string'&&row.email.toLowerCase()===email.toLowerCase())}catch(error){if(![403,404].includes(error.status))throw error}
  if(Number.isSafeInteger(user.id)&&typeof user.login==='string'&&[`${user.id}+${user.login}@users.noreply.github.com`].some(value=>value.toLowerCase()===email.toLowerCase()))attributed=true
  if(!attributed&&emailKnown)reasons.push('AUTHOR_EMAIL_NOT_ASSOCIATED')
  if(reasons.length)return result('conditions_not_met',reasons)
  if(!attributed)return result('conditions_unknown',['AUTHOR_EMAIL_PERMISSION_UNAVAILABLE'])
  if(repo.private)return result('conditions_unknown',['PRIVATE_GRAPH_SETTING_UNCONFIRMED'])
  return result('conditions_met',['GRAPH_REFLECTION_NOT_INDEPENDENTLY_VERIFIED'])
 }catch{return result('conditions_unknown',['READ_CHECK_UNAVAILABLE'])}
}
module.exports={checkGitHubContribution}
