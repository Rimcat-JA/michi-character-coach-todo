import { useState } from 'react'
import type { Task } from './domain'
import type { NavigationId } from './navigation'

type Item = { id: string; label: string; kind: 'view' | 'task' }
export default function QuickJump({ navigation, tasks, onView, onTask, onClose }: { navigation: { view: NavigationId; label: string }[]; tasks: Task[]; onView: (view: NavigationId) => void; onTask: (task: Task) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const all: Item[] = [...navigation.map(item => ({ id: item.view, label: item.label, kind: 'view' as const })), ...tasks.filter(task => !task.deletedAt).map(task => ({ id: task.id, label: task.title, kind: 'task' as const }))]
  const items = all.filter(item => `${item.label} ${item.id}`.toLocaleLowerCase('ja-JP').includes(query.trim().toLocaleLowerCase('ja-JP'))).slice(0, 12)
  function choose(item: Item) {
    if (item.kind === 'view') onView(item.id as NavigationId)
    else { const task = tasks.find(candidate => candidate.id === item.id); if (task) onTask(task) }
    onClose()
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><div className="card quick-jump" role="dialog" aria-modal="true" aria-label="クイックジャンプ"><label className="field">画面またはタスクを探す<input autoFocus value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') onClose(); if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && items[0]) { event.preventDefault(); choose(items[0]) } }} /></label><div className="quick-jump-results">{items.length ? items.map(item => <button key={`${item.kind}:${item.id}`} onClick={() => choose(item)}><span>{item.label}</span><small>{item.kind === 'view' ? '画面' : 'タスク'}</small></button>) : <p className="muted">一致する項目がありません。</p>}</div><button className="text-button" onClick={onClose}>閉じる</button></div></div>
}
