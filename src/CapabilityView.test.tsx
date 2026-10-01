import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { db, ensureSettings } from './db'
import { aiAvailability, capabilityLabel, capabilityRows, type CapabilityEnvironment } from './capabilities'
import { CapabilityTable, NetworkCounters, RuntimeChoiceCard } from './CapabilityView'
import { ExternalLinkView } from './ExternalLink'
import { CoachOfflineBanner } from './CoachOfflineBanner'
import { AI_OFFLINE_NOTICE, holdCoachDraftOffline } from './coach-offline'
import { createCoachConversation, readCoachConversation, saveCoachDraft } from './chat-history'
import FeatureConnectionsView, { type ConnectionGateways } from './FeatureConnectionsView'
import { egressLine } from './feature-connections'
import { standaloneProfile, type NetworkStatus } from './runtime-profile'
import type { VoiceMediaController } from './voice-media'

// Synthetic only: environments are plain objects; nothing reaches OpenRouter, GitHub or a real device.
const electronOnline: CapabilityEnvironment = { electron: true, policy: 'explicit_online', online: true, aiKeyConfigured: true, aiEnabled: true, aiModel: true, notificationPermission: 'granted' }
const row = (env: CapabilityEnvironment, id: string) => capabilityRows(env).find(item => item.id === id)!
beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('18.3 機能能力表', () => {
  it('通常ToDo・ポイント・繰り返し・バックアップはどの環境でも○', () => {
    for (const env of [electronOnline, { ...electronOnline, policy: 'offline_only' as const, online: false }, { ...electronOnline, electron: false, aiKeyConfigured: false }])
      for (const id of ['tasks', 'points', 'views', 'recurrence', 'tracking', 'files', 'history', 'backup']) expect(row(env, id).state).toBe('local')
  })
  it('外部AIはoffline_only・ネットなしで「通信が必要」、未設定は条件付き、ブラウザ版は未提供', () => {
    expect(aiAvailability(electronOnline)).toMatchObject({ ready: true, offline: false, state: 'conditional' })
    expect(aiAvailability({ ...electronOnline, policy: 'offline_only' })).toMatchObject({ ready: false, offline: true, state: 'network', detail: expect.stringContaining('AIはオフラインのため利用できません') })
    expect(aiAvailability({ ...electronOnline, online: false })).toMatchObject({ ready: false, offline: true, state: 'network' })
    expect(aiAvailability({ ...electronOnline, aiKeyConfigured: false, policy: 'offline_only' })).toMatchObject({ ready: false, offline: false, state: 'conditional' })
    expect(aiAvailability({ ...electronOnline, electron: false })).toMatchObject({ ready: false, offline: false, state: 'unsupported' })
  })
  it('GitHub投稿は通信が必要、offline_onlyでは送らないと表示する', () => {
    expect(row(electronOnline, 'publish')).toMatchObject({ state: 'network', detail: expect.stringContaining('本人の確認ボタン') })
    expect(row({ ...electronOnline, policy: 'offline_only' }, 'publish').detail).toContain('送信しません')
    expect(row({ ...electronOnline, electron: false }, 'publish').state).toBe('unsupported')
  })
  it('Windows通知はOS予約ではなくアプリ起動中のみ、通知拒否でもToDoは使えると表示する', () => {
    expect(row(electronOnline, 'reminders').detail).toContain('アプリ起動中のみ')
    expect(row(electronOnline, 'reminders').detail).toContain('OS予約通知は未実装')
    expect(row({ ...electronOnline, electron: false, notificationPermission: 'denied' }, 'reminders').detail).toContain('通知が拒否されています。ToDoは通常どおり使えます')
  })
  it('表示ラベルを ○ / 条件付き / 通信が必要 / このPCでは未提供 で出し分ける', () => {
    const html = renderToStaticMarkup(<CapabilityTable rows={capabilityRows({ ...electronOnline, policy: 'offline_only' })} electron />)
    for (const label of ['○', '条件付き', '通信が必要', 'このPCでは未提供']) expect(html).toContain(label)
    expect(capabilityLabel('unsupported', false)).toBe('この環境では未提供')
    expect(html).toContain('data-capability="ai"')
  })
  it('通信カウンターにURLや秘密を出さず、ブラウザ版は記録なしと表示する', () => {
    const counters = { attempts: 0, blockedOffline: 2, blockedHost: 0, failed: 0 }
    const html = renderToStaticMarkup(<NetworkCounters network={{ policy: 'offline_only', source: 'profile', checkedAt: null, counters: { openrouter: counters, github: { ...counters, blockedOffline: 1 }, webhook: { ...counters, blockedOffline: 0 } }, legacyOnlineConfigured: false }} />)
    expect(html).toContain('OpenRouter 送信0回・設定で遮断2回')
    expect(html).not.toMatch(/https?:|openrouter\.ai|api\.github/)
    expect(renderToStaticMarkup(<NetworkCounters network={null} />)).toContain('ブラウザ版')
  })
  it('初回カードは端末単独を主導線にし、サーバー/クラウドを隠さず未提供と示す', () => {
    const html = renderToStaticMarkup(<RuntimeChoiceCard run={async () => true} />)
    expect(html.indexOf('この端末だけで始める')).toBeLessThan(html.indexOf('自分のPCサーバーへ接続（未提供）'))
    expect(html).toContain('クラウドへ接続（未提供）')
    expect(html).not.toMatch(/メール|パスワード|APIキーを入力|サーバーURLを入力/)
  })
  it('offline_onlyでは外部リンクを文字として表示し、hrefを出さない', () => {
    const offline = renderToStaticMarkup(<ExternalLinkView href="https://www.live2d.com/sdk/license/" policy="offline_only">Live2Dの条件</ExternalLinkView>)
    expect(offline).not.toContain('<a ')
    expect(offline).toContain('通信が必要')
    expect(renderToStaticMarkup(<ExternalLinkView href="https://www.live2d.com/sdk/license/" policy="explicit_online">Live2Dの条件</ExternalLinkView>)).toContain('<a href="https://www.live2d.com/sdk/license/"')
  })
})

describe('S17 接続とバックグラウンドへの統合', () => {
  const zero = { attempts: 0, blockedOffline: 0, blockedHost: 0, failed: 0 }
  const network: NetworkStatus = { policy: 'offline_only', source: 'profile', checkedAt: null, counters: { openrouter: { ...zero, blockedOffline: 3 }, github: zero, webhook: zero }, legacyOnlineConfigured: false }
  const voice = { snapshot: () => ({ speech: 'idle', input: 'idle', music: 'empty', trackName: '', volume: .5, duck: .25, transcript: '', notice: '' }), subscribe: () => () => undefined, stopAll: () => undefined } as unknown as VoiceMediaController
  const github = { status: async () => ({}), invalidate: async () => undefined } as unknown as NonNullable<ConnectionGateways['github']>
  it('offline_onlyではAI・GitHubの行に送信前の遮断と回数を出し、GitHubの状態確認ボタンを出さない', async () => {
    const settings = (await db.settings.get('main'))!
    const offline = { ...settings, aiEnabled: true, aiModel: 'synthetic/model', runtimeProfile: standaloneProfile(settings.datasetId, 'offline_only') }
    const html = renderToStaticMarkup(<FeatureConnectionsView settings={offline} taskCount={0} gateways={{ github }} voice={voice} aiStatus={null} network={network} />)
    expect(html).toContain('オフライン専用のため送信前に遮断（今回の起動後 送信0回・設定で遮断3回）')
    expect(html).toContain('状態確認は通信が必要です')
    expect(html).not.toContain('GitHubに接続して状態を確認')
    expect(html).toContain('data-network-counters')
    expect(html).not.toMatch(/openrouter\.ai|api\.github/)
    const online = renderToStaticMarkup(<FeatureConnectionsView settings={{ ...offline, runtimeProfile: standaloneProfile(settings.datasetId, 'explicit_online') }} taskCount={0} gateways={{ github }} voice={voice} aiStatus={null} network={{ ...network, policy: 'explicit_online' }} />)
    expect(online).toContain('GitHubに接続して状態を確認')
    expect(online).toContain('本人の操作時だけ許可')
  })
  it('ブラウザ版（回数なし）は方針だけを表示する', () => {
    expect(egressLine('offline_only', null, 'openrouter')).toBe('オフライン専用のため送信前に遮断')
  })
})

describe('AT-N10-11 外部モデルのみ・ネットなしのコーチ', () => {
  it('バナーを表示し、下書きを保存し、live_ai/template/応答行を作らない', async () => {
    expect(renderToStaticMarkup(<CoachOfflineBanner reason="オフライン専用の設定です" />)).toContain('AIはオフラインのため利用できません')
    const id = await createCoachConversation(), before = await readCoachConversation(id)
    await saveCoachDraft(id, before.conversation.draftRevision, '途中まで')
    expect(await holdCoachDraftOffline(id, '今日の予定を相談したい')).toBe(AI_OFFLINE_NOTICE)
    const after = await readCoachConversation(id)
    expect(after.conversation.draft).toBe('今日の予定を相談したい')
    expect(after.conversation.pendingMessageId ?? null).toBeNull()
    expect(after.messages).toEqual([])
    expect(await db.coachMessages.count()).toBe(0)
    expect(await db.tasks.count()).toBe(0)
    // Repeating the offline send is idempotent and still writes no reply.
    await holdCoachDraftOffline(id, '今日の予定を相談したい')
    expect((await readCoachConversation(id)).conversation.draftRevision).toBe(after.conversation.draftRevision)
    expect(await db.coachMessages.where('conversationId').equals(id).filter(row => row.origin === 'live_ai').count()).toBe(0)
  })
})
