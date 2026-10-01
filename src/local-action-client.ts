import { db } from './db'
import { canonicalJSON, contentDigest } from './canonical'
import { changePolicyFor } from './change-set'
import { operationMode } from './automation-policy'
import { localActionReceiptKey, type LocalActionDefinition, type LocalActionDefinitionInput, type LocalActionGateway, type LocalActionInspection, type LocalActionPrepared, type LocalActionResult, type LocalActionStatus } from './local-action-types'
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype)
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))
const token=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const integer=(value:unknown,min=0)=>Number.isSafeInteger(value)&&Number(value)>=min
const text=(value:unknown,max=4000)=>typeof value==='string'&&Boolean(value.trim())&&value.length<=max
function fail(message='PC操作の対象・内容または承認を確認できません。確認画面から準備してください。'):never{throw new Error(message)}
function click(event:Event){if(!(event instanceof Event)||!event.isTrusted||event.type!=='click')fail('本人のPC操作確認ボタンから操作してください。');try{const getter=Object.getOwnPropertyDescriptor(Event.prototype,'type')?.get;if(!getter||getter.call(event)!=='click')throw new Error()}catch{fail()}}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)}return value}
export function validateLocalActionInput(value:unknown):asserts value is LocalActionDefinitionInput {
  if(!record(value)||!exact(value,['title','executable','cwd','argv','schema'])||!text(value.title,120)||!text(value.executable)||!text(value.cwd)||!Array.isArray(value.argv)||value.argv.length>64||!record(value.schema)||Object.keys(value.schema).length>16)fail('登録内容の形式が不正です。実行ファイル、固定引数、作業フォルダーを確認してください。')
  for(const [name,rule]of Object.entries(value.schema)){
    if(!token(name)||!record(rule))fail()
    if(rule.type==='string'){if(!exact(rule,['type','enum','maxLength'])||!integer(rule.maxLength,1)||Number(rule.maxLength)>300||!Array.isArray(rule.enum)||!rule.enum.length||rule.enum.length>16||new Set(rule.enum).size!==rule.enum.length||rule.enum.some(item=>!text(item,Number(rule.maxLength))||/^[\s-]|[\0\r\n;&|<>`$]/.test(item as string)))fail('文字引数は、指定した短い選択肢だけを使えます。')}
    else if(rule.type==='number'){if(!exact(rule,['type','min','max'])||!integer(rule.min)||!integer(rule.max)||Number(rule.max)>1000000||Number(rule.min)>Number(rule.max))fail()}
    else if(rule.type==='boolean'){if(!exact(rule,['type']))fail()}
    else fail('対応する引数は選択肢・範囲付き整数・真偽値です。任意コマンドやパス引数は登録できません。')
  }
  if(value.argv.some(arg=>typeof arg==='string'?arg.length>4096||/[\0\r\n]/.test(arg):!record(arg)||!exact(arg,['param'])||!token(arg.param)||!Object.hasOwn(value.schema as object,arg.param as string)))fail()
}
function definition(value:unknown):asserts value is LocalActionDefinition {
  if(!record(value)||!exact(value,['title','executable','cwd','argv','schema','id','revision','ownerId','datasetId','deviceId','executableRoot','sha256'])||!token(value.id)||!integer(value.revision,1)||!token(value.ownerId)||!token(value.datasetId)||!token(value.deviceId)||!text(value.executableRoot)||!hash(value.sha256))fail()
  validateLocalActionInput({title:value.title,executable:value.executable,cwd:value.cwd,argv:value.argv,schema:value.schema})
}
export function validateLocalActionResult(value:unknown):asserts value is LocalActionResult {
  if(!record(value)||!exact(value,['version','requestId','digest','ownerId','datasetId','deviceId','actionId','policyEpoch','sourcePermissionRevision','definitionRevision','startedAt','status','exitCode','signal','output','outputTruncated','timedOut','completedAt','signature'])||value.version!==1||!['requestId','ownerId','datasetId','deviceId','actionId'].every(key=>token(value[key]))||!hash(value.digest)||!hash(value.signature)||!['policyEpoch','sourcePermissionRevision','startedAt','completedAt'].every(key=>integer(value[key]))||!integer(value.definitionRevision,1)||Number(value.completedAt)<Number(value.startedAt)||!['succeeded','failed','timed_out','canceled','unknown'].includes(value.status as string)||value.exitCode!==null&&!Number.isInteger(value.exitCode)||value.signal!==null&&!text(value.signal,100)||typeof value.output!=='string'||new TextEncoder().encode(value.output).length>65536||typeof value.outputTruncated!=='boolean'||typeof value.timedOut!=='boolean')fail('実行結果の形式を確認できません。タスクの完了には反映していません。')
  if(value.status==='succeeded'&&(value.exitCode!==0||value.timedOut)||value.status==='timed_out'&&!value.timedOut)fail()
}
function status(value:unknown):asserts value is LocalActionStatus {
  if(!record(value)||!exact(value,['version','available','enabled','ownerId','datasetId','deviceId','definitions','results','notice'])||value.version!==1||typeof value.available!=='boolean'||typeof value.enabled!=='boolean'||!token(value.ownerId)||!token(value.datasetId)||!token(value.deviceId)||!Array.isArray(value.definitions)||value.definitions.length>20||!Array.isArray(value.results)||value.results.length>100||typeof value.notice!=='string'||value.notice.length>2000)fail()
  value.definitions.forEach(definition);value.results.forEach(validateLocalActionResult)
  if(new Set(value.definitions.map(item=>item.id)).size!==value.definitions.length||new Set(value.results.map(item=>item.requestId)).size!==value.results.length||value.definitions.some(item=>item.ownerId!==value.ownerId||item.datasetId!==value.datasetId||item.deviceId!==value.deviceId)||value.results.some(item=>item.ownerId!==value.ownerId||item.datasetId!==value.datasetId||item.deviceId!==value.deviceId))fail()
}
function inspection(value:unknown):asserts value is LocalActionInspection {
  if(!record(value)||!exact(value,['version','reference','digest','ownerId','datasetId','deviceId','policyEpoch','sourcePermissionRevision','definition','expiresAt'])||value.version!==1||!token(value.reference)||!hash(value.digest)||!['ownerId','datasetId','deviceId'].every(key=>token(value[key]))||!integer(value.policyEpoch)||!integer(value.sourcePermissionRevision)||!integer(value.expiresAt,1))fail()
  definition(value.definition)
  if(value.definition.ownerId!==value.ownerId||value.definition.datasetId!==value.datasetId||value.definition.deviceId!==value.deviceId)fail()
}
function prepared(value:unknown):asserts value is LocalActionPrepared {
  if(!record(value)||!exact(value,['version','reference','event','review'])||value.version!==1||!token(value.reference)||value.event!=='owner-click'||!record(value.review))fail()
  const review=value.review
  if(!exact(review,['requestId','digest','actionId','executable','argv','cwd','expiresAt','approvalRequired','ownerId','datasetId','deviceId','policyEpoch','sourcePermissionRevision','definitionRevision'])||!['requestId','actionId','ownerId','datasetId','deviceId'].every(key=>token(review[key]))||!hash(review.digest)||!text(review.executable)||!text(review.cwd)||!Array.isArray(review.argv)||review.argv.length>64||review.argv.some(arg=>typeof arg!=='string'||arg.length>4096||/[\0\r\n]/.test(arg))||!integer(review.expiresAt,1)||review.approvalRequired!==true||!integer(review.policyEpoch)||!integer(review.sourcePermissionRevision)||!integer(review.definitionRevision,1))fail()
}
export type LocalActionOutcome={result:LocalActionResult;receiptSaved:boolean}
/** Public objects are display data; only objects obtained through this app gateway may execute. */
export function createLocalActionController(gateway:LocalActionGateway) {
  const inspections=new Map<string,LocalActionInspection>(),requests=new Map<string,LocalActionPrepared>(),results=new Map<string,LocalActionResult>()
  let current:LocalActionStatus|null=null
  function clear(){inspections.clear();requests.clear()}
  async function assertOwner(ownerId:string,datasetId:string,deviceId:string,epoch?:number,sourceRevision?:number) {
    const settings=await db.settings.get('main'),policy=settings?changePolicyFor(settings):null
    if(!settings||settings.profileId!==ownerId||settings.datasetId!==datasetId||current&&current.deviceId!==deviceId)fail('本人・保存データまたは端末が変わりました。')
    if(epoch!==undefined&&(!settings.aiEnabled||!policy?.aiChangesEnabled||operationMode(policy!,'local_action.run')==='deny'||policy!.epoch!==epoch||policy.sourcePermissionRevision!==sourceRevision))fail('AIまたは変更の許可が変わりました。PC操作を準備し直してください。')
  }
  async function adopt(value:LocalActionStatus) {
    status(value);await assertOwner(value.ownerId,value.datasetId,value.deviceId)
    if(current&&canonicalJSON({definitions:current.definitions,enabled:current.enabled})!==canonicalJSON({definitions:value.definitions,enabled:value.enabled}))clear()
    current=freeze(structuredClone(value));for(const result of current.results)results.set(result.requestId,result)
    return current
  }
  async function persist(result:LocalActionResult):Promise<LocalActionOutcome> {
    try{
      if(results.get(result.requestId)!==result)fail()
      validateLocalActionResult(result);await assertOwner(result.ownerId,result.datasetId,result.deviceId)
      await db.transaction('rw',db.settings,db.commands,db.audits,async()=>{
        await assertOwner(result.ownerId,result.datasetId,result.deviceId)
        const key=localActionReceiptKey(result.requestId),prior=await db.commands.get(key),at=new Date(result.completedAt).toISOString()
        if(prior){if(prior.hash!==result.digest||canonicalJSON(JSON.parse(prior.resultId))!==canonicalJSON(result))fail('保存済み実行結果と一致しません。');return}
        await db.commands.add({key,hash:result.digest,resultId:JSON.stringify(result),at})
        await db.audits.add({id:`localaction:${result.requestId}`,taskId:null,operation:'localaction.result',at,detail:JSON.stringify({requestId:result.requestId,actionId:result.actionId,digest:result.digest,ownerId:result.ownerId,datasetId:result.datasetId,deviceId:result.deviceId,policyEpoch:result.policyEpoch,sourcePermissionRevision:result.sourcePermissionRevision,definitionRevision:result.definitionRevision,status:result.status,exitCode:result.exitCode,outputTruncated:result.outputTruncated})})
      })
      await gateway.recordReceipt({requestId:result.requestId,digest:result.digest})
      return {result,receiptSaved:true}
    }catch{return {result,receiptSaved:false}}
  }
  return {
    clearAuthority:clear,
    refresh:async()=>adopt(await gateway.status()),
    async inspectFromUI(input:LocalActionDefinitionInput,event:Event) {
      click(event);validateLocalActionInput(input)
      const raw=await gateway.inspectDefinition(structuredClone(input));inspection(raw)
      const {digest,...payload}=raw
      if(digest!==await contentDigest(payload)||raw.expiresAt<=Date.now())fail()
      await assertOwner(raw.ownerId,raw.datasetId,raw.deviceId,raw.policyEpoch,raw.sourcePermissionRevision)
      const value=freeze(structuredClone(raw));inspections.set(value.reference,value);return value
    },
    async configureFromUI(value:LocalActionInspection,event:Event) {
      click(event)
      if(inspections.get(value.reference)!==value||value.expiresAt<=Date.now())fail()
      await assertOwner(value.ownerId,value.datasetId,value.deviceId,value.policyEpoch,value.sourcePermissionRevision)
      return adopt(await gateway.configure({reference:value.reference,digest:value.digest}))
    },
    async removeFromUI(actionId:string,event:Event){click(event);if(!current?.definitions.some(def=>def.id===actionId))fail();return adopt(await gateway.remove({actionId}))},
    async prepare(actionId:string,params:Record<string,string|number|boolean>) {
      const def=current?.definitions.find(item=>item.id===actionId)
      if(!def||!current?.enabled)fail('登録したPC操作を選んでください。')
      const raw=await gateway.prepare({actionId,event:'owner-click',params:structuredClone(params)});prepared(raw)
      if(raw.review.actionId!==def.id||raw.review.definitionRevision!==def.revision||raw.review.executable!==def.executable||raw.review.cwd!==def.cwd||raw.review.expiresAt<=Date.now()||raw.review.expiresAt>Date.now()+60000)fail()
      const expected=def.argv.map(arg=>typeof arg==='string'?arg:String(params[arg.param]))
      if(canonicalJSON(expected)!==canonicalJSON(raw.review.argv))fail()
      await assertOwner(raw.review.ownerId,raw.review.datasetId,raw.review.deviceId,raw.review.policyEpoch,raw.review.sourcePermissionRevision)
      const value=freeze(structuredClone(raw));requests.set(value.reference,value);return value
    },
    async executeFromUI(value:LocalActionPrepared,event:Event):Promise<LocalActionOutcome> {
      click(event)
      if(requests.get(value.reference)!==value||value.review.expiresAt<=Date.now())fail('PC操作の確認期限が切れたか、内容が変わりました。準備し直してください。')
      const review=value.review
      await assertOwner(review.ownerId,review.datasetId,review.deviceId,review.policyEpoch,review.sourcePermissionRevision)
      const raw=await gateway.execute({reference:value.reference,digest:review.digest});validateLocalActionResult(raw)
      if(raw.requestId!==review.requestId||raw.digest!==review.digest||raw.actionId!==review.actionId||raw.ownerId!==review.ownerId||raw.datasetId!==review.datasetId||raw.deviceId!==review.deviceId||raw.policyEpoch!==review.policyEpoch||raw.sourcePermissionRevision!==review.sourcePermissionRevision||raw.definitionRevision!==review.definitionRevision)fail('PC操作の実行結果が確認内容と一致しません。タスクには反映していません。')
      const result=freeze(structuredClone(raw));results.set(result.requestId,result)
      return persist(result)
    },
    async retryReceiptFromUI(result:LocalActionResult,event:Event){click(event);if(results.get(result.requestId)!==result)fail();return persist(result)}
  }
}
export type LocalActionController=ReturnType<typeof createLocalActionController>
