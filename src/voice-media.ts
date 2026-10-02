export type VoiceDescriptor = { id: string; name: string; lang: string; local: true }
export type TTSAdapter = { voices(): VoiceDescriptor[]; speak(text: string, voiceId: string, events: { start(): void; end(): void; error(message: string): void }): void; cancel(): void }
export type RecognitionAdapter = { local: true; available(): Promise<boolean>; start(events: { start(): void; result(text: string): void; end(): void; error(message: string): void }): void; stop(): void; cancel(): void }
export type MusicPort = Pick<HTMLAudioElement, 'volume' | 'src' | 'play' | 'pause' | 'load' | 'onended' | 'onerror'>
export type VoiceMediaState = { speech: 'idle' | 'starting' | 'speaking'; input: 'idle' | 'permission' | 'recording' | 'transcribing' | 'reviewing'; music: 'empty' | 'paused' | 'playing'; trackName: string; volume: number; duck: number; transcript: string; notice: string }
export type VoiceMediaDependencies = { tts: TTSAdapter | null; recognition: RecognitionAdapter | null; music: MusicPort; createURL(file: Blob): string; revokeURL(url: string): void }

export function createVoiceMediaController(dependencies: VoiceMediaDependencies) {
  let state: VoiceMediaState = { speech: 'idle', input: 'idle', music: 'empty', trackName: '', volume: .5, duck: .25, transcript: '', notice: '' }
  let speechEpoch = 0, inputEpoch = 0, musicEpoch = 0, trackURL: string | null = null, recordingTimer: ReturnType<typeof setTimeout> | null = null
  const listeners = new Set<(state: VoiceMediaState) => void>()
  const update = (change: Partial<VoiceMediaState>) => { state = { ...state, ...change }; for (const listener of listeners) listener({ ...state }) }
  const applyVolume = () => { dependencies.music.volume = state.volume * (state.speech === 'speaking' ? state.duck : 1) }
  const stopSpeech = () => { speechEpoch++; try { dependencies.tts?.cancel() } catch { /* Restore the music even if the platform cancellation failed. */ } finally { update({ speech: 'idle' }); applyVolume() } }
  const clearTimer = () => { if (recordingTimer !== null) clearTimeout(recordingTimer); recordingTimer = null }
  const cancelInput = () => { inputEpoch++; clearTimer(); try { dependencies.recognition?.cancel() } catch { /* The recording generation is already invalidated. */ } finally { update({ input: 'idle', transcript: '' }) } }
  const stopInput = () => { if (state.input !== 'recording') return; clearTimer(); update({ input: 'transcribing' }); try { dependencies.recognition?.stop() } catch { cancelInput(); update({ notice: '音声入力を停止しました。テキスト入力を続けられます。' }) } }
  dependencies.music.volume = state.volume
  dependencies.music.onended = () => { musicEpoch++; update({ music: trackURL ? 'paused' : 'empty' }) }
  dependencies.music.onerror = () => { musicEpoch++; dependencies.music.pause(); update({ music: trackURL ? 'paused' : 'empty', notice: 'この音源を再生できませんでした。別の本人音源を選んでください。' }) }

  return {
    snapshot: () => ({ ...state }),
    subscribe(listener: (state: VoiceMediaState) => void) { listeners.add(listener); listener({ ...state }); return () => { listeners.delete(listener) } },
    voices: () => dependencies.tts?.voices() ?? [],
    recognitionSupported: () => dependencies.recognition !== null,
    setVolume(volume: number) { if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('音量は0〜100%で指定してください'); update({ volume }); applyVolume() },
    setDuck(duck: number) { if (!Number.isFinite(duck) || duck < 0 || duck > 1) throw new Error('読み上げ中の音量比は0〜100%で指定してください'); update({ duck }); applyVolume() },
    selectTrack(file: Blob, name: string) {
      if (!(file instanceof Blob) || !file.size || file.size > 100 * 1024 * 1024 || typeof name !== 'string' || !name.trim() || name.length > 300) throw new Error('本人の音源は100 MiBまで選択できます')
      const next = dependencies.createURL(file)
      musicEpoch++; dependencies.music.pause(); dependencies.music.src = next; dependencies.music.load()
      if (trackURL) dependencies.revokeURL(trackURL)
      trackURL = next; update({ trackName: name, music: 'paused', notice: '' }); applyVolume()
    },
    async playMusic() {
      if (!trackURL) throw new Error('本人の音源を選択してください')
      const epoch = ++musicEpoch
      try { await dependencies.music.play(); if (epoch === musicEpoch) update({ music: 'playing', notice: '' }) }
      catch { if (epoch === musicEpoch) update({ music: 'paused', notice: '音楽の再生を開始できませんでした。再生ボタンを押して再試行できます。' }) }
    },
    pauseMusic() { musicEpoch++; dependencies.music.pause(); update({ music: trackURL ? 'paused' : 'empty' }) },
    clearTrack() { musicEpoch++; dependencies.music.pause(); dependencies.music.src = ''; dependencies.music.load(); if (trackURL) dependencies.revokeURL(trackURL); trackURL = null; update({ trackName: '', music: 'empty' }) },
    speakResponse(value: string, voiceId: string) {
      if (typeof value !== 'string' || !value.trim() || value.length > 10000) throw new Error('読み上げる応答本文は1〜10000文字で指定してください')
      const voice = dependencies.tts?.voices().find(item => item.id === voiceId && item.local === true)
      if (!dependencies.tts || !voice) throw new Error('端末内の読み上げ音声を利用できません。応答はテキストで読めます。')
      cancelInput(); stopSpeech(); const epoch = ++speechEpoch
      update({ speech: 'starting', notice: '' })
      const finish = (notice = '') => { if (epoch !== speechEpoch) return; update({ speech: 'idle', notice }); applyVolume() }
      try { dependencies.tts.speak(value, voice.id, { start: () => { if (epoch !== speechEpoch) return; update({ speech: 'speaking' }); applyVolume() }, end: () => finish(), error: () => finish('読み上げを停止しました。応答はテキストで読めます。') }) }
      catch { finish('読み上げを開始できませんでした。応答はテキストで読めます。') }
    },
    stopSpeech,
    async startInput() {
      const adapter = dependencies.recognition
      if (!adapter || adapter.local !== true) { update({ notice: '端末内の音声認識が未対応です。テキスト入力を利用してください。' }); return }
      stopSpeech(); cancelInput(); const epoch = ++inputEpoch
      update({ input: 'permission', transcript: '', notice: '' })
      try {
        if (!await adapter.available()) { if (epoch === inputEpoch) update({ input: 'idle', notice: '端末内の日本語認識資産が利用できません。テキスト入力を利用してください。自動ダウンロードは行いません。' }); return }
        if (epoch !== inputEpoch) return
        adapter.start({
          start: () => { if (epoch !== inputEpoch) return; update({ input: 'recording' }); recordingTimer = setTimeout(stopInput, 60000) },
          result: transcript => { if (epoch !== inputEpoch || typeof transcript !== 'string') return; clearTimer(); update({ input: 'reviewing', transcript: transcript.slice(0, 6000) }) },
          end: () => { if (epoch !== inputEpoch) return; clearTimer(); update({ input: state.transcript.trim() ? 'reviewing' : 'idle' }) },
          error: code => { if (epoch !== inputEpoch) return; cancelInput(); update({ notice: ['not-allowed','service-not-allowed'].includes(code) ? 'マイクが許可されていません。テキスト入力を続けられます。' : '音声認識を利用できませんでした。テキスト入力を続けられます。' }) },
        })
      } catch { if (epoch === inputEpoch) { cancelInput(); update({ notice: '音声入力を開始できませんでした。テキスト入力を続けられます。' }) } }
    },
    stopInput, cancelInput,
    editTranscript(value: string) { if (state.input !== 'reviewing' || typeof value !== 'string' || value.length > 6000) throw new Error('確認中の文字起こしは6000文字まで編集できます'); update({ transcript: value }) },
    stopAll() { stopSpeech(); cancelInput(); musicEpoch++; dependencies.music.pause(); update({ music: trackURL ? 'paused' : 'empty' }) },
    dispose() { stopSpeech(); cancelInput(); musicEpoch++; dependencies.music.pause(); dependencies.music.src = ''; dependencies.music.load(); if (trackURL) dependencies.revokeURL(trackURL); trackURL = null; listeners.clear(); dependencies.music.onended = null; dependencies.music.onerror = null },
  }
}
export type VoiceMediaController = ReturnType<typeof createVoiceMediaController>

type BrowserRecognition = { processLocally: boolean; lang: string; continuous: boolean; interimResults: boolean; onstart: (() => void) | null; onend: (() => void) | null; onerror: ((event: { error?: string }) => void) | null; onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null; start(): void; stop(): void; abort(): void }
type RecognitionConstructor = { new(): BrowserRecognition; available?(options: { langs: string[]; processLocally: true }): Promise<string> }
export function createBrowserRecognitionAdapter(host: { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }): RecognitionAdapter | null {
  const Recognition = host.SpeechRecognition ?? host.webkitSpeechRecognition
  if (!Recognition?.available) return null
  let active: BrowserRecognition | null = null
  try { if (!('processLocally' in new Recognition())) return null } catch { return null }
  return {
    local: true,
    available: async () => await Recognition.available!({ langs: ['ja-JP'], processLocally: true }) === 'available',
    start(events) {
      if (active) active.abort()
      const recognition = new Recognition(); recognition.processLocally = true
      if (recognition.processLocally !== true) throw new Error('端末内の音声認識が未対応です')
      recognition.lang = 'ja-JP'; recognition.continuous = false; recognition.interimResults = false
      recognition.onstart = events.start; recognition.onend = () => { if (active === recognition) active = null; events.end() }; recognition.onerror = event => events.error(event.error ?? 'recognition-error')
      recognition.onresult = event => { const final = Array.from(event.results).filter(result => result.isFinal).map(result => result[0].transcript).join(''); if (final.trim()) events.result(final) }
      active = recognition; recognition.start()
    },
    stop: () => { active?.stop() },
    cancel: () => { const previous = active; active = null; previous?.abort() },
  }
}

export function createBrowserTTSAdapter(synthesis: SpeechSynthesis, createUtterance: (text: string) => SpeechSynthesisUtterance): TTSAdapter {
  return {
    voices: () => synthesis.getVoices().filter(voice => voice.localService === true).map(voice => ({ id: voice.voiceURI, name: voice.name, lang: voice.lang, local: true })),
    speak(text, voiceId, events) { const voice = synthesis.getVoices().find(item => item.voiceURI === voiceId && item.localService === true); if (!voice) throw new Error('端末内の声がありません'); const utterance = createUtterance(text); utterance.voice = voice; utterance.lang = voice.lang; utterance.onstart = events.start; utterance.onend = events.end; utterance.onerror = () => events.error('読み上げを利用できません'); synthesis.speak(utterance) },
    cancel: () => { synthesis.cancel() },
  }
}

let browserController: VoiceMediaController | null = null
export function getBrowserVoiceMediaController(): VoiceMediaController {
  if (browserController) return browserController
  const music = new Audio()
  browserController = createVoiceMediaController({ music, tts: typeof window.speechSynthesis === 'object' && typeof window.SpeechSynthesisUtterance === 'function' ? createBrowserTTSAdapter(window.speechSynthesis, text => new SpeechSynthesisUtterance(text)) : null, recognition: createBrowserRecognitionAdapter(window as unknown as Parameters<typeof createBrowserRecognitionAdapter>[0]), createURL: file => URL.createObjectURL(file), revokeURL: url => URL.revokeObjectURL(url) })
  document.addEventListener('visibilitychange', () => { if (document.hidden) browserController?.cancelInput() })
  return browserController
}
export function stopBrowserVoiceMedia(): void { browserController?.stopAll() }
