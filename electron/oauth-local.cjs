const crypto = require('node:crypto')
const fail = code => { throw Object.assign(Error(code), { code }) }
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
const sha = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex')
const b64url = bytes => Buffer.from(bytes).toString('base64url')
const CODE_TTL_MS = 5 * 60000, ACCESS_TTL_MS = 15 * 60000, REFRESH_TTL_MS = 24 * 3600000, CONSENT_TTL_MS = 5 * 60000

/** Loopback-only redirect: http://127.0.0.1[:port]/<path>. The port stays flexible per RFC 8252 7.3; scheme, host and path match exactly. */
function parseLoopbackRedirect(value) {
  if (typeof value !== 'string' || value.length > 2000) return null
  let url
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.hash) return null
  if (!/^\/[A-Za-z0-9._~/-]{1,200}$/.test(url.pathname) || url.pathname.includes('//')) return null
  return { href: value, path: url.pathname, port: url.port || '80' }
}
function pkceS256(verifier, challenge) {
  if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128 || !/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false
  return crypto.timingSafeEqual(Buffer.from(b64url(crypto.createHash('sha256').update(verifier, 'utf8').digest())), Buffer.from(challenge))
}

/** Preregistered clients, single-use codes and rotating bearer tokens. Secrets never leave as hashes; raw values cross only the issuing response. */
function createOAuthLocalStore({ now = () => Date.now(), random = size => crypto.randomBytes(size), load, save }) {
  const blank = () => ({ version: 1, clients: [], codes: {}, access: {}, refresh: {}, revokedFamilies: [] })
  let state = blank(), loaded = false
  async function ensure() {
    if (loaded) return
    loaded = true
    try {
      const raw = await load()
      if (raw && raw.version === 1 && Array.isArray(raw.clients)) state = { ...blank(), ...raw }
    } catch { state = blank() }
  }
  async function persist() { await save(structuredClone(state)) }
  function sweep() {
    const at = now()
    for (const [hash, code] of Object.entries(state.codes)) if (code.expiresAt <= at || code.used) delete state.codes[hash]
    for (const [hash, token] of Object.entries(state.access)) if (token.expiresAt <= at) delete state.access[hash]
    for (const [hash, token] of Object.entries(state.refresh)) if (token.expiresAt <= at) delete state.refresh[hash]
    if (state.revokedFamilies.length > 1000) state.revokedFamilies = state.revokedFamilies.slice(-1000)
  }
  function clientOf(clientId) { return state.clients.find(row => row.clientId === clientId) ?? null }
  return {
    async register(clientId, label, redirectPath = '/callback') {
      await ensure(); sweep()
      if (!uuid(clientId) || typeof label !== 'string' || !label.trim() || label.length > 120) fail('CLIENT_INVALID')
      if (!/^\/[A-Za-z0-9._~/-]{1,120}$/.test(redirectPath) || redirectPath.includes('//')) fail('REDIRECT_INVALID')
      let client = clientOf(clientId)
      if (!client) { client = { clientId, label: label.slice(0, 120), redirectPaths: [], createdAt: new Date(now()).toISOString() }; state.clients.push(client) }
      else client.label = label.slice(0, 120)
      if (!client.redirectPaths.includes(redirectPath)) client.redirectPaths.push(redirectPath)
      await persist()
      return structuredClone(client)
    },
    async unregister(clientId) {
      await ensure()
      state.clients = state.clients.filter(row => row.clientId !== clientId)
      for (const table of [state.codes, state.access, state.refresh]) for (const [hash, row] of Object.entries(table)) if (row.clientId === clientId) delete table[hash]
      await persist()
    },
    async clients() { await ensure(); return structuredClone(state.clients) },
    /** Authorize step 1: validate and park a consent request. The app resolves it through native S26 consent. */
    async parkConsent({ clientId, redirectUri, challenge, method, state: opaque }) {
      await ensure(); sweep()
      const client = clientOf(clientId)
      if (!client) fail('UNKNOWN_CLIENT')
      const redirect = parseLoopbackRedirect(redirectUri)
      if (!redirect || !client.redirectPaths.includes(redirect.path)) fail('REDIRECT_MISMATCH')
      if (method !== 'S256' || typeof challenge !== 'string' || !challenge.length || challenge.length > 512) fail('PKCE_REQUIRED')
      if (opaque !== undefined && (typeof opaque !== 'string' || !opaque.length || opaque.length > 2000)) fail('STATE_INVALID')
      const id = crypto.randomUUID()
      const pending = { id, clientId, redirectUri, challenge, state: opaque ?? null, expiresAt: now() + CONSENT_TTL_MS }
      await persist()
      return { pending, client }
    },
    /** Authorize step 2: owner decision from native consent. Allow mints one single-use code; deny records nothing. */
    async decideConsent(pending, allow) {
      await ensure()
      if (!pending || pending.expiresAt <= now()) fail('CONSENT_EXPIRED')
      if (!allow) return null
      const raw = b64url(random(32)), record = { clientId: pending.clientId, redirectUri: pending.redirectUri, challenge: pending.challenge, expiresAt: now() + CODE_TTL_MS, used: false }
      state.codes[sha(raw)] = record
      await persist()
      return { code: raw }
    },
    async exchangeCode({ clientId, code, verifier, redirectUri, canonicalResource }) {
      await ensure(); sweep()
      if (!uuid(clientId) || typeof code !== 'string' || !code.length) fail('CODE_INVALID')
      const hash = sha(code), record = state.codes[hash]
      if (!record || record.used || record.expiresAt <= now()) fail('CODE_INVALID')
      if (record.clientId !== clientId || record.redirectUri !== redirectUri || !pkceS256(verifier, record.challenge)) fail('CODE_INVALID')
      record.used = true
      const familyId = crypto.randomUUID(), at = now()
      const accessRaw = b64url(random(32)), refreshRaw = b64url(random(32))
      state.access[sha(accessRaw)] = { clientId, familyId, audience: canonicalResource, expiresAt: at + ACCESS_TTL_MS }
      state.refresh[sha(refreshRaw)] = { clientId, familyId, expiresAt: at + REFRESH_TTL_MS, replacedBy: null }
      await persist()
      return { accessRaw, refreshRaw, familyId, accessExpiresIn: Math.floor(ACCESS_TTL_MS / 1000) }
    },
    /** Refresh rotation: the presented token dies, a new pair is born. Outstanding access tokens stay
     * valid until their short expiry (standard); replaying a rotated refresh revokes its whole family. */
    async rotateRefresh({ clientId, refreshRaw, canonicalResource }) {
      await ensure(); sweep()
      if (!uuid(clientId) || typeof refreshRaw !== 'string' || !refreshRaw.length) fail('TOKEN_INVALID')
      const hash = sha(refreshRaw), record = state.refresh[hash]
      if (!record || record.clientId !== clientId) fail('TOKEN_INVALID')
      if (record.replacedBy || state.revokedFamilies.includes(record.familyId)) {
        await this.revokeFamily(record.familyId)
        fail('TOKEN_REUSED')
      }
      if (record.expiresAt <= now()) fail('TOKEN_INVALID')
      const at = now(), accessRaw = b64url(random(32)), nextRaw = b64url(random(32))
      record.replacedBy = sha(nextRaw)
      state.access[sha(accessRaw)] = { clientId, familyId: record.familyId, audience: canonicalResource, expiresAt: at + ACCESS_TTL_MS }
      state.refresh[sha(nextRaw)] = { clientId, familyId: record.familyId, expiresAt: at + REFRESH_TTL_MS, replacedBy: null }
      await persist()
      return { accessRaw, refreshRaw: nextRaw, accessExpiresIn: Math.floor(ACCESS_TTL_MS / 1000) }
    },
    async revokeFamily(familyId) {
      await ensure()
      for (const table of [state.access, state.refresh]) for (const [hash, row] of Object.entries(table)) if (row.familyId === familyId) delete table[hash]
      if (!state.revokedFamilies.includes(familyId)) state.revokedFamilies.push(familyId)
      await persist()
    },
    /** RFC 7009: presenting a refresh token revokes its family; an access token revokes itself. */
    async revokeToken(raw) {
      await ensure()
      if (typeof raw !== 'string' || !raw.length) return false
      const hash = sha(raw)
      if (state.access[hash]) { delete state.access[hash]; await persist(); return true }
      const refresh = state.refresh[hash]
      if (refresh) { await this.revokeFamily(refresh.familyId); return true }
      return false
    },
    /** Bearer check for /mcp: hash lookup, expiry, audience, then the caller's live grant re-check. */
    async authenticate(raw, canonicalResource) {
      await ensure()
      if (typeof raw !== 'string' || !raw.length) return null
      const token = state.access[sha(raw)]
      if (!token || token.expiresAt <= now() || token.audience !== canonicalResource || state.revokedFamilies.includes(token.familyId)) return null
      return { clientId: token.clientId, familyId: token.familyId }
    },
    async revokeClient(clientId) {
      await ensure()
      for (const table of [state.codes, state.access, state.refresh]) for (const [hash, row] of Object.entries(table)) if (row.clientId === clientId) delete table[hash]
      await persist()
    },
  }
}
module.exports = { createOAuthLocalStore, parseLoopbackRedirect, CODE_TTL_MS, ACCESS_TTL_MS, REFRESH_TTL_MS, CONSENT_TTL_MS }
