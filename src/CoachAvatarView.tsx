import { useEffect, useMemo, useRef, useState } from 'react'
import { createAvatarController, importAvatarBundle, type AvatarBundle, type AvatarMode, type Live2DAdapter } from './avatar-media'
import ExternalLink from './ExternalLink'

export function CoachAvatarView({ name = 'コーチ', mode = 'idle', adapter = null, hidden = false, onHiddenChange }: { name?: string; mode?: AvatarMode; adapter?: Live2DAdapter | null; hidden?: boolean; onHiddenChange?: (value: boolean) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), [bundle, setBundle] = useState<AvatarBundle | null>(null), [state, setState] = useState<{ status: 'static' | 'loading' | 'animated'; notice: string }>({ status: 'static', notice: '' })
  const controller = useMemo(() => createAvatarController(adapter, setState), [adapter]), [stopped, setStopped] = useState(false), [rights, setRights] = useState(false), [rightsNote, setRightsNote] = useState(''), [error, setError] = useState(''), [imageURL, setImageURL] = useState(''), [imageFailed, setImageFailed] = useState(false)
  useEffect(() => () => controller.dispose(), [controller])
  useEffect(() => { if (controller && bundle && canvas.current && !hidden && !stopped) void controller.load(canvas.current, bundle); else controller?.fallback() }, [controller, bundle, hidden, stopped])
  useEffect(() => { controller?.setMode(mode) }, [controller, mode])
  useEffect(() => {
    if (!controller) return
    const motion = matchMedia('(prefers-reduced-motion: reduce)'), update = () => controller.setPaused(stopped || hidden || document.hidden || motion.matches)
    update(); motion.addEventListener('change', update); document.addEventListener('visibilitychange', update)
    return () => { motion.removeEventListener('change', update); document.removeEventListener('visibilitychange', update) }
  }, [controller, hidden, stopped])
  useEffect(() => () => { if (imageURL) URL.revokeObjectURL(imageURL) }, [imageURL])
  if (hidden) return <section className="card" style={{ padding: 16 }}><p>キャラクター表示は OFF です。テキストとタスク操作は利用できます。</p>{onHiddenChange && <button className="secondary-button" onClick={() => onHiddenChange(false)}>キャラクターを表示</button>}</section>
  return <section className="card" style={{ padding: 20, marginTop: 16 }} aria-label="任意のキャラクター表示"><div className="card-heading"><h2>{name}の表示</h2>{onHiddenChange && <button className="text-button" onClick={() => onHiddenChange(true)}>表示を OFF</button>}</div>
    <div style={{ display: 'grid', placeItems: 'center', minHeight: 160 }}><canvas ref={canvas} width={320} height={240} aria-label="Live2D表示" hidden={state.status !== 'animated'} style={{ maxWidth: '100%' }} />{state.status !== 'animated' && (imageURL && !imageFailed ? <img src={imageURL} alt={`${name}の静止キャラクター`} style={{ maxWidth: '100%', maxHeight: 200 }} onError={() => { setImageFailed(true); setError('静止画像を読めませんでした。同梱キャラクターを表示します。') }} /> : <svg viewBox="0 0 160 140" width="160" role="img" aria-label={`${name}の同梱静止キャラクター`}><rect x="20" y="15" width="120" height="110" rx="45" fill="#eee9ff" /><circle cx="57" cy="62" r="7" fill="#7561d9" /><circle cx="103" cy="62" r="7" fill="#7561d9" /><path d="M62 90 Q80 108 98 90" stroke="#7561d9" strokeWidth="6" fill="none" strokeLinecap="round" /></svg>)}</div>
    <p aria-live="polite">{mode === 'speaking' ? '話しています' : mode === 'listening' ? '聞いています' : mode === 'thinking' ? '考えています' : '通常表示'} · {state.status === 'animated' ? 'Live2D' : state.status === 'loading' ? 'モデル読込中・静止表示' : '静止表示'}</p>
    <button className="secondary-button" onClick={() => setStopped(value => !value)}>{stopped ? '動きを再開' : '動きを停止して静止表示'}</button>
    <details style={{ marginTop: 12 }}><summary>本人のキャラクター素材を選択</summary><p>素材はこの起動中だけ利用します。Live2D用モデル・実行SDKは同梱していません。素材とSDKの配布条件は別確認です。実際のLive2D表示と端末試験は素材・SDKの提供後に行います。</p>
      <label className="field">本人の静止画像（PNG/JPEG/WebP・最大10 MiB）<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024 || !file.size) { setError('PNG/JPEG/WebPの静止画像を10 MiBまで選択してください'); return }; setImageURL(URL.createObjectURL(file)); setImageFailed(false); setError('') }} /></label>{imageURL && <button className="text-button" onClick={() => { setImageURL(''); setImageFailed(false) }}>本人画像を解除</button>}
      <label style={{ display: 'block', marginTop: 12 }}><input type="checkbox" checked={rights} onChange={event => setRights(event.target.checked)} /> この端末で使うLive2D素材を所有しているか、利用許諾を確認しました</label><label className="field">利用権利の確認メモ<input value={rightsNote} maxLength={2000} onChange={event => setRightsNote(event.target.value)} /></label>
      <label className="field">model3.json を含む本人フォルダー<input type="file" multiple disabled={!rights || !rightsNote.trim()} {...{ webkitdirectory: '', directory: '' }} onChange={async event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; setError(''); try { setBundle(await importAvatarBundle(files, { ownsOrLicensed: true, usageNote: rightsNote, redistributionAllowed: false })) } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) } }} /></label>{bundle && <><p>選択中: {bundle.name} · {bundle.resources.size}参照ファイル。外部公開・再配布の許可は付与していません。</p><button className="text-button" onClick={() => setBundle(null)}>モデルを解除</button></>}
      <p><ExternalLink href="https://www.live2d.com/sdk/license/">Live2DのSDK利用・公開条件を確認</ExternalLink></p>
    </details>{state.notice && <p role="status">{state.notice}</p>}{!adapter && <p className="muted">Live2D SDKは未提供のため静止表示です。</p>}{error && <p role="alert">{error}</p>}
  </section>
}
