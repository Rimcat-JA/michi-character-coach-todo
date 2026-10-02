import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import type { Settings } from './domain'
import type { CalendarRulesState } from './calendar-resolver'
import { acknowledgeScheduleRefresh, pendingScheduleRefreshFile, refreshStatuses, recordScheduleAcquisitionStatus } from './schedule-refresh'
import type { ScheduleRefreshInbox, ScheduleRefreshStatus } from './schedule-refresh-types'
import CalendarImportView from './CalendarImportView'
import CalendarCSVImportView from './CalendarCSVImportView'
const labels = { unconfirmed: '未確認', current: '最新確認済', pending: '変更あり確認待ち', stale: '取得失敗・古い', paused: '設定により取得停止' }
export function ScheduleSourcesPanel({ state, settings }: { state: CalendarRulesState; settings: Settings }) {
  const [statuses, setStatuses] = useState<ScheduleRefreshStatus[]>([]), [sourceId, setSourceId] = useState(''), [kind, setKind] = useState<'url'|'file'>('url'), [url, setURL] = useState(''), [format, setFormat] = useState<'ics'|'csv'|'pdf'|'xlsx'>('ics'), [policy, setPolicy] = useState('manual'), [validFrom, setValidFrom] = useState(state.contexts[0]?.validFrom ?? ''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [selected, setSelected] = useState<{ row: ScheduleRefreshInbox; file: File } | null>(null)
  const pending = useLiveQuery(() => db.scheduleRefreshInbox.where('state').equals('pending').filter(row => row.ownerId === settings.profileId && row.datasetId === settings.datasetId).toArray(), [settings.profileId, settings.datasetId]) ?? []
  useEffect(() => {
    if (!window.michiScheduleRefresh) return
    let active = true
    const update = () => { void refreshStatuses().then(rows => { if (active) setStatuses(rows) }).catch(error => { if (active) setMessage(String(error)) }) }
    update();const timer = setInterval(update, 3000)
    return () => { active = false; clearInterval(timer) }
  }, [settings.profileId, settings.datasetId])
  async function run(action: () => Promise<unknown>) { setBusy(true); setMessage(''); try { await action(); const rows = await refreshStatuses(); await recordScheduleAcquisitionStatus(rows); setStatuses(rows) } catch (error) { setMessage(String(error)) } finally { setBusy(false) } }
  async function applied() { const input = selected; setSelected(null); if (input) { try { await acknowledgeScheduleRefresh(input.row); setStatuses(await refreshStatuses()) } catch { setMessage('資料は保存済みです。取得側の受領記録を確認してください。') } } }
  return <section className="card setting-section" aria-label="予定資料の更新取得"><h2>予定資料の更新取得</h2><p>最初に資料を取り込み、固定の取込元を選んで取得先を登録してください。取得はアプリの起動中だけ行い、変更の保存と発生回への反映はそれぞれ確認します。</p><a href="#calendar-integrations">読取・書込の対応状況</a>
    {!window.michiScheduleRefresh ? <p>ブラウザー版ではURL取得・ファイル監視は未対応です。手動ファイル取込を利用してください。</p> : <>
      {statuses.some(row => row.qaFixture) && <p role="status">合成サーバー：127.0.0.1だけを使う試験です。実サービスへの接続確認は未実施です。</p>}
      <label>更新する取込元<select value={sourceId} disabled={busy} onChange={event => { const source = state.sources.find(row => row.id === event.target.value);setSourceId(event.target.value);setFormat(source?.ics ? 'ics' : 'csv') }}><option value="">取込元を選ぶ</option>{state.sources.filter(row => row.ics || row.csv && !row.csv.retiredAt).map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
      <label>取得方式<select value={kind} disabled={busy} onChange={event => setKind(event.target.value as 'url'|'file')}><option value="url">HTTPS URL</option><option value="file">本人が選んだローカルファイル</option></select></label>
      {kind === 'url' && <label>資料URL<input type="url" value={url} maxLength={2048} disabled={busy} onChange={event => setURL(event.target.value)} placeholder="https://…" /></label>}
      <label>資料形式<select value={format} disabled={busy} onChange={event => setFormat(event.target.value as typeof format)}>{(['ics','csv','pdf','xlsx'] as const).map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
      <label>確認間隔<select value={policy} disabled={busy} onChange={event => setPolicy(event.target.value)}><option value="manual">手動</option><option value="daily">毎日</option><option value="weekly">毎週</option><option value="window_dense">有効開始の前後14日は毎日・ほかは毎週</option></select></label><label>資料の有効開始<input type="date" value={validFrom} disabled={busy} onChange={event => setValidFrom(event.target.value)} /></label>
      <button type="button" disabled={busy || !sourceId} onClick={() => void run(async () => { const result = await window.michiScheduleRefresh!.request({ action: 'configure', sourceId, format, kind, url: kind === 'url' ? url : null, refreshPolicy: policy, validFrom });if(result)setMessage('取得先を登録しました。保存済みの予定は変更していません。') })}>取得先を確認して登録</button>
      <ul>{statuses.map(row => <li key={row.id}><strong>{state.sources.find(source => source.id === row.sourceId)?.title ?? '取込元不明'}</strong> / 方式：{row.kind === 'url' ? 'URL' : 'ファイル監視'} / {labels[row.status]}<dl><dt>最終確認</dt><dd>{row.lastCheckedAt ?? '未確認'}</dd><dt>最終変更</dt><dd>{row.lastChangedAt ?? '未確認'}</dd><dt>次回確認</dt><dd>{row.nextDueAt ?? '手動'}</dd></dl>{row.lastError && <p>{row.lastError}</p>}<button disabled={busy} onClick={() => void run(() => window.michiScheduleRefresh!.request({action:'refresh',id:row.id}))}>今確認する</button><button disabled={busy} onClick={() => void run(() => window.michiScheduleRefresh!.request({action:'remove',id:row.id}))}>取得を停止</button></li>)}</ul>
    </>}
    {message && <p role="status">{message}</p>}
    <h3>取得した資料の確認待ち（{pending.length}件）</h3><p>新しい取得があると、同じ取込元の古い確認案は失効します。本人の変更を保持し、完了した回を再作成しません。</p>
    {pending.map(row => <button key={row.id} disabled={busy} onClick={() => void run(async () => { setSelected({row,file:await pendingScheduleRefreshFile(row)}) })}>{state.sources.find(source => source.id === row.sourceId)?.title ?? '資料'} · {row.fetchedAt} · 差分を開く</button>)}
    {selected && <div><button onClick={() => setSelected(null)}>確認を閉じる</button>{selected.row.format === 'ics' ? <CalendarImportView key={selected.row.id} state={state} refreshInput={selected} onApplied={applied} /> : <CalendarCSVImportView key={selected.row.id} state={state} settings={settings} refreshInput={selected} onApplied={applied} />}</div>}
  </section>
}
