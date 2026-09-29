import { useState } from 'react'
import type { Task, ThemeRule } from './domain'
import { createThemeRule, removeThemeRule } from './themes'

const weekdayNames = ['日', '月', '火', '水', '木', '金', '土']

export function ThemeRulesView({ tasks, rules, ownerId, run }: { tasks: Task[]; rules: ThemeRule[]; ownerId: string; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [category, setCategory] = useState('')
  const [weekdays, setWeekdays] = useState<number[]>([])
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [strength, setStrength] = useState(2)
  const categories = [...new Set(tasks.map(task => task.project).filter(Boolean))].sort()
  const own = rules.filter(rule => rule.ownerId === ownerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  async function add() {
    if (await run(() => createThemeRule({ category, weekdays, startDate: startDate || null, endDate: endDate || null, strength }), '重点テーマを保存しました')) {
      setCategory(''); setWeekdays([]); setStartDate(''); setEndDate('')
    }
  }
  return <section className="card list-card">
    <div className="card-heading"><div><h2>曜日・期間の重点テーマ</h2><p className="muted">一致するカテゴリを候補の上位へ。今日が期限のタスクは優先して残します。</p></div></div>
    <div className="form-grid">
      <label className="field">カテゴリ・プロジェクト名<input list="theme-categories" value={category} onChange={event => setCategory(event.target.value)} maxLength={100} placeholder="例：執筆" /></label>
      <datalist id="theme-categories">{categories.map(name => <option key={name} value={name} />)}</datalist>
      <label className="field">強度<select value={strength} onChange={event => setStrength(Number(event.target.value))}>{[1, 2, 3].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label className="field">開始日<input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></label>
      <label className="field">終了日<input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></label>
    </div>
    <div className="theme-weekdays">曜日（未選択なら毎日）：{weekdayNames.map((name, day) => <label key={day}><input type="checkbox" checked={weekdays.includes(day)} onChange={event => setWeekdays(current => event.target.checked ? [...current, day].sort() : current.filter(value => value !== day))} />{name}</label>)}</div>
    <button className="secondary-button" disabled={!category.trim()} onClick={add}>重点テーマを追加</button>
    {own.map(rule => <div className="container-row" key={rule.id}><strong>{rule.category}</strong><span>強度 {rule.strength} · {rule.weekdays.length ? rule.weekdays.map(day => weekdayNames[day]).join('・') : '毎日'} · {rule.startDate ?? '開始指定なし'}〜{rule.endDate ?? '終了指定なし'}</span><button className="text-button" onClick={() => run(() => removeThemeRule(rule.id), '重点テーマを削除しました')}>削除</button></div>)}
  </section>
}
