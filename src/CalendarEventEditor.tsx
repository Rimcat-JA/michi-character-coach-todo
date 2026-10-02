import { useState } from 'react'
import { localTimeAt } from './zoned-time'
import { calendarDateAt, resolveLocalCalendarTime, type CalendarRulesState } from './calendar-resolver'
import type { CalendarEvent } from './domain'
import { eventOrigin, localCalendarEditNotice } from './calendar-event-origin'
import { updateCalendarEventLocally } from './calendar-event-local-edit'
import { applyCalendarProposalFromUI, prepareCalendarSourceAcceptance, type CalendarGenerationProposal } from './calendar-rules-save'
export default function CalendarEventEditor({ event, state, run }: { event: CalendarEvent; state?: CalendarRulesState | null; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const local = (at: string) => `${calendarDateAt(at, event.timezone)}T${localTimeAt(at, event.timezone)}`
  const [title, setTitle] = useState(event.title), [start, setStart] = useState(local(event.startAt)), [end, setEnd] = useState(local(event.endAt)), [proposal, setProposal] = useState<CalendarGenerationProposal | null>(null), [checked, setChecked] = useState(false), [notice, setNotice] = useState('')
  const origin = eventOrigin(event, state)
  const at = (value: string) => { const [date, time] = value.split('T'), result = resolveLocalCalendarTime(date, time, event.timezone); if (!result.at) throw new Error(result.reason ?? '予定の時刻を確認してください'); return result.at }
  return <section aria-label="予定の出典と端末内編集"><h3>予定の出典と端末内編集</h3>
    <p>出典：{origin.kind === 'imported' ? origin.sources.map(source => `${source.title} · v${source.revision} · 取込 ${source.importedAt}`).join(' / ') : '本人の端末内予定'}</p>
    <p>読取：{origin.read.reason}<br />書込：{origin.write.reason}</p>
    {origin.kind === 'imported' && <button disabled title={origin.write.reason}>元カレンダーへ反映</button>}
    {origin.locallyEdited && <p className="status-tag">本人変更・外部未反映</p>}
    <label className="field">端末内の予定名<input aria-label="端末内の予定名" value={title} maxLength={300} onChange={event => setTitle(event.target.value)} /></label>
    <label className="field">端末内の開始<input aria-label="端末内の開始" type="datetime-local" value={start} onChange={event => setStart(event.target.value)} /></label>
    <label className="field">端末内の終了<input aria-label="端末内の終了" type="datetime-local" value={end} onChange={event => setEnd(event.target.value)} /></label>
    <p>日時は {event.timezone} で指定します。外部資料・勤務表は変更しません。</p>
    <button className="primary-button" onClick={async click => { if (await run(() => updateCalendarEventLocally(event.id, event.revision ?? 1, { title, startAt: at(start), endAt: at(end) }, click.nativeEvent), origin.provider === 'ics_file' ? localCalendarEditNotice : 'この端末の予定だけ変更しました（外部資料は変更されていません）')) setNotice('本人変更・外部未反映') }}>端末内の予定だけ保存</button>
    {origin.kind === 'imported' && origin.locallyEdited && <><p>再取込では本人変更を保持して確認待ちにします。変更を保つか、この回だけ資料の値を別に確認して採用できます。</p><button className="secondary-button" onClick={() => { setProposal(null); setChecked(false); setNotice('本人の変更を保持します。外部資料は変更しません') }}>本人の変更を保持</button><button className="secondary-button" onClick={() => void run(async () => {
      const source = state!.sources.find(row => row.id === origin.sources[0].id)!, from = source.coverageFrom, to = source.coverageTo
      setProposal(await prepareCalendarSourceAcceptance(origin.generationKey!, from, to)); setChecked(false)
    })}>この回に資料の値を使う案を確認</button></>}
    {proposal && <div className="csv-preview"><p>変更 {proposal.plan.updates.length} / 明示取消 {proposal.plan.cancels.length} / 矛盾 {proposal.plan.conflicts.length}</p>{proposal.plan.updates.map(change => <p key={change.after.generationKey}>{change.after.title} · {change.after.startAt}〜{change.after.endAt}</p>)}{proposal.plan.conflicts.map(conflict => <p key={conflict.key} role="alert">{conflict.reason}</p>)}<label><input type="checkbox" aria-label="この回の資料採用を確認した" checked={checked} onChange={event => setChecked(event.target.checked)} />本人変更をこの回だけ資料の値へ戻す差分を確認しました。</label><button disabled={!checked || Boolean(proposal.plan.conflicts.length)} onClick={async event => { if (await run(() => applyCalendarProposalFromUI(proposal, event.nativeEvent), '確認した資料の値をこの回だけ採用しました')) { setProposal(null); setChecked(false) } }}>この回だけ資料の値を採用</button></div>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
