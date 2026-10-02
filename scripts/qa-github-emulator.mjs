// Synthetic GitHub REST subset backed by actual Git objects. Never contacts GitHub.
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const QA_GITHUB_TOKEN = 'qa_' + 'a'.repeat(36)
const validSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const validBranch = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(value) && !value.includes('..') && !value.includes('//') && !value.endsWith('.lock')
const validPath = value => typeof value === 'string' && /^[A-Za-z0-9_./-]{1,250}$/.test(value) && !value.startsWith('/') && !value.split('/').includes('..')
const refuse = (status = 422) => { const error = new Error('synthetic fixture rejected request'); error.status = status; throw error }

export async function createGitHubEmulator({ empty = false, protectedBranch = false, owner = 'owner', name = 'repo' } = {}) {
  if (![owner, name].every(value => /^[A-Za-z0-9_-]{1,50}$/.test(value))) refuse()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'michi-github-qa-')), repository = path.join(root, 'repository.git')
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Synthetic Owner', GIT_AUTHOR_EMAIL: 'owner@example.test', GIT_COMMITTER_NAME: 'Synthetic Owner', GIT_COMMITTER_EMAIL: 'owner@example.test' }
  const git = (args, input, extraEnv) => { const output = execFileSync('git', ['--git-dir=' + repository, ...args], { input, encoding: 'utf8', env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024 }); return args[0] === 'cat-file' && args[1] === 'blob' ? output : output.trimEnd() }
  execFileSync('git', ['init', '--bare', '--initial-branch=main', repository], { stdio: 'ignore' })
  const state = { protected: protectedBranch, fork: false, emailPermission: true, email: 'owner@example.test', drop: null, conflict: false, requests: [], pulls: [] }
  const head = (branch = 'main') => { if (!validBranch(branch)) refuse(); try { return git(['rev-parse', '--verify', 'refs/heads/' + branch]) } catch { return null } }
  const blob = content => git(['hash-object', '-w', '--stdin'], content)
  const tree = async (entries, base) => {
    if (base !== undefined && !validSha(base) || !Array.isArray(entries) || entries.length > 20) refuse()
    const index = path.join(root, 'index-' + randomUUID()), indexEnv = { GIT_INDEX_FILE: index }
    try {
      git(['read-tree', ...(base ? [base] : ['--empty'])], undefined, indexEnv)
      for (const row of entries) { if (!validPath(row.path) || !validSha(row.sha) || row.mode !== '100644' || row.type !== 'blob') refuse(); git(['update-index', '--add', '--cacheinfo', '100644,' + row.sha + ',' + row.path], undefined, indexEnv) }
      return git(['write-tree'], undefined, indexEnv)
    } finally { await fs.unlink(index).catch(() => {}) }
  }
  const commit = (treeSha, parents, message) => { if (!validSha(treeSha) || !Array.isArray(parents) || parents.some(value => !validSha(value)) || parents.length > 2 || typeof message !== 'string' || message.length > 1000) refuse(); return git(['commit-tree', treeSha, ...parents.flatMap(value => ['-p', value]), '-m', message]) }
  const commitInfo = sha => { if (!validSha(sha)) refuse(); let raw; try { raw = git(['show', '--no-patch', '--format=%H%x00%T%x00%P%x00%aI%x00%ae%x00%an', sha]).split('\0') } catch { refuse(404) }; return { sha: raw[0], tree: { sha: raw[1] }, parents: raw[2] ? raw[2].split(' ').map(sha => ({ sha })) : [], author: { date: raw[3], email: raw[4], name: raw[5] } } }
  const update = (branch, sha, old = head(branch)) => { if (!validBranch(branch) || !validSha(sha)) refuse(); try { git(['update-ref', 'refs/heads/' + branch, sha, old ?? '0'.repeat(40)]) } catch { refuse(409) } }
  const contents = (file, ref) => { if (!validPath(file) || !(validSha(ref) || validBranch(ref))) refuse(); let sha; try { sha = git(['rev-parse', ref + ':' + file]); if (git(['cat-file', '-t', sha]) !== 'blob') refuse(404) } catch { refuse(404) }; const text = git(['cat-file', 'blob', sha]); return { type: 'file', path: file, sha, encoding: 'base64', content: Buffer.from(text).toString('base64') } }
  const externalCommit = async files => { const current = head(), entries = Object.entries(files).map(([file, text]) => ({ path: file, mode: '100644', type: 'blob', sha: blob(text) })), treeSha = await tree(entries, current ? commitInfo(current).tree.sha : undefined), sha = commit(treeSha, current ? [current] : [], 'Synthetic external change'); update('main', sha, current); return sha }
  if (!empty) await externalCommit({ 'unrelated.txt': 'Unrelated synthetic content\n', 'README.md': '# Synthetic repository\n' })
  const merge = number => { const pull = state.pulls.find(row => row.number === number); if (!pull || pull.state !== 'open') refuse(); const current = head(), branchSha = head(pull.head.ref), sha = commit(commitInfo(branchSha).tree.sha, [current], 'Synthetic squash merge'); update('main', sha, current); Object.assign(pull, { state: 'closed', merged: true, merge_commit_sha: sha }); return pull }
  const prefix = `/repos/${owner}/${name}`
  const refObject = branch => { const sha = head(branch); if (!sha) refuse(empty ? 409 : 404); return { ref: 'refs/heads/' + branch, object: { type: 'commit', sha } } }
  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== 'Bearer ' + QA_GITHUB_TOKEN) refuse(401)
      let raw = '', size = 0
      for await (const part of request) { size += part.length; if (size > 1024 * 1024) refuse(413); raw += part }
      const body = raw ? JSON.parse(raw) : {}, url = new URL(request.url, 'http://127.0.0.1'), method = request.method
      state.requests.push({ method, path: url.pathname })
      let value, mutation = null
      if (url.pathname === '/user' && method === 'GET') value = { id: 7, login: owner }
      else if (url.pathname === '/user/emails' && method === 'GET') { if (!state.emailPermission) refuse(403); value = [{ email: state.email, verified: true, primary: true }] }
      else if (url.pathname === '/__qa/control' && method === 'POST') {
        if (body.action === 'protect') state.protected = body.value === true
        else if (body.action === 'drop') state.drop = body.kind
        else if (body.action === 'merge') merge(body.number)
        else if (body.action === 'close') { const pull = state.pulls.find(row => row.number === body.number); if (!pull) refuse(); pull.state = 'closed' }
        else refuse()
        value = { ok: true }
      } else if (url.pathname === prefix && method === 'GET') value = { id: 123, name, owner: { id: 7, login: owner }, default_branch: 'main', visibility: 'public', private: false, fork: state.fork, size: head() ? 1 : 0, archived: false, disabled: false, permissions: { push: true } }
      else if (url.pathname.startsWith(prefix + '/')) {
        const suffix = decodeURIComponent(url.pathname.slice(prefix.length))
        if (suffix.startsWith('/branches/') && method === 'GET') { const branch = suffix.slice(10); if (!head(branch)) refuse(head() ? 404 : 409); value = { name: branch, protected: branch === 'main' && state.protected } }
        else if (suffix.startsWith('/git/ref/heads/') && method === 'GET') value = refObject(suffix.slice(15))
        else if (suffix === '/git/blobs' && method === 'POST') { if (body.encoding !== 'utf-8' || typeof body.content !== 'string' || body.content.length > 250000) refuse(); value = { sha: blob(body.content) }; mutation = 'blob' }
        else if (suffix === '/git/trees' && method === 'POST') { value = { sha: await tree(body.tree, body.base_tree) }; mutation = 'tree' }
        else if (suffix === '/git/commits' && method === 'POST') { value = commitInfo(commit(body.tree, body.parents, body.message)); mutation = 'commit' }
        else if (suffix.startsWith('/git/commits/') && method === 'GET') value = commitInfo(suffix.slice(13))
        else if (suffix === '/git/refs' && method === 'POST') { const branch = body.ref?.startsWith('refs/heads/') ? body.ref.slice(11) : ''; if (!head()) refuse(409); if (head(branch)) refuse(422); update(branch, body.sha, null); value = refObject(branch); mutation = 'branch' }
        else if (suffix.startsWith('/git/refs/heads/') && method === 'PATCH') {
          const branch = suffix.slice(16), previous = head(branch)
          if (body.force !== false || !validSha(body.sha) || !previous || branch === 'main' && state.protected) refuse(422)
          if (state.conflict) { state.conflict = false; refuse(409) }
          try { git(['merge-base', '--is-ancestor', previous, body.sha]) } catch { refuse(422) }
          update(branch, body.sha, previous); value = refObject(branch); mutation = 'ref'
        } else if (suffix.startsWith('/contents/') && method === 'GET') value = contents(suffix.slice(10), url.searchParams.get('ref') ?? 'main')
        else if (suffix === '/contents/README.md' && method === 'PUT') {
          if (head() || body.branch !== 'main' || body.sha !== undefined || typeof body.content !== 'string') refuse(409)
          const text = Buffer.from(body.content, 'base64').toString('utf8'), sha = await externalCommit({ 'README.md': text }); value = { content: contents('README.md', sha), commit: commitInfo(sha) }; mutation = 'initialize'
        } else if (suffix.startsWith('/compare/') && method === 'GET') {
          const [base, target] = suffix.slice(9).split('...'); if (!validSha(base) || !validSha(target)) refuse()
          const mergeBase = git(['merge-base', base, target]), ahead = Number(git(['rev-list', '--count', base + '..' + target])), behind = Number(git(['rev-list', '--count', target + '..' + base])); value = { base_commit: { sha: base }, head_commit: { sha: target }, merge_base_commit: { sha: mergeBase }, ahead_by: ahead, behind_by: behind, status: !ahead && !behind ? 'identical' : !behind ? 'ahead' : !ahead ? 'behind' : 'diverged' }
        } else if (suffix === '/pulls' && method === 'POST') {
          if (body.base !== 'main' || !head(body.head) || typeof body.title !== 'string') refuse()
          if (state.pulls.some(row => row.head.ref === body.head && row.state === 'open')) refuse(422)
          value = { number: state.pulls.length + 1, html_url: `https://github.com/${owner}/${name}/pull/${state.pulls.length + 1}`, state: 'open', merged: false, merge_commit_sha: null, head: { ref: body.head, sha: head(body.head) }, base: { ref: 'main' } }; state.pulls.push(value); mutation = 'pr'
        } else if (suffix === '/pulls' && method === 'GET') value = state.pulls.filter(row => (!url.searchParams.get('head') || url.searchParams.get('head') === owner + ':' + row.head.ref) && (url.searchParams.get('state') === 'all' || row.state === (url.searchParams.get('state') ?? 'open')))
        else if (/^\/pulls\/\d+$/.test(suffix) && method === 'GET') { value = state.pulls.find(row => row.number === Number(suffix.slice(7))); if (!value) refuse(404) }
        else refuse(404)
      } else refuse(404)
      if (mutation && state.drop === mutation) { state.drop = null; response.destroy(); return }
      response.writeHead(method === 'POST' || method === 'PUT' ? 201 : 200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value))
    } catch (error) { if (!response.destroyed) { response.writeHead(error.status ?? 422, { 'content-type': 'application/json' }); response.end(JSON.stringify({ message: 'Synthetic fixture rejected request' })) } }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = 'http://127.0.0.1:' + server.address().port
  const fetchImpl = async (url, init) => { const target = new URL(url); if (target.origin !== 'https://api.github.com' || target.username || target.password) refuse(); const response = await fetch(endpoint + target.pathname + target.search, { ...init, redirect: 'error' }); Object.defineProperty(response, 'url', { value: url }); return response }
  return { root, repository, endpoint, token: QA_GITHUB_TOKEN, state, git, head, externalCommit, merge, fetchImpl, close: () => new Promise(resolve => server.close(resolve)), dispose: async () => { await new Promise(resolve => server.close(resolve)); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('michi-github-qa-')) refuse(); await fs.rm(root, { recursive: true }) } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await createGitHubEmulator({ empty: process.argv.includes('--empty'), protectedBranch: process.argv.includes('--protected') })
  process.stdout.write('READY ' + JSON.stringify({ endpoint: fixture.endpoint, repository: fixture.repository, token: QA_GITHUB_TOKEN }) + '\n')
  process.on('SIGINT', async () => { await fixture.close(); process.exit(0) })
}
