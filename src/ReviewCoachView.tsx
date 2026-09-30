import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import { today, type Settings, type Task } from './domain'
import { currentReviewSummary, refreshReviewActual, reviewAIContext, reviewObservation, reviewRange, saveReviewAnswer, setReviewSummary, type ReviewKind } from './review-coach'

const labels: Record<ReviewKind, string> = { morning: '朝の計画', evening: '夕方の振り返り', weekly: '週の振り返り' }
const questions: Record<ReviewKind, string> = {
  morning: '今日は何を大切にしますか。余裕や休息についても自由に残せます。',
  evening: 'どんな一日でしたか。残った作業は予定を見直して構いません。',
  weekly: 'この週に気づいたことと、次に調整したいことを残せます。'
}
type Run = (fn: () => Promise<unknown>, success?: string) => Promise<boolean>

export default function ReviewCoachView({ settings, tasks, onEdit, run }: { settings: Settings; tasks: Task[]; onEdit: (task: Task) => void; run?: Run }) {
  const [date, setDate] = useState(() => today()), [kind, setKind] = useState<ReviewKind>('evening')
  const [answerDraft, setAnswerDraft] = useState<string | null>(null), [summaryDraft, setSummaryDraft] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false), [notice, setNotice] = useState('')
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const id = `${settings.profileId}:${date}:${timezone}:${kind}`
  const record = useLiveQuery(() => db.reviewRecords.get(id), [id])
  const selectedId = useRef(id), localSummaryDraft = useRef(summaryDraft), localAnswerDraft = useRef(answerDraft)
  useEffect(() => { selectedId.current = id }, [id])
  useEffect(() => { localSummaryDraft.current = summaryDraft }, [summaryDraft])
  useEffect(() => { localAnswerDraft.current = answerDraft }, [answerDraft])
  const summary = record ? currentReviewSummary(record) : null
  const answer = answerDraft ?? record?.answer ?? ''
  const answerChanged = Boolean(record && answer !== record.answer)
  const aiAvailable = Boolean(settings.aiEnabled && settings.aiModel && window.michiAI)
  let range: { rangeStart: string; rangeEnd: string } | null = null
  try { range = reviewRange(date, kind) } catch { /* Invalid date remains editable. */ }
  const planIds = new Set(record?.plan.entries.map(entry => entry.taskId) ?? [])
  const currentTasks = tasks.filter(task => !task.deletedAt && task.status === 'open' && (
    planIds.has(task.id) || range && (
      task.scheduledDate !== null && task.scheduledDate >= range.rangeStart && task.scheduledDate <= range.rangeEnd ||
      task.dueDate !== null && task.dueDate <= range.rangeEnd
    )
  ))
  function changeSelection(change: () => void) { selectedId.current = ''; localAnswerDraft.current = null; localSummaryDraft.current = null; change(); setAnswerDraft(null); setSummaryDraft(null); setNotice('') }
  async function execute(operation: () => Promise<unknown>, success: string): Promise<boolean> {
    try {
      const ok = run ? await run(operation, success) : (await operation(), true)
      if (ok) setNotice(success)
      else setNotice('処理できませんでした。本人回答と下書きは残っています。')
      return ok
    } catch (error) { setNotice(`${error instanceof Error ? error.message : String(error)} 本人回答と下書きは残っています。`); return false }
  }
  async function saveAnswer() {
    const selected = id, savedAnswer = answer, savedDraft = answerDraft
    if (await execute(() => saveReviewAnswer({ date, timezone, kind, answer: savedAnswer, expectedAnswerRevision: record?.answerRevision ?? 0 }), '本人回答とレビューを保存しました')) {
      if (selectedId.current === selected && localAnswerDraft.current === savedDraft) setAnswerDraft(null)
    }
  }
  async function generateSummary() {
    if (!record || !aiAvailable || generating || answerChanged) return
    const saved = record, savedDraft = summaryDraft
    setGenerating(true)
    try {
      const ok = await execute(async () => {
        const result = await window.michiAI!.summarize({ model: settings.aiModel!, kind: 'review', text: reviewAIContext(saved) })
        await setReviewSummary(saved.id, saved.summaryRevision, result, 'ai', saved.answerRevision, saved.actualRevision)
      }, 'レビューのAI要約を別に保存しました')
      if (ok && selectedId.current === saved.id && localSummaryDraft.current === savedDraft) setSummaryDraft(null)
    } finally { setGenerating(false) }
  }
  return <section className="card list-card review-coach">
    <div className="card-heading"><div><span className="eyebrow">REVIEW</span><h2>朝夕・週次レビュー</h2><small>本人回答、最初の計画、実績、要約を別々に保存します。</small></div></div>
    <div className="form-grid">
      <label className="field">対象日<input aria-label="レビュー対象日" type="date" value={date} onChange={event => changeSelection(() => setDate(event.target.value))} /></label>
      <label className="field">レビューの種類<select aria-label="レビューの種類" value={kind} onChange={event => changeSelection(() => setKind(event.target.value as ReviewKind))}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    {range && <p className="muted">{range.rangeStart}〜{range.rangeEnd} · {timezone}</p>}
    <label className="field">本人回答<textarea aria-label="レビューの本人回答" value={answer} maxLength={10000} rows={4} placeholder={questions[kind]} onChange={event => { localAnswerDraft.current = event.target.value; setAnswerDraft(event.target.value) }} /></label>
    <button className="primary-button" disabled={!range} onClick={saveAnswer}>本人回答を保存</button>
    {record && !record.deletedAt && <>
      <p className="muted">本人回答版 {record.answerRevision} · 変更履歴 {record.history.length}件。空欄や「0」もそのまま保存できます。</p>
      <h3>保存した実績</h3>
      <p>{reviewObservation(record.actual)}</p>
      <p className="muted">完了 {record.actual.completed.length}件 · 確定ポイント {record.actual.points}pt · 点数未確定 {record.actual.unscoredCount}件 · 作業 {record.actual.minutes}分。実績版 {record.actualRevision}、取得 {new Date(record.actual.capturedAt).toLocaleString('ja-JP')}。</p>
      <button className="secondary-button" onClick={() => execute(() => refreshReviewActual(record.id, record.actualRevision), '実績の新しい版を保存しました')}>現在の完了・時間記録を取り込む</button>
      <details><summary>最初に保存した計画（{record.plan.entries.length}件）</summary><p className="muted">取得 {new Date(record.plan.capturedAt).toLocaleString('ja-JP')}。再計画後もこの内容を保存します。</p>{record.plan.entries.map(entry => {
        const current = tasks.find(task => task.id === entry.taskId && !task.deletedAt)
        return <div className="setting-line" key={entry.taskId}><div><strong>{entry.title}</strong><small>保存時：予定 {entry.scheduledDate ?? '未設定'}、期限 {entry.dueDate ?? '未設定'}、{entry.points === null ? '点数未設定' : `${entry.points}pt`}</small><small>現在：{current ? `${current.title} · 予定 ${current.scheduledDate ?? '未設定'} · ${current.status === 'completed' ? '完了' : '未完了'}` : '対象タスクは削除されています'}</small></div></div>
      })}{record.plan.entries.length === 0 && <p className="muted">この期間に予定されたタスクは保存時にありませんでした。</p>}</details>
      <h3>残った作業の再計画</h3>
      <p className="muted">タスクを開いて予定日・分割・負荷を編集できます。保存済みの計画は履歴として残ります。</p>
      {currentTasks.map(task => <div className="setting-line" key={task.id}><div><strong>{task.title}</strong><small>現在の予定 {task.scheduledDate ?? '未設定'} · 期限 {task.dueDate ?? '未設定'}{planIds.has(task.id) ? '' : ' · 後から追加された作業'}</small></div><button className="secondary-button" onClick={() => onEdit(task)}>再計画を編集</button></div>)}
      {currentTasks.length === 0 && <p className="muted">このレビューの対象に残っている未完了タスクはありません。</p>}
      <h3>別保存の要約</h3>
      <label className="field">要約を編集<textarea aria-label="レビューの要約" rows={3} maxLength={10000} value={summaryDraft ?? record.aiSummary ?? ''} onChange={event => { localSummaryDraft.current = event.target.value; setSummaryDraft(event.target.value) }} /></label>
      <div className="export-buttons"><button className="secondary-button" disabled={answerChanged} onClick={async () => { if (await execute(() => setReviewSummary(record.id, record.summaryRevision, summaryDraft ?? record.aiSummary, 'human', record.answerRevision, record.actualRevision), '本人が編集した要約を保存しました')) setSummaryDraft(null) }}>要約を保存</button><button className="text-button" onClick={async () => { if (await execute(() => setReviewSummary(record.id, record.summaryRevision, null, 'human', record.answerRevision, record.actualRevision), '要約を削除しました')) setSummaryDraft(null) }}>要約を削除</button>{aiAvailable && <button className="secondary-button" disabled={generating || answerChanged} onClick={generateSummary}>{generating ? 'AI要約を待っています…' : 'OpenRouterでレビューを要約'}</button>}</div>
      {answerChanged && <p className="muted">要約を作成・保存する前に、変更した本人回答を保存してください。</p>}
      <p className="muted">要約版 {record.summaryRevision} · {summary?.stale ? '本人回答または実績の更新前の要約です' : record.aiSummary ? `${record.summaryOrigin === 'ai' ? 'AI' : '本人'}の要約` : '要約なし'}。AI要約ボタンは、このレビューの本人回答・計画・実績だけをOpenRouterへ送ります。</p>
      <details><summary>レビューの変更履歴</summary>{record.history.map((event, index) => <div key={`${event.kind}-${event.revision}-${index}`} className="setting-line"><div><strong>{event.kind === 'answer' ? '本人回答' : event.kind === 'actual' ? '実績' : '要約'} 版{event.revision}</strong><small>{new Date(event.at).toLocaleString('ja-JP')}</small><p>{event.kind === 'answer' ? event.answer || '空欄' : event.kind === 'actual' ? `${event.actual.completed.length}件・${event.actual.minutes}分・${event.actual.points}pt` : event.summary ?? '要約なし'}</p></div></div>)}{record.history.length === 0 && <p className="muted">変更履歴はまだありません。</p>}</details>
    </>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
