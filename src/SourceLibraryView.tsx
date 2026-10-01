import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { today, type Settings } from './domain'
import { currentSourceSummaries, defaultSourcePermissions, deleteSource, importLocalSource, permissionKeys, purgeExpiredSources, readSource, searchSources, setSourcePermissions, sourceDb as db, sourceDerivedCounts, summarizeSelectedSource, type ContextSource, type SourceDeletionReport, type SourceDerivedCounts, type SourcePermissions, type SourceProvider, type SourceSummary } from './source-library'
import { defaultSourceRetention, retentionDefaults, retentionDraft, retentionValue } from './retention-defaults'
import RetentionChoice from './RetentionChoice'

type Run = (fn: () => Promise<unknown>, success?: string) => Promise<boolean>
const providers: Record<SourceProvider, string> = { local: 'テキスト資料', slack: 'Slackの手動export', line: 'LINEの手動export', teams: 'Teamsの手動export', discord: 'Discordの手動export', other: 'その他の会話export' }
const labels: Record<keyof SourcePermissions, string> = { acquire: '取得・閲覧', retain: '保存', index: '検索・索引・要約作成', aiEgress: 'OpenRouterへのAI送信', notify: '通知', externalWrite: '外部サービスの変更', disclose: '別の送信先への開示' }
function PermissionFields({ value, onChange }: { value: SourcePermissions; onChange: (next: SourcePermissions) => void }) {
  return <div className="feature-toggle-grid">{permissionKeys.map(key => <label key={key}><input type="checkbox" aria-label={labels[key]} checked={value[key]} onChange={event => onChange({ ...value, [key]: event.target.checked })} />{labels[key]}</label>)}</div>
}
const erasedLabels: [keyof SourceDeletionReport['erased'], string][] = [['original', '原文（保存本文）'], ['summaries', 'AI要約'], ['caches', 'cache・取込元データ'], ['embeddings', 'embedding'], ['candidates', '検出候補'], ['memories', '資料由来の記憶'], ['aiReplies', '資料を参照したAI返信'], ['taskQuotes', 'タスク内の資料引用'], ['legacyCopies', '旧形式メモの受領記録・監査の複写']]
export function DeletionReport({ report, onClose }: { report: SourceDeletionReport; onClose: () => void }) {
  const unmigrated = report.reviewTasks.filter(task => task.state === 'exact').length, edited = report.reviewTasks.length - unmigrated
  return <div className="source-deletion-report" role="dialog" aria-label="資料の削除結果"><h3>資料を削除しました</h3>
    <ul>{erasedLabels.map(([key, label]) => <li key={key}>{label}：{report.erased[key]}件を消去</li>)}</ul>
    {unmigrated > 0 && <p role="alert">旧形式の機械生成メモ（未移行）{unmigrated}件は、次回起動時の移行まで残ります。資料由来のため外部へは送りません。</p>}
    {edited > 0 && <p role="alert">旧形式の引用を本人が編集したメモのタスク{edited}件は、本人の文として消さずに残しました。資料由来の可能性があるため外部へは送りません。タスク編集画面で確認してください。</p>}
    <p>{report.sentModels.length ? `この資料の本文・引用を外部AIへ送信した記録があります（要約・検出・会話、送信を試みた記録を含む: モデル ${report.sentModels.join('、')}）。提供先へ渡った内容は回収できません。` : 'この資料の外部AI送信記録は見つかりませんでした。送信済みの内容がある場合、提供先から回収できません。'}</p>
    <p className="muted">タスクの題名・期限・点数・完了実績・台帳は変更していません。資料の行は題名を伏せた削除記録として残り、この端末で古いバックアップを復元しても再び削除します。</p>
    <button className="secondary-button" onClick={onClose}>閉じる</button></div>
}
const derivedText = (counts: SourceDerivedCounts | undefined) => `派生物：AI要約${counts?.summaries ?? 0}件 · cache${counts?.caches ?? 0}件 · embedding${counts?.embeddings ?? 0}件 · 検出候補${counts?.candidates ?? 0}件 · タスク内引用${counts?.taskQuotes ?? 0}件 · 記憶${counts?.memories ?? 0}件`

function SourceItem({ source, settings, execute, counts, onDeleted }: { source: ContextSource; settings: Settings; execute: Run; counts: SourceDerivedCounts | undefined; onDeleted: (report: SourceDeletionReport) => void }) {
  const [permissions, setPermissions] = useState(source.permissions), [model, setModel] = useState(source.allowedModels.join(',')), [retention, setRetention] = useState(() => retentionDraft(source.retentionUntil))
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
    <div className="card-heading"><div><h3>{source.title}</h3><small>{providers[source.provider]} · 内容版{source.latestRevision} · 許可版{source.permissionRevision}</small></div><button className="text-button" onClick={() => execute(async () => onDeleted(await deleteSource(source.id, source.revision)), '資料本文と派生情報を削除しました')}>資料を削除</button></div>
    <p className="muted">本人が取り込んだ範囲：{source.coverage.fromDate}〜{source.coverage.toDate}。全履歴の取得は未確認。最後の取込確認 {new Date(source.coverage.lastCheckedAt).toLocaleString('ja-JP')}。</p>
    <p className="muted">{source.author ? `話者：${source.author}` : '話者未確認'} · {source.conversation ? `会話：${source.conversation}` : '会話名未設定'} · 保存期限 {source.retentionUntil ? new Date(source.retentionUntil).toLocaleString('ja-JP') : '期限なし（長期保存）'}</p>
    <p className="muted" data-derived-counts={source.id}>{derivedText(counts)}</p>
    <details><summary>資料ごとの許可を編集</summary><PermissionFields value={permissions} onChange={setPermissions} /><label className="field">送信を許可するモデルID（カンマ区切り）<input aria-label={`${source.title}の許可モデル`} value={model} onChange={event => setModel(event.target.value)} /></label><RetentionChoice label={`${source.title}の保持期限`} value={retention} onChange={setRetention} defaultNote="既存資料の期限は本人が変更するまで変わりません。" /><button className="secondary-button" onClick={() => execute(() => setSourcePermissions(source.id, source.revision, permissions, model.split(',').map(value => value.trim()).filter(Boolean), retentionValue(retention)), '資料の許可を更新しました')}>許可を保存</button><p className="muted">許可の変更で古いAI応答・派生情報を失効します。保存を取り消すと、保存済み本文も削除します。</p></details>
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
  const [permissions, setPermissions] = useState(defaultSourcePermissions), [models, setModels] = useState(settings.aiModel ?? ''), [retention, setRetention] = useState(() => retentionDraft(defaultSourceRetention('local')))
  const [report, setReport] = useState<SourceDeletionReport | null>(null)
  const [query, setQuery] = useState(''), [searchFrom, setSearchFrom] = useState('2020-01-01'), [searchTo, setSearchTo] = useState(() => today()), [result, setResult] = useState<Awaited<ReturnType<typeof searchSources>> | null>(null), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const sources = useLiveQuery(() => db.contextSources.where('ownerId').equals(settings.profileId).toArray(), [settings.profileId]) ?? []
  const counts = useLiveQuery(() => sourceDerivedCounts(settings.profileId), [settings.profileId])
  const unlimitedCount = sources.filter(source => !source.deletedAt && source.retentionUntil === null && source.provider !== 'local').length
  const own = sources.filter(source => !source.deletedAt && (!source.retentionUntil || Date.parse(source.retentionUntil) > clock)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const visibleHits = result?.hits.filter(hit => sources.some(source => source.id === hit.source.id && !source.deletedAt && source.permissions.acquire && source.permissions.retain && source.permissions.index && source.revision === hit.source.revision && (!source.retentionUntil || Date.parse(source.retentionUntil) > clock))) ?? []
  useEffect(() => { const purge = () => { setClock(Date.now()); void purgeExpiredSources().catch(error => setNotice(error instanceof Error ? error.message : String(error))) }; const initial = window.setTimeout(purge, 0), timer = window.setInterval(purge, 60000); window.addEventListener('focus', purge); return () => { window.clearTimeout(initial); window.clearInterval(timer); window.removeEventListener('focus', purge) } }, [settings.profileId, settings.datasetId])
  useEffect(() => { const timer = window.setTimeout(() => setResult(null), 0); return () => window.clearTimeout(timer) }, [settings.changePolicy?.sourcePermissionRevision])
  async function execute(operation: () => Promise<unknown>, success = '') {
    try { const ok = run ? await run(operation, success) : (await operation(), true); setNotice(ok ? success : '処理できませんでした。入力した資料は残っています。'); return ok }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return false }
  }
  async function importText() {
    if (busy) return
    setBusy(true)
    try { if (await execute(() => importLocalSource({ title, provider, text, date, fromDate, toDate, author: author || null, conversation: conversation || null, externalId: externalId || null, sourceUrl: null, permissions, allowedModels: models.split(',').map(value => value.trim()).filter(Boolean), retentionUntil: retentionValue(retention) }), '本人が選んだ資料を保存しました')) { setTitle(''); setText('') } }
    finally { setBusy(false) }
  }
  return <section className="card setting-section source-library">
    <div className="setting-heading"><div><h2>資料・会話履歴のローカル取込</h2><p>選んだテキスト資料と会話exportを端末に保存します。外部アカウントの認証・新着同期は未接続です。</p></div></div>
    <label className="field">UTF-8ファイルを選ぶ<input type="file" accept=".txt,.md,.csv,.json,text/plain" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (!file) return; void execute(async () => { if (file.size > 2 * 1024 * 1024) throw new Error('2MiB以下のテキストファイルを選んでください'); const content = await file.text(); if (content.length > 200000) throw new Error('資料は200000文字以内にしてください'); setText(content); setTitle(file.name.slice(0, 200)) }, '選んだファイルを取込前の下書きに読みました') }} /></label>
    <div className="form-grid"><label className="field">資料名<input aria-label="資料名" maxLength={200} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label><label className="field">由来<select value={provider} disabled={busy} onChange={event => { const next = event.target.value as SourceProvider; setProvider(next); setRetention(retentionDraft(defaultSourceRetention(next))) }}>{Object.entries(providers).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field">資料の日付<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label><label className="field">取得範囲の開始<input type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} /></label><label className="field">取得範囲の終了<input type="date" value={toDate} onChange={event => setToDate(event.target.value)} /></label><label className="field">話者（任意）<input value={author} maxLength={200} onChange={event => setAuthor(event.target.value)} /></label><label className="field">会話名（任意）<input value={conversation} maxLength={200} onChange={event => setConversation(event.target.value)} /></label><label className="field">外部ID（任意・文字列）<input value={externalId} maxLength={200} onChange={event => setExternalId(event.target.value)} /></label></div>
    <label className="field">資料の本文<textarea aria-label="資料の本文" rows={5} maxLength={200000} value={text} disabled={busy} onChange={event => setText(event.target.value)} /></label>
    <PermissionFields value={permissions} onChange={setPermissions} />
    <div className="form-grid"><label className="field">AI送信を許可するモデルID<input aria-label="資料の許可モデル" value={models} onChange={event => setModels(event.target.value)} /></label></div>
    <RetentionChoice label="取り込む資料の保持期限" value={retention} onChange={setRetention} disabled={busy} defaultNote={provider === 'local' ? 'ローカル文書の期限は本人が選びます（既定は期限なし）。' : `会話export・引用の既定は取込から${retentionDefaults.importedConversationDays}日です。長期保存は本人が明示的に選んでください。`} />
    {unlimitedCount > 0 && <p className="muted">既存の会話資料のうち期限なしは{unlimitedCount}件です。既存資料の期限は自動では変更しません。</p>}
    <button className="secondary-button" disabled={busy || !title.trim() || !text.trim()} onClick={importText}>本人が選んだ資料を保存</button>
    <p className="muted">取込時はAI送信をしません。通知・外部変更・開示の許可は個別に保存しますが、このローカル取込画面から配信や外部操作は実行しません。</p>
    <details><summary>保存済み資料の文字検索</summary><div className="form-grid"><label className="field">検索語<input aria-label="資料の検索語" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} /></label><label className="field">検索開始<input type="date" value={searchFrom} onChange={event => setSearchFrom(event.target.value)} /></label><label className="field">検索終了<input type="date" value={searchTo} onChange={event => setSearchTo(event.target.value)} /></label></div><button className="secondary-button" onClick={() => execute(async () => { setResult(await searchSources(query, searchFrom, searchTo)) })}>許可と期間を絞って検索</button>{result && <><p className="muted">{result.notice}</p>{visibleHits.map(hit => <div className="setting-line" key={hit.span.id}><div><strong>{hit.source.title} · 内容版{hit.snapshotRevision} · 行{hit.span.index + 1}</strong><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{hit.span.text}</p><small>取得範囲 {hit.source.coverage.fromDate}〜{hit.source.coverage.toDate} · 出典 {hit.source.id}/{hit.span.id}</small></div></div>)}{visibleHits.length === 0 && <p>取得済みの許可範囲に一致はありません。未取得期間の依頼の有無は不明です。</p>}</>}</details>
    {report && <DeletionReport report={report} onClose={() => setReport(null)} />}
    {own.map(source => <SourceItem key={`${source.id}:${source.revision}`} source={source} settings={settings} execute={execute} counts={counts?.get(source.id)} onDeleted={setReport} />)}
    {own.length === 0 && <p className="muted">保存した有効な資料はまだありません。</p>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
