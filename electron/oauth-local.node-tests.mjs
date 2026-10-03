import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
const { createOAuthLocalStore } = createRequire(import.meta.url)('./oauth-local.cjs')

const AUD = 'http://127.0.0.1:39331/mcp'
const CLIENT = '123e4567-e89b-42d3-a456-426614174000'
function store() {
  let saved = null
  return createOAuthLocalStore({ load: async () => saved, save: async value => { saved = value } })
}
function pkce() {
  const verifier = `${crypto.randomBytes(32).toString('base64url')}-~_abc`
  const challenge = crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url')
  return { verifier, challenge }
}
async function consented(s, redirect = 'http://127.0.0.1:51011/callback') {
  await s.register(CLIENT, 'synthetic host', '/callback')
  const { verifier, challenge } = pkce()
  const { pending } = await s.parkConsent({ clientId: CLIENT, redirectUri: redirect, challenge, method: 'S256', state: 'xyz' })
  const decided = await s.decideConsent(pending, true, AUD)
  assert.ok(decided.code)
  return { verifier, code: decided.code, redirect }
}

test('wrong verifier, wrong redirect and plain PKCE never mint a token', async () => {
  const s = store()
  await s.register(CLIENT, 'synthetic host', '/callback')
  const { verifier, challenge } = pkce()
  await assert.rejects(s.parkConsent({ clientId: CLIENT, redirectUri: 'http://127.0.0.1:1/callback', challenge, method: 'plain' }), /PKCE_REQUIRED/)
  await assert.rejects(s.parkConsent({ clientId: CLIENT, redirectUri: 'https://evil.example/callback', challenge, method: 'S256' }), /REDIRECT_MISMATCH/)
  await assert.rejects(s.parkConsent({ clientId: CLIENT, redirectUri: 'http://127.0.0.1:1/other', challenge, method: 'S256' }), /REDIRECT_MISMATCH/)
  const { pending } = await s.parkConsent({ clientId: CLIENT, redirectUri: 'http://127.0.0.1:1/callback', challenge, method: 'S256' })
  const { code } = await s.decideConsent(pending, true, AUD)
  await assert.rejects(s.exchangeCode({ clientId: CLIENT, code, verifier: `${verifier}x`, redirectUri: 'http://127.0.0.1:1/callback', canonicalResource: AUD }), /CODE_INVALID/)
  await assert.rejects(s.exchangeCode({ clientId: CLIENT, code, verifier, redirectUri: 'http://127.0.0.1:2/callback', canonicalResource: AUD }), /CODE_INVALID/)
})

test('single-use codes and refresh rotation with reuse family revoke', async () => {
  const s = store()
  const { verifier, code, redirect } = await consented(s)
  const first = await s.exchangeCode({ clientId: CLIENT, code, verifier, redirectUri: redirect, canonicalResource: AUD })
  await assert.rejects(s.exchangeCode({ clientId: CLIENT, code, verifier, redirectUri: redirect, canonicalResource: AUD }), /CODE_INVALID/)
  assert.ok((await s.authenticate(first.accessRaw, AUD)).clientId === CLIENT)
  const rotated = await s.rotateRefresh({ clientId: CLIENT, refreshRaw: first.refreshRaw, canonicalResource: AUD })
  // Outstanding access tokens stay valid until expiry (standard); rotation only replaces the refresh chain.
  assert.ok((await s.authenticate(first.accessRaw, AUD)).clientId === CLIENT)
  assert.ok((await s.authenticate(rotated.accessRaw, AUD)).clientId === CLIENT)
  await assert.rejects(s.rotateRefresh({ clientId: CLIENT, refreshRaw: first.refreshRaw, canonicalResource: AUD }), /TOKEN_REUSED/)
  // Reuse revokes the whole family, including still-valid access tokens.
  assert.equal((await s.authenticate(first.accessRaw, AUD)), null)
  assert.equal((await s.authenticate(rotated.accessRaw, AUD)), null)
})

test('audience mismatch never authenticates and revoke kills old and new tokens', async () => {
  const s = store()
  const { verifier, code, redirect } = await consented(s)
  const pair = await s.exchangeCode({ clientId: CLIENT, code, verifier, redirectUri: redirect, canonicalResource: AUD })
  assert.equal((await s.authenticate(pair.accessRaw, 'http://127.0.0.1:1/other')), null)
  const rotated = await s.rotateRefresh({ clientId: CLIENT, refreshRaw: pair.refreshRaw, canonicalResource: AUD })
  assert.equal(await s.revokeToken(rotated.refreshRaw), true)
  assert.equal((await s.authenticate(pair.accessRaw, AUD)), null)
  assert.equal((await s.authenticate(rotated.accessRaw, AUD)), null)
  assert.equal(await s.revokeToken('nope'), false)
})

test('denied consent mints nothing and unregister wipes the client tokens', async () => {
  const s = store()
  await s.register(CLIENT, 'synthetic host', '/callback')
  const { challenge } = pkce()
  const { pending } = await s.parkConsent({ clientId: CLIENT, redirectUri: 'http://127.0.0.1:9/callback', challenge, method: 'S256' })
  assert.equal(await s.decideConsent(pending, false, AUD), null)
  const { verifier, code, redirect } = await consented(s)
  const pair = await s.exchangeCode({ clientId: CLIENT, code, verifier, redirectUri: redirect, canonicalResource: AUD })
  await s.unregister(CLIENT)
  assert.equal((await s.authenticate(pair.accessRaw, AUD)), null)
  assert.deepEqual(await s.clients(), [])
})
