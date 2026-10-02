import { useCallback, useEffect, useRef, useState } from 'react'
import { addDays, today, uid, type Settings } from './domain'
import { type CalendarRulesState, type ScheduleFact } from './calendar-resolver'
import { prepareCalendarCSVImport, prepareCalendarCSVRetirement, type CSVImportTarget } from './calendar-csv-import'
import { applyCalendarCSVImportFromUI, cancelCalendarCSVImport } from './calendar-csv-import-save'
import { applyCalendarProposalFromUI, discardCalendarConfigurationProposal, type CalendarConfigurationProposal } from './calendar-rules-save'
import { calendarCSVRetentionUntil, readCalendarCSVFile } from './calendar-csv-view-input'
import './CalendarCSVImportView.css'
import CalendarCSVMappingStep from './CalendarCSVMappingStep'
import type { CSVMappingProfile } from './calendar-csv-mapping'
import { extractCalendarDocument, tableCSVBytes, tableEvidence, type ScheduleDocumentExtraction, type ScheduleDocumentTable } from './calendar-document-import'
import CalendarDocumentPreview from './CalendarDocumentPreview'
import { bindScheduleRefreshPreview } from './schedule-refresh'
import type { ScheduleRefreshInbox } from './schedule-refresh-types'

type Prepared = Awaited<ReturnType<typeof prepareCalendarCSVImport>>
type Selection = { kind: 'calendar' | 'roster'; contextName: string; bindingId: string; personRef: string | null; calendarName: string; activityName: string | null; timezone: string; feedId: string; title: string; fromDate: string; toDate: string; retentionUntil: string }
type Props = { state: CalendarRulesState; settings: Settings; onApplied?: () => void | Promise<void>; refreshInput?: { row: ScheduleRefreshInbox; file: File } }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
function when(value: string, timezone: string) { return new Date(value).toLocaleString('ja-JP', { timeZone: timezone }) }
function factText(fact: ScheduleFact | null, timezone: string) {
  if (!fact) return '事実なし／明示取り下げ'
  if (fact.kind === 'open' || fact.kind === 'closed') return `${fact.date} ${fact.kind === 'open' ? '営業日' : '休業日'}`
  if (fact.kind === 'roster_assignment') return `${fact.status === 'cancelled' ? '明示取消' : '公開済み勤務'} ${when(fact.startAt, timezone)}〜${when(fact.endAt, timezone)}`
  return '共通カレンダーの事実（要確認）'
}

export function CalendarCSVPreview({ prepared, selection }: { prepared: Prepared; selection: Selection }) {
  const { preview } = prepared
  return <section className="csv-preview" aria-label="CSV資料の確認案">
    <h3>資料の確認案</h3>
    <dl className="csv-values">
      <div><dt>対象と本人適用</dt><dd>{selection.contextName}<small>本人適用ID：{selection.bindingId}</small>{selection.kind === 'roster' && <small>本人識別子：{selection.personRef}</small>}</dd></div>
      <div><dt>カレンダーと活動</dt><dd>{selection.calendarName}<small>{selection.activityName ?? '営業日カレンダー（活動指定なし）'}</small></dd></div>
      <div><dt>固定の取込元</dt><dd>{selection.title}<small>{selection.feedId}</small></dd></div>
      <div><dt>取込期間とタイムゾーン</dt><dd>{selection.fromDate}〜{selection.toDate}<small>{selection.timezone}</small></dd></div>
      <div><dt>選択した原文の保持期限</dt><dd>{when(selection.retentionUntil, selection.timezone)}<small>{selection.timezone} / UTC：{selection.retentionUntil}</small></dd></div>
      <div><dt>元ファイルのSHA-256</dt><dd><code>{preview.parsed.fileSha256}</code><small>元ファイル全体は保存しません。選択した行の原文だけを保持します。</small></dd></div>
    </dl>
    <p>選択 {preview.selectedCount}行 / 除外：下書き {preview.excludedDraft}・他者 {preview.excludedOtherPerson}・期間外 {preview.excludedOutsidePeriod}行</p>
    <p>新規 {preview.added}・変更 {preview.updated}・明示取消／取り下げ {preview.canceled}・変更なし {preview.unchanged}件</p>
    <p>新しいファイルにない記録は取消と判断しません。保存する資料と事実を確認してください。</p>
    {preview.noOp && preview.selectedCount > 0 && <p>選択行・対象期間・設定が保存済みの版と同じです（元ファイル全体のSHA-256は記録用で、他者の行や改行の違いでは変わります）。再保存する必要はありません。</p>}
    {preview.retentionShortened && <p className="csv-warning">この保持期限（UTC：{preview.retentionShortened.until}）は、この取込元の以前の記録 {preview.retentionShortened.snapshots}版にも適用され、今回のファイルにない記録 {preview.retentionShortened.otherRecords}件の原文も期限に消去します。消去後の記録は、同じ取込元へ再取込するまで予定の根拠に使いません。</p>}
    {preview.warnings.map((warning, index) => <p key={index} className="csv-warning">{warning}</p>)}
    {prepared.configuration?.conflicts.map((conflict, index) => <p key={`${conflict.key}:${index}`} role="alert" className="csv-warning">発生回への反映は確認待ち：{conflict.reason}。資料の根拠は保存できますが、この矛盾が残る系列のタスク・予定は反映しません。</p>)}
    {preview.selectedCount === 0 && <p>保存できる選択行がありません。対象・公開状態・期間を確認してください。既存の資料と予定を置換・取消しません。</p>}
    <h4>選択行の根拠と日時</h4>
    <ol className="csv-rows">{preview.parsed.rows.map(row => <li key={`${row.externalId}:${row.revision}`}>
      <strong>{row.externalId} / 記録の版 {row.revision} / {row.status}</strong>
      <span>レコード {row.recordNumber} / 原文 {row.lineStart}〜{row.lineEnd}行 / バイト {row.byteStart}〜{row.byteEnd}</span>
      <span>{row.date ?? (row.startAt && row.endAt ? `${when(row.startAt, selection.timezone)}〜${when(row.endAt, selection.timezone)}（${selection.timezone}）` : '日時なし／要確認')}</span>
      <code className="csv-fingerprint">行のSHA-256：{row.quoteHash}</code><pre>{row.quote}</pre>
    </li>)}</ol>
    {preview.changes.length > 0 && <><h4>保存する事実の差分</h4><ul className="csv-changes">{preview.changes.map((change, index) => <li key={`${change.recordId}:${index}`}><strong>{change.recordId} / {change.status}</strong><span>{factText(change.before, selection.timezone)} → {factText(change.after, selection.timezone)}</span></li>)}</ul></>}
    <p className="muted">資料の保存ではタスク・予定を生成しません。保存後、共通カレンダーの「発生回の差分を確認」から、別の承認で予定へ反映できます。</p>
  </section>
}

export default function CalendarCSVImportView({ state, settings, onApplied, refreshInput }: Props) {
  const refreshSource = state.sources.find(row => row.id === refreshInput?.row.sourceId)
  const [kind, setKind] = useState<'calendar' | 'roster' | ''>(refreshSource?.csv?.format ?? '')
  const [contextId, setContextId] = useState(refreshSource?.contextId ?? ''), [bindingId, setBindingId] = useState(refreshSource?.csv?.target.bindingId ?? ''), [calendarId, setCalendarId] = useState(refreshSource?.csv?.target.calendarId ?? ''), [activityId, setActivityId] = useState(refreshSource?.csv?.target.activityId ?? ''), [timezone, setTimezone] = useState(refreshSource?.csv?.target.timezone ?? '')
  const [feedMode, setFeedMode] = useState<'new' | 'existing' | ''>(refreshSource ? 'existing' : ''), [sourceId, setSourceId] = useState(refreshSource?.id ?? ''), [feedId, setFeedId] = useState(refreshSource?.csv?.feedId ?? ''), [title, setTitle] = useState(refreshSource?.title ?? '')
  const [fromDate, setFromDate] = useState(refreshSource?.coverageFrom ?? ''), [toDate, setToDate] = useState(refreshSource?.coverageTo ?? ''), [retention, setRetention] = useState(refreshSource?.csv?.retentionUntil?.slice(0, 10) ?? '')
  const [fileName, setFileName] = useState(''), [bytes, setBytes] = useState<Uint8Array | null>(null)
  const [mappingMode, setMappingMode] = useState(Boolean(refreshSource?.csv?.mapping)), [mappingProfile, setMappingProfile] = useState<CSVMappingProfile | null>(refreshSource?.csv?.mapping?.profile ?? null), [profileChangeConfirmed, setProfileChangeConfirmed] = useState(false), [newerFileConfirmed, setNewerFileConfirmed] = useState(false)
  const [documentInput, setDocumentInput] = useState<{ bytes: Uint8Array; extraction: ScheduleDocumentExtraction; table: ScheduleDocumentTable } | null>(null), [yTolerance, setYTolerance] = useState(2), [xGap, setXGap] = useState(12)
  const [savedPrepared, setPrepared] = useState<Prepared | null>(null), [selection, setSelection] = useState<Selection | null>(null), [proofSignature, setProofSignature] = useState('')
  const [checked, setChecked] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const [retireId, setRetireId] = useState(''), [retirement, setRetirement] = useState<CalendarConfigurationProposal | null>(null), [retireChecked, setRetireChecked] = useState(false), [eraseOriginals, setEraseOriginals] = useState(false)
  const sequence = useRef(0), retireSequence = useRef(0), preparedRef = useRef<Prepared | null>(null), retirementRef = useRef<CalendarConfigurationProposal | null>(null)
  const revoke = useCallback(() => { sequence.current++; if (preparedRef.current) cancelCalendarCSVImport(preparedRef.current); preparedRef.current = null }, [])
  const dropRetirement = useCallback(() => { retireSequence.current++; if (retirementRef.current) discardCalendarConfigurationProposal(retirementRef.current); retirementRef.current = null; setRetirement(null); setRetireChecked(false) }, [])
  const signature = JSON.stringify([state, settings.profileId, settings.datasetId, settings.changePolicy])
  const prepared = proofSignature === signature ? savedPrepared : null
  const context = state.contexts.find(item => item.id === contextId)
  const bindings = state.bindings.filter(item => item.contextId === contextId && item.personId === settings.profileId && item.confirmed)
  const binding = bindings.find(item => item.id === bindingId), calendars = state.calendars.filter(item => item.contextId === contextId), calendar = calendars.find(item => item.id === calendarId)
  const activities = state.activities.filter(item => item.contextId === contextId && item.bindingId === bindingId && item.calendarId === calendarId && binding?.activityIds.includes(item.id) && item.weekdays.length === 0)
  const activity = activities.find(item => item.id === activityId)
  const sources = state.sources.filter(item => item.contextId === contextId && item.csv?.format === kind && !item.csv.retiredAt && item.csv.target.bindingId === bindingId && item.csv.target.calendarId === calendarId && item.csv.target.activityId === (kind === 'roster' ? activityId : null))
  const source = sources.find(item => item.id === sourceId)
  const sameTarget = state.sources.find(item => item.contextId === contextId && item.csv?.format === kind && !item.csv.retiredAt && item.csv.target.calendarId === calendarId && item.csv.target.activityId === (kind === 'roster' ? activityId : null))
  const retirable = state.sources.filter(item => item.csv && !item.csv.retiredAt), retireSource = retirable.find(item => item.id === retireId)
  useEffect(() => {
    revoke()
    // A prior snapshot cannot regain approval if it later reappears.
    // oxlint-disable-next-line react/set-state-in-effect
    setProofSignature('')
    setChecked(false)
    dropRetirement()
    return () => { revoke(); dropRetirement() }
  }, [signature, revoke, dropRetirement])
  useEffect(() => {
    if (!prepared || !selection) return
    const until = Math.min(Date.parse(selection.retentionUntil), Date.parse(prepared.expiresAt))
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      const remaining = until - Date.now()
      if (remaining > 0) { timer = setTimeout(schedule, Math.min(remaining, 2147483647)); return }
      revoke(); setPrepared(null); setChecked(false)
      if (Date.parse(selection.retentionUntil) <= Date.now()) { setBytes(null); setFileName(''); setDocumentInput(null); setNotice('原文保持期限に達したため選択ファイルを解放しました。期限を確認してファイルを選び直してください。') }
      else setNotice('確認案の期限が切れました。入力とファイルを確認して候補を作り直してください。')
    }
    schedule()
    return () => clearTimeout(timer)
  }, [prepared, selection, revoke])
  function changed(action?: () => void) { revoke(); action?.(); setPrepared(null); setSelection(null); setProofSignature(''); setChecked(false); setNotice('') }
  function resetFeed() { setFeedMode(''); setSourceId(''); setFeedId(''); setTitle(''); setMappingProfile(null); setProfileChangeConfirmed(false); setNewerFileConfirmed(false) }
  async function readFile(file: File) {
    changed(() => { setFileName(file.name); setBytes(null); setDocumentInput(null) }); const token = ++sequence.current; setBusy(true)
    try {
      if (/\.(pdf|xlsx)$/i.test(file.name)) {
        const result = await extractCalendarDocument(file, yTolerance, xGap)
        if (token !== sequence.current) throw new Error('読取中に対象が変わりました。選び直してください')
        if (!result.extraction.tables.length) throw new Error('確認できる表がありません')
        const table = result.extraction.tables[0]; setDocumentInput({ ...result, table }); setBytes(tableCSVBytes(table)); setMappingMode(true); setMappingProfile(null)
      } else { const next = await readCalendarCSVFile(file, mappingMode ? 'undecided' : 'utf-8'); if (token !== sequence.current) throw new Error('読取中に対象や設定が変わりました。ファイルを選び直してください。'); setBytes(next) }
      setNotice('ファイルを端末内で読みました。対象と期間を選んで確認案を作ってください。')
    }
    catch (error) { setNotice(errorText(error)) } finally { setBusy(false) }
  }
  async function prepare() {
    if (busy) return
    changed(); const token = ++sequence.current; setBusy(true)
    try {
      if (!kind || !context || !binding || !calendar || !timezone || timezone !== context.timezone || !fromDate || !toDate || !feedMode || !bytes) throw new Error('CSV形式・対象・本人適用・カレンダー・タイムゾーン・期間・取込元・ファイルを明示的に選んでください。')
      if (kind === 'roster' && (!activity || !binding.personRef)) throw new Error('勤務表には本人識別子を登録した確認済みの本人適用と、曜日指定のない専用活動が必要です。')
      if (feedMode === 'existing' && !source?.csv) throw new Error('同じ対象に対応する既存のCSV取込元を選んでください。')
      const chosenFeed = feedMode === 'existing' ? source!.csv!.feedId : feedId
      if (refreshInput && source?.id !== refreshInput.row.sourceId) throw new Error('更新取得の取込元を変更できません')
      const retentionUntil = calendarCSVRetentionUntil(retention, timezone)
      const target: CSVImportTarget = { kind, contextId, bindingId, calendarId, activityId: kind === 'roster' ? activityId : null, feedId: chosenFeed, title, retentionUntil }
      const snapshot: Selection = { kind, contextName: context.name, bindingId, personRef: kind === 'roster' ? binding.personRef : null, calendarName: calendar.name, activityName: activity?.title ?? null, timezone, feedId: chosenFeed, title, fromDate, toDate, retentionUntil }
      if (mappingMode && !mappingProfile) throw new Error('列対応を設定して「この列対応設定を確認案に使う」を押してください')
      const next = await prepareCalendarCSVImport(target, bytes, { fromDate, toDate, ...(mappingMode && mappingProfile ? { mappingProfile, profileChangeConfirmed, newerFileConfirmed } : {}), ...(documentInput ? { documentEvidence: tableEvidence(documentInput.extraction, documentInput.table) } : {}) })
      if (refreshInput && next.configuration) await bindScheduleRefreshPreview(next.configuration, refreshInput.row.id, refreshInput.row.bodySha256)
      if (token !== sequence.current) { cancelCalendarCSVImport(next); throw new Error('確認中に対象や設定が変わりました。現在の選択で確認案を作り直してください。') }
      preparedRef.current = next; setPrepared(next); setSelection(snapshot); setProofSignature(signature); setChecked(false); setNotice('資料の確認案を作りました。まだ保存していません。')
    } catch (error) { setNotice(errorText(error)) } finally { setBusy(false) }
  }
  async function apply(event: Event) {
    if (!prepared?.configuration || !checked || busy) return
    setBusy(true); setNotice('')
    try { await applyCalendarCSVImportFromUI(prepared, prepared.digest, event); changed(() => { setBytes(null); setFileName(''); setDocumentInput(null) }); setNotice('確認したCSV資料を保存しました。タスク・予定への反映は共通カレンダーで別に確認してください。'); await onApplied?.() }
    catch (error) { changed(); setNotice(`${errorText(error)} 選択と入力は残っています。確認案を作り直してください。`) } finally { setBusy(false) }
  }
  async function prepareRetirement() {
    if (busy || !retireSource) return
    dropRetirement(); const token = retireSequence.current; setBusy(true); setNotice('')
    try {
      // Preview the current part of the coverage (from two weeks ago), bounded like every common-calendar diff.
      const recent = [retireSource.coverageFrom, addDays(today(), -14)].sort()[1], from = recent > retireSource.coverageTo ? retireSource.coverageFrom : recent, to = [retireSource.coverageTo, addDays(from, 366)].sort()[0]
      const next = await prepareCalendarCSVRetirement(retireSource.id, from, to, eraseOriginals)
      // A proposal for a superseded selection or an unmounted view is discarded, never shown or kept.
      if (token !== retireSequence.current) { discardCalendarConfigurationProposal(next); return }
      retirementRef.current = next; setRetirement(next); setNotice('取込元の終了の確認案を作りました。まだ保存していません。')
    } catch (error) { setNotice(errorText(error)) } finally { setBusy(false) }
  }
  async function applyRetirement(event: Event) {
    if (!retirement || !retireChecked || busy) return
    setBusy(true); setNotice('')
    try { await applyCalendarProposalFromUI(retirement, event); retirementRef.current = null; setRetirement(null); setRetireChecked(false); setRetireId(''); setEraseOriginals(false); setNotice('取込元を終了しました。予定・タスクへの影響は共通カレンダーの「発生回の差分を確認」で別に確認してください。'); await onApplied?.() }
    catch (error) { dropRetirement(); setNotice(`${errorText(error)} 終了の確認案を作り直してください。`) } finally { setBusy(false) }
  }
  const status = notice || (savedPrepared && !prepared ? '対象・版・本人権限が変わったため、以前の確認案を取り消しました。選択を確認して差分を作り直してください。' : '')
  return <section className="card setting-section calendar-csv-import" aria-label="営業日・勤務表CSVの取込">
    <h2>営業日・勤務表のローカル取込</h2>
    <p>本人が選んだCSV/TSV（1MiB以内）、PDF/XLSX（25MiB以内）を端末内で読み取ります。文字コードと任意列は本人が設定し、PDFはテキスト層の表、XLSXは文字・値のセルだけを使います。外部AIへ送信しません。元ファイル全体は保存せず、本人に適用する選択行だけを原文保持期限まで保存します。</p>
    {refreshInput && <button type="button" disabled={busy} onClick={() => void readFile(refreshInput.file)}>取得した資料を列対応・原文で確認</button>}
    <details><summary>対応する固定ヘッダーと値</summary><p>営業日：statusは open / closed / withdrawn</p><pre>record_id,record_revision,date,status</pre><p>勤務表：publishedは true / false、statusは scheduled / cancelled。本人に一致する公開済みの行だけを取り込みます。</p><pre>shift_id,record_revision,person_ref,published,status,start_date,start_time,end_date,end_time</pre><p>日付はYYYY-MM-DD、時刻はHH:mmです。夜勤は終了日を明示してください。列名・列数・引用符・文字コード・版・日時が曖昧なファイルは、切り捨てて取り込みません。</p></details>
    <div className="csv-form">
      <label className="field">CSV形式<select aria-label="CSV形式" value={kind} disabled={busy} onChange={event => changed(() => { setKind(event.target.value as typeof kind); setActivityId(''); resetFeed() })}><option value="">選んでください</option><option value="calendar">営業日カレンダー</option><option value="roster">勤務表</option></select></label>
      <label className="field">対象<select aria-label="CSVの対象" value={contextId} disabled={busy} onChange={event => changed(() => { setContextId(event.target.value); setBindingId(''); setCalendarId(''); setActivityId(''); setTimezone(''); resetFeed() })}><option value="">選んでください</option>{state.contexts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="field">本人適用<select aria-label="CSVの本人適用" value={bindingId} disabled={busy} onChange={event => changed(() => { setBindingId(event.target.value); setActivityId(''); resetFeed() })}><option value="">選んでください</option>{bindings.map(item => <option key={item.id} value={item.id}>{item.id} / {item.validFrom}〜{item.validTo}{item.personRef ? ` / ${item.personRef}` : ''}</option>)}</select></label>
      <label className="field">カレンダー<select aria-label="CSVのカレンダー" value={calendarId} disabled={busy} onChange={event => changed(() => { setCalendarId(event.target.value); setActivityId(''); resetFeed() })}><option value="">選んでください</option>{calendars.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="field">タイムゾーンを確認<select aria-label="CSVのタイムゾーン" value={timezone} disabled={busy} onChange={event => changed(() => setTimezone(event.target.value))}><option value="">選んでください</option>{context && <option value={context.timezone}>{context.timezone}</option>}</select></label>
      {kind === 'roster' && <label className="field">勤務表専用の活動<select aria-label="CSVの勤務活動" value={activityId} disabled={busy} onChange={event => changed(() => { setActivityId(event.target.value); resetFeed() })}><option value="">選んでください</option>{activities.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
      {kind === 'roster' && <p className="csv-full">本人識別子：{binding?.personRef ?? '未設定'}。勤務表専用の活動がない場合は、共通カレンダーの本人対象登録で「活動は公開シフトの割当だけを使う」にチェックして登録してください。通常の週次活動との二重発生を防ぎます。</p>}
      <label className="field">取込元の選び方<select aria-label="CSVの取込元の選び方" value={feedMode} disabled={busy} onChange={event => changed(() => { setFeedMode(event.target.value as typeof feedMode); setSourceId(''); setFeedId(''); setTitle('') })}><option value="">選んでください</option><option value="new">新しい取込元</option><option value="existing">既存の取込元を更新</option></select></label>
      {/* An expired source's title is a placeholder, so the person names the refreshed material again. */}
      {feedMode === 'existing' && <label className="field">固定の取込元<select aria-label="CSVの既存取込元" value={sourceId} disabled={busy} onChange={event => changed(() => { const item = sources.find(source => source.id === event.target.value); setSourceId(event.target.value); setTitle(item?.status === 'current' ? item.title : ''); setMappingMode(Boolean(item?.csv?.mapping)); setMappingProfile(item?.csv?.mapping?.profile ?? null); setProfileChangeConfirmed(false); setNewerFileConfirmed(false) })}><option value="">選んでください</option>{sources.map(item => <option key={item.id} value={item.id}>{item.title} / v{item.revision} / {item.status === 'current' ? '取込済み' : '保持期限切れ・資料名を入力'}</option>)}</select></label>}
      {feedMode === 'new' && <label className="field">固定の取込元ID<input aria-label="CSVの新しい取込元ID" value={feedId} disabled={busy} onChange={event => changed(() => setFeedId(event.target.value))} /><button className="text-button" disabled={busy} onClick={() => changed(() => setFeedId(`csv-${uid()}`))}>新しい取込元IDを作る</button></label>}
      {feedMode === 'new' && sameTarget && <p className="csv-full csv-warning">同じ対象の取込元「{sameTarget.title}」があります。同じ記録を二重に取り込まないよう、「既存の取込元を更新」を選ぶか、下の「取込元の終了」で終了してから新しい取込元を作ってください。</p>}
      <label className="field">資料名<input aria-label="CSV資料名" value={title} disabled={busy} onChange={event => changed(() => setTitle(event.target.value))} /></label>
      <label className="field">取込開始<input aria-label="CSV取込開始" type="date" value={fromDate} disabled={busy} onChange={event => changed(() => setFromDate(event.target.value))} /></label>
      <label className="field">取込終了<input aria-label="CSV取込終了" type="date" value={toDate} disabled={busy} onChange={event => changed(() => setToDate(event.target.value))} /></label>
      <label className="field">選択タイムゾーンでの原文保持期限<input aria-label="CSV原文保持期限" type="datetime-local" value={retention} disabled={busy} onChange={event => changed(() => setRetention(event.target.value))} /></label>
      <label className="csv-check csv-full"><input aria-label="任意列と文字コードを設定する" type="checkbox" checked={mappingMode} disabled={busy || Boolean(source?.csv?.mapping)} onChange={event => changed(() => { setMappingMode(event.target.checked); setMappingProfile(null); setProfileChangeConfirmed(false); setNewerFileConfirmed(false); setBytes(null); setFileName('') })} />任意列・Shift_JIS・TSVの対応を設定する</label>
      <label className="field">PDFの行許容幅<input aria-label="PDFの行許容幅" type="number" min={0.1} max={5} step={0.1} value={yTolerance} disabled={busy} onChange={event => changed(() => { setYTolerance(Number(event.target.value)); setBytes(null); setDocumentInput(null) })} /></label>
      <label className="field">PDFの列許容幅<input aria-label="PDFの列許容幅" type="number" min={2} max={100} value={xGap} disabled={busy} onChange={event => changed(() => { setXGap(Number(event.target.value)); setBytes(null); setDocumentInput(null) })} /></label>
      <label className="field csv-full">CSV・PDF・XLSXファイル<input aria-label="CSVファイル" type="file" accept=".csv,.tsv,.pdf,.xlsx,text/csv,text/tab-separated-values" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void readFile(file) }} /><small>{fileName ? `${fileName} / ${bytes ? `${bytes.byteLength}バイト読取済み` : '読取未完了'}` : '未選択'}</small></label>
    </div>
    {documentInput && <CalendarDocumentPreview {...documentInput} onTable={table => changed(() => { setDocumentInput({ ...documentInput, table }); setBytes(tableCSVBytes(table)); setProfileChangeConfirmed(false); setNewerFileConfirmed(false) })} />}
    {mappingMode && kind && <fieldset disabled={busy}><CalendarCSVMappingStep key={`${kind}:${sourceId}`} kind={kind} bytes={bytes} initial={source?.csv?.mapping?.profile} onChange={profile => changed(() => { setMappingProfile(profile); setProfileChangeConfirmed(false); setNewerFileConfirmed(false) })} />
      {source && <label className="csv-check"><input type="checkbox" aria-label="列対応の変更を確認した" checked={profileChangeConfirmed} onChange={event => changed(() => setProfileChangeConfirmed(event.target.checked))} />既存資料の列対応変更と再検証を確認しました（ID・版の方式変更は取込元の終了が必要）。</label>}
      {mappingProfile?.revisionStrategy === 'import_order' && <label className="csv-check"><input type="checkbox" aria-label="今回の資料が新しいことを確認した" checked={newerFileConfirmed} onChange={event => changed(() => setNewerFileConfirmed(event.target.checked))} />今回の資料が前回より新しいことを確認しました。</label>}
    </fieldset>}
    <p>同じ資料の更新は同じ取込元を選んでください。終了日を省略した夜勤、未公開行、他者の行、欠けた記録から日時や取消を推測しません。</p>
    <div className="csv-actions"><button className="secondary-button" disabled={busy} onClick={() => void prepare()}>CSV資料の差分を確認</button></div>
    {prepared && selection && <><CalendarCSVPreview prepared={prepared} selection={selection} />{prepared.configuration && <><label className="csv-check"><input type="checkbox" aria-label="CSVの本人適用・期間・保持期限・原文と差分を確認した" checked={checked} disabled={busy} onChange={event => setChecked(event.target.checked)} /><span>本人適用・取込元・期間・タイムゾーン・保持期限・選択原文と表示された全差分を確認しました。</span></label><div className="csv-actions"><button className="primary-button" disabled={busy || !checked} onClick={event => void apply(event.nativeEvent)}>確認したCSV資料を保存</button></div></>}<div className="csv-actions"><button className="secondary-button" disabled={busy} onClick={() => changed()}>CSV確認案を取り消す</button></div></>}
    <details className="csv-retire"><summary>取込元の終了</summary>
      <p>記録の上限に達した取込元や、本人識別子・タイムゾーンが変わった取込元を終了します。原文の保持期限が切れただけの取込元は、同じ取込元へ再取込すれば更新できます。終了した取込元の行は新しい予定・タスクの根拠に使わず、再開・更新もできません。保存済みの根拠・監査と、反映済みの予定・完了・台帳は残し、勤務の取消とは扱いません。営業日カレンダーを終了した場合の休業日・営業日の変化は、共通カレンダーの差分で別に確認します。</p>
      <label className="field">終了する取込元<select aria-label="終了するCSV取込元" value={retireId} disabled={busy} onChange={event => { dropRetirement(); setRetireId(event.target.value) }}><option value="">選んでください</option>{retirable.map(item => <option key={item.id} value={item.id}>{item.title} / {item.csv!.format === 'calendar' ? '営業日' : '勤務表'} / 取込元ID {item.csv!.feedId} / v{item.revision} / 最終取込 {item.importedAt.slice(0, 10)} / {item.status === 'current' ? '取込済み' : '保持期限切れ'}</option>)}</select></label>
      <label className="csv-check"><input type="checkbox" aria-label="終了時に保持中の原文とCSVの本人識別子も消去する" checked={eraseOriginals} disabled={busy} onChange={event => { dropRetirement(); setEraseOriginals(event.target.checked) }} /><span>終了と同時に、保持中の原文とCSVの本人識別子も消去する（保持期限を待たない。記録ID・版・日時・hashは残ります）</span></label>
      <div className="csv-actions"><button className="secondary-button" disabled={busy || !retireSource} onClick={() => void prepareRetirement()}>終了の確認案を作る</button></div>
      {retirement && retireSource && <section className="csv-preview" aria-label="取込元の終了の確認案"><h3>取込元の終了の確認案</h3>
        <p>「{retireSource.title}」（取込元ID {retireSource.csv!.feedId}・{retireSource.coverageFrom}〜{retireSource.coverageTo}・記録 {retireSource.csv!.heads.length}件）を終了します。{eraseOriginals ? '保持中の原文とCSVの本人識別子も消去します。' : '原文は保持期限まで残ります。'}終了した取込元は再開・更新できません。同じ対象は新しい取込元で取り込めます。</p>
        {retirement.conflicts.map((conflict, index) => <p key={`${conflict.key}:${index}`} className="csv-warning">終了後も確認が必要：{conflict.reason}</p>)}
        <label className="csv-check"><input type="checkbox" aria-label="取込元の終了と影響を確認した" checked={retireChecked} disabled={busy} onChange={event => setRetireChecked(event.target.checked)} /><span>終了後はこの取込元の行を新しい予定・タスクの根拠に使わないことを確認しました。</span></label>
        <div className="csv-actions"><button className="primary-button" disabled={busy || !retireChecked} onClick={event => void applyRetirement(event.nativeEvent)}>確認した取込元を終了</button><button className="secondary-button" disabled={busy} onClick={dropRetirement}>終了の確認案を取り消す</button></div>
      </section>}
    </details>
    {/* One live region stays mounted so screen readers announce each new result. */}
    <p role="status" aria-live="polite" className="csv-notice">{status}</p>
  </section>
}
