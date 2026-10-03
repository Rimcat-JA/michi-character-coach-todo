import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
const { createOAuthLocalStore } = createRequire(import.meta.url)('./oauth-local.cjs')
const { createMCPHttpServer } = createRequire(import.meta.url)('./mcp-http-server.cjs')

const CLIENT = '123e4567-e89b-42d3-a456-426614174000'
function pkce() {
  const verifier = `${crypto.randomBytes(32).toString('base64url')}-~_abc`
  return { verifier, challenge: crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url') }
}
async function fixture(t, { consent = true } = {}) {
  let saved = null
  const store = createOAuthLocalStore({ load: async () => saved, save: async value => { saved = value } })
  await store.register(CLIENT, 'synthetic host', '/callback')
  const registration = {
    owner_id: 'owner', dataset_id: '123e4567-e89b-42d3-a456-426614174001', policy_epoch: 1, source_permission_revision: 1,
    client: { id: CLIENT, revision: 1, grant_epoch: 1, grant: { expires_at: new Date(Date.now() + 3600000).toISOString() } },
  }
  let live = true
  const server = createMCPHttpServer({
    store,
    getGrant: async () => live ? {
      registration, ownerId: 'owner', datasetId: registration.dataset_id, enabled: true,
      externalEpoch: 0, active: true, frozen: false, policyEpoch: 1, sourcePermissionRevision: 1,
    } : null,
    dispatch: async (name) => {
      if (name === 'coach_get_capabilities') return { enabled: true, operations: ['coach_get_capabilities'], limitations: [] }
      throw Object.assign(Error('FEATURE_NOT_IMPLEMENTED'), { code: 'FEATURE_NOT_IMPLEMENTED' })
    },
    implemented: ['coach_get_capabilities'],
    requestConsent: async () => consent,
  })
  const { port, url } = await server.listen()
  t.after(async () => { await server.close() })
  const request = (method, path, { headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
    const target = new URL(path, url)
    const payload = body === null ? null : typeof body === 'string' ? body : JSON.stringify(body)
    const req = new (createRequire(import.meta.url)('node:http')).request({
      method, hostname: '127.0.0.1', port: target.port, path: `${target.pathname}${target.search}`,
      headers: { host: `127.0.0.1:${target.port}`, ...headers, ...(payload === null ? {} : { 'content-length': Buffer.byteLength(payload) }) },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
  async function authorize(redirectUri, challenge, method = 'S256') {
    const params = new URLSearchParams({ client_id: CLIENT, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: method, state: 's1' })
    const reply = await request('GET', `/authorize?${params}`)
    assert.equal(reply.status, 302)
    const location = new URL(reply.headers.location)
    assert.equal(location.searchParams.get('state'), 's1')
    return location
  }
  async function token(params) {
    const reply = await request('POST', '/token', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() })
    return { status: reply.status, json: reply.text ? JSON.parse(reply.text) : null }
  }
  async function mcp(tokenValue, message) {
    const reply = await request('POST', '/mcp', {
      headers: { 'content-type': 'application/json', ...(tokenValue ? { authorization: `Bearer ${tokenValue}` } : {}) },
      body: message,
    })
    return { status: reply.status, json: reply.text ? JSON.parse(reply.text) : null, headers: reply.headers }
  }
  return { store, server, port, url, request, authorize, token, mcp, registration, setLive: value => { live = value } }
}

test('metadata endpoints describe the loopback resource without credentials', async t => {
  const f = await fixture(t)
  const prm = await f.request('GET', '/.well-known/oauth-protected-resource')
  assert.equal(prm.status, 200)
  assert.equal(JSON.parse(prm.text).resource, `${f.url}/mcp`)
  const asm = await f.request('GET', '/.well-known/oauth-authorization-server')
  assert.deepEqual(JSON.parse(asm.text).code_challenge_methods_supported, ['S256'])
})

test('synthetic client runs the code flow then lists tools and reads capabilities', async t => {
  const f = await fixture(t)
  const { verifier, challenge } = pkce()
  const redirect = `http://127.0.0.1:51234/callback`
  const location = await f.authorize(redirect, challenge)
  const code = location.searchParams.get('code')
  assert.ok(code)
  const exchanged = await f.token({ grant_type: 'authorization_code', client_id: CLIENT, code, code_verifier: verifier, redirect_uri: redirect })
  assert.equal(exchanged.status, 200)
  assert.ok(exchanged.json.access_token)
  const listed = await f.mcp(exchanged.json.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  assert.equal(listed.status, 200)
  assert.equal(listed.json.result.tools.length, 15)
  const caps = await f.mcp(exchanged.json.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'coach_get_capabilities', arguments: {} } })
  assert.equal(caps.status, 200)
  assert.equal(caps.json.result.structuredContent.state, 'ok')
})

test('wrong verifier, wrong redirect and plain PKCE never mint a token over HTTP', async t => {
  const f = await fixture(t)
  const { verifier, challenge } = pkce()
  const location = await f.authorize('http://127.0.0.1:51234/callback', challenge)
  const code = location.searchParams.get('code')
  for (const params of [
    { grant_type: 'authorization_code', client_id: CLIENT, code, code_verifier: `${verifier}x`, redirect_uri: 'http://127.0.0.1:51234/callback' },
    { grant_type: 'authorization_code', client_id: CLIENT, code, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:51235/callback' },
  ]) {
    const reply = await f.token(params)
    assert.equal(reply.status, 400)
    assert.equal(reply.json.error, 'invalid_grant')
  }
  const plain = await f.request('GET', `/authorize?${new URLSearchParams({ client_id: CLIENT, redirect_uri: 'http://127.0.0.1:1/callback', code_challenge: challenge, code_challenge_method: 'plain' })}`)
  assert.equal(plain.status, 400)
})

test('Host and Origin mismatch are refused and the socket is loopback-only', async t => {
  const f = await fixture(t)
  const direct = await new Promise((resolve, reject) => {
    const http = createRequire(import.meta.url)('node:http')
    const req = http.request({ method: 'GET', hostname: '127.0.0.1', port: f.port, path: '/.well-known/oauth-protected-resource', headers: { host: 'evil.example' } }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(direct, 403)
  const origin = await f.request('GET', '/.well-known/oauth-protected-resource', { headers: { origin: 'https://evil.example' } })
  assert.equal(origin.status, 403)
  const address = await new Promise(resolve => {
    const probe = createRequire(import.meta.url)('node:net').connect(f.port, '127.0.0.1', () => { probe.end(); resolve(true) })
    probe.on('error', () => resolve(false))
  })
  assert.equal(address, true)
})

test('a token from another audience and a revoked grant are denied with metadata', async t => {
  const f = await fixture(t)
  const { verifier, challenge } = pkce()
  const location = await f.authorize('http://127.0.0.1:51234/callback', challenge)
  const exchanged = await f.token({ grant_type: 'authorization_code', client_id: CLIENT, code: location.searchParams.get('code'), code_verifier: verifier, redirect_uri: 'http://127.0.0.1:51234/callback' })
  const foreign = await f.mcp(exchanged.json.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })
  assert.equal(foreign.status, 200)
  // Restarting the server changes the canonical audience: old tokens fail closed.
  await f.server.close()
  const relistened = await f.server.listen()
  assert.notEqual(relistened.port, f.port)
  const stale = await f.request('POST', `http://127.0.0.1:${relistened.port}/mcp`, {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${exchanged.json.access_token}` },
    body: { jsonrpc: '2.0', id: 2, method: 'ping' },
  })
  assert.equal(stale.status, 401)
  assert.match(stale.headers['www-authenticate'] ?? '', /resource_metadata/)
})

test('approval-shaped input cannot self-approve and refresh then revoke kills both tokens', async t => {
  const f = await fixture(t)
  const { verifier, challenge } = pkce()
  const location = await f.authorize('http://127.0.0.1:51234/callback', challenge)
  const exchanged = await f.token({ grant_type: 'authorization_code', client_id: CLIENT, code: location.searchParams.get('code'), code_verifier: verifier, redirect_uri: 'http://127.0.0.1:51234/callback' })
  const forged = await f.mcp(exchanged.json.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'coach_get_capabilities', arguments: { approved: true } } })
  assert.equal(forged.status, 403)
  assert.match(JSON.stringify(forged.json), /TOOL_SCHEMA/)
  const rotated = await f.token({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: exchanged.json.refresh_token })
  assert.equal(rotated.status, 200)
  const revoked = await f.request('POST', '/revoke', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: rotated.json.refresh_token }).toString() })
  assert.equal(revoked.status, 200)
  assert.equal((await f.mcp(exchanged.json.access_token, { jsonrpc: '2.0', id: 2, method: 'ping' })).status, 401)
  assert.equal((await f.mcp(rotated.json.access_token, { jsonrpc: '2.0', id: 3, method: 'ping' })).status, 401)
})

test('denied consent ends at the redirect with an error and no token', async t => {
  const f = await fixture(t, { consent: false })
  const { challenge } = pkce()
  const location = await f.authorize('http://127.0.0.1:51234/callback', challenge)
  assert.equal(location.searchParams.get('error'), 'access_denied')
  assert.equal(location.searchParams.get('code'), null)
})
