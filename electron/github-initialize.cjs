const crypto = require('node:crypto')
const { createGitHubHTTP, inspectGitHubRepository, githubValueDigest, githubContentHash, githubBlobSha } = require('./github-publish.cjs')
const README = '# 本人が選んだ証拠付き作業実績\n\n実績を公開する前の初期化です。実績・証拠・タスク・会話は含みません。\n'
const fail = code => { const error = new Error(code); error.code = code; throw error }
function createGitHubInitializer({ configuration, readInitialization, writeInitialization, fetchImpl, verifyAuthority, now = Date.now }) {
  const proposals = new Map(), request = createGitHubHTTP({ token: configuration.token, ...configuration.repository, fetchImpl })
  const target = () => inspectGitHubRepository({ token: configuration.token, ...configuration.repository, branch: configuration.repository.defaultBranch }, fetchImpl, now)
  const key = [configuration.repository.repositoryId, configuration.id]
  const same = value => ['repositoryId','owner','name','defaultBranch','visibility'].every(key => value[key] === configuration.repository[key])
  async function active() { if (await verifyAuthority(configuration) !== true) fail('INITIALIZATION_AUTHORITY_CHANGED') }
  async function prepare() {
    await active(); const current = await target()
    if (!same(current) || !current.empty) fail('REPOSITORY_NOT_EMPTY')
    if (await readInitialization(...key)) fail('INITIALIZATION_RECONCILE_REQUIRED')
    const value = { reference: crypto.randomUUID(), repository: current, path: 'README.md', content: README, sha256: githubContentHash(README), expiresAt: new Date(now() + 300000).toISOString() }
    const digest = githubValueDigest(value); proposals.clear(); proposals.set(value.reference, { ...value, digest }); return { ...value, digest }
  }
  async function verify(journal) {
    await active(); const current = await target()
    if (!same(current) || current.empty) return null
    const file = await request('GET', '/contents/README.md?ref=' + current.headSha)
    if (file.type !== 'file' || file.path !== 'README.md' || file.sha !== githubBlobSha(journal.content, current.headSha.length === 64 ? 'sha256' : 'sha1')) fail('INITIALIZATION_CONTENT_CHANGED')
    const commit = await request('GET', '/git/commits/' + current.headSha)
    if (commit.sha !== current.headSha || commit.parents?.length !== 0) fail('INITIALIZATION_NOT_SINGLE_ROOT_COMMIT')
    await active(); await writeInitialization({ ...journal, state: 'initialized', headSha: current.headSha }, false); return current
  }
  async function initialize(input, verifyNative) {
    if (!input || Object.keys(input).length !== 2 || typeof input.reference !== 'string' || typeof input.digest !== 'string') fail('INITIALIZATION_INVALID')
    const proposal = proposals.get(input.reference); proposals.delete(input.reference)
    if (!proposal || proposal.digest !== input.digest || Date.parse(proposal.expiresAt) <= now()) fail('INITIALIZATION_PROPOSAL_EXPIRED')
    if (await verifyNative() !== true) fail('INITIALIZATION_NATIVE_REQUIRED'); await active(); const current = await target()
    if (!same(current) || !current.empty || await readInitialization(...key)) fail('INITIALIZATION_ALREADY_RESERVED')
    const journal = { version: 1, repositoryId: key[0], configurationId: key[1], ownerId: configuration.ownerId, datasetId: configuration.datasetId, digest: input.digest, content: README, state: 'reserved', headSha: null, startedAt: new Date(now()).toISOString() }
    await writeInitialization(journal, true)
    try {
      await active()
      await request('PUT', '/contents/README.md', { message: 'Initialize achievement records', content: Buffer.from(README).toString('base64'), branch: current.defaultBranch })
      const repository = await verify(journal); if (!repository) fail('INITIALIZATION_UNCONFIRMED')
      return { status: 'initialized', repository }
    } catch { await writeInitialization({ ...journal, state: 'unknown' }, false); return { status: 'unknown', repository: null } }
  }
  async function reconcile() {
    const journal = await readInitialization(...key)
    if (!journal || journal.ownerId !== configuration.ownerId || journal.datasetId !== configuration.datasetId || journal.content !== README) fail('INITIALIZATION_JOURNAL_MISSING')
    const repository = await verify(journal); return { status: repository ? 'initialized' : 'unknown', repository }
  }
  return { prepare, initialize, reconcile }
}
module.exports = { createGitHubInitializer }
