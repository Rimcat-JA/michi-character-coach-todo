import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import { today, type Goal, type GoalCheckIn } from './domain'
import { allGoalsPoints, createGoal, createGoalCheckIn, deleteGoalCheckIn, goalProgress, reviseGoalCheckIn, setGoalCheckInAiSummary, updateGoalProgress } from './goals'

export default function GoalsView({ run }: { run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [parentId, setParentId] = useState(''), [containerId, setContainerId] = useState(''), [taskId, setTaskId] = useState(''), [habitId, setHabitId] = useState(''), [dueDate, setDueDate] = useState(''), [cadence, setCadence] = useState<Goal['checkInCadence']>(null), [question, setQuestion] = useState('今週の進み具合はどうでしたか？')
  const [answers, setAnswers] = useState<Record<string, string>>({}), [summaries, setSummaries] = useState<Record<string, string>>({}), [percents, setPercents] = useState<Record<string, string>>({}), [editingId, setEditingId] = useState<string | null>(null), [generatingId, setGeneratingId] = useState<string | null>(null)
  const goals = useLiveQuery(() => db.goals.toArray(), []) ?? []
  const checkIns = useLiveQuery(() => db.goalCheckIns.toArray(), []) ?? []
  const tasks = useLiveQuery(() => db.tasks.toArray(), []) ?? []
  const containers = useLiveQuery(() => db.containers.toArray(), []) ?? []
  const habits = useLiveQuery(() => db.habits.toArray(), []) ?? []
  const completions = useLiveQuery(() => db.completions.toArray(), []) ?? []
  const sessions = useLiveQuery(() => db.sessions.toArray(), []) ?? []
  const settings = useLiveQuery(() => db.settings.get('main'), [])
  const own = goals.filter(goal => goal.ownerId === settings?.profileId && !goal.deletedAt)
  async function add() {
    if (await run(() => createGoal({ title, description, parentId: parentId || null, dueDate: dueDate || null, containerId: containerId || null, taskIds: taskId ? [taskId] : [], habitIds: habitId ? [habitId] : [], manualPercent: null, checkInCadence: cadence, checkInQuestion: question }), '目標を作成しました')) setTitle('')
  }
  async function generateCheckInSummary(goal: Goal, saved: GoalCheckIn) {
    if (!settings?.aiEnabled || !settings.aiModel || !window.michiAI || generatingId) return
    setGeneratingId(saved.id)
    try {
      await run(async () => {
        const summary = await window.michiAI!.summarize({ model: settings.aiModel!, kind: 'goal-checkin', text: `質問: ${goal.checkInQuestion}\n本人回答: ${saved.answer}` })
        await setGoalCheckInAiSummary(saved.id, saved.summaryRevision, saved.answer, summary)
      }, 'AI要約を保存しました')
    } finally { setGeneratingId(null) }
  }
  return <><div className="page-heading"><div><span className="eyebrow">GOALS</span><h1>目標とチェックイン</h1><p>タスクや習慣を関連付け、振り返りを自分で編集できます。</p></div></div>
    <section className="card list-card"><div className="card-heading"><h2>目標を作成</h2></div><div className="form-grid">
      <label className="field">目標名<input value={title} maxLength={200} onChange={event => setTitle(event.target.value)} /></label>
      <label className="field">期限<input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} /></label>
      <label className="field full-field">説明<textarea value={description} maxLength={10000} onChange={event => setDescription(event.target.value)} /></label>
      <label className="field">上位目標<select value={parentId} onChange={event => setParentId(event.target.value)}><option value="">なし</option>{own.map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></label>
      <label className="field">関連プロジェクト<select value={containerId} onChange={event => setContainerId(event.target.value)}><option value="">なし</option>{containers.filter(item => !item.deletedAt && item.ownerId === settings?.profileId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="field">関連タスク<select value={taskId} onChange={event => setTaskId(event.target.value)}><option value="">なし</option>{tasks.filter(task => !task.deletedAt).map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
      <label className="field">関連習慣<select value={habitId} onChange={event => setHabitId(event.target.value)}><option value="">なし</option>{habits.filter(habit => habit.ownerId === settings?.profileId).map(habit => <option key={habit.id} value={habit.id}>{habit.title}</option>)}</select></label>
      <label className="field">チェックイン周期<select value={cadence ?? ''} onChange={event => setCadence(event.target.value ? event.target.value as Goal['checkInCadence'] : null)}><option value="">なし</option><option value="weekly">毎週</option><option value="monthly">毎月</option></select></label>
      <label className="field">質問<input value={question} maxLength={500} onChange={event => setQuestion(event.target.value)} /></label>
    </div><button className="primary-button" disabled={!title.trim()} onClick={add}>目標を作成</button></section>
    <section className="card list-card"><div className="card-heading"><h2>目標の進捗</h2><span className="subtle">全目標で重複を除いた実績：{allGoalsPoints(own, tasks, containers, habits, completions)}pt</span></div>
      {own.map(goal => {
        const progress = goalProgress(goal, own, tasks, containers, habits, completions, sessions)
        const current = checkIns.filter(item => item.goalId === goal.id && !item.deletedAt).sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt))
        return <div className="goal-row" key={goal.id}><h3>{goal.title}</h3><p>{goal.description}</p><p>関連タスク {progress.completedTasks}/{progress.linkedTasks}件 · {progress.points}pt · 作業 {progress.minutes}分{progress.manualPercent !== null ? ` · 手動進捗${progress.manualPercent}%` : ''}</p>
          <div className="goal-controls"><input aria-label={`${goal.title}の手動進捗率`} type="number" min={0} max={100} value={percents[goal.id] ?? (goal.manualPercent ?? '')} onChange={event => setPercents(values => ({ ...values, [goal.id]: event.target.value }))} placeholder="進捗%" /><button className="text-button" onClick={() => run(() => updateGoalProgress(goal.id, goal.revision, percents[goal.id] === '' ? null : Number(percents[goal.id] ?? goal.manualPercent)), '進捗率を保存しました')}>進捗を保存</button></div>
          {goal.checkInCadence && <><p>チェックイン：{goal.checkInCadence === 'weekly' ? '毎週' : '毎月'} · {goal.checkInQuestion}</p><textarea aria-label={`${goal.title}の回答`} value={answers[goal.id] ?? ''} onChange={event => setAnswers(values => ({ ...values, [goal.id]: event.target.value }))} placeholder="自分の回答" /><button className="secondary-button" disabled={!answers[goal.id]?.trim()} onClick={async () => { if (await run(() => createGoalCheckIn(goal.id, today(), answers[goal.id]), 'チェックインを保存しました')) setAnswers(values => ({ ...values, [goal.id]: '' })) }}>回答を記録</button></>}
          {current.map(saved => {
            return <div className="checkin-row" key={saved.id}><strong>{saved.date} の回答</strong><p>{saved.answer}</p><p>要約：{saved.summary ?? 'なし'}{saved.summaryOrigin ? `（${saved.summaryOrigin === 'ai' ? 'AI' : '本人'}）` : ''}</p><small>要約版 {saved.summaryRevision} · 過去版 {saved.history.length}件</small>{settings?.aiEnabled && settings.aiModel && window.michiAI && <button className="secondary-button" disabled={!!generatingId} onClick={() => generateCheckInSummary(goal, saved)}>{generatingId === saved.id ? 'OpenRouterで要約中…' : 'OpenRouterで要約'}</button>}{editingId === saved.id ? <><textarea aria-label="回答を訂正" value={answers[saved.id] ?? saved.answer} onChange={event => setAnswers(values => ({ ...values, [saved.id]: event.target.value }))} /><textarea aria-label="要約を訂正" value={summaries[saved.id] ?? saved.summary ?? ''} onChange={event => setSummaries(values => ({ ...values, [saved.id]: event.target.value }))} /><button className="secondary-button" onClick={async () => { if (await run(() => reviseGoalCheckIn(saved.id, saved.summaryRevision, answers[saved.id] ?? saved.answer, summaries[saved.id] ?? saved.summary), 'チェックインを訂正しました')) setEditingId(null) }}>訂正を保存</button><button className="text-button" onClick={() => setEditingId(null)}>取消</button></> : <><button className="text-button" onClick={() => setEditingId(saved.id)}>回答・要約を訂正</button><button className="text-button" onClick={() => run(() => deleteGoalCheckIn(saved.id, saved.summaryRevision), 'チェックインを削除しました')}>削除</button></>}</div>
          })}
        </div>
      })}{!own.length && <p className="muted">目標はまだありません。</p>}
    </section>
  </>
}
