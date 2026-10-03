const crypto=require('node:crypto')
const {canonicalFileJSON}=require('./local-file-bridge.cjs')
const {createMCPFileClient}=require('./mcp-file-client.cjs')
const fail=code=>{throw Object.assign(Error(code),{code})}
const sha=value=>crypto.createHash('sha256').update(canonicalFileJSON(value)).digest('hex')
const bound=c=>({registration:c.registration,ownerId:c.ownerId,datasetId:c.datasetId,externalEpoch:c.externalEpoch,policyEpoch:c.policyEpoch,sourcePermissionRevision:c.sourcePermissionRevision})
/** Catalog writes enter the existing signed inbox. This module never applies tasks or issues approvals. */
function createAppChangeDispatcher({getHub,readDB,dispatch}){
 const queues=new Map()
 async function serial(client,action){
  let queue=queues.get(client);if(!queue){queue={tail:Promise.resolve(),count:0};queues.set(client,queue)}
  if(queue.count>=32)fail('TOO_MANY_PROPOSALS');queue.count++
  const previous=queue.tail;let release;queue.tail=new Promise(resolve=>{release=resolve});await previous
  try{return await action()}finally{queue.count--;release();if(!queue.count)queues.delete(client)}
 }
 async function planFor(id,context){
  const client=context.registration.client.id,row=await readDB('commands',`externalplan:${client}:${id}`)
  if(!row)fail('NOT_FOUND')
  let plan;try{plan=JSON.parse(row.resultId)}catch{fail('PLAN_INVALID')}
  if(!plan||Object.keys(plan).length!==7||plan.version!==1||plan.id!==id||row.hash!==sha(plan)||canonicalFileJSON(plan.context)!==canonicalFileJSON(bound(context)))fail('PLAN_INVALID')
  const {externalCommandEnvelope}=await import('./external-command-envelope.mjs')
  const envelope=externalCommandEnvelope(plan.request,plan.id)
  if(plan.request.basis.kind!=='external_request')fail('UNVERIFIED_REFERENCE')
  if(!context.registration.client.grant.keys.includes('tasks:prepare')||!context.registration.client.grant.keys.includes('changes:submit')||Object.keys(envelope.payload).some(field=>!context.registration.client.grant.fields.includes(field)))fail('INSUFFICIENT_SCOPE')
  if(envelope.target_id&&!context.registration.task_ids.includes(envelope.target_id))fail('NOT_FOUND')
  return {plan,row,envelope}
 }
 async function actualResult(id,context){
  const client=context.registration.client.id,result=await(await getHub()).commandResult({clientId:client,commandId:id})
  if(!result)return null
  if(result.state!=='applied')fail(result.code??(result.state==='unknown'?'OUTCOME_UNKNOWN':'COMMAND_FAILED'))
  const stored=await readDB('commands',`filebridge:applied:${client}:${id}`)
  let receipt;try{receipt=JSON.parse(stored?.resultId)}catch{fail('RECEIPT_MISSING')}
  const reg=context.registration
  if(!receipt||receipt.version!==1||receipt.commandId!==id||receipt.clientId!==client||receipt.ownerId!==context.ownerId||receipt.datasetId!==context.datasetId||receipt.policyEpoch!==context.policyEpoch||receipt.sourcePermissionRevision!==context.sourcePermissionRevision||receipt.registrationRevision!==reg.client.revision||receipt.grantEpoch!==reg.client.grant_epoch||receipt.fileDigest!==result.digest||stored.hash!==receipt.applicationDigest||stored.at!==receipt.appliedAt||canonicalFileJSON(receipt.taskIds)!==canonicalFileJSON(result.receipt?.taskIds)||receipt.appliedAt!==result.receipt?.appliedAt)fail('RECEIPT_MISSING')
  return result
 }
 return async function dispatchAppChange(name,args,context){
  if(name==='coach_get_command_result'){
   if(!context.registration.client.grant.keys.includes('commands:read'))fail('INSUFFICIENT_SCOPE')
   const {plan}=await planFor(args.command_id,context),result=await actualResult(plan.id,context)
   if(!result&&Date.parse(plan.expiresAt)<=Date.now())fail('PLAN_EXPIRED')
   return {command_id:plan.id,state:result?'applied':'awaiting_approval',replayed:Boolean(result),change_set_id:plan.id,summary:result?'共通コマンドバスの保存記録と署名結果を確認しました。完了や実績の付与は行いません。':'アプリのローカル接続の受信箱で本人が確認します。'}
  }
  if(name!=='coach_prepare_change'&&name!=='coach_submit_change')return dispatch(name,args,context)
  return serial(context.registration.client.id,async()=>{
   const data=await dispatch(name,args,context),{plan,row,envelope}=await planFor(data.change_set_id,context)
   if(data.digest!==row.hash||data.command_id!==plan.id||name==='coach_submit_change'&&(args.change_set_id!==plan.id||args.digest!==row.hash)||name==='coach_prepare_change'&&canonicalFileJSON(args)!==canonicalFileJSON(plan.request))fail('PLAN_INVALID')
   if(name==='coach_prepare_change')return data
   const result=await actualResult(plan.id,context);if(result)return {...data,state:'applied'}
   if(Date.parse(plan.expiresAt)<=Date.now())fail('PLAN_EXPIRED')
   const status=await(await getHub()).clientStatus({clientId:context.registration.client.id})
   if(!status.connected||!status.snapshot||canonicalFileJSON(status.registration)!==canonicalFileJSON(context.registration))fail('SNAPSHOT_REQUIRED')
   const client=await createMCPFileClient(status.root),input={commandId:plan.id,snapshotId:status.snapshot.snapshot_id,payload:envelope.payload}
   if(envelope.type==='task.create')await client.proposeCreate(input)
   else await client.proposeUpdate({...input,targetId:envelope.target_id,expectedRevision:envelope.expected_revision})
   if(context.registration.client.grant.mutation_mode==='auto_within_bounds'){
    const processed=await dispatch('michi_process_catalog_submission',{commandId:plan.id,clientId:context.registration.client.id},context)
    if(await actualResult(plan.id,context))return {...data,state:'applied'}
    if(processed?.state==='unknown')fail('OUTCOME_UNKNOWN')
   }
   return data
  })
 }
}
module.exports={createAppChangeDispatcher}
