import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createAILocks } = require('./ai-locks.cjs')

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
test('owner chat during an in-flight background wording request is not refused', async () => {
  const locks = createAILocks(), wording = deferred()
  const background = locks.automatic(() => wording.promise)
  assert.equal(await locks.owner(async () => 'chat'), 'chat')
  wording.resolve('text'); assert.equal(await background, 'text')
})
test('wording requested during an owner call or another wording request is skipped (template fallback)', async () => {
  const locks = createAILocks(), chat = deferred()
  const owner = locks.owner(() => chat.promise)
  await assert.rejects(locks.automatic(async () => 'text'), /前のAI応答を待っています/)
  await assert.rejects(locks.owner(async () => 'second'), /前のAI応答を待っています/)
  chat.resolve('done'); assert.equal(await owner, 'done')
  const wording = deferred(), first = locks.automatic(() => wording.promise)
  await assert.rejects(locks.automatic(async () => 'again'), /前のAI応答を待っています/)
  wording.resolve('ok'); assert.equal(await first, 'ok')
  assert.equal(await locks.automatic(async () => 'next'), 'next')
})
test('locks are released after a failure', async () => {
  const locks = createAILocks()
  await assert.rejects(locks.owner(async () => { throw new Error('x') }), /x/)
  await assert.rejects(locks.automatic(async () => { throw new Error('y') }), /y/)
  assert.equal(await locks.owner(async () => 1), 1)
  assert.equal(await locks.automatic(async () => 2), 2)
})
test('main.cjs routes notification wording through the automatic lock and everything else through the owner lock', () => {
  const main = readFileSync(new URL('./main.cjs', import.meta.url), 'utf8')
  assert.doesNotMatch(main, /chatInFlight/)
  assert.match(main, /channel === 'michi:ai-notification-text' \? aiLocks\.automatic\(/)
})
