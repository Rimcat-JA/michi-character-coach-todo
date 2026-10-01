import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import CoachTaskChangeView from './CoachTaskChangeView'
import CoachSplitView from './CoachSplitView'
import RoutineAssistView from './RoutineAssistView'
import { loadCalendarRulesState } from './calendar-rules-save'
import { parseCoachTargetAnswer, resolveCoachTarget, type CoachTargetCandidate, type CoachTargetResolution } from './coach-target-resolution'
import { consultationKind, parseCoachSplit, type CoachSplitPart } from './coach-split'
import type { Settings, Task } from './domain'

export type ConsultNotification = { id: string; title: string; taskIds: string[]; revisions: Record<string, number> }
type Analysis = { kind: 'task' | 'split' | 'clarify' | 'routine'; text: string; resolution: CoachTargetResolution | null; parts: CoachSplitPart[]; message: string }
/** N08: identify the target from the consultation itself, ask when ambiguous, then hand off to the approval-bound flows. */
export default function CoachConsultView({ settings, tasks, notification, initialText = '', onEdit, onClose }: { settings: Settings; tasks: Task[]; notification?: ConsultNotification; initialText?: string; onEdit?: (task: Task) => void; onClose?: () => void }) {
  const [text, setText] = useState(initialText), [analysis, setAnalysis] = useState<Analysis | null>(null), [chosenId, setChosenId] = useState(''), [radio, setRadio] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [reloaded, setReloaded] = useState(false)
  const calendarState = useLiveQuery(() => analysis?.kind === 'routine' ? loadCalendarRulesState() : null, [analysis?.kind, settings.profileId, settings.datasetId])
  const open = tasks.filter(task => !task.deletedAt && task.status === 'open'), chosen = open.find(task => task.id === chosenId)
  const aiResolve = window.michiAI?.resolveTarget, aiReady = Boolean(settings.aiEnabled && settings.aiModel && aiResolve)
  function analyze() {
    setNotice(''); setChosenId(''); setRadio(''); setReloaded(false)
    let split: ReturnType<typeof parseCoachSplit> = null
    try { if (consultationKind(text, open.map(task => task.title)) === 'routine') { setAnalysis({ kind: 'routine', text, resolution: null, parts: [], message: '' }); return } split = parseCoachSplit(text) } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); setAnalysis(null); return }
    const resolution = resolveCoachTarget(text, tasks, { notificationTaskIds: notification?.taskIds })
    setAnalysis({ kind: split?.kind ?? 'task', text, resolution, parts: split?.kind === 'split' ? split.parts : [], message: split?.kind === 'clarify' ? split.message : '' })
    if (resolution.status === 'unique') setChosenId(resolution.task.id)
  }
  async function askAI(candidates: CoachTargetCandidate[]) {
    if (!aiResolve || !settings.aiModel) return
    setBusy(true); setNotice('')
    try { setRadio(parseCoachTargetAnswer(await aiResolve({ model: settings.aiModel, message: analysis!.text, candidates }), candidates)); setNotice('AIが候補から一つを示しました。正しければ「このタスクで続ける」を押してください。') }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const candidates = analysis?.resolution && analysis.resolution.status !== 'unique' ? analysis.resolution.candidates.length ? analysis.resolution.candidates : open.slice(0, 50).map(task => ({ id: task.id, title: task.title, scheduledDate: task.scheduledDate, dueDate: task.dueDate, revision: task.revision })) : []
  const revisionChanged = Boolean(chosen && notification && notification.revisions[chosen.id] !== undefined && notification.revisions[chosen.id] !== chosen.revision && !reloaded)
  return <section className="card setting-section coach-consult" aria-label="相談から対象を探す">
    <div className="setting-heading"><div><h2>{notification ? `通知に返信して調整：${notification.title}` : '相談から対象を探す'}</h2><p>相談文から対象のタスクを探します。対象が一つに決まるまで変更案は作りません。</p></div>{onClose && <button className="text-button" onClick={onClose}>閉じる</button>}</div>
    <label className="field">相談文<textarea aria-label="コーチへの相談（対象を探す）" rows={2} maxLength={4000} value={text} onChange={event => { setText(event.target.value); setAnalysis(null); setChosenId('') }} placeholder="例：「報告書」を明日に移して / 調査と実装に分けて / 毎月末に勤怠提出" /></label>
    <button className="secondary-button" disabled={!text.trim()} onClick={analyze}>相談から対象を探す</button>
    {notice && <p role="status">{notice}</p>}
    {analysis?.kind === 'routine' && <><p role="note">周期の設定として確認します。既存タスクは変更しません。ルールの保存と発生回の作成は、それぞれ本人の確認ボタンで行います。</p>{calendarState && <RoutineAssistView key={`coach-routine:${analysis.text}`} state={calendarState} settings={settings} initialMessage={analysis.text} heading="周期の設定として確認" />}</>}
    {analysis && analysis.kind !== 'routine' && analysis.resolution?.status !== 'unique' && !chosen && <div className="coach-target-chooser" role="group" aria-label="対象タスクの選択">
      <p role="alert">{analysis.resolution?.status === 'ambiguous' ? '対象が複数考えられます。どのタスクか選んでください。' : '相談文から対象を特定できませんでした。タスクを選んでください。'}</p>
      {candidates.map(item => <label key={item.id} className="setting-line"><span><input type="radio" name="coach-target" aria-label={`対象：${item.title}`} checked={radio === item.id} onChange={() => setRadio(item.id)} /> <strong>{item.title}</strong></span><small>予定 {item.scheduledDate ?? '未設定'} · 期限 {item.dueDate ?? 'なし'}</small></label>)}
      {aiReady && analysis.resolution?.status === 'ambiguous' && candidates.length >= 2 && candidates.length <= 10 && <button className="text-button" disabled={busy} onClick={() => askAI(candidates)}>{busy ? 'AIに確認中…' : 'AIで候補から選ぶ（候補の名前・予定日・期限だけ送信）'}</button>}
      <button className="secondary-button" disabled={!radio} onClick={() => setChosenId(radio)}>このタスクで続ける</button>
    </div>}
    {analysis?.kind === 'clarify' && chosen && <div role="note"><p>{analysis.message}</p><p className="muted">分ける場合は「調査と実装に分けて」のように作業名を書いてください。範囲を減らす場合はタスク編集で本人が内容とポイントを見直します。</p>{onEdit && <button className="text-button" onClick={() => onEdit(chosen)}>タスク編集を開く（範囲を見直す）</button>}</div>}
    {revisionChanged && chosen && <div role="alert"><p>通知の後に「{chosen.title}」が更新されました（版 {notification!.revisions[chosen.id]} → {chosen.revision}）。現在の値：予定 {chosen.scheduledDate ?? '未設定'} · 期限 {chosen.dueDate ?? 'なし'}。</p><button className="secondary-button" onClick={() => setReloaded(true)}>現在の値を確認して続ける</button></div>}
    {analysis?.kind === 'task' && chosen && !revisionChanged && <CoachTaskChangeView key={`${chosen.id}:${analysis.text}`} selectedTask={chosen} settings={settings} onEdit={onEdit} initialInstruction={analysis.text} onApplied={receipt => { setReloaded(true); setNotice(`変更を保存しました。確定したタスク：${receipt.taskIds.length}件。`) }} />}
    {analysis?.kind === 'split' && chosen && !revisionChanged && <CoachSplitView key={`${chosen.id}:${chosen.revision}:${analysis.text}`} task={chosen} parts={analysis.parts} instruction={analysis.text} settings={settings} />}
  </section>
}
