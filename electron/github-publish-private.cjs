const fs=require('node:fs/promises')
const path=require('node:path')
const crypto=require('node:crypto')
const {validateGitHubPublicationManifest}=require('./github-publish.cjs')
function fail(code){const error=new Error(code);error.code=code;throw error}
async function createGitHubPrivateStore({directory,safeStorage}){
 if(!safeStorage.isEncryptionAvailable())fail('SAFE_STORAGE_UNAVAILABLE')
 await fs.mkdir(directory,{recursive:true})
 const info=await fs.lstat(directory),root=await fs.realpath(directory)
 const normalized=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value)
 if(info.isSymbolicLink()||!info.isDirectory()||normalized(root)!==normalized(directory))fail('PRIVATE_DIRECTORY_UNSAFE')
 async function boundary(){const value=await fs.lstat(directory);if(value.isSymbolicLink()||!value.isDirectory()||value.dev!==info.dev||value.ino!==info.ino||await fs.realpath(directory)!==root)fail('PRIVATE_DIRECTORY_CHANGED')}
 async function read(name,fallback){await boundary();const target=path.join(root,name);let before;try{before=await fs.lstat(target)}catch(error){if(error.code==='ENOENT')return fallback;throw error}if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>1048576)fail('PRIVATE_FILE_UNSAFE');const handle=await fs.open(target,'r');try{const opened=await handle.stat();if(opened.dev!==before.dev||opened.ino!==before.ino||opened.nlink!==1||opened.size>1048576)fail('PRIVATE_FILE_CHANGED');const bytes=await handle.readFile();await boundary();const after=await fs.lstat(target);if(after.dev!==opened.dev||after.ino!==opened.ino||after.nlink!==1||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs)fail('PRIVATE_FILE_CHANGED');try{return JSON.parse(safeStorage.decryptString(bytes))}catch{fail('PRIVATE_FILE_INVALID')}}finally{await handle.close()}}
 async function write(name,value,exclusive=false){await boundary();const target=path.join(root,name);try{const existing=await fs.lstat(target);if(!existing.isFile()||existing.isSymbolicLink()||existing.nlink!==1)fail('PRIVATE_FILE_UNSAFE');if(exclusive)fail('ATTEMPT_ALREADY_RESERVED')}catch(error){if(error.code!=='ENOENT')throw error}
 const bytes=safeStorage.encryptString(JSON.stringify(value));if(bytes.length>1048576)fail('PRIVATE_FILE_BUDGET');const temporary=exclusive?target:`${target}.${crypto.randomUUID()}.tmp`,handle=await fs.open(temporary,'wx',0o600)
 try{await handle.writeFile(bytes);await handle.sync()}catch(error){await handle.close();await fs.unlink(temporary).catch(()=>{});throw error}await handle.close();await boundary();if(!exclusive){try{const existing=await fs.lstat(target);if(!existing.isFile()||existing.isSymbolicLink()||existing.nlink!==1)fail('PRIVATE_FILE_UNSAFE')}catch(error){if(error.code!=='ENOENT'){await fs.unlink(temporary).catch(()=>{});throw error}}try{await fs.rename(temporary,target)}catch(error){await fs.unlink(temporary).catch(()=>{});throw error}}
 }
 async function present(name){await boundary();try{await fs.lstat(path.join(root,name));return true}catch(error){if(error.code==='ENOENT')return false;throw error}}
 const key=(repositoryId,completionId)=>{if(!Number.isSafeInteger(repositoryId)||repositoryId<1||typeof completionId!=='string'||!/^[a-f0-9-]{36}$/.test(completionId))fail('JOURNAL_KEY_INVALID');return `attempt-${crypto.createHash('sha256').update(`${repositoryId}:${completionId}`).digest('hex')}.bin`}
 function attempt(value,repositoryId,completionId){if(!value||value.version!==1||value.repositoryId!==repositoryId||value.completionId!==completionId||value.manifest?.repository.repositoryId!==repositoryId||value.approvalDigest!==value.manifest.approvalDigest||!['preparing','committing','published','unknown','failed','pr_pending'].includes(value.state)||!['parentSha','treeSha','commitSha'].every(field=>value[field]===null||/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value[field])))fail('JOURNAL_INVALID');validateGitHubPublicationManifest(value.manifest);if(value.state==='published'&&(!value.receipt||value.receipt.commitSha!==value.commitSha||value.receipt.approvalDigest!==value.approvalDigest||value.receipt.attemptId!==value.attemptId||value.receipt.exportId!==value.manifest.exportId))fail('JOURNAL_RECEIPT_INVALID');return value}
 return Object.freeze({
  loadConfiguration:async()=>{const revoked=await read('revoked.bin',false),configuration=await read('connection.bin',null);if(revoked===true)return {version:1,revision:configuration?.revision??0,configuration:null};return configuration},
  // A null configuration never creates connection.bin (main reads its presence as a past registration); an existing one still advances its revision.
  saveConfiguration:async value=>{if(value.configuration===null){await write('revoked.bin',true);if(!await present('connection.bin'))return}await write('connection.bin',value);if(value.configuration!==null)await write('revoked.bin',false)},
  revoke:()=>write('revoked.bin',true),
  readAttempt:async(repositoryId,completionId)=>{const value=await read(key(repositoryId,completionId),null);return value===null?null:attempt(value,repositoryId,completionId)},
  writeAttempt:async(value,exclusive)=>{attempt(value,value.repositoryId,value.completionId);await write(key(value.repositoryId,value.completionId),value,exclusive)}
 })
}
module.exports={createGitHubPrivateStore}
