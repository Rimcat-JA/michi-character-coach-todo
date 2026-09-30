const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const KINDS = ['chat', 'summarize', 'assist', 'score']
const DEFAULT_LIMITS = Object.freeze({
  dailyRequests: 100, dailyTokens: 200000, monthlyRequests: 1000, monthlyTokens: 2000000,
  kindDailyRequests: Object.freeze({ chat: 100, summarize: 100, assist: 100, score: 100 })
})
const MAX_REQUESTS = 100000
const MAX_TOKENS = 1000000000
const MAX_RESERVATION = 10000000
const CORRUPT_MESSAGE = 'AI利用記録を読み込めないため、送信を停止しました。記録を確認してください'

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function keysAre(value, required, optional = []) {
  return plainObject(value) && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}
function integer(value, max = MAX_TOKENS) { return Number.isSafeInteger(value) && value >= 0 && value <= max }

function validateUsageLimits(value) {
  const globals = ['dailyRequests', 'dailyTokens', 'monthlyRequests', 'monthlyTokens']
  if (!keysAre(value, globals, ['kindDailyRequests']) || !integer(value.dailyRequests, MAX_REQUESTS) ||
    !integer(value.monthlyRequests, MAX_REQUESTS) || !integer(value.dailyTokens) || !integer(value.monthlyTokens)) {
    throw new Error('AI利用上限は範囲内の0以上の整数で指定してください')
  }
  const kindDailyRequests = value.kindDailyRequests ?? Object.fromEntries(KINDS.map(kind => [kind, value.dailyRequests]))
  if (!keysAre(kindDailyRequests, KINDS) || KINDS.some(kind => !integer(kindDailyRequests[kind], MAX_REQUESTS))) {
    throw new Error('処理別のAI回数上限は0以上の整数で指定してください')
  }
  return { ...Object.fromEntries(globals.map(key => [key, value[key]])), kindDailyRequests: { ...kindDailyRequests } }
}

function dateKey(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()) || date.getFullYear() < 1 || date.getFullYear() > 9999) throw new Error('AI利用記録の日付を確認してください')
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const date = new Date(`${day}T12:00:00`)
  return Number.isFinite(date.getTime()) && dateKey(date) === day
}
function clone(value) { return JSON.parse(JSON.stringify(value)) }

function validateState(value) {
  if (!keysAre(value, ['version', 'provider', 'lastDay', 'limits', 'entries']) || value.version !== 1 ||
    value.provider !== 'openrouter' || !validDay(value.lastDay) || !Array.isArray(value.entries) || value.entries.length > 1000000) {
    throw new Error(CORRUPT_MESSAGE)
  }
  try { value.limits = validateUsageLimits(value.limits) } catch { throw new Error(CORRUPT_MESSAGE) }
  const ids = new Set()
  for (const entry of value.entries) {
    if (!keysAre(entry, ['id', 'day', 'settledDay', 'kind', 'reservedTokens', 'actualTokens', 'outcome']) ||
      typeof entry.id !== 'string' || !/^[\da-f-]{36}$/.test(entry.id) || ids.has(entry.id) || !validDay(entry.day) || entry.day > value.lastDay ||
      !KINDS.includes(entry.kind) || !integer(entry.reservedTokens, MAX_RESERVATION) || entry.reservedTokens === 0 ||
      !['pending', 'success', 'failed', 'timeout'].includes(entry.outcome) ||
      (entry.actualTokens !== null && !integer(entry.actualTokens, MAX_RESERVATION)) ||
      (entry.outcome === 'pending' && (entry.settledDay !== null || entry.actualTokens !== null)) ||
      (entry.outcome !== 'pending' && (!validDay(entry.settledDay) || entry.settledDay < entry.day || entry.settledDay > value.lastDay))) {
      throw new Error(CORRUPT_MESSAGE)
    }
    ids.add(entry.id)
  }
  return value
}

function totals(entries) {
  const result = { requests: entries.length, tokens: 0, knownTokens: 0, unknownRequests: 0, pendingRequests: 0 }
  for (const entry of entries) {
    result.tokens += entry.outcome === 'success' && entry.actualTokens !== null ? entry.actualTokens : Math.max(entry.reservedTokens, entry.actualTokens ?? 0)
    if (entry.actualTokens !== null) result.knownTokens += entry.actualTokens
    else if (entry.outcome !== 'pending') result.unknownRequests += 1
    if (entry.outcome === 'pending') result.pendingRequests += 1
  }
  if (!Number.isSafeInteger(result.tokens) || !Number.isSafeInteger(result.knownTokens)) throw new Error(CORRUPT_MESSAGE)
  return result
}

function snapshot(state) {
  const day = state.lastDay
  const month = day.slice(0, 7)
  // A request crossing midnight counts on both days. Pending earlier requests
  // are carried into today's quota until settled; an app restart marks them unknown.
  const dailyEntries = state.entries.filter(entry => entry.day === day || entry.settledDay === day || entry.outcome === 'pending')
  const monthlyEntries = state.entries.filter(entry => entry.day.startsWith(month) || entry.settledDay?.startsWith(month) || entry.outcome === 'pending')
  return {
    provider: 'openrouter', day, month, limits: clone(state.limits), automaticBudget: { requests: 0, tokens: 0 },
    daily: totals(dailyEntries), monthly: totals(monthlyEntries),
    byKind: Object.fromEntries(KINDS.map(kind => [kind, totals(dailyEntries.filter(entry => entry.kind === kind))])),
    cost: null
  }
}

function createAIBudget({ filePath, now = () => new Date() }) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('AI利用記録の保存先が不正です')
  let state = null
  let blocked = null
  let queue = Promise.resolve()

  function serialize(operation) {
    const result = queue.then(operation)
    queue = result.catch(() => {})
    return result
  }
  async function atomicWrite(next) {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`
    let handle
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      handle = await fs.open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify(next), 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temporaryPath, filePath); break }
        catch (error) {
          if (attempt >= 2 || !['EPERM', 'EBUSY'].includes(error.code)) throw error
          await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
        }
      }
    } catch (error) {
      throw new Error('AI利用記録を保存できないため、送信を停止しました', { cause: error })
    } finally {
      if (handle) await handle.close().catch(() => {})
      await fs.unlink(temporaryPath).catch(() => {})
    }
  }
  async function commit(next) {
    await atomicWrite(next)
    state = next
  }
  async function load() {
    if (blocked) throw blocked
    const day = dateKey(now())
    if (!state) {
      let next
      try {
        const stat = await fs.stat(filePath)
        if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error(CORRUPT_MESSAGE)
        next = validateState(JSON.parse(await fs.readFile(filePath, 'utf8')))
      } catch (error) {
        if (error.code === 'ENOENT') next = { version: 1, provider: 'openrouter', lastDay: day, limits: clone(DEFAULT_LIMITS), entries: [] }
        else { blocked = new Error(CORRUPT_MESSAGE); throw blocked }
      }
      if (day < next.lastDay) throw new Error('端末の日付がAI利用記録より前です。日付を確認してください')
      next.lastDay = day
      // A crashed request may already have been billed; never release it as unused.
      for (const entry of next.entries) if (entry.outcome === 'pending') { entry.outcome = 'timeout'; entry.settledDay = day }
      await commit(next)
    }
    if (day < state.lastDay) throw new Error('端末の日付がAI利用記録より前です。日付を確認してください')
    if (day > state.lastDay) {
      const next = clone(state)
      next.lastDay = day
      const previousMonth = new Date(`${day.slice(0, 7)}-01T12:00:00`)
      previousMonth.setMonth(previousMonth.getMonth() - 1)
      const keepFrom = dateKey(previousMonth)
      next.entries = next.entries.filter(entry => entry.outcome === 'pending' || entry.day >= keepFrom || entry.settledDay >= keepFrom)
      await commit(next)
    }
    return state
  }

  return {
    usage: () => serialize(async () => snapshot(await load())),
    setLimits: value => serialize(async () => {
      const limits = validateUsageLimits(value)
      await load()
      const next = clone(state)
      next.limits = limits
      await commit(next)
      return snapshot(state)
    }),
    reserve: value => serialize(async () => {
      if (!keysAre(value, ['kind', 'reservedTokens'], ['automatic']) || !KINDS.includes(value.kind) ||
        !integer(value.reservedTokens, MAX_RESERVATION) || value.reservedTokens === 0 ||
        (value.automatic !== undefined && typeof value.automatic !== 'boolean')) throw new Error('AI予算予約の形式が不正です')
      if (value.automatic) throw new Error('自動AI処理の利用予算は0です')
      await load()
      const usage = snapshot(state)
      const limits = state.limits
      if (usage.daily.requests + 1 > limits.dailyRequests || usage.daily.tokens + value.reservedTokens > limits.dailyTokens) throw new Error('1日のAI利用上限に達しています')
      if (usage.monthly.requests + 1 > limits.monthlyRequests || usage.monthly.tokens + value.reservedTokens > limits.monthlyTokens) throw new Error('1か月のAI利用上限に達しています')
      if (usage.byKind[value.kind].requests + 1 > limits.kindDailyRequests[value.kind]) throw new Error('この処理の1日のAI回数上限に達しています')
      const reservation = { id: randomUUID(), day: state.lastDay, settledDay: null, kind: value.kind, reservedTokens: value.reservedTokens, actualTokens: null, outcome: 'pending' }
      const next = clone(state)
      next.entries.push(reservation)
      await commit(next)
      return { id: reservation.id, day: reservation.day, reservedTokens: reservation.reservedTokens }
    }),
    settle: (id, value) => serialize(async () => {
      if (typeof id !== 'string' || !keysAre(value, ['outcome'], ['actualTokens']) || !['success', 'failed', 'timeout'].includes(value.outcome) ||
        (value.actualTokens !== undefined && value.actualTokens !== null && !integer(value.actualTokens, MAX_RESERVATION))) throw new Error('AI利用結果の形式が不正です')
      await load()
      const next = clone(state)
      const entry = next.entries.find(item => item.id === id)
      if (!entry) throw new Error('AI予算予約が見つかりません')
      if (entry.outcome !== 'pending') throw new Error('このAI予算予約は記録済みです')
      entry.outcome = value.outcome
      entry.actualTokens = value.actualTokens ?? null
      entry.settledDay = state.lastDay
      await commit(next)
      return snapshot(state)
    })
  }
}

// Input UTF-8 bytes plus protocol headroom reserves conservatively for the fixed
// provider. A provider-reported value is always recorded even if larger than this.
function estimateReservationTokens(messages, maxOutputTokens) {
  if (!Array.isArray(messages) || !integer(maxOutputTokens, MAX_RESERVATION) || maxOutputTokens === 0) throw new Error('AIトークン予約が不正です')
  const tokens = Buffer.byteLength(JSON.stringify(messages), 'utf8') + maxOutputTokens + 512
  if (!integer(tokens, MAX_RESERVATION) || tokens === 0) throw new Error('AIトークン予約が上限を超えています')
  return tokens
}

module.exports = { createAIBudget, validateUsageLimits, DEFAULT_LIMITS, estimateReservationTokens }
