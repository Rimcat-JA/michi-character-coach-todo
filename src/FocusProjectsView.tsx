import type { FocusProjectSelection, Task } from './domain'
import { recommendFocusProjects, setFocusProjects } from './focus-projects'

export function FocusProjectsView({ tasks, selection, date, run }: { tasks: Task[]; selection?: FocusProjectSelection; date: string; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const names = [...new Set(tasks.filter(task => !task.deletedAt && task.status === 'open').map(task => task.project).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'))
  const chosen = selection?.projects ?? []
  async function toggle(project: string) {
    const next = chosen.includes(project) ? chosen.filter(name => name !== project) : [...chosen, project]
    await run(() => setFocusProjects(date, next, 'user'), '今日の重点案件を保存しました')
  }
  return <section className="card suggestion-card">
    <div className="card-heading"><div><h2>今日の重点プロジェクト</h2><p className="muted">選んだ案件の作業を候補の上位へ。今日が期限の作業は先に残します。</p></div><span className="subtle">{selection?.source === 'user' ? '本人が選択' : selection?.source === 'coach' ? 'コーチ候補' : '未選択'}</span></div>
    {names.length ? <div className="focus-project-choices">{names.map(name => <label key={name}><input type="checkbox" checked={chosen.includes(name)} disabled={!chosen.includes(name) && chosen.length >= 5} onChange={() => toggle(name)} />{name}</label>)}</div> : <p className="muted">プロジェクト名を持つタスクを登録すると選べます。</p>}
    {names.length > 0 && <button className="secondary-button" onClick={() => run(() => setFocusProjects(date, recommendFocusProjects(tasks, date), 'coach'), selection?.source === 'user' ? '本人の選択を維持しました' : '候補を保存しました')}>コーチ候補を提案</button>}
  </section>
}
