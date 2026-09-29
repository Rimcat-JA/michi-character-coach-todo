import { useState } from 'react'
import { scoreText, type Settings, type Task, type WallTile } from './domain'
import { addWallTile, moveWallTile, removeWallTile, setWallTileGroup } from './wall'

type Run = (fn: () => Promise<unknown>, success?: string) => Promise<boolean>

function TileCard({ tile, task, onEdit, run }: { tile: WallTile; task: Task | undefined; onEdit: (task: Task) => void; run: Run }) {
  const [draft, setDraft] = useState<{ base: string; value: string } | null>(null)
  const group = draft?.base === tile.group ? draft.value : tile.group
  return <article className="wall-tile" style={{ gridColumn: tile.x + 1, gridRow: tile.y + 1 }}>
    <span className="wall-tile-position">{tile.x + 1}列 · {tile.y + 1}行</span>
    <button className="wall-tile-title" disabled={!task || !!task.deletedAt} onClick={() => task && onEdit(task)}>{task?.title ?? '削除済みタスク'}</button>
    <small>{task ? `${scoreText(task)} · ${task.status === 'completed' ? '完了済み' : '未完了'}` : '参照先なし'}</small>
    <div className="wall-moves"><button aria-label="左へ" disabled={tile.x === 0} onClick={() => run(() => moveWallTile(tile.taskId, -1, 0))}>←</button><button aria-label="右へ" disabled={tile.x === 4} onClick={() => run(() => moveWallTile(tile.taskId, 1, 0))}>→</button><button aria-label="上へ" disabled={tile.y === 0} onClick={() => run(() => moveWallTile(tile.taskId, 0, -1))}>↑</button><button aria-label="下へ" disabled={tile.y === 9} onClick={() => run(() => moveWallTile(tile.taskId, 0, 1))}>↓</button></div>
    <label className="field">グループ<input value={group} maxLength={100} onChange={event => setDraft({ base: tile.group, value: event.target.value })} /></label>
    <div className="wall-tile-actions"><button className="text-button" disabled={group === tile.group} onClick={() => run(() => setWallTileGroup(tile.taskId, group))}>保存</button><button className="text-button" onClick={() => run(() => removeWallTile(tile.taskId))}>外す</button></div>
  </article>
}

export default function WallView({ tasks, settings, onEdit, run }: { tasks: Task[]; settings: Settings; onEdit: (task: Task) => void; run: Run }) {
  const [taskId, setTaskId] = useState(''), [group, setGroup] = useState('')
  const tiles = settings.wallTiles ?? []
  const available = tasks.filter(task => !task.deletedAt && !tiles.some(tile => tile.taskId === task.id))
  return <><div className="page-heading"><div><span className="eyebrow">THE WALL</span><h1>タスクの付箋</h1><p>既存タスクを配置します。位置とグループを変えても、タスクの状態やポイントは変わりません。</p></div></div>
    <section className="card list-card"><div className="form-grid"><label className="field">追加するタスク<select value={taskId} onChange={event => setTaskId(event.target.value)}><option value="">選択してください</option>{available.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><label className="field">グループ<input value={group} maxLength={100} onChange={event => setGroup(event.target.value)} placeholder="任意" /></label></div><button className="primary-button" disabled={!taskId} onClick={async () => { if (await run(() => addWallTile(taskId, group), '付箋を追加しました')) { setTaskId(''); setGroup('') } }}>付箋を追加</button></section>
    <div className="wall-scroll"><div className="wall-grid">{tiles.map(tile => <TileCard key={tile.taskId} tile={tile} task={tasks.find(task => task.id === tile.taskId)} onEdit={onEdit} run={run} />)}</div></div>
    {!tiles.length && <p className="muted">付箋はまだありません。タスクを選んで追加してください。</p>}
  </>
}
