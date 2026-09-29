import { useState } from 'react'
import type { SmartList, Task, TaskDependency, ThemeRule } from './domain'
import { choosePair, drawRandomTask, setSpotlight, spotlightTasks, suggestedWithReason } from './focus-tools'

export function FocusChoiceTools({ tasks, dependencies, themes, focusProjects, lists, ownerId, date, now, onEdit, run }: { tasks: Task[]; dependencies: TaskDependency[]; themes: ThemeRule[]; focusProjects: string[]; lists: SmartList[]; ownerId: string; date: string; now: string; onEdit: (task: Task) => void; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [drawnId, setDrawnId] = useState('')
  const [selectedListId, setSelectedListId] = useState('')
  const selected = spotlightTasks(tasks)
  const pair = choosePair(tasks, date, dependencies, now)
  const ownLists = lists.filter(list => list.ownerId === ownerId)
  const recommendation = suggestedWithReason(tasks, date, dependencies, now, themes, focusProjects, ownLists.find(list => list.id === selectedListId), ownerId)
  const drawn = tasks.find(task => task.id === drawnId)
  async function draw() {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]
    await run(async () => { const result = await drawRandomTask(seed, date); if (!result.task) throw new Error('実行可能な候補がありません'); setDrawnId(result.task.id) }, '実行可能な候補から選びました')
  }
  return <section className="card suggestion-card"><div className="card-heading"><div><h2>次の作業を選ぶ</h2><p className="muted">Spotlightは既存タスク最大3件の参照です。候補は依存・延期・保留を考慮します。</p></div></div>
    <div className="focus-choice-grid"><div><h3>Spotlight {selected.length}/3</h3>{selected.length ? selected.map(task => <div className="focus-choice-row" key={task.id}><button className="text-button" onClick={() => onEdit(task)}>{task.title}</button><button className="text-button" onClick={() => run(() => setSpotlight(task.id, task.revision, false), 'Spotlightから外しました')}>外す</button></div>) : <p className="muted">タスク一覧または二択から追加してください。</p>}</div><div><h3>おすすめ</h3><select aria-label="推薦に使う保存条件" value={selectedListId} onChange={event => setSelectedListId(event.target.value)}><option value="">すべての実行可能タスク</option>{ownLists.map(list => <option key={list.id} value={list.id}>{list.name}</option>)}</select>{recommendation ? <div className="focus-choice-row"><button className="text-button" onClick={() => onEdit(recommendation.task)}>{recommendation.task.title}</button><small>{recommendation.reasons.join(' · ')}</small></div> : <p className="muted">条件に合う実行可能な候補はありません。</p>}</div><div><h3>二択</h3><p className="muted">{pair.message}</p>{pair.candidates.map(task => <div className="focus-choice-row" key={task.id}><button className="text-button" onClick={() => onEdit(task)}>{task.title}</button><button className="secondary-button" disabled={selected.length >= 3 && task.spotlightOrder == null} onClick={() => run(() => setSpotlight(task.id, task.revision, true), 'Spotlightへ追加しました')}>Spotlightへ</button></div>)}</div><div><h3>ランダム候補</h3><button className="secondary-button" onClick={draw}>実行可能なタスクから選ぶ</button>{drawn && <div className="focus-choice-row"><button className="text-button" onClick={() => onEdit(drawn)}>{drawn.title}</button><small>抽選seedと候補IDを監査履歴へ保存</small></div>}</div></div>
  </section>
}
