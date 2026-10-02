import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { db, ensureSettings } from './db'
import type { Settings } from './domain'
import { changePolicyFor } from './change-set'
import { stopConnection, type ConnectionKind } from './external-connection'
import { loadConnectionStatus, runRowStop, stopAIProcessingRow, UNPROVIDED_CONNECTIONS } from './feature-connections'
import FeatureConnectionsView, { type ConnectionGateways } from './FeatureConnectionsView'
import FeatureOffCard from './FeatureOffCard'
import { VoiceMediaView } from './VoiceMediaView'
import { setFeatureVisible } from './features'
import type { VoiceMediaController, VoiceMediaState } from './voice-media'
import type { FileBridgeGateway } from './file-bridge-types'
import type { LocalActionGateway } from './local-action-types'
import type { GitHubAchievementsGateway } from './github-publish-types'

const settings: Settings = { id: 'main', profileId: 'owner', datasetId: 'dataset', createdAt: '2026-10-01T00:00:00.000Z', coachName: 'コーチ', dailyMinutes: 480, dailyPoints: 100, notifications: true, aiEnabled: true, aiModel: 'synthetic/model', automation: 'A1', lastBackupAt: null, hiddenFeatures: ['voice', 'localActions'] }
function fakes() {
  const fileBridge = { invalidate: vi.fn(async () => undefined), status: vi.fn() } as unknown as FileBridgeGateway & { invalidate: ReturnType<typeof vi.fn> }
  const localActions = { invalidate: vi.fn(async () => undefined), status: vi.fn() } as unknown as LocalActionGateway & { invalidate: ReturnType<typeof vi.fn> }
  const github = { invalidate: vi.fn(async () => undefined), status: vi.fn() } as unknown as GitHubAchievementsGateway & { invalidate: ReturnType<typeof vi.fn> }
  return { fileBridge, localActions, github }
}
const host = (gateways: ReturnType<typeof fakes>) => ({ michiFileBridge: gateways.fileBridge, michiLocalActions: gateways.localActions, michiGitHubAchievements: gateways.github })
function voice(state: Partial<VoiceMediaState>) {
  const snapshot: VoiceMediaState = { speech: 'idle', input: 'idle', music: 'empty', trackName: '', volume: .5, duck: .25, transcript: '', notice: '', ...state }
  return { snapshot: () => ({ ...snapshot }), subscribe: vi.fn(() => () => undefined), stopAll: vi.fn(), cancelInput: vi.fn(), stopSpeech: vi.fn(), voices: () => [], recognitionSupported: () => false } as unknown as VoiceMediaController & { stopAll: ReturnType<typeof vi.fn> }
}
beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings(); await db.settings.update('main', { aiEnabled: true, aiModel: 'synthetic/model' }) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('H01 per-connection stop', () => {
  it.each(['fileBridge', 'localActions', 'github'] as ConnectionKind[])('stopConnection(%s) invalidates only that gateway and leaves AI and the policy epoch alone', async kind => {
    const gateways = fakes(), before = (await db.settings.get('main'))!
    expect(await stopConnection(kind, host(gateways))).toBe('stopped')
    const called = Object.entries(gateways).filter(([, gateway]) => gateway.invalidate.mock.calls.length).map(([name]) => name)
    expect(called).toEqual([kind])
    const after = (await db.settings.get('main'))!
    expect(after).toEqual(before); expect(after.aiEnabled).toBe(true); expect(changePolicyFor(after).epoch).toBe(changePolicyFor(before).epoch)
  })
  it('reports a missing gateway as not available and a rejected invalidate as unconfirmed for that row only', async () => {
    const gateways = fakes()
    gateways.fileBridge.invalidate.mockRejectedValueOnce(new Error('main did not answer'))
    expect(await runRowStop(() => stopConnection('fileBridge', host(gateways)))).toBe('unconfirmed')
    expect(await runRowStop(() => stopConnection('localActions', host(gateways)))).toBe('stopped')
    expect(await runRowStop(() => stopConnection('github', { michiFileBridge: gateways.fileBridge }))).toBe('not_available')
    expect(gateways.github.invalidate).not.toHaveBeenCalled()
    await expect(stopConnection('unknown' as ConnectionKind, host(gateways))).rejects.toThrow('停止する接続')
  })
  it('hiding PC operations or the file bridge never invalidates a connection or stops audio', async () => {
    const gateways = fakes(), controller = voice({ music: 'playing', trackName: '本人の音源.wav' })
    vi.stubGlobal('window', host(gateways))
    for (const id of ['localActions', 'fileBridge', 'achievements', 'voice'] as const) await setFeatureVisible(id, false)
    for (const gateway of Object.values(gateways)) expect(gateway.invalidate).not.toHaveBeenCalled()
    expect(controller.stopAll).not.toHaveBeenCalled()
    expect((await db.settings.get('main'))!.aiEnabled).toBe(true)
  })
})

describe('H01 S17 AI row and GitHub status', () => {
  it('the AI row stop advances the epoch, turns AI off and revokes all three connections; a failed revoke shows as unconfirmed', async () => {
    const gateways = fakes()
    vi.stubGlobal('window', host(gateways))
    gateways.fileBridge.invalidate.mockRejectedValueOnce(new Error('main did not answer'))
    const before = changePolicyFor((await db.settings.get('main'))!).epoch
    expect(await stopAIProcessingRow()).toBe('unconfirmed')
    const after = (await db.settings.get('main'))!
    expect(after.aiEnabled).toBe(false); expect(changePolicyFor(after).epoch).toBe(before + 1)
    for (const gateway of Object.values(gateways)) expect(gateway.invalidate).toHaveBeenCalledOnce()
    await db.settings.update('main', { aiEnabled: true })
    expect(await stopAIProcessingRow()).toBe('stopped')
  })
  it('a file-connection row stop leaves the epoch, AI and the other gateways untouched', async () => {
    const gateways = fakes(), before = (await db.settings.get('main'))!
    expect(await runRowStop(() => stopConnection('fileBridge', host(gateways)))).toBe('stopped')
    expect(await db.settings.get('main')).toEqual(before)
    expect(gateways.localActions.invalidate).not.toHaveBeenCalled(); expect(gateways.github.invalidate).not.toHaveBeenCalled()
  })
  it('never contacts GitHub on open or after a row stop; the status check is an explicit button (SSR + loader, no DOM)', async () => {
    const gateways = fakes()
    ;(gateways.fileBridge.status as ReturnType<typeof vi.fn>).mockResolvedValue(null); (gateways.localActions.status as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const html = renderToStaticMarkup(<FeatureConnectionsView settings={{ ...settings, hiddenFeatures: ['achievements'] }} taskCount={0} gateways={gateways as ConnectionGateways} voice={voice({})} aiStatus={null} />)
    expect(html).toContain('未確認（確認するとGitHubに接続します）'); expect(html).toContain('>GitHubに接続して状態を確認</button>'); expect(html).toContain('状態確認はGitHubに接続します')
    await loadConnectionStatus(gateways as ConnectionGateways)
    expect(await runRowStop(() => stopConnection('github', host(gateways)))).toBe('stopped')
    await loadConnectionStatus(gateways as ConnectionGateways)
    expect(gateways.fileBridge.status).toHaveBeenCalledTimes(2)
    expect(gateways.github.status).not.toHaveBeenCalled()
  })
})

describe('H01 S17 views (server-rendered)', () => {
  it('the hidden voice panel still shows playback as active with the separate stop button, without stopping it', () => {
    const controller = voice({ music: 'playing', trackName: '本人の音源.wav' })
    const visible = renderToStaticMarkup(<VoiceMediaView controller={controller} onHiddenChange={() => undefined} />)
    expect(visible).toContain('表示を OFF'); expect(visible).toContain('再生中')
    const hidden = renderToStaticMarkup(<VoiceMediaView controller={controller} hidden onHiddenChange={() => undefined} />)
    expect(hidden).toContain('音声表示は OFF'); expect(hidden).toContain('動作中'); expect(hidden).toContain('音声と音楽を停止'); expect(hidden).toContain('音声コントロールを表示')
    expect(controller.stopAll).not.toHaveBeenCalled()
    const idle = renderToStaticMarkup(<VoiceMediaView controller={voice({})} hidden />)
    expect(idle).not.toContain('動作中'); expect(idle).toContain('音声と音楽を停止')
  })
  it('the OFF card for PC operations explains what is kept and offers the separate connection stop without calling it', () => {
    const gateways = fakes()
    const html = renderToStaticMarkup(<FeatureOffCard id="localActions" connection="localActions" gateways={gateways as ConnectionGateways} onShow={() => undefined} />)
    expect(html).toContain('PC操作は表示だけ停止中'); expect(html).toContain('保存データ・接続・権限・自動処理は変わりません'); expect(html).toContain('登録済みの操作と実行履歴は残ります')
    expect(html).toContain('PC操作を表示'); expect(html).toContain('この接続だけ停止')
    expect(gateways.localActions.invalidate).not.toHaveBeenCalled()
    const capture = renderToStaticMarkup(<FeatureOffCard id="captureImport" onShow={() => undefined} />)
    expect(capture).not.toContain('この接続だけ停止')
  })
  it('lists display, data, authority and background per feature; unprovided providers have no control', () => {
    const gateways = fakes(), controller = voice({ speech: 'speaking' })
    const html = renderToStaticMarkup(<FeatureConnectionsView settings={settings} taskCount={3} gateways={gateways as ConnectionGateways} voice={controller} aiStatus={{ configured: true } as never} />)
    for (const label of ['OpenRouter AI', 'ファイル接続/MCP', 'PC操作', 'API（このPC内）','署名Webhook','GitHub実績', '通知・Bug Me', '音声と音楽']) expect(html).toContain(`<h3>${label}</h3>`)
    for (const column of ['<dt>表示</dt>', '<dt>保存データ</dt>', '<dt>権限・接続</dt>', '<dt>バックグラウンド</dt>']) expect(html.split(column).length - 1).toBe(8)
    expect(html).toContain('非表示（データ・接続は維持）'); expect(html).toContain('APIキー保存済み'); expect(html).toContain('動作中')
    // The AI row's stop is the AI-processing stop and says so; the other five rows keep '個別停止'.
    expect(html.split('>個別停止</button>').length - 1).toBe(5); expect(html).toContain('>AI処理を停止（他の接続も取り消し）</button>')
    expect(html).toContain('ファイル接続/MCP・PC操作・GitHubの接続も取り消され'); expect(html).toContain('OpenRouter AIの停止はAI処理停止と同じで、epochを進め')
    for (const name of UNPROVIDED_CONNECTIONS) {
      const row = html.slice(html.indexOf(`<h3>${name}</h3>`)).split('</article>')[0]
      expect(row).toContain('この版では未提供（接続・自動処理なし）'); expect(row).not.toContain('<button'); expect(row).not.toContain('<input')
    }
    const missing = renderToStaticMarkup(<FeatureConnectionsView settings={{ ...settings, aiEnabled: false }} taskCount={0} gateways={{}} voice={controller} aiStatus={null} />)
    expect(missing.split('この環境では未提供').length - 1).toBe(5)
    // AI is already off and the three connections are absent: only notifications and voice keep a stop button.
    expect(missing.split('>個別停止</button>').length - 1).toBe(2)
    for (const gateway of Object.values(gateways)) expect(gateway.invalidate).not.toHaveBeenCalled()
  })
})
