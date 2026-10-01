import { useEffect, useRef, useState } from 'react'
import { changePolicyFor } from './change-set'
import { calendarRuleEditorDefinition } from './calendar-rule-editor'
import { calendarDateAt, type CalendarChangeScope, type CalendarRule, type CalendarRulesState, type ResolvedCalendarSpec } from './calendar-resolver'
import { applyCalendarProposalFromUI, prepareCalendarGeneration, type CalendarGenerationProposal } from './calendar-rules-save'
import { today, type Settings } from './domain'
import { createRoutineAssistRequest, parseRoutineAssistAnswer, type RoutineAssistCandidate, type RoutineAssistInput } from './routine-assist'
import { confirmRoutineInstructionFromUI } from './routine-instruction'
import { applyRoutineAssistConfigurationFromUI, cancelRoutineAssistance, prepareRoutineAssistConfiguration, type PreparedRoutineAssistance } from './routine-assist-save'
import './RoutineAssistView.css'

export type RoutineSourceSuggestion = {
  message: string
  prepare: (input: RoutineAssistInput, event: Event) => Promise<PreparedRoutineAssistance>
  apply: (prepared: PreparedRoutineAssistance, digest: string, event: Event) => Promise<unknown>
}
type Props = {
  state: CalendarRulesState
  settings: Settings
  initialMessage?: string
  heading?: string
  sourceSuggestion?: RoutineSourceSuggestion
  allowAI?: boolean
  onPrepare?: (input: RoutineAssistInput, candidate: RoutineAssistCandidate, model: string | null, event: Event) => Promise<PreparedRoutineAssistance>
  onApply?: (prepared: PreparedRoutineAssistance, digest: string, event: Event) => Promise<unknown>
  onSaved?: (id: string) => void
  onCancel?: () => void
}
const weekdays = ['日', '月', '火', '水', '木', '金', '土']
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
function ruleWhen(trigger: CalendarRule['trigger']) {
  if (trigger.kind === 'weekly') return `毎週${trigger.weekdays.map(day => weekdays[day]).join('・')}曜 ${trigger.time}`
  if (trigger.kind === 'monthly_business') return `毎月の${trigger.from === 'start' ? '最初' : '最後'}から第${trigger.ordinal}営業日 ${trigger.time}`
  return `選択活動の${trigger.edge === 'start' ? '開始' : '終了'}から ${trigger.offsetDays}日 ${trigger.offsetMinutes}分`
}
function occurrenceWhen(spec: ResolvedCalendarSpec) { return spec.kind === 'task' ? `${spec.scheduledDate} / 締切 ${spec.dueDate ?? 'なし'}` : `${new Date(spec.startAt!).toLocaleString('ja-JP', { timeZone: spec.timezone })}〜${new Date(spec.endAt!).toLocaleString('ja-JP', { timeZone: spec.timezone })}` }
function occurrencePoints(spec: ResolvedCalendarSpec) { return spec.score?.mode === 'manual' ? `${spec.score.manualPoints}pt（本人指定）` : spec.score?.mode === 'formula' ? '計算方式・属性を保持' : spec.kind === 'event' ? `${Math.round((Date.parse(spec.endAt!) - Date.parse(spec.startAt!)) / 60000)}分の予定` : 'ポイント未設定' }
function StepSummary({ steps }: { steps: CalendarRule['steps'] }) { return <ul>{steps.map(step => <li key={step.key}>{step.title} / {step.kind === 'task' ? 'タスク' : '占有予定'} / 基準から{step.scheduledOffsetDays}日 / 締切 {step.dueOffsetDays === null ? 'なし' : `基準から${step.dueOffsetDays}日`} / {step.score?.mode === 'manual' ? `${step.score.manualPoints}pt（本人指定）` : step.score?.mode === 'formula' ? '既存の計算方式・属性を保持' : step.kind === 'event' ? `${step.durationMinutes}分` : 'ポイント未設定'}</li>)}</ul> }

export default function RoutineAssistView({ state, settings, initialMessage = '', heading = '周期の相談と確認', sourceSuggestion, allowAI = true, onPrepare, onApply, onSaved, onCancel }: Props) {
  const [message, setMessage] = useState(sourceSuggestion?.message ?? initialMessage)
  const [targetRuleId, setTargetRuleId] = useState('')
  const [contextId, setContextId] = useState(''), [bindingId, setBindingId] = useState(''), [calendarId, setCalendarId] = useState(''), [activityId, setActivityId] = useState('')
  const [validFrom, setValidFrom] = useState(''), [validTo, setValidTo] = useState(''), [time, setTime] = useState('')
  const [stepKind, setStepKind] = useState<'task' | 'event'>('task'), [duration, setDuration] = useState(''), [scheduledOffset, setScheduledOffset] = useState('0'), [dueOffset, setDueOffset] = useState('')
  const [scopeKind, setScopeKind] = useState<CalendarChangeScope['kind'] | ''>(''), [futureFrom, setFutureFrom] = useState(''), [instanceKey, setInstanceKey] = useState('')
  const [titleQuote, setTitleQuote] = useState(''), [triggerKind, setTriggerKind] = useState<CalendarRule['trigger']['kind'] | ''>(''), [weeklyDays, setWeeklyDays] = useState<number[]>([])
  const [ordinal, setOrdinal] = useState(''), [ordinalFrom, setOrdinalFrom] = useState<'start' | 'end' | ''>(''), [edge, setEdge] = useState<'start' | 'end' | ''>(''), [relativeDays, setRelativeDays] = useState(''), [relativeMinutes, setRelativeMinutes] = useState(''), [points, setPoints] = useState('')
  const [savedCandidate, setCandidate] = useState<RoutineAssistCandidate | null>(null), [candidateModel, setCandidateModel] = useState<string | null>(null)
  const [savedPrepared, setPrepared] = useState<PreparedRoutineAssistance | null>(null), [savedGenerationProposal, setGenerationProposal] = useState<CalendarGenerationProposal | null>(null)
  const [checked, setChecked] = useState(false), [generationChecked, setGenerationChecked] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const sequence = useRef(0)
  const [proofSignatures, setProofSignatures] = useState({ candidate: '', prepared: '', generation: '' })
  const policy = changePolicyFor(settings), context = state.contexts.find(item => item.id === contextId), target = state.rules.find(item => item.id === targetRuleId)
  const signature = JSON.stringify([state.revision, settings.aiEnabled, settings.aiModel, settings.profileId, settings.datasetId, policy.epoch, policy.sourcePermissionRevision])
  const candidate = proofSignatures.candidate === signature ? savedCandidate : null
  const prepared = proofSignatures.prepared === signature ? savedPrepared : null
  const generationProposal = proofSignatures.generation === signature ? savedGenerationProposal : null
  const targetDefinition = target ? calendarRuleEditorDefinition(target) : null
  const bindings = state.bindings.filter(item => item.contextId === contextId && item.confirmed && item.personId === settings.profileId)
  const calendars = state.calendars.filter(item => item.contextId === contextId)
  const activities = state.activities.filter(item => item.contextId === contextId && item.bindingId === bindingId && item.calendarId === calendarId)
  const bridge = window.michiAI?.proposeRoutine
  const aiAvailable = Boolean(!sourceSuggestion && allowAI && settings.aiEnabled && settings.aiModel && bridge)
  const disabled = busy || Boolean(prepared || generationProposal)
  useEffect(() => {
    sequence.current++
    // External authority changes permanently invalidate earlier drafts, including when AI is later re-enabled.
    // oxlint-disable-next-line react/set-state-in-effect
    setProofSignatures({ candidate: '', prepared: '', generation: '' })
  }, [settings.aiEnabled, settings.aiModel, settings.profileId, settings.datasetId, policy.epoch, policy.sourcePermissionRevision, state.revision])
  useEffect(() => () => { if (savedPrepared) cancelRoutineAssistance(savedPrepared) }, [savedPrepared, signature])
  function changed(action: () => void) { sequence.current++; action(); setCandidate(null); setCandidateModel(null); setPrepared(null); setGenerationProposal(null); setChecked(false); setGenerationChecked(false); setNotice('') }
  function scope(): CalendarChangeScope {
    if (scopeKind === 'all_uncompleted') return { kind: scopeKind }
    if (scopeKind === 'this_and_future' && futureFrom) return { kind: scopeKind, fromDate: futureFrom }
    if (scopeKind === 'this_instance' && instanceKey) return { kind: scopeKind, generationKey: instanceKey }
    throw new Error('変更の範囲と、その対象日・発生回を明示的に選んでください')
  }
  function input(): RoutineAssistInput {
    if (!context || !bindingId || !calendarId || !validFrom || !validTo || !time) throw new Error('対象・本人適用・カレンダー・有効期間・時刻をすべて選んでください')
    if (targetRuleId && !target) throw new Error('編集対象が変わりました。現在のルールを選び直してください')
    if (stepKind === 'event' && !duration.trim()) throw new Error('占有予定の時間を本人が指定してください')
    return { message: sourceSuggestion?.message ?? message, referenceDate: today(), targetRuleId: target?.id ?? null, expectedRuleRevision: target?.revision ?? null, selection: { contextId, bindingId, calendarId, activityId: activityId || null, timezone: context.timezone, validFrom, validTo, time, stepKind, durationMinutes: stepKind === 'event' ? Number(duration) : null, scheduledOffsetDays: Number(scheduledOffset), dueOffsetDays: stepKind === 'event' || dueOffset === '' ? null : Number(dueOffset) }, scope: scope() }
  }
  function manualCandidate(current: RoutineAssistInput): RoutineAssistCandidate {
    if (!triggerKind) throw new Error('本文に明示した周期を選んでください')
    if (!target && !titleQuote.trim()) throw new Error('新規作業の名前を、本人の相談文からそのまま入力してください')
    if (triggerKind === 'activity_relative' && !relativeDays.trim() && !relativeMinutes.trim()) throw new Error('活動からの日数または分数を本人が明示してください。0も指定できます。')
    const trigger = triggerKind === 'weekly' ? { kind: triggerKind, weekdays: weeklyDays, time } : triggerKind === 'monthly_business' ? { kind: triggerKind, ordinal: Number(ordinal), from: ordinalFrom, time } : { kind: triggerKind, activityId, edge, offsetDays: Number(relativeDays), offsetMinutes: Number(relativeMinutes) }
    return parseRoutineAssistAnswer(JSON.stringify({ title_quote: titleQuote.trim() || null, recurrence_quote: current.message, trigger, manual_points: points.trim() === '' ? null : Number(points), reason: '本人が相談文に明示した周期を入力欄で指定した' }), current, state)
  }
  async function ask() {
    if (!aiAvailable || busy) return
    const token = ++sequence.current
    setBusy(true); setNotice('')
    try {
      const current = input(), model = settings.aiModel!
      const answer = await bridge!(createRoutineAssistRequest(current, state, model))
      if (token !== sequence.current) throw new Error('相談中に設定・本人適用・ルールの版が変わりました。選択内容を確認し直してください。')
      const next = parseRoutineAssistAnswer(answer, current, state)
      setProofSignatures(current => ({ ...current, candidate: signature })); setCandidate(next); setCandidateModel(model); setNotice('周期の候補を作りました。まだ設定や発生回は保存していません。')
    } catch (error) { setNotice(`${errorText(error)} 本文と入力欄は残っています。`) }
    finally { setBusy(false) }
  }
  async function prepare(event: Event) {
    if (busy) return
    const token = ++sequence.current
    setBusy(true); setNotice('')
    try {
      const current = input()
      let next: PreparedRoutineAssistance
      if (sourceSuggestion) next = await sourceSuggestion.prepare(current, event)
      else {
        const selected = candidate ?? manualCandidate(current), model = candidate ? candidateModel : null
        next = onPrepare ? await onPrepare(current, selected, model, event) : await prepareRoutineAssistConfiguration(await confirmRoutineInstructionFromUI(current, selected, model, event))
        setProofSignatures(current => ({ ...current, candidate: signature })); setCandidate(selected); setCandidateModel(model)
      }
      if (token !== sequence.current) { cancelRoutineAssistance(next); throw new Error('確認中に設定や対象が変わりました。本人の指定を確認し直してください。') }
      setProofSignatures(current => ({ ...current, prepared: signature })); setPrepared(next); setChecked(false); setNotice('本人の周期指定と設定差分を確認しました。表示した設定を保存するには、続く承認が必要です。')
    } catch (error) { setNotice(`${errorText(error)} 本文と入力欄は残っています。`) }
    finally { setBusy(false) }
  }
  async function save(event: Event) {
    if (!prepared || !checked || busy) return
    setBusy(true); setNotice('')
    try {
      const result = sourceSuggestion ? await sourceSuggestion.apply(prepared, prepared.digest, event) : onApply ? await onApply(prepared, prepared.digest, event) : await applyRoutineAssistConfigurationFromUI(prepared, prepared.digest, event)
      setPrepared(null); setCandidate(null); setCandidateModel(null); setChecked(false); setNotice('周期の設定を保存しました。タスク・予定への反映は別の承認で行います。'); onSaved?.(typeof result === 'string' ? result : prepared.id)
    } catch (error) { setNotice(`${errorText(error)} 指定と確認案は残っています。`) }
    finally { setBusy(false) }
  }
  async function prepareGeneration() {
    if (busy) return
    setBusy(true); setNotice('')
    try { if (!validFrom || !validTo) throw new Error('発生回を確認する期間を指定してください'); const next = await prepareCalendarGeneration(validFrom, validTo, scope()); setProofSignatures(current => ({ ...current, generation: signature })); setGenerationProposal(next); setGenerationChecked(false) }
    catch (error) { setNotice(errorText(error)) }
    finally { setBusy(false) }
  }
  async function generate(event: Event) {
    if (!generationProposal || !generationChecked || busy) return
    setBusy(true); setNotice('')
    try { await applyCalendarProposalFromUI(generationProposal, event); setGenerationProposal(null); setGenerationChecked(false); setNotice('確認した発生回を反映しました。完了済みの実績は保持しています。') }
    catch (error) { setNotice(errorText(error)) }
    finally { setBusy(false) }
  }
  const proposedRules = prepared?.configuration.next.rules.filter(rule => !state.rules.some(old => old.id === rule.id && old.revision === rule.revision)) ?? []
  return <section className="card routine-assist-view" aria-label={heading}>
    <h3>{heading}</h3>
    <p>本人が指定した周期を確認し、選んだカレンダーで次の発生回を示します。</p>
    <label className="field">{sourceSuggestion ? '検証済みの周期候補（参照用）' : '本人の周期の相談文'}<textarea aria-label="周期の相談文" rows={3} maxLength={4000} value={sourceSuggestion?.message ?? message} readOnly={Boolean(sourceSuggestion)} disabled={disabled} onChange={event => changed(() => setMessage(event.target.value))} placeholder="例：毎月第2営業日に勤怠提出" /></label>
    {!sourceSuggestion && <label className="field">新規 / 編集<select aria-label="周期相談の編集対象" value={targetRuleId} disabled={disabled} onChange={event => changed(() => { setTargetRuleId(event.target.value); const chosen = state.rules.find(item => item.id === event.target.value); const first = chosen ? calendarRuleEditorDefinition(chosen).steps[0] : null; setStepKind(first?.kind ?? 'task'); setDuration(first?.durationMinutes === null || first?.durationMinutes === undefined ? '' : String(first.durationMinutes)) })}><option value="">新規の周期設定</option>{state.rules.map(rule => <option key={rule.id} value={rule.id}>{rule.title}（版{rule.revision}）</option>)}</select></label>}
    {targetDefinition && target && <details open><summary>現在の手順・ポイント</summary><p>{targetDefinition.title} / {ruleWhen(targetDefinition.trigger)} / {targetDefinition.enabled ? '有効' : '停止'}</p><p>対象：{state.contexts.find(item => item.id === target.contextId)?.name} / カレンダー：{state.calendars.find(item => item.id === target.calendarId)?.name} / 有効期間：{target.validFrom}〜{target.validTo}</p><StepSummary steps={targetDefinition.steps} /><p className="muted">周期相談は、明示された変更以外の既存手順・ポイント・属性を保持します。各手順の編集は通常のルール編集で行えます。</p></details>}
    <div className="form-grid">
      <label className="field">本人が選ぶ対象<select aria-label="周期相談の対象" value={contextId} disabled={disabled} onChange={event => changed(() => { setContextId(event.target.value); setBindingId(''); setCalendarId(''); setActivityId('') })}><option value="">対象を選択してください</option>{state.contexts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="field">確認済みの本人適用<select aria-label="周期相談の本人適用" value={bindingId} disabled={disabled || !contextId} onChange={event => changed(() => { setBindingId(event.target.value); setActivityId('') })}><option value="">適用条件を選択してください</option>{bindings.map(item => <option key={item.id} value={item.id}>{item.personRef ?? '本人'} / {item.weekdays.map(day => weekdays[day]).join('・')}曜 / {item.validFrom}〜{item.validTo}</option>)}</select></label>
      <label className="field">本人が選ぶ営業・稼働カレンダー<select aria-label="周期相談のカレンダー" value={calendarId} disabled={disabled || !contextId} onChange={event => changed(() => { setCalendarId(event.target.value); setActivityId('') })}><option value="">カレンダーを選択してください</option>{calendars.map(item => <option key={item.id} value={item.id}>{item.name} / {item.weekdays.map(day => weekdays[day]).join('・')}曜</option>)}</select></label>
      <label className="field">活動（相対指定する場合のみ）<select aria-label="周期相談の活動" value={activityId} disabled={disabled || !bindingId || !calendarId} onChange={event => changed(() => setActivityId(event.target.value))}><option value="">活動を指定しない</option>{activities.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <label className="field">選択対象のタイムゾーン<input aria-label="周期相談のタイムゾーン" readOnly value={context?.timezone ?? ''} placeholder="対象を選択すると表示" /></label>
      <label className="field">本人が指定する現地時刻<input aria-label="周期相談の時刻" type="time" value={time} disabled={disabled} onChange={event => changed(() => setTime(event.target.value))} /></label>
      <label className="field">有効開始日<input aria-label="周期相談の有効開始日" type="date" value={validFrom} disabled={disabled} onChange={event => changed(() => setValidFrom(event.target.value))} /></label>
      <label className="field">有効終了日<input aria-label="周期相談の有効終了日" type="date" value={validTo} disabled={disabled} onChange={event => changed(() => setValidTo(event.target.value))} /></label>
    </div>
    {!target && <details><summary>本人が指定する作業の形</summary><div className="form-grid">
      <label className="field">作業の種別<select aria-label="周期相談の作業種別" value={stepKind} disabled={disabled} onChange={event => changed(() => setStepKind(event.target.value as typeof stepKind))}><option value="task">タスク</option><option value="event">占有予定</option></select></label>
      <label className="field">基準日から予定日まで（日）<input aria-label="周期相談の予定日オフセット" type="number" min={-366} max={366} value={scheduledOffset} disabled={disabled} onChange={event => changed(() => setScheduledOffset(event.target.value))} /></label>
      {stepKind === 'task' ? <label className="field">基準日から本当の締切まで（日、空欄はなし）<input aria-label="周期相談の締切オフセット" type="number" min={-366} max={366} value={dueOffset} disabled={disabled} onChange={event => changed(() => setDueOffset(event.target.value))} /></label> : <label className="field">占有する時間（分）<input aria-label="周期相談の占有時間" type="number" min={1} max={10080} value={duration} disabled={disabled} onChange={event => changed(() => setDuration(event.target.value))} /></label>}
    </div></details>}
    <label className="field">変更・反映する範囲<select aria-label="周期相談の変更範囲" value={scopeKind} disabled={disabled} onChange={event => changed(() => setScopeKind(event.target.value as typeof scopeKind))}><option value="">範囲を選択してください</option><option value="all_uncompleted">未完了のすべて</option><option value="this_and_future">指定日以後</option>{target && <option value="this_instance">今回だけ</option>}</select></label>
    {scopeKind === 'this_and_future' && <label className="field">以後の開始日<input aria-label="周期相談の以後開始日" type="date" value={futureFrom} disabled={disabled} onChange={event => changed(() => setFutureFrom(event.target.value))} /></label>}
    {scopeKind === 'this_instance' && <label className="field">今回だけの発生回<select aria-label="周期相談の今回の発生回" value={instanceKey} disabled={disabled} onChange={event => changed(() => setInstanceKey(event.target.value))}><option value="">発生回を選択してください</option>{state.instances.filter(item => item.spec.ruleId === targetRuleId).map(item => <option key={item.generationKey} value={item.generationKey}>{item.spec.title} / {item.spec.scheduledDate ?? calendarDateAt(item.spec.startAt!, item.spec.timezone)}</option>)}</select></label>}
    {!sourceSuggestion && <>
      <p className="muted">AIには相談文、基準日、選んだ対象・本人適用・カレンダー・活動のIDと暦名・活動名、タイムゾーン、有効期間、時刻を送ります。編集時は選択ルールのID・版・名前・周期も送ります。</p>
      {allowAI && <button type="button" className="secondary-button" disabled={disabled || !aiAvailable || !message.trim()} onClick={() => void ask()}>AIで周期の候補を作る</button>}
      {allowAI && !aiAvailable && <p className="muted">AIは停止中、または利用できません。下の本人入力で周期を指定できます。</p>}
      <details><summary>本文に明示した周期を本人が入力</summary>
        <p className="muted">相談文に書いた作業名と周期をそのまま指定してください。指定のない既存ポイントは保持します。</p>
        <div className="form-grid">
          <label className="field">本文に書いた作業名（編集で維持するなら空欄）<input aria-label="周期相談の本文作業名" maxLength={300} value={titleQuote} disabled={disabled} onChange={event => changed(() => setTitleQuote(event.target.value))} /></label>
          <label className="field">明示した周期<select aria-label="周期相談の本人入力周期" value={triggerKind} disabled={disabled} onChange={event => changed(() => setTriggerKind(event.target.value as typeof triggerKind))}><option value="">周期を選択してください</option><option value="weekly">毎週の明示曜日</option><option value="monthly_business">毎月の営業日順位</option><option value="activity_relative">選択活動からの相対指定</option></select></label>
          {triggerKind === 'monthly_business' && <><label className="field">数える向き<select aria-label="周期相談の営業日の向き" value={ordinalFrom} disabled={disabled} onChange={event => changed(() => setOrdinalFrom(event.target.value as typeof ordinalFrom))}><option value="">向きを選択してください</option><option value="start">月の最初から</option><option value="end">月の最後から</option></select></label><label className="field">第何営業日<input aria-label="周期相談の営業日順位" type="number" min={1} max={31} value={ordinal} disabled={disabled} onChange={event => changed(() => setOrdinal(event.target.value))} /></label></>}
          {triggerKind === 'activity_relative' && <><label className="field">活動の基準<select aria-label="周期相談の活動基準" value={edge} disabled={disabled} onChange={event => changed(() => setEdge(event.target.value as typeof edge))}><option value="">基準を選択してください</option><option value="start">開始</option><option value="end">終了</option></select></label><label className="field">基準からの日数<input aria-label="周期相談の相対日数" type="number" min={-366} max={366} value={relativeDays} disabled={disabled} onChange={event => changed(() => setRelativeDays(event.target.value))} /></label><label className="field">さらに分数<input aria-label="周期相談の相対分数" type="number" min={-10080} max={10080} value={relativeMinutes} disabled={disabled} onChange={event => changed(() => setRelativeMinutes(event.target.value))} /></label></>}
          <label className="field">本文に明示した本人指定ポイント（空欄は変更なし）<input aria-label="周期相談の本人指定ポイント" type="number" min={0} max={100000} value={points} disabled={disabled} onChange={event => changed(() => setPoints(event.target.value))} /></label>
        </div>
        {triggerKind === 'weekly' && <fieldset><legend>本文に明示した曜日</legend>{weekdays.map((name, day) => <label key={day}><input type="checkbox" aria-label={`周期相談の${name}曜日`} checked={weeklyDays.includes(day)} disabled={disabled} onChange={event => changed(() => setWeeklyDays(event.target.checked ? [...weeklyDays, day].sort() : weeklyDays.filter(value => value !== day)))} />{name}曜 </label>)}</fieldset>}
      </details>
    </>}
    <p className="muted">毎日・隔週・固定日など未対応の周期や、時刻付きの締切は確認待ちになります。別の周期や日付へ置き換えません。</p>
    {candidate && <section aria-label="周期の候補"><h4>保存前の候補</h4><p>{candidate.definition.title} / {ruleWhen(candidate.definition.trigger)}</p><StepSummary steps={candidate.definition.steps} />{candidate.notices.map((item, index) => <p key={index}>{item}</p>)}</section>}
    <div className="routine-assist-actions"><button type="button" className="primary-button" disabled={disabled || !(sourceSuggestion?.message ?? message).trim()} onClick={event => void prepare(event.nativeEvent)}>本人の周期指定を確定して次の10回を確認</button>{onCancel && <button type="button" className="text-button" disabled={busy} onClick={onCancel}>周期候補を閉じる</button>}</div>
    {prepared && <section className="routine-assist-preview" aria-label="周期設定の確認案"><h4>保存される設定と次の10回</h4>
      {proposedRules.map(rule => { const definition = calendarRuleEditorDefinition(rule); return <div key={rule.id}><p><strong>{definition.title}</strong> / {ruleWhen(definition.trigger)} / {rule.validFrom}〜{rule.validTo} / {definition.enabled ? '有効' : '停止'}</p><StepSummary steps={definition.steps} /></div> })}
      <p>カレンダー：{calendars.find(item => item.id === calendarId)?.name ?? '選択済みカレンダー'} / {context?.timezone} / 変更範囲：{scopeKind === 'all_uncompleted' ? '未完了すべて' : scopeKind === 'this_and_future' ? `${futureFrom}以後` : '今回だけ'}</p>
      {prepared.configuration.preview.length > 0 ? <ol>{prepared.configuration.preview.map(spec => <li key={spec.generationKey}>{spec.title}：{occurrenceWhen(spec)}{spec.score?.mode === 'manual' ? ` / ${spec.score.manualPoints}pt` : ''}</li>)}</ol> : <p>この期間の発生回はありません。期間と本人適用を確認してください。</p>}
      {prepared.configuration.conflicts.map((conflict, index) => <p role="alert" key={`${conflict.key}:${index}`}>{conflict.reason}</p>)}
      <p className="muted">設定の保存だけを行います。タスクや予定への反映は続く別の確認で行えます。</p>
      <label><input type="checkbox" aria-label="周期設定の差分を確認" checked={checked} disabled={busy} onChange={event => setChecked(event.target.checked)} />本人指定・カレンダー・期間・手順・ポイント・変更範囲を確認した</label>
      <div className="routine-assist-actions"><button type="button" className="primary-button" disabled={busy || !checked} onClick={event => void save(event.nativeEvent)}>確認した周期設定を保存</button><button type="button" className="text-button" disabled={busy} onClick={() => { cancelRoutineAssistance(prepared); setPrepared(null); setChecked(false); setNotice('設定案を取り消しました。本文と入力欄は残っています。') }}>設定案を取り消す</button></div>
    </section>}
    {!sourceSuggestion && <details><summary>保存済みの周期をタスク・予定へ反映</summary><p>上で指定した期間と変更範囲で、保存済みの共通カレンダー全体の差分を確認します。</p><button type="button" className="secondary-button" disabled={disabled || !state.rules.length} onClick={() => void prepareGeneration()}>発生回への反映を別に確認</button></details>}
    {generationProposal && <section className="routine-assist-preview" aria-label="周期発生回の確認案"><h4>タスク・予定への反映差分</h4><p>新規 {generationProposal.plan.creates.length} · 変更 {generationProposal.plan.updates.length} · 取消 {generationProposal.plan.cancels.length} · 完了済みを保持 {generationProposal.plan.skippedCompleted}</p>
      <ul>{generationProposal.plan.creates.map(spec => <li key={spec.generationKey}>新規：{spec.title} / {occurrenceWhen(spec)} / {occurrencePoints(spec)}</li>)}{generationProposal.plan.updates.map(update => <li key={update.after.generationKey}>変更：{update.before.spec.title} / {occurrenceWhen(update.before.spec)} / {occurrencePoints(update.before.spec)} → {update.after.title} / {occurrenceWhen(update.after)} / {occurrencePoints(update.after)}</li>)}{generationProposal.plan.cancels.map(cancel => <li key={cancel.before.generationKey}>取消：{cancel.before.spec.title} / {occurrenceWhen(cancel.before.spec)} / {occurrencePoints(cancel.before.spec)} / {cancel.reason}</li>)}</ul>
      {generationProposal.plan.conflicts.map((conflict, index) => <p role="alert" key={`${conflict.key}:${index}`}>{conflict.reason}</p>)}
      <label><input type="checkbox" aria-label="周期発生回の差分を確認" checked={generationChecked} disabled={busy} onChange={event => setGenerationChecked(event.target.checked)} />表示した新規・変更・取消と完了実績の保持を確認した</label>
      <div className="routine-assist-actions"><button type="button" className="primary-button" disabled={busy || !generationChecked || generationProposal.plan.conflicts.length > 0} onClick={event => void generate(event.nativeEvent)}>確認した発生回を反映</button><button type="button" className="text-button" disabled={busy} onClick={() => { setGenerationProposal(null); setGenerationChecked(false) }}>発生回の案を取り消す</button></div>
    </section>}
    {busy && <p role="status">指定内容を確認しています…</p>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
