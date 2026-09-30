import { useEffect, useState } from 'react'
import { getBrowserVoiceMediaController, type VoiceMediaController, type VoiceMediaState } from './voice-media'

export function VoiceMediaView({ responseText = '', onTranscript, hidden = false, onHiddenChange, controller: provided }: { responseText?: string; onTranscript?: (text: string) => void; hidden?: boolean; onHiddenChange?: (hidden: boolean) => void; controller?: VoiceMediaController }) {
  const [media, setMedia] = useState<{ controller: VoiceMediaController; state: VoiceMediaState } | null>(null), [voiceId, setVoiceId] = useState(''), [error, setError] = useState(''), [voiceRevision, setVoiceRevision] = useState(0)
  const controller = media?.controller ?? null, state = media?.state ?? null
  useEffect(() => { const selected = provided ?? getBrowserVoiceMediaController(); const unsubscribe = selected.subscribe(next => setMedia({ controller: selected, state: next })); return () => { unsubscribe(); selected.cancelInput() } }, [provided])
  useEffect(() => { const synth = window.speechSynthesis; if (!synth) return; const changed = () => setVoiceRevision(value => value + 1); synth.addEventListener('voiceschanged', changed); return () => synth.removeEventListener('voiceschanged', changed) }, [])
  useEffect(() => { if (hidden) controller?.cancelInput() }, [controller, hidden])
  useEffect(() => { controller?.stopSpeech() }, [controller, responseText])
  // The service outlives this panel; hiding controls and stopping audio are separate operations.
  const voices = controller?.voices() ?? []
  const selectedVoice = voices.some(voice => voice.id === voiceId) ? voiceId : voices.find(voice => voice.lang.startsWith('ja'))?.id ?? voices[0]?.id ?? ''
  async function run(operation: () => void | Promise<void>) { setError(''); try { await operation() } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) } }
  if (!controller || !state) return <p>音声コントロールを準備しています。テキスト入力は続けられます。</p>
  const active = state.speech !== 'idle' || state.music === 'playing' || ['permission', 'recording', 'transcribing'].includes(state.input)
  if (hidden) return <section className="card" style={{ padding: 16 }} aria-label="音声表示はOFF"><p>音声表示は OFF です。タスクと会話は保存されています。{active ? '音声または音楽は動作中です。' : ''}</p>{onHiddenChange && <button className="secondary-button" onClick={() => onHiddenChange(false)}>音声コントロールを表示</button>}<button className="secondary-button" onClick={() => controller.stopAll()}>音声と音楽を停止</button></section>
  return <section className="card" style={{ padding: 20, marginTop: 16 }} aria-label="音声とFocus Music">
    <div className="card-heading"><h2>音声と Focus Music</h2>{onHiddenChange && <button className="text-button" onClick={() => onHiddenChange(true)}>表示を OFF</button>}</div>
    <p className="muted">端末内の声・本人が選んだ音源を使います。自動再生、音声の外部送信、原音保存は行いません。対応方式と日本語資産は端末により異なります。</p>
    <label className="field">読み上げる端末内の声<select data-voice-revision={voiceRevision} value={selectedVoice} onChange={event => setVoiceId(event.target.value)}><option value="">利用できる端末内の声がありません</option>{voices.map(voice => <option key={`${voice.id}:${voice.lang}`} value={voice.id}>{voice.name} · {voice.lang}</option>)}</select></label>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}><button className="secondary-button" disabled={!responseText.trim() || !selectedVoice} onClick={() => void run(() => controller.speakResponse(responseText, selectedVoice))}>選択した応答を読み上げ</button><button className="secondary-button" disabled={state.speech === 'idle'} onClick={() => controller.stopSpeech()}>読み上げを停止</button></div>
    <p aria-live="polite">{state.speech === 'speaking' ? '読み上げ中' : state.speech === 'starting' ? '読み上げを準備中' : '読み上げ停止中'}</p>
    <details><summary>端末内の音声入力</summary><p>本人が開始してから停止するまで認識します。停止後の文字起こしを編集し、テキスト入力へ追加できます。自動送信しません。</p>
      <button className="secondary-button" disabled={!controller.recognitionSupported() || state.input !== 'idle' && state.input !== 'reviewing'} onClick={() => void run(() => controller.startInput())}>音声入力を開始</button><button className="secondary-button" disabled={state.input !== 'recording'} onClick={() => controller.stopInput()}>認識を停止して確認</button><button className="secondary-button" disabled={state.input === 'idle'} onClick={() => controller.cancelInput()}>音声入力を取消</button>
      <p aria-live="polite">{state.input === 'recording' ? 'マイク使用中（最大60秒）' : state.input === 'permission' ? '端末内認識とマイクの許可を確認中' : state.input === 'transcribing' ? '文字起こしを待っています' : state.input === 'reviewing' ? '文字起こしを確認してください' : 'マイク停止中'}{!controller.recognitionSupported() ? ' · この端末は端末内の音声入力に未対応です。テキスト入力を利用できます。' : ''}</p>
      {state.input === 'reviewing' && <><label className="field">送信前に編集できる文字起こし<textarea value={state.transcript} maxLength={6000} onChange={event => controller.editTranscript(event.target.value)} /></label><button className="secondary-button" disabled={!onTranscript || !state.transcript.trim()} onClick={() => { onTranscript?.(state.transcript); controller.cancelInput() }}>テキスト入力へ追加</button></>}
    </details>
    <div className="divider" />
    <label className="field">本人の音源を選択（この起動中のみ・最大100 MiB）<input type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac" onChange={event => { const file = event.target.files?.[0]; if (file) void run(() => controller.selectTrack(file, file.name)); event.target.value = '' }} /></label>
    <p>{state.trackName || '音源未選択'} · {state.music === 'playing' ? '再生中' : '停止中'}</p>
    <button className="secondary-button" disabled={state.music === 'empty'} onClick={() => void run(() => controller.playMusic())}>音楽を再生</button><button className="secondary-button" disabled={state.music !== 'playing'} onClick={() => controller.pauseMusic()}>音楽を一時停止</button><button className="text-button" disabled={state.music === 'empty'} onClick={() => controller.clearTrack()}>音源を解除</button>
    <div className="form-grid" style={{ marginTop: 12 }}><label className="field">音量 {Math.round(state.volume * 100)}%<input type="range" min={0} max={100} value={state.volume * 100} onChange={event => controller.setVolume(Number(event.target.value) / 100)} /></label><label className="field">読み上げ中の音量比 {Math.round(state.duck * 100)}%<input type="range" min={0} max={100} value={state.duck * 100} onChange={event => controller.setDuck(Number(event.target.value) / 100)} /><small>0%で消音、100%で抑制なし。読み上げ終了・停止時に元の音量へ戻ります。</small></label></div>
    {state.notice && <p role="status">{state.notice}</p>}{error && <p role="alert">{error}</p>}
    <button className="secondary-button" onClick={() => controller.stopAll()}>音声と音楽をすべて停止</button>
  </section>
}
