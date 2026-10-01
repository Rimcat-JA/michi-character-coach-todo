import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const fs = require('node:fs/promises')
const { createAIBudget, DEFAULT_LIMITS } = require('./ai-budget.cjs')
const copy = value => JSON.parse(JSON.stringify(value))
const limits = overrides => ({ ...copy(DEFAULT_LIMITS), ...overrides })
const entry = ({ day, settledDay = day, outcome = 'success', reservedTokens = 10, actualTokens = 10, kind = 'chat' }) => ({ id: randomUUID(), day, settledDay, outcome, reservedTokens, actualTokens, kind })
const state = (day, entries, overrides = {}) => ({ version: 1, provider: 'openrouter', lastDay: day, limits: limits(overrides), entries })
const date = day => new Date(`${day}T12:00:00`)

async function fixture(run) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'michi-ai-retention-node-'))
  const knownFiles = new Set()
  const file = name => { knownFiles.add(name); return join(directory, name) }
  try { await run({ directory, file }) }
  finally {
    for (const name of knownFiles) await fs.unlink(join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error })
    await fs.rmdir(directory)
  }
}
const write = (filePath, value) => fs.writeFile(filePath, JSON.stringify(value), 'utf8')
const read = async filePath => JSON.parse(await fs.readFile(filePath, 'utf8'))

test('起動時の前月初日境界は開始日・精算日の両方を見て、稼働中の日付切替と同じ記録を残す', async () => fixture(async ({ file }) => {
  for (const sample of [
    { today: '2026-10-01', previousDay: '2026-09-30', old: '2026-08-31', boundary: '2026-09-01' },
    { today: '2027-01-01', previousDay: '2026-12-31', old: '2026-11-30', boundary: '2026-12-01' },
    { today: '2028-03-01', previousDay: '2028-02-29', old: '2028-01-31', boundary: '2028-02-01' },
  ]) {
    const obsolete = entry({ day: sample.old })
    const boundary = entry({ day: sample.boundary })
    const settledLater = entry({ day: '2026-01-01', settledDay: sample.boundary, kind: 'summarize' })
    const input = state(sample.previousDay, [obsolete, boundary, settledLater])
    const coldFile = file(`cold-${sample.today}.json`), liveFile = file(`live-${sample.today}.json`)
    await write(coldFile, input); await write(liveFile, input)
    let clock = date(sample.previousDay)
    const live = createAIBudget({ filePath: liveFile, now: () => clock })
    await live.usage(); clock = date(sample.today)
    const cold = createAIBudget({ filePath: coldFile, now: () => clock })
    assert.deepEqual(await cold.usage(), await live.usage(), sample.today)
    assert.deepEqual((await read(coldFile)).entries, [boundary, settledLater], sample.today)
    assert.deepEqual(await read(coldFile), await read(liveFile), sample.today)
  }
  // The existing valid-day range starts at year 1; retention has no earlier rows to keep.
  const minimumFile = file('minimum-valid-year.json')
  const minimum = state('0001-01-01', [entry({ day: '0001-01-01' })])
  await write(minimumFile, minimum)
  assert.equal((await createAIBudget({ filePath: minimumFile, now: () => date('0001-01-01') }).usage()).daily.requests, 1)
}))

test('毎日起動を100日繰り返しても前月と当月だけで、同日再読込は回数や課金を増やさない', async () => fixture(async ({ file }) => {
  const filePath = file('daily-restarts.json')
  for (let offset = 0; offset < 100; offset++) {
    const clock = new Date(2026, 7, 1 + offset, 12)
    const make = () => createAIBudget({ filePath, now: () => clock })
    const budget = make()
    const reservation = await budget.reserve({ kind: 'chat', reservedTokens: 20 })
    await budget.settle(reservation.id, { outcome: 'success', actualTokens: 10 })
    const saved = await read(filePath), usage = await budget.usage()
    assert.ok(saved.entries.length <= 62, `100日中の${offset + 1}日目: ${saved.entries.length}件`)
    assert.equal(usage.daily.requests, 1)
    assert.equal(usage.monthly.requests, clock.getDate())
    assert.equal(usage.monthly.tokens, clock.getDate() * 10)
    const reopened = make()
    assert.deepEqual(await reopened.usage(), usage)
    assert.deepEqual(await reopened.usage(), usage)
    assert.deepEqual(await read(filePath), saved)
  }
  const final = await read(filePath)
  assert.equal(final.entries.length, 39)
  assert.equal(final.entries[0].day, '2026-10-01')
  assert.equal(final.entries.at(-1).day, '2026-11-08')
}))

test('古いpendingは今日の未知課金timeoutへ復旧して残り、日/月の上限を払い戻さない', async () => fixture(async ({ file }) => {
  const filePath = file('old-pending.json')
  const pending = entry({ day: '2026-06-01', settledDay: null, outcome: 'pending', actualTokens: null, reservedTokens: 500, kind: 'assist' })
  const input = state('2026-09-30', [entry({ day: '2026-08-01' }), pending], { dailyRequests: 1, dailyTokens: 500, monthlyRequests: 1, monthlyTokens: 500 })
  await write(filePath, input)
  const budget = createAIBudget({ filePath, now: () => date('2026-10-01') })
  const usage = await budget.usage()
  const expected = { requests: 1, tokens: 500, knownTokens: 0, unknownRequests: 1, pendingRequests: 0 }
  assert.deepEqual(usage.daily, expected); assert.deepEqual(usage.monthly, expected)
  assert.deepEqual(usage.byKind.assist, expected)
  assert.deepEqual(usage.limits, input.limits)
  assert.deepEqual(usage.automaticBudget, { requests: 0, tokens: 0 })
  assert.equal(usage.cost, null)
  assert.deepEqual((await read(filePath)).entries, [{ ...pending, outcome: 'timeout', settledDay: '2026-10-01' }])
  const saved = await fs.readFile(filePath, 'utf8')
  await assert.rejects(budget.reserve({ kind: 'chat', reservedTokens: 1 }), /1日の/)
  assert.equal(await fs.readFile(filePath, 'utf8'), saved)
  await budget.setLimits(limits({ dailyRequests: 100, dailyTokens: 10000, monthlyRequests: 1, monthlyTokens: 500 }))
  await assert.rejects(budget.reserve({ kind: 'chat', reservedTokens: 1 }), /1か月の/)
  await budget.setLimits(limits({ dailyRequests: 100, dailyTokens: 10000, monthlyRequests: 100, monthlyTokens: 500 }))
  await assert.rejects(budget.reserve({ kind: 'chat', reservedTokens: 1 }), /1か月の/)
  assert.deepEqual((await budget.usage()).monthly, expected)
}))

test('日付逆行を冷起動と稼働中に拒否して、保持記録・予算・最後の日付を変更しない', async () => fixture(async ({ file }) => {
  const filePath = file('backward-clock.json')
  await write(filePath, state('2026-10-05', [entry({ day: '2026-10-05', actualTokens: 100, reservedTokens: 100 })]))
  let clock = date('2026-10-04')
  const budget = createAIBudget({ filePath, now: () => clock })
  let saved = await fs.readFile(filePath, 'utf8')
  await assert.rejects(budget.usage(), /日付/)
  assert.equal(await fs.readFile(filePath, 'utf8'), saved)
  clock = date('2026-10-05')
  const usage = await budget.usage(); saved = await fs.readFile(filePath, 'utf8')
  clock = date('2026-10-04')
  await assert.rejects(budget.usage(), /日付/)
  await assert.rejects(budget.reserve({ kind: 'chat', reservedTokens: 1 }), /日付/)
  await assert.rejects(budget.setLimits(limits({ dailyRequests: 0 })), /日付/)
  assert.equal(await fs.readFile(filePath, 'utf8'), saved)
  clock = date('2026-10-05')
  assert.deepEqual(await budget.usage(), usage)
}))

test('起動時/日付切替の保存失敗は元fileとメモリを変えず、後の正常保存で整理できる', async () => fixture(async ({ file, directory }) => {
  const obsolete = entry({ day: '2026-08-31' }), retained = entry({ day: '2026-09-01' })
  const nativeRename = fs.rename
  const failRename = async () => { throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' }) }
  const coldFile = file('cold-write-failure.json')
  await write(coldFile, state('2026-09-30', [obsolete, retained]))
  const coldSaved = await fs.readFile(coldFile, 'utf8')
  const cold = createAIBudget({ filePath: coldFile, now: () => date('2026-10-01') })
  try { fs.rename = failRename; await assert.rejects(cold.usage(), /保存できない/) }
  finally { fs.rename = nativeRename }
  assert.equal(await fs.readFile(coldFile, 'utf8'), coldSaved)
  assert.equal((await cold.usage()).day, '2026-10-01')
  assert.deepEqual((await read(coldFile)).entries, [retained])
  const liveFile = file('live-write-failure.json')
  await write(liveFile, state('2026-09-30', [obsolete, retained]))
  let clock = date('2026-09-30')
  const live = createAIBudget({ filePath: liveFile, now: () => clock }), oldUsage = await live.usage()
  const liveSaved = await fs.readFile(liveFile, 'utf8'); clock = date('2026-10-01')
  try { fs.rename = failRename; await assert.rejects(live.usage(), /保存できない/) }
  finally { fs.rename = nativeRename }
  assert.equal(await fs.readFile(liveFile, 'utf8'), liveSaved)
  clock = date('2026-09-30')
  assert.deepEqual(await live.usage(), oldUsage)
  clock = date('2026-10-01')
  await live.usage()
  assert.deepEqual((await read(liveFile)).entries, [retained])
  assert.deepEqual((await fs.readdir(directory)).sort(), ['cold-write-failure.json', 'live-write-failure.json'])
}))

test('起動整理後の残り1枠に20件並列予約しても1件だけを永続化する', async () => fixture(async ({ file }) => {
  const filePath = file('parallel-last-slot.json')
  const current = Array.from({ length: 4 }, () => entry({ day: '2026-10-01', reservedTokens: 100, actualTokens: 100 }))
  await write(filePath, state('2026-10-01', [entry({ day: '2026-08-31' }), ...current], { dailyRequests: 5, dailyTokens: 500, monthlyRequests: 5, monthlyTokens: 500, kindDailyRequests: { chat: 5, summarize: 100, assist: 100, score: 100 } }))
  const budget = createAIBudget({ filePath, now: () => date('2026-10-01') })
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => budget.reserve({ kind: 'chat', reservedTokens: 100 })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 19)
  const saved = await read(filePath)
  assert.equal(saved.entries.length, 5)
  assert.equal(saved.entries.filter(value => value.outcome === 'pending').length, 1)
  for (const original of current) assert.deepEqual(saved.entries.find(value => value.id === original.id), original)
  assert.deepEqual((await budget.usage()).daily, { requests: 5, tokens: 500, knownTokens: 400, unknownRequests: 0, pendingRequests: 1 })
}))

test('巨大file・破損JSON・古い不正行は整理の前に停止し、0利用へresetしない', async () => fixture(async ({ file }) => {
  const brokenFile = file('broken.json')
  await fs.writeFile(brokenFile, '{ broken synthetic json', 'utf8')
  const invalidFile = file('old-invalid-entry.json')
  await write(invalidFile, state('2026-09-30', [entry({ day: '2026-01-01', reservedTokens: -1 })]))
  for (const filePath of [brokenFile, invalidFile]) {
    const saved = await fs.readFile(filePath, 'utf8')
    const budget = createAIBudget({ filePath, now: () => date('2026-10-01') })
    await assert.rejects(budget.usage(), /送信を停止/)
    await assert.rejects(budget.reserve({ kind: 'chat', reservedTokens: 1 }), /送信を停止/)
    await assert.rejects(budget.setLimits(limits({ dailyRequests: 100000 })), /送信を停止/)
    assert.equal(await fs.readFile(filePath, 'utf8'), saved)
  }
  const hugeFile = file('oversized.json')
  const handle = await fs.open(hugeFile, 'wx')
  try { await handle.writeFile('synthetic oversized file'); await handle.truncate(64 * 1024 * 1024 + 1) }
  finally { await handle.close() }
  const size = (await fs.stat(hugeFile)).size
  const huge = createAIBudget({ filePath: hugeFile, now: () => date('2026-10-01') })
  await assert.rejects(huge.usage(), /送信を停止/)
  await assert.rejects(huge.reserve({ kind: 'chat', reservedTokens: 1 }), /送信を停止/)
  await assert.rejects(huge.setLimits(limits()), /送信を停止/)
  assert.equal((await fs.stat(hugeFile)).size, size)
  const prefix = await fs.open(hugeFile, 'r')
  try {
    const buffer = Buffer.alloc(24)
    await prefix.read(buffer, 0, buffer.length, 0)
    assert.equal(buffer.toString(), 'synthetic oversized file')
  } finally { await prefix.close() }
}))
