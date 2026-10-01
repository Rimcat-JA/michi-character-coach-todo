import { useState, type FormEvent } from 'react'
import { addDays, today, uid } from './domain'
import { calendarRuleEditorDefinition, calendarRuleEditorSteps } from './calendar-rule-editor'
import { calendarDateAt, type CalendarChangeScope, type CalendarRule, type CalendarRulesState, type ResolvedCalendarSpec } from './calendar-resolver'
import type { CalendarConfigurationProposal, CalendarGenerationProposal, CalendarRulesConfiguration } from './calendar-rules-save'

type Proposal = CalendarConfigurationProposal | CalendarGenerationProposal
type Props = {
  state: CalendarRulesState
  onPrepareConfiguration: (next: CalendarRulesConfiguration, revision: number, from: string, to: string) => Promise<CalendarConfigurationProposal>
  onPrepareImport: (contextId: string, input: unknown, from: string, to: string) => Promise<CalendarConfigurationProposal>
  onPrepareGeneration: (from: string, to: string, scope: CalendarChangeScope) => Promise<CalendarGenerationProposal>
  onApply: (proposal: Proposal, event: Event) => Promise<unknown>
}
const labels = ['日', '月', '火', '水', '木', '金', '土']
function configuration(state: CalendarRulesState): CalendarRulesConfiguration { const { contexts, bindings, calendars, activities, sources, facts, rules } = state; return structuredClone({ contexts, bindings, calendars, activities, sources, facts, rules }) }
function when(spec: ResolvedCalendarSpec) { return spec.kind === 'task' ? `${spec.scheduledDate} / 締切 ${spec.dueDate ?? 'なし'}` : `${new Date(spec.startAt!).toLocaleString('ja-JP', { timeZone: spec.timezone })} 〜 ${new Date(spec.endAt!).toLocaleString('ja-JP', { timeZone: spec.timezone })} (${spec.timezone})` }
function ruleWhen(trigger: CalendarRule['trigger']) { return trigger.kind === 'weekly' ? `毎週${trigger.weekdays.map(day => labels[day]).join('・')}曜 ${trigger.time}` : trigger.kind === 'monthly_business' ? `月の${trigger.from === 'start' ? '最初' : '最後'}から第${trigger.ordinal}営業日 ${trigger.time}` : `活動の${trigger.edge === 'start' ? '開始' : '終了'}から ${trigger.offsetDays}日 ${trigger.offsetMinutes}分` }
function ConfigurationSummary({ proposal }: { proposal: CalendarConfigurationProposal }) { return <details open><summary>保存される本人設定</summary>
  <ul>{proposal.next.contexts.map(context => <li key={context.id}>{context.name} / {context.timezone} / {context.validFrom}〜{context.validTo}</li>)}</ul>
  <ul>{proposal.next.calendars.map(calendar => <li key={calendar.id}>選択カレンダー：{calendar.name} / {calendar.weekdays.map(day => labels[day]).join('・')}曜 / {calendar.validFrom}〜{calendar.validTo}</li>)}</ul>
  <ul>{proposal.next.bindings.map(binding => <li key={binding.id}>本人適用：{binding.confirmed ? '確認済み' : '未確認'} / {binding.weekdays.map(day => labels[day]).join('・')}曜 / 勤務表の本人識別子 {binding.personRef ?? '未設定'} / {binding.validFrom}〜{binding.validTo}</li>)}</ul>
  <ul>{proposal.next.activities.map(activity => <li key={activity.id}>活動：{activity.title} / {activity.weekdays.length ? `${activity.weekdays.map(day => labels[day]).join('・')}曜 / ${activity.startTime}〜${activity.endDayOffset ? `翌${activity.endDayOffset}日 ` : ''}${activity.endTime}` : '公開シフト・読取専用外部予定に明示された日時を使用'}</li>)}</ul>
  <ul>{proposal.next.rules.map(rule => <li key={rule.id}>{rule.title} / {ruleWhen(rule.trigger)} / {rule.enabled ? '有効' : '停止'}<ul>{rule.steps.map(step => <li key={step.key}>{step.title} / 基準から{step.scheduledOffsetDays}日 / 締切{step.dueOffsetDays === null ? 'なし' : `基準から${step.dueOffsetDays}日`} / {step.score?.mode === 'manual' ? `${step.score.manualPoints}pt` : step.kind === 'event' ? `${step.durationMinutes}分の予定` : 'ポイント未設定'}</li>)}</ul>{rule.editions?.map(edition => <p key={edition.id}>変更版{edition.revision}：{edition.scope.kind === 'this_instance' ? '今回だけ' : edition.scope.kind === 'this_and_future' ? `${edition.scope.fromDate}以後` : '未完了すべて'} / {edition.definition.title} / {ruleWhen(edition.definition.trigger)} / {edition.definition.enabled ? '有効' : '停止'} / {edition.definition.steps.map(step => `${step.title}：${step.score?.mode === 'manual' ? `${step.score.manualPoints}pt` : step.kind === 'event' ? `${step.durationMinutes}分` : '未設定'}、基準から${step.scheduledOffsetDays}日`).join('、')}</p>)}</li>)}</ul>
  {proposal.importPreview && <ul>{proposal.importPreview.facts.map(fact => <li key={fact.id}>取込：{fact.kind} / {'date' in fact ? fact.date : 'originalDate' in fact ? `${fact.originalDate}${fact.kind === 'reschedule' ? ` → ${fact.newDate}` : ''}` : fact.kind === 'external_event' ? `${fact.title} / ${fact.startAt}〜${fact.endAt} / ${fact.timezone} / ${fact.status} / ICS読取専用` : `${fact.startAt}〜${fact.endAt} / ${fact.personRef} / ${fact.published ? '公開' : '下書き'} / ${fact.status}`} / v{fact.revision} / {fact.validity === 'active' ? '有効' : '撤回'} / 置換する事実 {fact.supersedes.join('、') || 'なし'}</li>)}</ul>}
  {proposal.conflicts.map((conflict, index) => <p role="alert" key={`${conflict.key}:${index}`}>確認待ち：{conflict.reason}。この矛盾が残る系列の発生回は反映しません。</p>)}
</details> }
function Weekdays({ value, onChange, name }: { value: number[]; onChange: (days: number[]) => void; name: string }) { return <fieldset><legend>{name}</legend>{labels.map((label, day) => <label key={day}><input type="checkbox" checked={value.includes(day)} onChange={event => onChange(event.target.checked ? [...value, day].sort() : value.filter(value => value !== day))} />{label}曜 </label>)}</fieldset> }

export function CalendarRulesView({ state, onPrepareConfiguration, onPrepareImport, onPrepareGeneration, onApply }: Props) {
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [proposal, setProposal] = useState<Proposal | null>(null)
  const [from, setFrom] = useState(addDays(today(), -14)), [to, setTo] = useState(addDays(today(), 90))
  const [contextName, setContextName] = useState(''), [domain, setDomain] = useState<'education' | 'work' | 'other'>('work'), [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [validFrom, setValidFrom] = useState(today()), [validTo, setValidTo] = useState(addDays(today(), 365)), [calendarName, setCalendarName] = useState(''), [businessDays, setBusinessDays] = useState([1, 2, 3, 4, 5]), [ownDays, setOwnDays] = useState([1, 2, 3, 4, 5])
  const [personRef, setPersonRef] = useState(''), [activityTitle, setActivityTitle] = useState(''), [startTime, setStartTime] = useState('09:00'), [endTime, setEndTime] = useState('17:00'), [overnight, setOvernight] = useState(false), [rosterOnly, setRosterOnly] = useState(false), [applicabilityConfirmed, setApplicabilityConfirmed] = useState(false)
  const [contextId, setContextId] = useState(state.contexts[0]?.id ?? ''), [editId, setEditId] = useState(''), [title, setTitle] = useState(''), [stepTitle, setStepTitle] = useState(''), [points, setPoints] = useState(''), [stepKind, setStepKind] = useState<'task' | 'event'>('task'), [duration, setDuration] = useState('30'), [scheduledOffset, setScheduledOffset] = useState('0'), [dueOffset, setDueOffset] = useState('')
  const [selectedBindingId, setSelectedBindingId] = useState(''), [selectedCalendarId, setSelectedCalendarId] = useState('')
  const [triggerKind, setTriggerKind] = useState<'weekly' | 'monthly_business' | 'activity_relative'>('weekly'), [weeklyDays, setWeeklyDays] = useState([1]), [time, setTime] = useState('09:00'), [ordinal, setOrdinal] = useState('2'), [ordinalFrom, setOrdinalFrom] = useState<'start' | 'end'>('start'), [activityId, setActivityId] = useState(''), [edge, setEdge] = useState<'start' | 'end'>('start'), [relativeDays, setRelativeDays] = useState('0'), [relativeMinutes, setRelativeMinutes] = useState('0'), [enabled, setEnabled] = useState(true)
  const [scopeKind, setScopeKind] = useState<CalendarChangeScope['kind']>('all_uncompleted'), [futureFrom, setFutureFrom] = useState(today()), [instanceKey, setInstanceKey] = useState('')
  const [importConfirmed, setImportConfirmed] = useState(false), [applyConfirmed, setApplyConfirmed] = useState(false)
  const chosenContextId = contextId || state.contexts[0]?.id || ''
  const chosenContext = state.contexts.find(item => item.id === chosenContextId)
  const compatibleBindings = state.bindings.filter(item => item.contextId === chosenContextId && item.personId === state.ownerId && item.confirmed)
  const compatibleCalendars = state.calendars.filter(item => item.contextId === chosenContextId)
  const binding = compatibleBindings.find(item => item.id === (selectedBindingId || (compatibleBindings.length === 1 ? compatibleBindings[0].id : '')))
  const calendar = compatibleCalendars.find(item => item.id === (selectedCalendarId || (compatibleCalendars.length === 1 ? compatibleCalendars[0].id : '')))
  const compatibleActivities = state.activities.filter(item => item.contextId === chosenContextId && item.bindingId === binding?.id && item.calendarId === calendar?.id)
  const chosenActivityId = activityId || (compatibleActivities.length === 1 ? compatibleActivities[0].id : '')
  const ruleInstances = state.instances.filter(item => item.spec.ruleId === editId)
  const scope = (): CalendarChangeScope => scopeKind === 'this_instance' ? { kind: scopeKind, generationKey: instanceKey } : scopeKind === 'this_and_future' ? { kind: scopeKind, fromDate: futureFrom } : { kind: scopeKind }
  async function prepare(run: () => Promise<Proposal>) { setBusy(true); setMessage(''); setProposal(null); setApplyConfirmed(false); try { setProposal(await run()) } catch (error) { setMessage(String(error)) } finally { setBusy(false) } }
  function editRule(id: string) {
    setEditId(id); setProposal(null); setSelectedBindingId(''); setSelectedCalendarId(''); setActivityId('')
    const base = state.rules.find(rule => rule.id === id)
    if (!base) { setTitle(''); setStepTitle(''); setPoints(''); setEnabled(true); return }
    const rule = { ...base, ...calendarRuleEditorDefinition(base) }, step = rule.steps[0]
    setContextId(rule.contextId); setSelectedBindingId(rule.bindingId); setSelectedCalendarId(rule.calendarId); setTitle(rule.title); setStepTitle(step.title); setPoints(step.score?.mode === 'manual' ? String(step.score.manualPoints) : ''); setStepKind(step.kind); setDuration(String(step.durationMinutes ?? 30)); setScheduledOffset(String(step.scheduledOffsetDays)); setDueOffset(step.dueOffsetDays === null ? '' : String(step.dueOffsetDays)); setEnabled(rule.enabled); setTriggerKind(rule.trigger.kind)
    if (rule.trigger.kind === 'weekly') { setWeeklyDays(rule.trigger.weekdays); setTime(rule.trigger.time) }
    else if (rule.trigger.kind === 'monthly_business') { setOrdinal(String(rule.trigger.ordinal)); setOrdinalFrom(rule.trigger.from); setTime(rule.trigger.time) }
    else { setActivityId(rule.trigger.activityId); setEdge(rule.trigger.edge); setRelativeDays(String(rule.trigger.offsetDays)); setRelativeMinutes(String(rule.trigger.offsetMinutes)) }
    setInstanceKey(state.instances.find(item => item.spec.ruleId === id)?.generationKey ?? '')
  }
  async function createContext(event: FormEvent) {
    event.preventDefault()
    if (!applicabilityConfirmed) { setMessage('本人に適用される活動・曜日・期間を確認してください'); return }
    const id = uid(), bindingId = uid(), calendarId = uid(), nextActivityId = activityTitle.trim() ? uid() : null
    const period = { validFrom, validTo, revision: 1 }, next = configuration(state)
    next.contexts.push({ id, name: contextName.trim(), domain, timezone, ...period })
    next.bindings.push({ id: bindingId, contextId: id, personId: state.ownerId, personRef: personRef.trim() || null, activityIds: nextActivityId ? [nextActivityId] : [], weekdays: ownDays, confirmed: true, ...period })
    next.calendars.push({ id: calendarId, contextId: id, name: calendarName.trim(), weekdays: businessDays, ...period })
    if (nextActivityId) next.activities.push({ id: nextActivityId, contextId: id, bindingId, calendarId, title: activityTitle.trim(), eventKind: domain === 'education' ? 'class' : 'other', weekdays: rosterOnly ? [] : ownDays, startTime, endTime, endDayOffset: overnight ? 1 : 0, ...period })
    await prepare(() => onPrepareConfiguration(next, state.revision, from, to))
  }
  async function saveRule(event: FormEvent) {
    event.preventDefault()
    if (!chosenContext || !binding || !calendar) { setMessage('本人の対象・適用条件・カレンダーを先に登録してください'); return }
    const next = configuration(state), old = state.rules.find(rule => rule.id === editId)
    const trigger: CalendarRule['trigger'] = triggerKind === 'weekly' ? { kind: triggerKind, weekdays: weeklyDays, time } : triggerKind === 'monthly_business' ? { kind: triggerKind, ordinal: Number(ordinal), from: ordinalFrom, time } : { kind: triggerKind, activityId: chosenActivityId, edge, offsetDays: Number(relativeDays), offsetMinutes: Number(relativeMinutes) }
    const steps = calendarRuleEditorSteps(old, { title: stepTitle.trim(), kind: stepKind, scheduledOffsetDays: Number(scheduledOffset), dueOffsetDays: stepKind === 'task' && dueOffset !== '' ? Number(dueOffset) : null, durationMinutes: stepKind === 'event' ? Number(duration) : null }, points)
    const definition = { title: title.trim(), enabled, trigger, steps }
    if (old) {
      const target = next.rules.find(rule => rule.id === old.id)!
      target.revision++; target.editions = [...(target.editions ?? []), { id: uid(), revision: target.revision, scope: scope(), definition }]
    } else next.rules.push({ id: uid(), contextId: chosenContextId, bindingId: binding.id, calendarId: calendar.id, originBasis: 'user_instruction', validFrom: chosenContext.validFrom, validTo: chosenContext.validTo, revision: 1, ...definition })
    await prepare(() => onPrepareConfiguration(next, state.revision, from, to))
  }
  async function apply(event: Event) { if (!proposal || !applyConfirmed) return; setBusy(true); setMessage(''); try { await onApply(proposal, event); setProposal(null); setApplyConfirmed(false); setMessage(proposal.kind === 'configuration' ? '設定を保存しました。予定・タスクの差分を確認して反映できます。' : '確認した発生回を反映しました。') } catch (error) { setMessage(String(error)) } finally { setBusy(false) } }
  const sampleCalendar = calendar?.id ?? 'calendar-id'
  const importSample = { format: 'coach-schedule-facts', version: 1, source: { id: 'official-calendar', title: '本人が選んだ正式な会社暦', authorityScope: 'calendar', coverageFrom: from, coverageTo: to, revision: 1 }, facts: [{ id: 'closed-day', revision: 1, validity: 'active', supersedes: [], kind: 'closed', calendarId: sampleCalendar, date: today() }] }
  return <section className="card setting-section calendar-rules-view"><h2>勤務・授業と共通ルーティン</h2>
    <p>本人が指定した周期と取り込んだ予定を照合します。活動だけを登録した場合、準備タスクは作りません。</p>
    {message && <p role="status">{message}</p>}
    <div className="form-grid"><label>差分を確認する開始日<input type="date" value={from} onChange={event => { setFrom(event.target.value); setProposal(null) }} /></label><label>終了日<input type="date" value={to} onChange={event => { setTo(event.target.value); setProposal(null) }} /></label></div>
    <details><summary>本人の対象・カレンダーを登録</summary><form onSubmit={createContext}>
      <label>対象名<input required value={contextName} onChange={event => setContextName(event.target.value)} placeholder="例：所属会社、履修している講座" /></label>
      <label>種類<select value={domain} onChange={event => setDomain(event.target.value as typeof domain)}><option value="work">勤務</option><option value="education">授業</option><option value="other">その他</option></select></label>
      <label>タイムゾーン<input required value={timezone} onChange={event => setTimezone(event.target.value)} /></label>
      <label>有効開始<input type="date" required value={validFrom} onChange={event => setValidFrom(event.target.value)} /></label><label>有効終了<input type="date" required value={validTo} onChange={event => setValidTo(event.target.value)} /></label>
      <label>本人が選ぶ営業・稼働日カレンダー名<input required value={calendarName} onChange={event => setCalendarName(event.target.value)} /></label>
      <Weekdays name="通常の営業・稼働日" value={businessDays} onChange={setBusinessDays} /><Weekdays name="本人が参加・出勤する曜日" value={ownDays} onChange={setOwnDays} />
      <label>活動名（空欄なら活動予定なし）<input value={activityTitle} onChange={event => setActivityTitle(event.target.value)} /></label>
      <label>開始<input type="time" value={startTime} onChange={event => setStartTime(event.target.value)} /></label><label>終了<input type="time" value={endTime} onChange={event => setEndTime(event.target.value)} /></label><label><input type="checkbox" checked={overnight} onChange={event => setOvernight(event.target.checked)} />終了は翌日</label>
      <label><input type="checkbox" checked={rosterOnly} onChange={event => setRosterOnly(event.target.checked)} />活動は公開シフトの割当だけを使う</label><label>勤務表内の本人識別子（公開シフト用）<input value={personRef} onChange={event => setPersonRef(event.target.value)} /></label>
      <label><input type="checkbox" required checked={applicabilityConfirmed} onChange={event => setApplicabilityConfirmed(event.target.checked)} />この対象・活動・曜日・期間が自分に適用されることを確認した</label><button disabled={busy}>登録内容と次の10回を確認</button>
    </form></details>
    <h3>明示したルーティン</h3><form onSubmit={saveRule}>
      <label>新規 / 編集<select value={editId} onChange={event => editRule(event.target.value)}><option value="">新規</option>{state.rules.map(rule => <option value={rule.id} key={rule.id}>{rule.title}</option>)}</select></label>
      <label>対象<select value={chosenContextId} disabled={Boolean(editId)} onChange={event => { setContextId(event.target.value); setActivityId(''); setSelectedBindingId(''); setSelectedCalendarId('') }}>{state.contexts.map(context => <option value={context.id} key={context.id}>{context.name}</option>)}</select></label><label>本人の適用条件<select required disabled={Boolean(editId)} value={binding?.id ?? ''} onChange={event => { setSelectedBindingId(event.target.value); setActivityId('') }}><option value="">選択してください</option>{compatibleBindings.map(item => <option key={item.id} value={item.id}>{item.personRef ?? '本人'} / {item.weekdays.map(day => labels[day]).join('・')}曜 / {item.validFrom}〜{item.validTo}</option>)}</select></label><label>営業日カレンダー<select required disabled={Boolean(editId)} value={calendar?.id ?? ''} onChange={event => { setSelectedCalendarId(event.target.value); setActivityId('') }}><option value="">選択してください</option>{compatibleCalendars.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>ルール名<input required value={title} onChange={event => setTitle(event.target.value)} /></label><label>ステップ名<input required value={stepTitle} onChange={event => setStepTitle(event.target.value)} /></label>
      <label>周期<select value={triggerKind} onChange={event => setTriggerKind(event.target.value as typeof triggerKind)}><option value="weekly">毎週の明示曜日</option><option value="monthly_business">毎月の営業日順位</option><option value="activity_relative">承認する活動から相対指定</option></select></label>
      {triggerKind === 'weekly' && <Weekdays name="実行する曜日" value={weeklyDays} onChange={setWeeklyDays} />}
      {triggerKind === 'monthly_business' && <><p>使用カレンダー：{calendar?.name ?? '未選択'}</p><label>月の<select value={ordinalFrom} onChange={event => setOrdinalFrom(event.target.value as typeof ordinalFrom)}><option value="start">最初から</option><option value="end">最後から</option></select></label><label>第何営業日<input type="number" min="1" max="31" value={ordinal} onChange={event => setOrdinal(event.target.value)} /></label></>}
      {triggerKind !== 'activity_relative' ? <label>現地時刻<input type="time" value={time} onChange={event => setTime(event.target.value)} /></label> : <><label>本人の活動<select value={chosenActivityId} onChange={event => setActivityId(event.target.value)}><option value="">選択してください</option>{compatibleActivities.map(activity => <option value={activity.id} key={activity.id}>{activity.title}</option>)}</select></label><label>基準<select value={edge} onChange={event => setEdge(event.target.value as typeof edge)}><option value="start">開始</option><option value="end">終了</option></select></label><label>基準から日数（負は前）<input type="number" min="-366" max="366" value={relativeDays} onChange={event => setRelativeDays(event.target.value)} /></label><label>さらに分数<input type="number" min="-10080" max="10080" value={relativeMinutes} onChange={event => setRelativeMinutes(event.target.value)} /></label></>}
      <label>ステップ種別<select value={stepKind} onChange={event => setStepKind(event.target.value as typeof stepKind)}><option value="task">タスク</option><option value="event">占有予定</option></select></label><label>周期の基準日から予定日まで（日）<input type="number" min="-366" max="366" value={scheduledOffset} onChange={event => setScheduledOffset(event.target.value)} /></label>
      {stepKind === 'task' ? <><label>必要ポイント（空欄は未設定）<input type="number" min="0" max="100000" value={points} onChange={event => setPoints(event.target.value)} /></label><label>基準日から締切まで（日・空欄はなし）<input type="number" min="-366" max="366" value={dueOffset} onChange={event => setDueOffset(event.target.value)} /></label></> : <label>予定時間（分）<input type="number" min="1" max="10080" value={duration} onChange={event => setDuration(event.target.value)} /></label>}
      <label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />このルールを有効にする</label>
      <fieldset><legend>{editId ? 'ルール変更の範囲' : '発生回の反映範囲'}</legend><select value={scopeKind} onChange={event => setScopeKind(event.target.value as typeof scopeKind)}><option value="all_uncompleted">未完了のすべて</option><option value="this_and_future">指定日以後</option><option value="this_instance">今回だけ</option></select>{scopeKind === 'this_and_future' && <input aria-label="以後の開始日" type="date" value={futureFrom} onChange={event => setFutureFrom(event.target.value)} />}{scopeKind === 'this_instance' && <select aria-label="今回だけの発生回" value={instanceKey} onChange={event => setInstanceKey(event.target.value)}><option value="">選択してください</option>{ruleInstances.map(item => <option value={item.generationKey} key={item.generationKey}>{item.spec.title} / {item.spec.scheduledDate ?? calendarDateAt(item.spec.startAt!, item.spec.timezone)}</option>)}</select>}</fieldset>
      <button disabled={busy || !chosenContext}>設定内容と次の10回を確認</button>
    </form>
    <h3>本人が選んだ予定資料</h3><p>授業の振替、会社休日、勤務日変更、本人の公開シフトを共通のJSON形式で取り込みます。資料の範囲・版・本人適用を確認してから保存します。</p>
    {state.sources.map(source => <p key={source.id}>{source.title} / v{source.revision} / {source.coverageFrom}〜{source.coverageTo} / {source.status === 'current' ? '取込済みスナップショット' : '取得が古い・確認待ち'} / {source.importedAt}</p>)}
    <label><input type="checkbox" checked={importConfirmed} onChange={event => setImportConfirmed(event.target.checked)} />選択した資料を「{chosenContext?.name ?? '対象未選択'}」の範囲に適用する</label>
    <label>予定JSONを選択<input type="file" accept=".json,application/json" disabled={busy || !chosenContext || !importConfirmed} onChange={event => { const file = event.target.files?.[0]; if (file) { if (file.size > 2000000) { setMessage('資料JSONは2MB以内にしてください'); return }; void prepare(async () => onPrepareImport(chosenContextId, JSON.parse(await file.text()), from, to)) }; event.target.value = '' }} /></label>
    <details><summary>休日JSONの形式例</summary><pre>{JSON.stringify(importSample, null, 2)}</pre><p>activity資料はreschedule/cancel、roster資料は公開済み本人のroster_assignmentを指定します。削除・資料取得失敗を取消として扱いません。</p></details>
    <h3>予定・タスクへの反映</h3><button disabled={busy || !state.contexts.length} onClick={() => void prepare(() => onPrepareGeneration(from, to, scope()))}>発生回の差分を確認</button>
    {proposal && <section aria-label="共通カレンダーの確認案"><h3>確認案</h3>
      {proposal.kind === 'configuration' ? <><p>設定の保存のみです。次の10回を確認し、保存後に発生回への反映を選べます。</p><ConfigurationSummary proposal={proposal} />{proposal.importPreview && <p>{proposal.importPreview.source.title} / 版{proposal.importPreview.source.revision} / {proposal.importPreview.source.coverageFrom}〜{proposal.importPreview.source.coverageTo} / 新規{proposal.importPreview.newFacts}・変更{proposal.importPreview.changedFacts}・既存保持{proposal.importPreview.untouchedFacts}</p>}<ul>{proposal.preview.map(spec => <li key={spec.generationKey}>{spec.title}：{when(spec)}{spec.score?.manualPoints !== null && spec.score?.mode === 'manual' ? ` / ${spec.score.manualPoints}pt` : ''}</li>)}</ul></> : <><p>新規{proposal.plan.creates.length}・変更{proposal.plan.updates.length}・取消{proposal.plan.cancels.length}・完了済みを保持{proposal.plan.skippedCompleted}・変更なし{proposal.plan.unchanged}</p><ul>{proposal.plan.creates.map(spec => <li key={spec.generationKey}>新規：{spec.title} / {when(spec)}</li>)}{proposal.plan.updates.map(update => <li key={update.after.generationKey}>変更：{update.before.spec.title} / {when(update.before.spec)} → {update.after.title} / {when(update.after)} / {update.before.spec.score?.manualPoints ?? '未設定'}pt → {update.after.score?.manualPoints ?? '未設定'}pt</li>)}{proposal.plan.cancels.map(cancel => <li key={cancel.before.generationKey}>取消：{cancel.before.spec.title} / {when(cancel.before.spec)} / {cancel.reason}</li>)}</ul>{proposal.plan.conflicts.map((conflict, index) => <p role="alert" key={`${conflict.key}:${index}`}>確認が必要：{conflict.reason}（{conflict.sourceRefs.map(reference => `${reference.sourceId}/${reference.factId}/v${reference.revision}`).join('、') || conflict.key}）</p>)}</>}
      <label><input type="checkbox" checked={applyConfirmed} onChange={event => setApplyConfirmed(event.target.checked)} />表示された設定・日付・ポイント・変更範囲を確認した</label><button disabled={busy || !applyConfirmed || proposal.kind === 'generation' && proposal.plan.conflicts.length > 0} onClick={event => void apply(event.nativeEvent)}>{proposal.kind === 'configuration' ? '確認した設定を保存' : '確認した発生回を反映'}</button><button disabled={busy} onClick={() => setProposal(null)}>案を取り消す</button>
    </section>}
  </section>
}
