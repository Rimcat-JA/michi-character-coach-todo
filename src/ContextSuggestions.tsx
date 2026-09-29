import { useState } from 'react'
import type { Task, TaskDependency, ThemeRule } from './domain'
import { contextSuggestions } from './planning'

export function ContextSuggestions({ tasks, dependencies, themes, date, now, onEdit }: { tasks: Task[]; dependencies: TaskDependency[]; themes: ThemeRule[]; date: string; now: string; onEdit: (task: Task) => void }) {
  const [energy, setEnergy] = useState<number | null>(null)
  const [focus, setFocus] = useState<number | null>(null)
  const { matches, unknown } = contextSuggestions(tasks, date, energy, focus, dependencies, now, themes)
  return <section className="card suggestion-card">
    <div className="card-heading"><div><h2>いまの状態に合う候補</h2><p className="muted">必要気力・集中度が未設定のタスクは別に表示します。0は「不要」で、未設定とは異なります。</p></div></div>
    <div className="context-controls"><label className="field">使える気力<select value={energy ?? ''} onChange={event => setEnergy(event.target.value === '' ? null : Number(event.target.value))}><option value="">指定しない</option>{[0, 1, 2, 3, 4].map(value => <option key={value} value={value}>{value}</option>)}</select></label><label className="field">使える集中力<select value={focus ?? ''} onChange={event => setFocus(event.target.value === '' ? null : Number(event.target.value))}><option value="">指定しない</option>{[0, 1, 2, 3, 4].map(value => <option key={value} value={value}>{value}</option>)}</select></label></div>
    <div className="suggestion-list">{matches.slice(0, 5).map(task => <button className="suggestion" key={task.id} onClick={() => onEdit(task)}><span className="suggestion-dot"/><span>{task.title}</span><small>気力 {task.energyNeed ?? '未設定'} · 集中 {task.focusNeed ?? '未設定'}</small></button>)}{!matches.length && <p className="muted">条件に合う設定済みタスクはありません。</p>}</div>
    {(energy !== null || focus !== null) && unknown.length > 0 && <details><summary>必要度が未設定の候補 {unknown.length}件</summary><div className="suggestion-list">{unknown.slice(0, 5).map(task => <button className="suggestion" key={task.id} onClick={() => onEdit(task)}><span className="suggestion-dot"/><span>{task.title}</span><small>気力 {task.energyNeed ?? '未設定'} · 集中 {task.focusNeed ?? '未設定'}</small></button>)}</div></details>}
  </section>
}
