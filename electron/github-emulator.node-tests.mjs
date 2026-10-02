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
  const client = createGitHubPublisher({ token: remote.token, repository, fetchImpl: remote.fetchImpl, verifyAuthority: async()=>true, verifyHumanApproval: async()=>true, readAttempt: async(repo,id)=>journal.get(repo+':'+id), writeAttempt: async(value,exclusive)=>{const key=value.repositoryId+':'+value.completionId;if(exclusive&&journal.has(key))throw Error('reserved');journal.set(key,structuredClone(value))} })
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
