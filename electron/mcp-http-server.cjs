const http = require('node:http')
const { createMCPCore } = require('./mcp-core.cjs')
/** Exact loopback Host only: any other Host (including domains that rebind to 127.0.0.1) is refused. */
function hostAllowed(req) {
  const host = req.headers.host
  return typeof host === 'string' && /^127\.0\.0\.1(?::\d{1,5})?$/.test(host)
}
function originAllowed(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  return typeof origin === 'string' && /^http:\/\/127\.0\.0\.1(?::\d{1,5})?$/.test(origin)
}
function readBody(req, limit = 262144) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) { reject(Object.assign(Error('BODY_TOO_LARGE'), { code: 'BODY_TOO_LARGE' })); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
const json = (res, status, value, extra = {}) => {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...extra })
  res.end(body)
}
const redirect = (res, location, query) => {
  const url = new URL(location)
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, value)
  res.writeHead(302, { location: url.toString(), 'cache-control': 'no-store' })
  res.end()
}
/** Opt-in loopback MCP over Streamable-HTTP subset (POST JSON-RPC only) with local OAuth (code + PKCE S256).
 * Same tool core as the pipe transport. Bearer tokens never reach approval or grant management:
 * no such endpoints exist here; consent resolves only through the owner's native S26 UI. */
function createMCPHttpServer({ store, getGrant, dispatch, implemented, requestConsent, now = () => Date.now(), onEvent = () => {} }) {
  const pending = new Map()
  let server = null, port = 0
  const resource = () => `http://127.0.0.1:${port}/mcp`
  const coreOf = () => createMCPCore({
    authenticate: async identity => {
      if (!identity || typeof identity.token !== 'string') return null
      const auth = await store.authenticate(identity.token, resource())
      if (!auth) return null
      const grant = await getGrant(auth.clientId)
      if (!grant || !grant.registration || grant.registration.client.id !== auth.clientId) return null
      return { clientId: auth.clientId, externalEpoch: grant.externalEpoch, revision: grant.registration.client.revision, grantEpoch: grant.registration.client.grant_epoch }
    },
    getContext: async clientId => {
      const grant = await getGrant(clientId)
      if (!grant) return { externalEnabled: false }
      return {
        registration: grant.registration, ownerId: grant.ownerId, datasetId: grant.datasetId,
        externalEnabled: grant.enabled, externalEpoch: grant.externalEpoch, active: grant.active, frozen: grant.frozen,
        policyEpoch: grant.policyEpoch, sourcePermissionRevision: grant.sourcePermissionRevision,
      }
    },
    dispatch, implemented,
  })
  async function route(req, res) {
    const at = new Date(now()).toISOString()
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (!hostAllowed(req) || !originAllowed(req)) return json(res, 403, { error: 'HOST_MISMATCH' })
      if (url.pathname === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
        return json(res, 200, { resource: resource(), authorization_servers: [`http://127.0.0.1:${port}`], bearer_methods_supported: ['header'], scopes_supported: [] })
      }
      if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
        return json(res, 200, {
          issuer: `http://127.0.0.1:${port}`, authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
          token_endpoint: `http://127.0.0.1:${port}/token`, revocation_endpoint: `http://127.0.0.1:${port}/revoke`,
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
        })
      }
      if (url.pathname === '/authorize') {
        if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' })
        const params = url.searchParams
        let parked
        try {
          const { pending: record, client } = await store.parkConsent({
            clientId: params.get('client_id') ?? '', redirectUri: params.get('redirect_uri') ?? '',
            challenge: params.get('code_challenge') ?? '', method: params.get('code_challenge_method') ?? '',
            state: params.get('state') ?? undefined,
          })
          parked = { record, client }
        } catch (error) {
          return json(res, 400, { error: error.code ?? 'INVALID_REQUEST' })
        }
        const id = parked.record.id
        pending.set(id, parked)
        onEvent({ at, kind: 'consent-requested', clientId: parked.record.clientId })
        let allow = false
        try { allow = await requestConsent(parked.record, parked.client) }
        catch { allow = false }
        finally { pending.delete(id) }
        let decided = null
        try { decided = await store.decideConsent(parked.record, allow) } catch { decided = null }
        if (!decided) return redirect(res, parked.record.redirectUri, { error: 'access_denied', state: parked.record.state ?? undefined })
        return redirect(res, parked.record.redirectUri, { code: decided.code, state: parked.record.state ?? undefined })
      }
      if (url.pathname === '/token') {
        if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' })
        if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') return json(res, 400, { error: 'invalid_request' })
        const body = new URLSearchParams(await readBody(req))
        const grantType = body.get('grant_type')
        try {
          if (grantType === 'authorization_code') {
            const result = await store.exchangeCode({
              clientId: body.get('client_id') ?? '', code: body.get('code') ?? '',
              verifier: body.get('code_verifier') ?? '', redirectUri: body.get('redirect_uri') ?? '', canonicalResource: resource(),
            })
            return json(res, 200, { access_token: result.accessRaw, token_type: 'Bearer', expires_in: result.accessExpiresIn, refresh_token: result.refreshRaw })
          }
          if (grantType === 'refresh_token') {
            const result = await store.rotateRefresh({
              clientId: body.get('client_id') ?? '', refreshRaw: body.get('refresh_token') ?? '', canonicalResource: resource(),
            })
            return json(res, 200, { access_token: result.accessRaw, token_type: 'Bearer', expires_in: result.accessExpiresIn, refresh_token: result.refreshRaw })
          }
          return json(res, 400, { error: 'unsupported_grant_type' })
        } catch (error) {
          const code = ['CODE_INVALID', 'TOKEN_INVALID', 'TOKEN_REUSED'].includes(error.code ?? '') ? 'invalid_grant' : 'invalid_request'
          return json(res, 400, { error: code })
        }
      }
      if (url.pathname === '/revoke') {
        if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' })
        const body = new URLSearchParams(await readBody(req))
        await store.revokeToken(body.get('token') ?? '')
        return json(res, 200, {})
      }
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
          return res.end()
        }
        const authorization = req.headers.authorization
        const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
        let message
        try { message = JSON.parse(await readBody(req)) } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'PARSE_ERROR' } }) }
        const invoke = async single => {
          const core = await coreOf()
          const reply = await core.handle({ token }, { jsonrpc: '2.0', id: single?.id ?? null, method: single?.method, params: single?.params })
          if (reply?.error) {
            res.setHeader('www-authenticate', `Bearer resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource"`)
            return { status: reply.error.message === 'UNAUTHENTICATED' || reply.error.message === 'WRONG_AUDIENCE' ? 401 : 403, body: reply }
          }
          return { status: 200, body: reply }
        }
        if (Array.isArray(message)) return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'BATCH_NOT_SUPPORTED' } })
        const { status, body } = await invoke(message)
        return json(res, status, body)
      }
      return json(res, 404, { error: 'NOT_FOUND' })
    } catch (error) {
      onEvent({ at, kind: 'route-error', code: error.code ?? 'ROUTE_FAILED' })
      try { return json(res, 500, { error: 'SERVER_ERROR' }) } catch { /* closed */ }
    }
  }
  return {
    resource,
    pendingConsents() { return [...pending.values()].map(row => ({ id: row.record.id, clientId: row.record.clientId, redirectUri: row.record.redirectUri, expiresAt: row.record.expiresAt })) },
    async listen() {
      if (server) return { port, url: `http://127.0.0.1:${port}` }
      server = http.createServer(route)
      await new Promise((resolve, reject) => {
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve() })
      })
      onEvent({ at: new Date(now()).toISOString(), kind: 'listening', port })
      return { port, url: `http://127.0.0.1:${port}` }
    },
    async close() {
      for (const row of pending.values()) { try { await store.decideConsent(row.record, false) } catch { /* expired */ } }
      pending.clear()
      if (!server) return
      const current = server
      server = null
      await new Promise(resolve => current.close(resolve))
    },
  }
}
module.exports = { createMCPHttpServer }
