/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AIUsageKind, AIUsageLimits, AIUsageSnapshot } from './AIUsageView'

const require = createRequire(import.meta.url)
type Reservation = { id: string; day: string; reservedTokens: number }
type Budget = {
  usage: () => Promise<AIUsageSnapshot>
  setLimits: (value: unknown) => Promise<AIUsageSnapshot>
  reserve: (value: { kind: AIUsageKind; reservedTokens: number; automatic?: boolean } | Record<string, unknown>) => Promise<Reservation>
  settle: (id: string, value: { outcome: 'success' | 'failed' | 'timeout'; actualTokens?: number | null }) => Promise<AIUsageSnapshot>
}
const { createAIBudget, DEFAULT_LIMITS, estimateReservationTokens } = require('../electron/ai-budget.cjs') as {
  createAIBudget: (options: { filePath: string; now: () => Date }) => Budget
  DEFAULT_LIMITS: AIUsageLimits
  estimateReservationTokens: (messages: unknown[], maxOutputTokens: number) => number
}
const nativeFs = require('node:fs/promises') as { rename: (from: string, to: string) => Promise<void> }
let directory: string
let filePath: string
let clock: Date
let budget: Budget
const limits = (overrides: Partial<AIUsageLimits> = {}): AIUsageLimits => ({ ...DEFAULT_LIMITS, kindDailyRequests: { ...DEFAULT_LIMITS.kindDailyRequests }, ...overrides })
const makeBudget = () => createAIBudget({ filePath, now: () => clock })

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'michi-ai-budget-test-'))
  filePath = join(directory, 'usage.json')
  clock = new Date(2026, 8, 30, 12)
  budget = makeBudget()
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const file of await readdir(directory)) await unlink(join(directory, file))
  await rmdir(directory)
})

describe('OpenRouterの事前利用予約', () => {
  it('一時的なWindowsファイルロックを待って保存し、予約を一回だけ計上する', async () => {
    await budget.usage()
    const nativeRename = nativeFs.rename
    const rename = vi.spyOn(nativeFs, 'rename').mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EPERM' })).mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' })).mockImplementation(nativeRename)
    await budget.reserve({ kind: 'chat', reservedTokens: 100 })
    expect(rename).toHaveBeenCalledTimes(3)
    expect((await budget.usage()).daily).toMatchObject({ requests: 1, tokens: 100, pendingRequests: 1 })
    expect(JSON.parse(await readFile(filePath, 'utf8')).entries).toHaveLength(1)
  })
  it('20件の同時予約でも回数とトークン上限を超えず、応答前に永続化する', async () => {
    await budget.setLimits(limits({ dailyRequests: 5, dailyTokens: 450 }))
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => budget.reserve({ kind: 'chat', reservedTokens: 100 })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(4)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(16)
    expect((await budget.usage()).daily).toEqual({ requests: 4, tokens: 400, knownTokens: 0, pendingRequests: 4, unknownRequests: 0 })
    const persisted = JSON.parse(await readFile(filePath, 'utf8'))
    expect(persisted.entries).toHaveLength(4)
    expect(persisted.entries.every((entry: { outcome: string }) => entry.outcome === 'pending')).toBe(true)
  })

  it('残り1回で20件同時に開始しても1件だけ予約する', async () => {
    await budget.setLimits(limits({ dailyRequests: 1, dailyTokens: 100000 }))
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => budget.reserve({ kind: 'chat', reservedTokens: 100 })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect((await budget.usage()).daily.requests).toBe(1)
  })

  it('失敗・タイムアウト・usage欠落は予約額を残し、実測usageだけを既知と記録する', async () => {
    const failed = await budget.reserve({ kind: 'chat', reservedTokens: 100 })
    const timeout = await budget.reserve({ kind: 'summarize', reservedTokens: 100 })
    const missingUsage = await budget.reserve({ kind: 'assist', reservedTokens: 100 })
    const known = await budget.reserve({ kind: 'score', reservedTokens: 100 })
    await budget.settle(failed.id, { outcome: 'failed', actualTokens: 0 })
    await budget.settle(timeout.id, { outcome: 'timeout' })
    await budget.settle(missingUsage.id, { outcome: 'success' })
    const result = await budget.settle(known.id, { outcome: 'success', actualTokens: 25 })
    expect(result.daily).toEqual({ requests: 4, tokens: 325, knownTokens: 25, pendingRequests: 0, unknownRequests: 2 })
    expect(result.cost).toBeNull()
    await expect(budget.settle(known.id, { outcome: 'success', actualTokens: 0 })).rejects.toThrow('記録済み')
  })

  it('再起動で応答待ちを未確定のtimeoutにして、予算を払い戻さない', async () => {
    await budget.setLimits(limits({ dailyRequests: 1 }))
    await budget.reserve({ kind: 'chat', reservedTokens: 100 })
    const reopened = makeBudget()
    const result = await reopened.usage()
    expect(result.daily).toMatchObject({ requests: 1, tokens: 100, pendingRequests: 0, unknownRequests: 1 })
    await expect(reopened.reserve({ kind: 'chat', reservedTokens: 1 })).rejects.toThrow('1日の')
  })

  it('日付をまたぐ予約を新しい日の上限にも含め、完了後もその日の使用として残す', async () => {
    await budget.setLimits(limits({ dailyRequests: 1 }))
    const reservation = await budget.reserve({ kind: 'chat', reservedTokens: 100 })
    clock = new Date(2026, 9, 1, 0, 1)
    expect((await budget.usage()).daily).toMatchObject({ requests: 1, tokens: 100, pendingRequests: 1 })
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 10 })).rejects.toThrow('1日の')
    await budget.settle(reservation.id, { outcome: 'success', actualTokens: 50 })
    expect((await budget.usage()).daily).toMatchObject({ requests: 1, tokens: 50, pendingRequests: 0 })
    clock = new Date(2026, 9, 2, 12)
    expect((await budget.usage()).daily.requests).toBe(0)
    expect((await budget.usage()).monthly.requests).toBe(1)
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 10 })).resolves.toMatchObject({ day: '2026-10-02' })
  })

  it('月上限を日付の切替で解除せず、翌月に切り替える', async () => {
    clock = new Date(2026, 8, 28, 12)
    await budget.setLimits(limits({ monthlyRequests: 2, monthlyTokens: 200 }))
    const first = await budget.reserve({ kind: 'chat', reservedTokens: 100 })
    await budget.settle(first.id, { outcome: 'failed' })
    clock = new Date(2026, 8, 29, 12)
    const second = await budget.reserve({ kind: 'chat', reservedTokens: 100 })
    await budget.settle(second.id, { outcome: 'timeout' })
    clock = new Date(2026, 8, 30, 12)
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 1 })).rejects.toThrow('1か月の')
    expect((await budget.usage()).monthly).toMatchObject({ requests: 2, tokens: 200 })
    clock = new Date(2026, 9, 1, 12)
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 100 })).resolves.toMatchObject({ day: '2026-10-01' })
  })

  it('月トークン上限を回数上限とは独立して検査する', async () => {
    await budget.setLimits(limits({ monthlyTokens: 150 }))
    const reservation = await budget.reserve({ kind: 'chat', reservedTokens: 100 })
    await budget.settle(reservation.id, { outcome: 'failed' })
    clock = new Date(2026, 9, 1, 12)
    const crossingMonth = await budget.reserve({ kind: 'chat', reservedTokens: 100 })
    await budget.settle(crossingMonth.id, { outcome: 'timeout' })
    clock = new Date(2026, 9, 2, 12)
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 51 })).rejects.toThrow('1か月の')
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 50 })).resolves.toBeDefined()
  })

  it('処理別の上限、自動予算0、全体の停止をネットワーク開始前に拒否する', async () => {
    await budget.setLimits(limits({ kindDailyRequests: { chat: 1, summarize: 0, assist: 100, score: 100 } }))
    await budget.reserve({ kind: 'chat', reservedTokens: 100 })
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 100 })).rejects.toThrow('この処理')
    await expect(budget.reserve({ kind: 'summarize', reservedTokens: 100 })).rejects.toThrow('この処理')
    await expect(budget.reserve({ kind: 'assist', reservedTokens: 100, automatic: true })).rejects.toThrow('予算は0')
    await budget.setLimits(limits({ dailyTokens: 0 }))
    await expect(budget.reserve({ kind: 'assist', reservedTokens: 1 })).rejects.toThrow('1日の')
  })

  it('自動AI処理（通知文など）は本人が設定した1日回数だけ予約でき、未設定は0回のまま古い記録形式を保つ', async () => {
    await budget.setLimits(limits())
    expect(JSON.parse(await readFile(filePath, 'utf8')).limits).not.toHaveProperty('automaticDailyRequests')
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 100, automatic: true })).rejects.toThrow('予算は0')
    expect((await budget.usage()).automaticBudget).toEqual({ requests: 0, used: 0 })
    await budget.setLimits(limits({ automaticDailyRequests: 2 }))
    await budget.reserve({ kind: 'chat', reservedTokens: 100, automatic: true })
    const second = await budget.reserve({ kind: 'chat', reservedTokens: 100, automatic: true })
    await budget.settle(second.id, { outcome: 'timeout' })
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 100, automatic: true })).rejects.toThrow('自動AI処理の1日の回数上限')
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 100 })).resolves.toBeDefined()
    expect((await budget.usage()).automaticBudget).toEqual({ requests: 2, used: 2 })
    expect(JSON.parse(await readFile(filePath, 'utf8')).entries.filter((entry: { automatic?: boolean }) => entry.automatic)).toHaveLength(2)
    await expect(budget.setLimits(limits({ automaticDailyRequests: 1001 }))).rejects.toThrow('自動AI処理')
    clock = new Date(clock.getTime() + 86400000)
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 100, automatic: true })).resolves.toBeDefined()
  })
  it('自動AI処理は本人のchatの種類別上限を使い切らない（全体上限は共通）', async () => {
    await budget.setLimits(limits({ automaticDailyRequests: 3, kindDailyRequests: { ...DEFAULT_LIMITS.kindDailyRequests, chat: 2 } }))
    for (let index = 0; index < 3; index++) await budget.reserve({ kind: 'chat', reservedTokens: 100, automatic: true })
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 100 })).resolves.toBeDefined()
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 100 })).resolves.toBeDefined()
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 100 })).rejects.toThrow('この処理の1日のAI回数上限')
    await budget.setLimits(limits({ automaticDailyRequests: 10, dailyRequests: 6, kindDailyRequests: { ...DEFAULT_LIMITS.kindDailyRequests, chat: 2 } }))
    await budget.reserve({ kind: 'chat', reservedTokens: 100, automatic: true })
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 100, automatic: true })).rejects.toThrow('1日のAI利用上限')
  })

  it('不正な上限・予算予約を保存せず、後続の正常予約を妨げない', async () => {
    for (const value of [-1, 1.5, NaN, Infinity, '10', 100001]) await expect(budget.setLimits(limits({ dailyRequests: value as number }))).rejects.toThrow('整数')
    await expect(budget.setLimits({ ...limits(), endpoint: 'https://elsewhere.invalid' })).rejects.toThrow('整数')
    await expect(budget.setLimits(limits({ kindDailyRequests: { chat: 1, summarize: 1, assist: 1 } as AIUsageLimits['kindDailyRequests'] }))).rejects.toThrow('処理別')
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 0 })).rejects.toThrow('形式')
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 10, text: '保存してはいけない原文' })).rejects.toThrow('形式')
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 10 })).resolves.toBeDefined()
    expect(await readFile(filePath, 'utf8')).not.toContain('保存してはいけない原文')
  })

  it('壊れた記録は0利用として再初期化せず、上限変更でも送信停止を解除しない', async () => {
    await writeFile(filePath, '{ broken json', 'utf8')
    await expect(budget.usage()).rejects.toThrow('送信を停止')
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 1 })).rejects.toThrow('送信を停止')
    await expect(budget.setLimits(limits())).rejects.toThrow('送信を停止')
    expect(await readFile(filePath, 'utf8')).toBe('{ broken json')
  })

  it('形式はJSONでも別providerや不正な台帳値なら停止する', async () => {
    const valid = { version: 1, provider: 'openrouter', lastDay: '2026-09-30', limits: limits(), entries: [] }
    await writeFile(filePath, JSON.stringify({ ...valid, provider: 'another-provider' }), 'utf8')
    await expect(budget.usage()).rejects.toThrow('送信を停止')
    await writeFile(filePath, JSON.stringify({ ...valid, limits: limits({ dailyTokens: -1 }) }), 'utf8')
    await expect(makeBudget().usage()).rejects.toThrow('送信を停止')
  })

  it('記録の保存失敗なら予約を返さず、後続処理に予算を消費したことにしない', async () => {
    await budget.usage()
    const failure = vi.spyOn(nativeFs, 'rename').mockRejectedValueOnce(new Error('disk error'))
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 100 })).rejects.toThrow('保存できない')
    failure.mockRestore()
    expect((await budget.usage()).daily.requests).toBe(0)
    expect(JSON.parse(await readFile(filePath, 'utf8')).entries).toHaveLength(0)
  })

  it('端末時計の逆行と実測が予約を上回る場合でも残り枠を水増ししない', async () => {
    await budget.setLimits(limits({ dailyTokens: 100 }))
    const reservation = await budget.reserve({ kind: 'chat', reservedTokens: 50 })
    expect((await budget.settle(reservation.id, { outcome: 'success', actualTokens: 120 })).daily.tokens).toBe(120)
    await expect(budget.reserve({ kind: 'chat', reservedTokens: 1 })).rejects.toThrow('1日の')
    clock = new Date(2026, 8, 29, 12)
    await expect(budget.usage()).rejects.toThrow('日付')
  })

  it('入力のバイト数と出力上限を予約し、本文自体は利用記録に保存しない', async () => {
    const messages = [{ role: 'user', content: '合成テスト文' }]
    const reservedTokens = estimateReservationTokens(messages, 800)
    expect(reservedTokens).toBeGreaterThan(800)
    await budget.reserve({ kind: 'chat', reservedTokens })
    expect(await readFile(filePath, 'utf8')).not.toContain('合成テスト文')
    expect((await budget.usage()).provider).toBe('openrouter')
  })
})
