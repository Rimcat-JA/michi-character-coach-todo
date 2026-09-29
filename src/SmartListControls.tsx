import { useState } from 'react'
import type { SmartList, SmartListAst, SmartListField } from './domain'
import { createSmartList, removeSmartList, updateSmartList } from './smart-lists'

type Condition = { field: SmartListField; operator: 'eq' | 'neq' | 'lte' | 'gte' | 'contains' | 'is_unknown'; value: string }
const fieldNames: { key: SmartListField; label: string }[] = [{ key: 'minutes', label: '見積分数' }, { key: 'labels', label: 'ラベル' }, { key: 'effectivePoints', label: '必要ポイント' }, { key: 'importance', label: '重要度' }, { key: 'status', label: '状態' }, { key: 'title', label: 'タイトル' }, { key: 'project', label: 'カテゴリ・プロジェクト' }, { key: 'energyNeed', label: '必要気力' }, { key: 'focusNeed', label: '必要集中度' }, { key: 'scheduledDate', label: '予定日' }, { key: 'dueDate', label: '期限' }]
const numeric = new Set<SmartListField>(['minutes', 'effectivePoints', 'importance', 'energyNeed', 'focusNeed'])
const dates = new Set<SmartListField>(['scheduledDate', 'dueDate'])
const operators = (field: SmartListField) => field === 'status' ? ['eq', 'neq'] : numeric.has(field) || dates.has(field) ? ['eq', 'neq', 'lte', 'gte', 'is_unknown'] : ['eq', 'neq', 'contains', 'is_unknown']
const operatorName: Record<Condition['operator'], string> = { eq: '等しい', neq: '等しくない', lte: '以下・以前', gte: '以上・以後', contains: '含む', is_unknown: '未設定' }
const initial: Condition = { field: 'minutes', operator: 'lte', value: '15' }

function flatConditions(ast: SmartListAst): { join: 'all' | 'any'; rows: Condition[] } | null {
  if (ast.type !== 'all' && ast.type !== 'any') return null
  if (ast.children.some(child => child.type !== 'condition')) return null
  return { join: ast.type, rows: ast.children.map(child => child.type === 'condition' ? { field: child.field, operator: child.operator, value: String(child.value ?? '') } : initial) }
}

export function SmartListControls({ lists, ownerId, selectedId, onSelect, run }: { lists: SmartList[]; ownerId: string; selectedId: string; onSelect: (id: string) => void; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [editingId, setEditingId] = useState('')
  const [name, setName] = useState('')
  const [join, setJoin] = useState<'all' | 'any'>('all')
  const [rows, setRows] = useState<Condition[]>([initial])
  const [error, setError] = useState('')
  const own = lists.filter(list => list.ownerId === ownerId).sort((a, b) => a.name.localeCompare(b.name, 'ja'))
  const selected = own.find(list => list.id === selectedId)
  function setRow(index: number, patch: Partial<Condition>) { setRows(current => current.map((row, i) => i === index ? { ...row, ...patch } : row)) }
  async function save() {
    setError('')
    try {
      if (rows.some(row => row.operator !== 'is_unknown' && !row.value.trim())) throw new Error('条件の値を入力してください')
      const ast: SmartListAst = { type: join, children: rows.map(row => ({ type: 'condition', field: row.field, operator: row.operator, ...(row.operator === 'is_unknown' ? {} : { value: numeric.has(row.field) ? Number(row.value) : row.value }) })) }
      const id = editingId || await createSmartList(name, ast)
      if (editingId) await updateSmartList(editingId, own.find(list => list.id === editingId)!.revision, name, ast)
      onSelect(id)
      setEditingId(''); setName(''); setRows([initial]); setJoin('all')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  function editSelected() {
    if (!selected) return
    const flat = flatConditions(selected.ast)
    if (!flat) { setError('この条件は画面から編集できません。保存済み一覧の削除と再作成を使ってください。'); return }
    setEditingId(selected.id); setName(selected.name); setJoin(flat.join); setRows(flat.rows); setError('')
  }
  return <section className="card smart-list-panel">
    <div className="card-heading"><div><h2>Smart List</h2><p className="muted">条件に合うタスクだけを表示。入力を変えると一覧も更新されます。</p></div></div>
    <div className="smart-list-toolbar"><select aria-label="保存済みSmart List" value={selectedId} onChange={event => onSelect(event.target.value)}><option value="">すべて表示</option>{own.map(list => <option key={list.id} value={list.id}>{list.name}</option>)}</select>{selected && <><button className="text-button" onClick={editSelected}>条件を編集</button><button className="text-button" onClick={async () => { if (await run(() => removeSmartList(selected.id), 'Smart Listを削除しました')) onSelect('') }}>削除</button></>}</div>
    <details open={editingId ? true : undefined}><summary>{editingId ? '条件を編集' : '新しい条件を保存'}</summary><div className="smart-list-builder"><label className="field">名前<input value={name} maxLength={100} onChange={event => setName(event.target.value)} placeholder="例：15分以内の生活タスク" /></label><label className="field">条件の組み合わせ<select value={join} onChange={event => setJoin(event.target.value as 'all' | 'any')}><option value="all">すべて満たす</option><option value="any">いずれかを満たす</option></select></label>{rows.map((row, index) => <div key={index} className="smart-list-condition"><select aria-label={`条件${index + 1}の項目`} value={row.field} onChange={event => { const field = event.target.value as SmartListField; setRow(index, { field, operator: field === 'status' ? 'eq' : numeric.has(field) || dates.has(field) ? 'lte' : 'contains', value: '' }) }}>{fieldNames.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}</select><select aria-label={`条件${index + 1}の比較`} value={row.operator} onChange={event => setRow(index, { operator: event.target.value as Condition['operator'] })}>{operators(row.field).map(operator => <option key={operator} value={operator}>{operatorName[operator as Condition['operator']]}</option>)}</select>{row.operator !== 'is_unknown' && (row.field === 'status' ? <select aria-label={`条件${index + 1}の値`} value={row.value} onChange={event => setRow(index, { value: event.target.value })}><option value="">選択</option><option value="open">未完了</option><option value="completed">完了</option></select> : <input aria-label={`条件${index + 1}の値`} type={numeric.has(row.field) ? 'number' : dates.has(row.field) ? 'date' : 'text'} value={row.value} onChange={event => setRow(index, { value: event.target.value })} />)}<button className="text-button" disabled={rows.length === 1} onClick={() => setRows(current => current.filter((_, i) => i !== index))}>削除</button></div>)}<div className="smart-list-actions"><button className="secondary-button" disabled={rows.length >= 50} onClick={() => setRows(current => [...current, { ...initial }])}>条件を追加</button><button className="primary-button" disabled={!name.trim()} onClick={save}>{editingId ? '更新' : '保存'}</button>{editingId && <button className="text-button" onClick={() => { setEditingId(''); setName(''); setRows([initial]) }}>取消</button>}</div>{error && <p role="alert" className="bulk-edit-notice">{error}</p>}</div></details>
  </section>
}
