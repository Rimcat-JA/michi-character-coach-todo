import { useState } from 'react'
import type { Routine } from './domain'
import type { CalendarRulesState } from './calendar-resolver'
import { describeCalendarTrigger } from './calendar-rule-editor'
import { applyLegacyRoutineConversionFromUI, prepareLegacyRoutineConversion, type LegacyRoutineConversionProposal } from './legacy-routine-conversion'

const cadenceText = (routine: Routine) => routine.cadence === 'daily' ? `${routine.interval}日ごと` : routine.cadence === 'weekly' ? `${routine.interval}週ごと` : routine.cadence === 'monthly' ? `${routine.interval}か月ごと・${routine.monthDay}日` : `完了から${routine.interval}日後`
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Moves one legacy routine into the common resolver only after the owner reviews the rule, the ID map and the next occurrences. */
export default function LegacyRoutineConversionView({ routines, state }: { routines: Routine[]; state: CalendarRulesState | null | undefined }) {
  const legacy = routines.filter(routine => routine.active)
  const [routineId, setRoutineId] = useState(''), [contextId, setContextId] = useState(''), [bindingId, setBindingId] = useState(''), [calendarId, setCalendarId] = useState(''), [time, setTime] = useState('09:00')
  const [proposal, setProposal] = useState<LegacyRoutineConversionProposal | null>(null), [checked, setChecked] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  if (!legacy.length) return null
  const bindings = state?.bindings.filter(row => row.contextId === contextId && row.confirmed && row.personId === state.ownerId) ?? [], calendars = state?.calendars.filter(row => row.contextId === contextId) ?? []
  const reset = (action: () => void) => { action(); setProposal(null); setChecked(false); setNotice('') }
  async function prepare() {
    setBusy(true); setNotice('')
    try { setProposal(await prepareLegacyRoutineConversion(routineId, { contextId, bindingId, calendarId, time })); setChecked(false) }
    catch (error) { setNotice(errorText(error)) } finally { setBusy(false) }
  }
  async function apply(event: Event) {
    if (!proposal || !checked) return
    setBusy(true); setNotice('')
    try { await applyLegacyRoutineConversionFromUI(proposal, proposal.digest, event); setProposal(null); setChecked(false); setRoutineId(''); setNotice('旧ルーティンを共通ルーティンへ移行しました。以後の発生回は共通カレンダーの反映確認で作ります。') }
    catch (error) { setNotice(errorText(error)) } finally { setBusy(false) }
  }
  return <section className="card setting-section" aria-label="旧ルーティンの移行">
    <h3>旧形式のルーティンを共通ルーティンへ移行</h3>
    <p>旧形式のルーティンは、変更範囲（今回だけ・以後・未完了すべて）や完了保護のない別の仕組みで展開しています。本人が確認した場合だけ、同じ日付規則の共通ルーティンへ移せます。自動では移行しません。</p>
    <div className="form-grid">
      <label className="field">移行する旧ルーティン<select aria-label="移行する旧ルーティン" value={routineId} disabled={busy} onChange={event => reset(() => setRoutineId(event.target.value))}><option value="">選択してください</option>{legacy.map(routine => <option key={routine.id} value={routine.id}>{routine.title}（{cadenceText(routine)}）</option>)}</select></label>
      <label className="field">移行先の対象<select aria-label="移行先の対象" value={contextId} disabled={busy || !state} onChange={event => reset(() => { setContextId(event.target.value); setBindingId(''); setCalendarId('') })}><option value="">選択してください</option>{state?.contexts.map(row => <option key={row.id} value={row.id}>{row.name} / {row.timezone}</option>)}</select></label>
      <label className="field">確認済みの本人適用<select aria-label="移行先の本人適用" value={bindingId} disabled={busy || !contextId} onChange={event => reset(() => setBindingId(event.target.value))}><option value="">選択してください</option>{bindings.map(row => <option key={row.id} value={row.id}>{row.personRef ?? '本人'} / {row.validFrom}〜{row.validTo}</option>)}</select></label>
      <label className="field">カレンダー<select aria-label="移行先のカレンダー" value={calendarId} disabled={busy || !contextId} onChange={event => reset(() => setCalendarId(event.target.value))}><option value="">選択してください</option>{calendars.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      <label className="field">予定時刻（タスクの日付は変わりません）<input aria-label="移行後の予定時刻" type="time" value={time} disabled={busy} onChange={event => reset(() => setTime(event.target.value))} /></label>
    </div>
    {!state?.contexts.length && <p className="muted">先に下の共通カレンダーで「個人の暦（全曜日）」などの対象と本人適用を登録してください。</p>}
    <button type="button" className="secondary-button" disabled={busy || !routineId || !contextId || !bindingId || !calendarId || !time} onClick={() => void prepare()}>移行内容を確認</button>
    {proposal && <section className="routine-assist-preview" aria-label="旧ルーティン移行の確認案"><h4>移行の確認</h4>
      <p>{proposal.rule.title} / {describeCalendarTrigger(proposal.rule.trigger)} / {proposal.rule.validFrom}〜{proposal.rule.validTo}</p>
      <p>既存の旧発生回 {proposal.totals.tasks}件（完了済み {proposal.totals.completed}件・確定 {proposal.totals.netPoints}pt）のタスクIDと完了実績を保ち、識別キーだけを付け替えます。</p>
      <details><summary>識別キーの対応表（legacy_id_map）</summary><ul>{proposal.mappings.map(row => <li key={row.taskId}>{row.anchorDate} / {row.status === 'completed' ? '完了済み' : row.trashed ? 'ゴミ箱' : '未完了'} / {row.from} → {row.to}</li>)}</ul></details>
      {proposal.preview.length > 0 && <><p>移行後に別の確認で作れる次の回（90日以内、最大10件）</p><ol>{proposal.preview.map(spec => <li key={spec.generationKey}>{spec.title}：{spec.scheduledDate}</li>)}</ol></>}
      {proposal.notices.map((item, index) => <p key={index}>{item}</p>)}
      <label><input type="checkbox" aria-label="旧ルーティン移行を確認" checked={checked} disabled={busy} onChange={event => setChecked(event.target.checked)} />規則・対応表・完了実績の保持と旧ルーティンの停止を確認した</label>
      <div className="routine-assist-actions"><button type="button" className="primary-button" disabled={busy || !checked} onClick={event => void apply(event.nativeEvent)}>確認した移行を実行</button><button type="button" className="text-button" disabled={busy} onClick={() => { setProposal(null); setChecked(false) }}>移行案を取り消す</button></div>
    </section>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
