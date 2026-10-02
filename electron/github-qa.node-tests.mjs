import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const { githubQAFetch } = createRequire(import.meta.url)('./github-qa.cjs')
test('packaged, non-literal loopback and non-QA profiles cannot activate the fixture override',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'github-guard-')),profile=path.join(root,'Codex','task','work','qa-reminders-profile');await fs.mkdir(profile,{recursive:true})
  try{const app={isPackaged:false,getPath:kind=>kind==='documents'?root:profile},fetchImpl=async()=>new Response('{}'),endpoint='http://127.0.0.1:9000'
    assert.equal(githubQAFetch({app,endpoint,fetchImpl}).enabled,true)
    assert.equal(githubQAFetch({app:{...app,isPackaged:true},endpoint,fetchImpl}).enabled,false)
    for(const value of ['http://localhost:9000','http://127.1:9000','https://127.0.0.1:9000','http://127.0.0.1:9000/path','http://127.0.0.1:9000?secret=x'])assert.equal(githubQAFetch({app,endpoint:value,fetchImpl}).enabled,false)
    assert.equal(githubQAFetch({app:{...app,getPath:()=>root},endpoint,fetchImpl}).enabled,false)
    let calls=0;const adapter=githubQAFetch({app,endpoint,fetchImpl:async url=>{calls++;assert.equal(url,'http://127.0.0.1:9000/user');return new Response('{}')}})
    for(const url of ['https://api.github.com/user','https://example.test/user'])await assert.rejects(adapter.fetchImpl(url,{headers:{Authorization:'Bearer real_secret_token'}}))
    assert.equal(calls,0);const response=await adapter.fetchImpl('https://api.github.com/user',{headers:{Authorization:'Bearer qa_'+'a'.repeat(36)}});assert.equal(response.url,'https://api.github.com/user');assert.equal(calls,1)
  }finally{assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^github-guard-/);await fs.rm(root,{recursive:true})}
})
