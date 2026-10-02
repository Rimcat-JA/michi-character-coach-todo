import { useState } from 'react'
import { addDays, today, uid } from './domain'
import { type CalendarRulesState } from './calendar-resolver'
import { applyCalendarProposalFromUI, prepareCalendarGeneration, type CalendarGenerationProposal } from './calendar-rules-save'
import { prepareCalendarICSImport, type PreparedCalendarImport } from './calendar-import'
import { bindScheduleRefreshPreview } from './schedule-refresh'
import type { ScheduleRefreshInbox } from './schedule-refresh-types'

type Props = { state: CalendarRulesState; onApplied?: () => void | Promise<void>; refreshInput?: { row: ScheduleRefreshInbox; file: File } }
export default function CalendarImportView({ state, onApplied, refreshInput }: Props) {
  const refreshSource = state.sources.find(row => row.id === refreshInput?.row.sourceId)
  const [contextId, setContextId] = useState(refreshSource?.contextId ?? state.contexts[0]?.id ?? ''), [sourceId, setSourceId] = useState(refreshSource?.id ?? ''), [newFeedId, setNewFeedId] = useState(`feed-${uid()}`)
  const [title, setTitle] = useState(refreshSource?.title ?? '本人が選んだICS予定'), [from, setFrom] = useState(refreshSource?.coverageFrom ?? today()), [to, setTo] = useState(refreshSource?.coverageTo ?? addDays(today(), 30)), [retentionDate, setRetentionDate] = useState(refreshSource?.ics?.retentionUntil?.slice(0, 10) ?? addDays(today(), 90))
  const [floatingConfirmed, setFloatingConfirmed] = useState(false), [applicabilityConfirmed, setApplicabilityConfirmed] = useState(false), [applyConfirmed, setApplyConfirmed] = useState(false)
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [prepared, setPrepared] = useState<PreparedCalendarImport | null>(null), [generation, setGeneration] = useState<CalendarGenerationProposal | null>(null)
  const chosenContext = state.contexts.find(item => item.id === (contextId || state.contexts[0]?.id)), binding = state.bindings.find(item => item.contextId === chosenContext?.id && item.personId === state.ownerId && item.confirmed), calendar = state.calendars.find(item => item.contextId === chosenContext?.id)
  const source = state.sources.find(item => item.id === sourceId && item.contextId === chosenContext?.id && item.ics)
  function reset() { setPrepared(null); setGeneration(null); setApplyConfirmed(false); setMessage('') }
  async function read(file: File) {
    reset(); setBusy(true)
    try {
      if (!chosenContext || !binding || !calendar || !applicabilityConfirmed) throw new Error('対象と本人への適用を確認してください')
      if (file.size > 1048576) throw new Error('ICSファイルは1MiB以内です')
      const input = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      if (refreshInput && (source?.id !== refreshInput.row.sourceId || file !== refreshInput.file)) throw new Error('更新取得の取込元を変更できません')
      const next = await prepareCalendarICSImport({ contextId: chosenContext.id, bindingId: binding.id, calendarId: calendar.id, feedId: source?.ics?.feedId ?? newFeedId, title: title.trim(), retentionUntil: retentionDate ? new Date(`${retentionDate}T23:59:59.999Z`).toISOString() : null }, input, { fromDate: from, toDate: to, allowFloating: floatingConfirmed })
      if (refreshInput && next.proposal) await bindScheduleRefreshPreview(next.proposal, refreshInput.row.id, refreshInput.row.bodySha256)
      setPrepared(next)
    } catch (error) { setMessage(String(error)) } finally { setBusy(false) }
  }
  async function apply(event: Event) {
    const proposal = generation ?? prepared?.proposal
    if (!proposal || !applyConfirmed) return
    setBusy(true); setMessage('')
    try {
      await applyCalendarProposalFromUI(proposal, event); if (proposal.kind === 'configuration') await onApplied?.(); setApplyConfirmed(false)
      if (proposal.kind === 'configuration') { if (prepared) setSourceId(prepared.preview.sourceId); setPrepared(null); setMessage('読取専用の資料を保存しました。発生回への反映は別の差分確認が必要です。') }
      else { setGeneration(null); setMessage('確認した予定の差分を反映しました。') }
    } catch (error) { setMessage(String(error)) } finally { setBusy(false) }
  }
  async function previewGeneration() { reset(); setBusy(true); try { setGeneration(await prepareCalendarGeneration(from, to)) } catch (error) { setMessage(String(error)) } finally { setBusy(false) } }
  const when = (start: string | null, end: string | null, zone: string) => `${start ? new Date(start).toLocaleString('ja-JP', { timeZone: zone }) : '日時なし'}${end ? `〜${new Date(end).toLocaleString('ja-JP', { timeZone: zone })}` : ''} (${zone})`
  return <section className="card setting-section calendar-rules-view calendar-import-view"><h2>ICS予定の読取専用取込</h2>
    <p>本人が選んだローカルファイルを保存します。元カレンダーへの書き戻し、招待への返信、Google・OutlookのOAuth同期は未接続です。予定だけからタスク、締切、ポイントを作りません。</p>
    <p>UTC、IANA・Windowsタイムゾーン、終日予定と日・週・月の基本周期に対応します。VTIMEZONEは各参照日時で検証し、アラームは警告付きで除外します。複雑な周期や終了不明の予定は保留します。</p>
    {refreshInput && <button type="button" disabled={busy || !applicabilityConfirmed} onClick={() => void read(refreshInput.file)}>取得したICSの差分を確認</button>}
    {message && <p role="status">{message}</p>}
    <label>対象<select disabled={busy} value={chosenContext?.id ?? ''} onChange={event => { setContextId(event.target.value); setSourceId(''); setNewFeedId(`feed-${uid()}`); setApplicabilityConfirmed(false); reset() }}><option value="">選択してください</option>{state.contexts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <p>本人適用：{binding ? `${binding.validFrom}〜${binding.validTo}` : '共通カレンダーで本人の適用条件を先に登録してください'} / タイムゾーン：{chosenContext?.timezone ?? '未選択'}</p>
    <label>固定の取込元<select disabled={busy} value={sourceId} onChange={event => { const selected = state.sources.find(item => item.id === event.target.value); setSourceId(event.target.value); if (!selected) setNewFeedId(`feed-${uid()}`); setTitle(selected?.title ?? '本人が選んだICS予定'); if (selected?.ics?.retentionUntil) setRetentionDate(selected.ics.retentionUntil.slice(0, 10)); reset() }}><option value="">新しい取込元</option>{state.sources.filter(item => item.contextId === chosenContext?.id && item.ics).map(item => <option key={item.id} value={item.id}>{item.title} / v{item.revision} / {item.status === 'current' ? '取込済み' : '確認待ち'}</option>)}</select></label>
    <p>同じ予定の更新ファイルは同じ取込元を選んでください。名前や日付が変わってもUIDと繰り返し回で照合します。</p>
    <label>資料名<input maxLength={300} value={title} disabled={busy} onChange={event => { setTitle(event.target.value); reset() }} /></label>
    <div className="form-grid"><label>取込開始<input type="date" value={from} disabled={busy} onChange={event => { setFrom(event.target.value); reset() }} /></label><label>終了<input type="date" value={to} disabled={busy} onChange={event => { setTo(event.target.value); reset() }} /></label><label>原本の保持期限<input type="date" value={retentionDate} required disabled={busy} onChange={event => { setRetentionDate(event.target.value); reset() }} /></label></div>
    <p>原文はこの本人データに保存し、外部AIに送信しません。期限到達時に原文・取り込んだ表示名を匿名化し、資料は確認待ちになります。保存済みの予定日時を取消とは判断しません。</p>
    <label><input type="checkbox" checked={floatingConfirmed} disabled={busy} onChange={event => { setFloatingConfirmed(event.target.checked); reset() }} />タイムゾーンのない時刻に {chosenContext?.timezone ?? '対象のタイムゾーン'} を適用することを確認した</label>
    <label><input type="checkbox" checked={applicabilityConfirmed} disabled={busy} onChange={event => { setApplicabilityConfirmed(event.target.checked); reset() }} />この取込元・期間・予定が自分に適用されることを確認した</label>
    <label>ICSファイルを選択<input type="file" accept=".ics,text/calendar" disabled={busy || !binding || !calendar || !applicabilityConfirmed || !retentionDate} onChange={event => { const file = event.target.files?.[0]; if (file) void read(file); event.target.value = '' }} /></label>
    {prepared && <section aria-label="ICS資料の差分"><h3>資料の確認案</h3><p>新規{prepared.preview.added}・変更{prepared.preview.updated}・明示取消{prepared.preview.canceled}・変更なし{prepared.preview.unchanged} / {prepared.preview.parsed.fromDate}〜{prepared.preview.parsed.toDate}</p>
      {prepared.preview.warnings.map(item => <p key={item}>{item}</p>)}{prepared.preview.noOp && <p>同じ原本・対象期間・設定です。再保存する必要はありません。</p>}
      <ul>{prepared.preview.parsed.occurrences.map(item => <li key={`${item.uid}:${item.recurrenceId}`}>{item.status === 'cancelled' ? '取消：' : ''}{item.title} / {item.allDay ? '終日 / ' : ''}{when(item.startAt, item.endAt, item.timezone)}</li>)}</ul>
      <h4>保存する事実の変更</h4><ul>{prepared.preview.changes.map(item => <li key={item.after.id}>{item.before ? `${item.before.title} / ${when(item.before.startAt, item.before.endAt, item.before.timezone)} → ` : '新規：'}{item.after.status === 'cancelled' ? '取消：' : ''}{item.after.title} / {when(item.after.startAt, item.after.endAt, item.after.timezone)}</li>)}</ul>
      {prepared.proposal && <><label><input type="checkbox" checked={applyConfirmed} onChange={event => setApplyConfirmed(event.target.checked)} />対象・取込元・保持期限・版・資料の差分を確認した</label><button disabled={busy || !applyConfirmed} onClick={event => void apply(event.nativeEvent)}>確認した資料を保存</button></>}
      <button disabled={busy} onClick={reset}>案を取り消す</button>
    </section>}
    <h3>保存した資料を予定へ反映</h3><button disabled={busy || !binding || !calendar} onClick={() => void previewGeneration()}>発生回の差分を確認</button>
    {generation && <section aria-label="ICS発生回の差分"><p>新規{generation.plan.creates.length}・変更{generation.plan.updates.length}・取消{generation.plan.cancels.length}・完了履歴を保持{generation.plan.skippedCompleted}</p><ul>{generation.plan.creates.map(item => <li key={item.generationKey}>新規：{item.title} / {when(item.startAt, item.endAt, item.timezone)}</li>)}{generation.plan.updates.map(item => <li key={item.after.generationKey}>変更：{item.before.spec.title} / {when(item.before.spec.startAt, item.before.spec.endAt, item.before.spec.timezone)} → {item.after.title} / {when(item.after.startAt, item.after.endAt, item.after.timezone)}</li>)}{generation.plan.cancels.map(item => <li key={item.before.generationKey}>取消：{item.before.spec.title} / {when(item.before.spec.startAt, item.before.spec.endAt, item.before.spec.timezone)} / {item.reason}</li>)}</ul>{generation.plan.conflicts.map((item, index) => <p role="alert" key={index}>確認が必要：{item.reason}</p>)}<label><input type="checkbox" checked={applyConfirmed} onChange={event => setApplyConfirmed(event.target.checked)} />表示されたすべての予定・タスクの差分を確認した</label><button disabled={busy || !applyConfirmed || Boolean(generation.plan.conflicts.length)} onClick={event => void apply(event.nativeEvent)}>確認した発生回を反映</button><button disabled={busy} onClick={reset}>案を取り消す</button></section>}
  </section>
}
