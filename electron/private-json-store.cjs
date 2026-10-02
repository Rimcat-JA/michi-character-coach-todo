const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto')
async function createPrivateJSONStore({ directory, safeStorage, maxBytes = 4 * 1024 * 1024 }) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('PRIVATE_STORAGE_UNAVAILABLE')
  await fs.mkdir(directory, { recursive: true })
  const root = await fs.realpath(directory), identity = await fs.lstat(directory)
  if (identity.isSymbolicLink() || !identity.isDirectory() || path.resolve(root).toLowerCase() !== path.resolve(directory).toLowerCase()) throw new Error('PRIVATE_PATH_UNSAFE')
  let queue = Promise.resolve()
  async function boundary() { const s = await fs.lstat(directory);if(s.isSymbolicLink()||s.dev!==identity.dev||s.ino!==identity.ino||await fs.realpath(directory)!==root)throw new Error('PRIVATE_PATH_CHANGED') }
  function target(name) { if(!/^[a-z0-9.-]{1,150}$/i.test(name)||name==='.'||name==='..')throw new Error('PRIVATE_NAME_INVALID');return path.join(root,name) }
  async function inspect(file) { await boundary();try{const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>maxBytes)throw new Error('PRIVATE_FILE_UNSAFE');return s}catch(e){if(e.code==='ENOENT')return null;throw e} }
  async function load(name, fallback = null) { await queue;const file=target(name),before=await inspect(file);if(!before)return structuredClone(fallback);const fd=await fs.open(file,'r');try{const s=await fd.stat();if(s.dev!==before.dev||s.ino!==before.ino||s.nlink!==1||s.size>maxBytes)throw new Error('PRIVATE_FILE_CHANGED');const bytes=await fd.readFile(),after=await inspect(file);if(!after||after.dev!==s.dev||after.ino!==s.ino||after.size!==s.size||after.mtimeMs!==s.mtimeMs)throw new Error('PRIVATE_FILE_CHANGED');return JSON.parse(safeStorage.decryptString(bytes))}finally{await fd.close()} }
  function save(name,value,exclusive=false) { const operation=queue.then(async()=>{const file=target(name);await inspect(file);const bytes=safeStorage.encryptString(JSON.stringify(value));if(bytes.length>maxBytes)throw new Error('PRIVATE_STORAGE_LIMIT');const temp=exclusive?file:file+'.'+crypto.randomUUID()+'.tmp',fd=await fs.open(temp,'wx',0o600);try{await fd.writeFile(bytes);await fd.sync()}finally{await fd.close()}if(!exclusive)try{await inspect(file);await fs.rename(temp,file)}catch(e){await fs.unlink(temp).catch(()=>{});throw e} });queue=operation.catch(()=>{});return operation }
  async function list() { await queue;await boundary();return (await fs.readdir(root)).filter(name=>/^[a-z0-9.-]{1,150}$/i.test(name)) }
  return { load, save, list }
}
module.exports = { createPrivateJSONStore }
