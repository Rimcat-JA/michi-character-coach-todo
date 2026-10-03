// Synthetic loopback OAuth + MCP client for local QA only. Never touches real hosts.
// Usage: node scripts/synthetic-oauth-client.mjs --endpoint http://127.0.0.1:PORT --client-id <uuid> [--redirect-port PORT] [--tool NAME] [--args JSON]
import crypto from 'node:crypto'

const argv = new Map()
for (let i = 2; i < process.argv.length; i += 2) argv.set(process.argv[i], process.argv[i + 1])
const endpoint = argv.get('--endpoint') ?? ''
const clientId = argv.get('--client-id') ?? ''
const redirectPort = Number(argv.get('--redirect-port') ?? '51999')
const tool = argv.get('--tool') ?? 'coach_get_capabilities'
const toolArgs = JSON.parse(argv.get('--args') ?? '{}')
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint) || !clientId) {
  console.error('need --endpoint http://127.0.0.1:PORT and --client-id <uuid> (loopback only)')
  process.exit(2)
}
const redirectUri = `http://127.0.0.1:${redirectPort}/callback`
const verifier = `${crypto.randomBytes(32).toString('base64url')}-~_synthetic`
const challenge = crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url')

async function get(path) {
  const res = await fetch(`${endpoint}${path}`, { redirect: 'manual' })
  return { status: res.status, location: res.headers.get('location'), json: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() }
}
async function post(path, params, bearer) {
  const res = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: { 'content-type': params instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: params instanceof URLSearchParams ? params.toString() : JSON.stringify(params),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

// NOTE: the owner must approve the pending request in the app S26 consent card.
const authParams = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state: crypto.randomUUID() })
console.log(`open (waiting for owner consent in app): ${endpoint}/authorize?${authParams}`)
const authorized = await get(`/authorize?${authParams}`)
if (authorized.status !== 302 || !authorized.location) {
  console.error('authorize failed', authorized.status, JSON.stringify(authorized.json).slice(0, 300))
  process.exit(1)
}
const location = new URL(authorized.location)
if (location.searchParams.get('error')) {
  console.error('consent denied:', location.searchParams.get('error'))
  process.exit(1)
}
const code = location.searchParams.get('code')
const exchanged = await post('/token', new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri }))
if (exchanged.status !== 200) {
  console.error('token failed', exchanged.status, JSON.stringify(exchanged.json).slice(0, 300))
  process.exit(1)
}
console.log(`token ok, expires_in=${exchanged.json.expires_in}`)
const called = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: toolArgs } }, exchanged.json.access_token)
console.log(`mcp status=${called.status}`)
console.log(JSON.stringify(called.json).slice(0, 2000))
