import { useState } from 'react'
import type { Settings } from './domain'
import { saveEmbeddingSettings } from './ai-connection'
import { validateEmbeddingSettings } from './embedding-settings'

export default function EmbeddingSettingsView({ settings }: { settings: Settings }) {
  const [endpoint, setEndpoint] = useState(settings.embedding?.endpoint ?? 'http://127.0.0.1:8080')
  const [model, setModel] = useState(settings.embedding?.model ?? '')
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const value = () => ({ provider: 'loopback-openai-compatible' as const, endpoint: endpoint.trim(), model: model.trim() })
  async function act(fn: () => Promise<unknown>) { setBusy(true); setNotice(''); try { await fn() } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) } }
  return <details><summary>意味検索の端末内サービス（既定OFF）</summary>
    <p className="muted">本人が起動した端末内サービスだけを使います。APIキーは送りません。通信の許可と資料ごとの索引許可が必要です。</p>
    <label className="field">サービスURL<input value={endpoint} onChange={event => setEndpoint(event.target.value)} /></label>
    <label className="field">埋め込みモデル<input value={model} onChange={event => setModel(event.target.value)} /></label>
    <button disabled={busy} className="secondary-button" onClick={event => { if (!event.nativeEvent.isTrusted) return; void act(async () => { await saveEmbeddingSettings(value()); setNotice('意味検索の設定を保存しました。資料の索引は別に作成してください。') }) }}>意味検索の設定を保存</button>
    <button disabled={busy || !window.michiAI?.embedTexts} className="text-button" onClick={() => void act(async () => { const config = value(); validateEmbeddingSettings(config); await window.michiAI!.embedTexts!({ endpoint: config.endpoint, model: config.model, inputs: ['接続試験用の合成文字列'] }); setNotice('合成文字列の接続試験に成功しました。検索品質は未評価です。') })}>合成文字列で接続試験</button>
    <button disabled={busy} className="text-button" onClick={event => { if (event.nativeEvent.isTrusted) void act(async () => { await saveEmbeddingSettings(null); setNotice('意味検索をOFFにしました') }) }}>意味検索をOFFにする</button>
    {notice && <p role="status">{notice}</p>}
  </details>
}
