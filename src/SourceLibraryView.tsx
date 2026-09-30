import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { today, type Settings } from './domain'
import { currentSourceSummaries, defaultSourcePermissions, deleteSource, importLocalSource, permissionKeys, purgeExpiredSources, readSource, searchSources, setSourcePermissions, sourceDb as db, summarizeSelectedSource, type ContextSource, type SourcePermissions, type SourceProvider, type SourceSummary } from './source-library'

type Run = (fn: () => Promise<unknown>, success?: string) => Promise<boolean>
const providers: Record<SourceProvider, string> = { local: 'テキスト資料', slack: 'Slackの手動export', line: 'LINEの手動export', teams: 'Teamsの手動export', discord: 'Discordの手動export', other: 'その他の会話export' }
const labels: Record<keyof SourcePermissions, string> = { acquire: '取得・閲覧', retain: '保存', index: '検索・索引・要約作成', aiEgress: 'OpenRouterへのAI送信', notify: '通知', externalWrite: '外部サービスの変更', disclose: '別の送信先への開示' }
function PermissionFields({ value, onChange }: { value: SourcePermissions; onChange: (next: SourcePermissions) => void }) {
  return <div className="feature-toggle-grid">{permissionKeys.map(key => <label key={key}><input type="checkbox" aria-label={labels[key]} checked={value[key]} onChange={event => onChange({ ...value, [key]: event.target.checked })} />{labels[key]}</label>)}</div>
}
function retentionDate(value: string) { return value ? new Date(`${value}T23:59:59.999`).toISOString() : null }

function SourceItem({ source, settings, execute }: { source: ContextSource; settings: Settings; execute: Run }) {
  const [permissions, setPermissions] = useState(source.permissions), [model, setModel] = useState(source.allowedModels.join(',')), [until, setUntil] = useState(source.retentionUntil?.slice(0, 10) ?? '')
  const [text, setText] = useState<string | null>(null), [summaries, setSummaries] = useState<SourceSummary[]>([]), [busy, setBusy] = useState(false)
  const enabled = Boolean(settings.aiEnabled && settings.aiModel && window.michiAI && source.permissions.index && source.permissions.aiEgress && source.allowedModels.includes(settings.aiModel))
  const bridge = window.michiAI as { summarize: (request: { model: string; kind: 'source'; text: string }) => Promise<string> } | undefined
  useEffect(() => { let alive = true; void currentSourceSummaries(source.id).then(value => { if (alive) setSummaries(value) }).catch(() => {}); return () => { alive = false } }, [source.id, source.revision, settings.changePolicy?.epoch])
  async function summarize() {
    if (!enabled || busy) return
    setBusy(true)
    try {
      await execute(() => summarizeSelectedSource(source.id, source.revision, settings.aiModel!, value => bridge!.summarize({ model: settings.aiModel!, kind: 'source', text: value })), '選んだ資料の要約を別に保存しました')
      setSummaries(await currentSourceSummaries(source.id))
    } finally { setBusy(false) }
  }
  return <article className="card setting-section">
    <div className="card-heading"><div><h3>{source.title}</h3><small>{providers[source.provider]} · 内容版{source.latestRevision} · 許可版{source.permissionRevision}</small></div><button className="text-button" onClick={() => execute(() => deleteSource(source.id, source.revision), '資料本文と派生情報を削除しました')}>資料を削除</button></div>
    <p className="muted">本人が取り込んだ範囲：{source.coverage.fromDate}〜{source.coverage.toDate}。全履歴の取得は未確認。最後の取込確認 {new Date(source.coverage.lastCheckedAt).toLocaleString('ja-JP')}。</p>
    <p className="muted">{source.author ? `話者：${source.author}` : '話者未確認'} · {source.conversation ? `会話：${source.conversation}` : '会話名未設定'} · 保存期限 {source.retentionUntil ? new Date(source.retentionUntil).toLocaleString('ja-JP') : '期限なし'}</p>
    <details><summary>資料ごとの許可を編集</summary><PermissionFields value={permissions} onChange={setPermissions} /><label className="field">送信を許可するモデルID（カンマ区切り）<input aria-label={`${source.title}の許可モデル`} value={model} onChange={event => setModel(event.target.value)} /></label><label className="field">保持期限<input aria-label={`${source.title}の保持期限`} type="date" value={until} onChange={event => setUntil(event.target.value)} /></label><button className="secondary-button" onClick={() => execute(() => setSourcePermissions(source.id, source.revision, permissions, model.split(',').map(value => value.trim()).filter(Boolean), retentionDate(until)), '資料の許可を更新しました')}>許可を保存</button><p className="muted">許可の変更で古いAI応答・派生情報を失効します。保存を取り消すと、保存済み本文も削除します。</p></details>
    <div className="export-buttons"><button className="secondary-button" onClick={async () => { if (text !== null) { setText(null); return }; await execute(async () => { setText((await readSource(source.id)).snapshot.text) }) }}>{text === null ? '保存済み本文を表示' : '本文を閉じる'}</button>{enabled && <button className="secondary-button" disabled={busy} onClick={summarize}>{busy ? 'AI要約を待っています…' : 'この資料だけをOpenRouterで要約'}</button>}</div>
    {text !== null && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflowY: 'auto' }}>{text}</pre>}
    {summaries.filter(summary => summary.policyEpoch === (settings.changePolicy?.epoch ?? 0) && summary.sourcePermissionRevision === (settings.changePolicy?.sourcePermissionRevision ?? 0)).map(summary => <p key={summary.id} style={{ whiteSpace: 'pre-wrap' }}>AI要約（{summary.model}）：{summary.text}</p>)}
  </article>
}

export default function SourceLibraryView({ settings, run }: { settings: Settings; run?: Run }) {
  const [clock, setClock] = useState(() => Date.now())
  const [title, setTitle] = useState(''), [provider, setProvider] = useState<SourceProvider>('local'), [text, setText] = useState('')
  const [date, setDate] = useState(() => today()), [fromDate, setFromDate] = useState(() => today()), [toDate, setToDate] = useState(() => today())
  const [author, setAuthor] = useState(''), [conversation, setConversation] = useState(''), [externalId, setExternalId] = useState('')
  const [permissions, setPermissions] = useState(defaultSourcePermissions), [models, setModels] = useState(settings.aiModel ?? ''), [until, setUntil] = useState('')
  const [query, setQuery] = useState(''), [searchFrom, setSearchFrom] = useState('2020-01-01'), [searchTo, setSearchTo] = useState(() => today()), [result, setResult] = useState<Awaited<ReturnType<typeof searchSources>> | null>(null), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const sources = useLiveQuery(() => db.contextSources.where('ownerId').equals(settings.profileId).toArray(), [settings.profileId]) ?? []
  const own = sources.filter(source => !source.deletedAt && (!source.retentionUntil || Date.parse(source.retentionUntil) > clock)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const visibleHits = result?.hits.filter(hit => sources.some(source => source.id === hit.source.id && !source.deletedAt && source.permissions.acquire && source.permissions.retain && source.permissions.index && source.revision === hit.source.revision && (!source.retentionUntil || Date.parse(source.retentionUntil) > clock))) ?? []
  useEffect(() => { const purge = () => { setClock(Date.now()); void purgeExpiredSources().catch(error => setNotice(error instanceof Error ? error.message : String(error))) }; const initial = window.setTimeout(purge, 0), timer = window.setInterval(purge, 60000); return () => { window.clearTimeout(initial); window.clearInterval(timer) } }, [settings.profileId])
  useEffect(() => { const timer = window.setTimeout(() => setResult(null), 0); return () => window.clearTimeout(timer) }, [settings.changePolicy?.sourcePermissionRevision])
  async function execute(operation: () => Promise<unknown>, success = '') {
    try { const ok = run ? await run(operation, success) : (await operation(), true); setNotice(ok ? success : '処理できませんでした。入力した資料は残っています。'); return ok }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return false }
  }
  async function importText() {
    if (busy) return
    setBusy(true)
    try { if (await execute(() => importLocalSource({ title, provider, text, date, fromDate, toDate, author: author || null, conversation: conversation || null, externalId: externalId || null, sourceUrl: null, permissions, allowedModels: models.split(',').map(value => value.trim()).filter(Boolean), retentionUntil: retentionDate(until) }), '本人が選んだ資料を保存しました')) { setTitle(''); setText('') } }
    finally { setBusy(false) }
  }
  return <section className="card setting-section source-library">
    <div className="setting-heading"><div><h2>資料・会話履歴のローカル取込</h2><p>選んだテキスト資料と会話exportを端末に保存します。外部アカウントの認証・新着同期は未接続です。</p></div></div>
    <label className="field">UTF-8ファイルを選ぶ<input type="file" accept=".txt,.md,.csv,.json,text/plain" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (!file) return; void execute(async () => { if (file.size > 2 * 1024 * 1024) throw new Error('2MiB以下のテキストファイルを選んでください'); const content = await file.text(); if (content.length > 200000) throw new Error('資料は200000文字以内にしてください'); setText(content); setTitle(file.name.slice(0, 200)) }, '選んだファイルを取込前の下書きに読みました') }} /></label>
    <div className="form-grid"><label className="field">資料名<input aria-label="資料名" maxLength={200} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label><label className="field">由来<select value={provider} disabled={busy} onChange={event => setProvider(event.target.value as SourceProvider)}>{Object.entries(providers).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field">資料の日付<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label><label className="field">取得範囲の開始<input type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} /></label><label className="field">取得範囲の終了<input type="date" value={toDate} onChange={event => setToDate(event.target.value)} /></label><label className="field">話者（任意）<input value={author} maxLength={200} onChange={event => setAuthor(event.target.value)} /></label><label className="field">会話名（任意）<input value={conversation} maxLength={200} onChange={event => setConversation(event.target.value)} /></label><label className="field">外部ID（任意・文字列）<input value={externalId} maxLength={200} onChange={event => setExternalId(event.target.value)} /></label></div>
    <label className="field">資料の本文<textarea aria-label="資料の本文" rows={5} maxLength={200000} value={text} disabled={busy} onChange={event => setText(event.target.value)} /></label>
    <PermissionFields value={permissions} onChange={setPermissions} />
    <div className="form-grid"><label className="field">AI送信を許可するモデルID<input aria-label="資料の許可モデル" value={models} onChange={event => setModels(event.target.value)} /></label><label className="field">保持期限（空欄は期限なし）<input type="date" value={until} onChange={event => setUntil(event.target.value)} /></label></div>
    <button className="secondary-button" disabled={busy || !title.trim() || !text.trim()} onClick={importText}>本人が選んだ資料を保存</button>
    <p className="muted">取込時はAI送信をしません。通知・外部変更・開示の許可は個別に保存しますが、このローカル取込画面から配信や外部操作は実行しません。</p>
    <details><summary>保存済み資料の文字検索</summary><div className="form-grid"><label className="field">検索語<input aria-label="資料の検索語" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} /></label><label className="field">検索開始<input type="date" value={searchFrom} onChange={event => setSearchFrom(event.target.value)} /></label><label className="field">検索終了<input type="date" value={searchTo} onChange={event => setSearchTo(event.target.value)} /></label></div><button className="secondary-button" onClick={() => execute(async () => { setResult(await searchSources(query, searchFrom, searchTo)) })}>許可と期間を絞って検索</button>{result && <><p className="muted">{result.notice}</p>{visibleHits.map(hit => <div className="setting-line" key={hit.span.id}><div><strong>{hit.source.title} · 内容版{hit.snapshotRevision} · 行{hit.span.index + 1}</strong><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{hit.span.text}</p><small>取得範囲 {hit.source.coverage.fromDate}〜{hit.source.coverage.toDate} · 出典 {hit.source.id}/{hit.span.id}</small></div></div>)}{visibleHits.length === 0 && <p>取得済みの許可範囲に一致はありません。未取得期間の依頼の有無は不明です。</p>}</>}</details>
    {own.map(source => <SourceItem key={`${source.id}:${source.revision}`} source={source} settings={settings} execute={execute} />)}
    {own.length === 0 && <p className="muted">保存した有効な資料はまだありません。</p>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
