import { describe, expect, it, vi } from 'vitest'
import { createBrowserRecognitionAdapter, createBrowserTTSAdapter, createVoiceMediaController, type MusicPort, type RecognitionAdapter, type TTSAdapter } from './voice-media'

function fixture() {
  let events!: Parameters<TTSAdapter['speak']>[2], input!: Parameters<RecognitionAdapter['start']>[0]
  const music = { volume: .8, src: '', play: vi.fn(async () => {}), pause: vi.fn(), load: vi.fn(), onended: null as MusicPort['onended'], onerror: null as MusicPort['onerror'] }
  const tts: TTSAdapter = { voices: () => [{ id: 'local-ja', name: '本人端末の声', lang: 'ja-JP', local: true }], speak: vi.fn((_text, _voice, callbacks) => { events = callbacks }), cancel: vi.fn() }
  const recognition: RecognitionAdapter = { local: true, available: vi.fn(async () => true), start: vi.fn(callbacks => { input = callbacks }), stop: vi.fn(), cancel: vi.fn() }
  const revokeURL = vi.fn(), controller = createVoiceMediaController({ music, tts, recognition, createURL: () => 'blob:local-music', revokeURL })
  return { music, tts, recognition, revokeURL, controller, events: () => events, input: () => input }
}
describe('本人操作の端末内音声と音楽', () => {
  it.each(['end', 'error', 'cancel'] as const)('読み上げ%s後にduck前の音量を戻し、音楽を勝手に再生しない', async outcome => {
    const f = fixture(); f.controller.setVolume(.8); f.controller.setDuck(.25); f.controller.selectTrack(new Blob(['music']), '本人の音源.mp3')
    expect(f.music.play).not.toHaveBeenCalled()
    await f.controller.playMusic(); f.controller.speakResponse('選んだ応答本文', 'local-ja'); f.events().start()
    expect(f.music.volume).toBeCloseTo(.2)
    if (outcome === 'end') f.events().end(); else if (outcome === 'error') f.events().error('エンジンエラー'); else f.controller.stopSpeech()
    expect(f.music.volume).toBeCloseTo(.8); expect(f.music.play).toHaveBeenCalledTimes(1)
    expect(f.controller.snapshot().speech).toBe('idle')
    expect(f.tts.speak).toHaveBeenCalledWith('選んだ応答本文', 'local-ja', expect.any(Object))
  })
  it('本人が読み上げ中に音量変更した場合は新しい指定値へ復元し、古いutterance終了を無視する', () => {
    const f = fixture(); f.controller.speakResponse('最初の応答', 'local-ja'); const first = f.events(); first.start()
    f.controller.speakResponse('新しい応答', 'local-ja'); f.events().start(); f.controller.setVolume(.6); first.end()
    expect(f.music.volume).toBeCloseTo(.15); expect(f.controller.snapshot().speech).toBe('speaking')
    f.events().end(); expect(f.music.volume).toBeCloseTo(.6)
  })
  it('cancel例外でも音量を戻し、音源切替/解除時にblob URLを解放する', () => {
    const f = fixture(); f.controller.selectTrack(new Blob(['music']), '本人音源.mp3'); f.controller.speakResponse('応答', 'local-ja'); f.events().start()
    vi.mocked(f.tts.cancel).mockImplementation(() => { throw new Error('cancel故障') })
    f.controller.stopAll(); expect(f.music.volume).toBeCloseTo(.5); expect(f.music.pause).toHaveBeenCalled()
    f.controller.selectTrack(new Blob(['new']), '新音源.mp3'); expect(f.revokeURL).toHaveBeenCalledTimes(1)
    f.controller.clearTrack(); expect(f.revokeURL).toHaveBeenCalledTimes(2); expect(f.music.src).toBe('')
  })
  it('マイク拒否・取消後の遅い認識結果を捨て、テキスト入力の縮退案内を出す', async () => {
    const f = fixture(); await f.controller.startInput(); f.input().error('not-allowed')
    expect(f.controller.snapshot()).toMatchObject({ input: 'idle', transcript: '', notice: 'マイクが許可されていません。テキスト入力を続けられます。' })
    await f.controller.startInput(); f.input().start(); const old = f.input(); f.controller.cancelInput(); old.result('取消した原音からの文字')
    expect(f.controller.snapshot()).toMatchObject({ input: 'idle', transcript: '' })
  })
  it('端末資産なしは録音を開始せず、認識後は編集・本人確認を待つ', async () => {
    const f = fixture(); vi.mocked(f.recognition.available).mockResolvedValueOnce(false)
    await f.controller.startInput(); expect(f.recognition.start).not.toHaveBeenCalled(); expect(f.controller.snapshot().notice).toContain('自動ダウンロードは行いません')
    await f.controller.startInput(); f.input().start(); f.controller.stopInput(); expect(f.recognition.stop).toHaveBeenCalled()
    f.input().result('今週のタスクを確認'); f.input().end(); f.controller.editTranscript('来週のタスクを確認')
    expect(f.controller.snapshot()).toMatchObject({ input: 'reviewing', transcript: '来週のタスクを確認' })
  })
  it('音楽のplay拒否をpausedで表示し、遅いplay解決で停止状態を覆さない', async () => {
    const f = fixture(); f.controller.selectTrack(new Blob(['music']), '本人音源.mp3'); vi.mocked(f.music.play).mockRejectedValueOnce(new Error('NotAllowed'))
    await f.controller.playMusic(); expect(f.controller.snapshot().music).toBe('paused')
    let resolve!: () => void; vi.mocked(f.music.play).mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
    const playing = f.controller.playMusic(); f.controller.pauseMusic(); resolve(); await playing
    expect(f.controller.snapshot().music).toBe('paused')
  })
  it('remoteの読み上げ声を除外し、processLocallyを強制できない認識には接続しない', async () => {
    const synthesis = { getVoices: () => [{ voiceURI: 'remote', name: '外部声', lang: 'ja-JP', localService: false }, { voiceURI: 'local', name: '端末声', lang: 'ja-JP', localService: true }], speak: vi.fn(), cancel: vi.fn() }
    const tts = createBrowserTTSAdapter(synthesis as unknown as SpeechSynthesis, text => ({ text }) as SpeechSynthesisUtterance)
    expect(tts.voices().map(voice => voice.id)).toEqual(['local'])
    expect(() => tts.speak('本人の応答', 'remote', { start() {}, end() {}, error() {} })).toThrow('端末内')
    expect(synthesis.speak).not.toHaveBeenCalled()
    expect(createBrowserRecognitionAdapter({})).toBeNull()
  })
})
