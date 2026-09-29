import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import { today } from './domain'
import { createTracker, currentDayNoteContext, recordTrackerEntry, saveDayNote, setDayNoteSummary } from './journal'

export default function JournalView({ run }: { run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [date, setDate] = useState(() => today()), [draft, setDraft] = useState<string | null>(null), [summaryDraft, setSummaryDraft] = useState<string | null>(null)
  const [trackerName, setTrackerName] = useState(''), [unit, setUnit] = useState('段階'), [min, setMin] = useState('0'), [max, setMax] = useState('5'), [values, setValues] = useState<Record<string, string>>({})
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const notes = useLiveQuery(() => db.dayNotes.toArray(), []) ?? []
  const definitions = useLiveQuery(() => db.trackerDefinitions.toArray(), []) ?? []
  const entries = useLiveQuery(() => db.trackerEntries.toArray(), []) ?? []
  const settings = useLiveQuery(() => db.settings.get('main'), [])
  const note = notes.find(item => item.ownerId === settings?.profileId && item.date === date && item.timezone === zone && !item.deletedAt)
  const context = note ? currentDayNoteContext(note) : null
  const own = definitions.filter(item => item.ownerId === settings?.profileId)
  return <><div className="page-heading"><div><span className="eyebrow">JOURNAL</span><h1>ノートと任意記録</h1><p>本人の本文と要約を別々に保存します。気分・気力の値は入力しなくても記録できます。</p></div></div>
    <section className="card list-card"><div className="card-heading"><h2>Day Notes</h2><span className="subtle">timezone：{zone}</span></div><label className="field">日付<input type="date" value={date} onChange={event => { setDate(event.target.value); setDraft(null); setSummaryDraft(null) }} /></label><label className="field">本人のメモ<textarea rows={6} value={draft ?? note?.humanText ?? ''} onChange={event => setDraft(event.target.value)} placeholder="今日のことを自分の言葉で" /></label><button className="primary-button" onClick={async () => { if (await run(() => saveDayNote(date, zone, draft ?? note?.humanText ?? ''), '日記を保存しました')) setDraft(null) }}>本人のメモを保存</button>
      {note && <><p>本文版 {note.humanRevision} · 変更履歴 {note.history.filter(item => item.kind === 'human').length}件</p><label className="field">別保存の要約（本人入力）<textarea rows={3} value={summaryDraft ?? note.aiSummary ?? ''} onChange={event => setSummaryDraft(event.target.value)} /></label><button className="secondary-button" onClick={async () => { if (await run(() => setDayNoteSummary(note.id, note.summaryRevision, summaryDraft ?? note.aiSummary, 'human'), '要約を保存しました')) setSummaryDraft(null) }}>要約を保存</button><p className="muted">要約版 {note.summaryRevision} · {context?.summaryStale ? '本文の更新後、要約は古い版です' : note.aiSummary ? `${note.summaryOrigin === 'ai' ? 'AI' : '本人'}の要約` : '要約なし'}。本文を保存しても要約は上書きしません。</p></>}
    </section>
    <section className="card list-card"><div className="card-heading"><h2>気分・気力などの記録</h2><span className="subtle">非公開の端末内データ</span></div><div className="form-grid"><label className="field">項目名<input value={trackerName} maxLength={100} onChange={event => setTrackerName(event.target.value)} placeholder="例：気力" /></label><label className="field">単位<input value={unit} maxLength={30} onChange={event => setUnit(event.target.value)} /></label><label className="field">最小<input type="number" value={min} onChange={event => setMin(event.target.value)} /></label><label className="field">最大<input type="number" value={max} onChange={event => setMax(event.target.value)} /></label></div><button className="secondary-button" disabled={!trackerName.trim()} onClick={async () => { if (await run(() => createTracker(trackerName, unit, Number(min), Number(max)), '記録項目を作成しました')) setTrackerName('') }}>項目を追加</button>
      {own.map(tracker => <div className="tracker-row" key={tracker.id}><strong>{tracker.name}（{tracker.unit}、{tracker.min}〜{tracker.max}）</strong><div><input aria-label={`${tracker.name}の値`} type="number" min={tracker.min} max={tracker.max} value={values[tracker.id] ?? ''} onChange={event => setValues(current => ({ ...current, [tracker.id]: event.target.value }))} placeholder="空欄も可" /><button className="secondary-button" onClick={async () => { if (await run(() => recordTrackerEntry(tracker.id, values[tracker.id] === undefined || values[tracker.id] === '' ? null : Number(values[tracker.id])), '記録を保存しました')) setValues(current => ({ ...current, [tracker.id]: '' })) }}>記録</button></div><small>{entries.filter(entry => entry.trackerId === tracker.id).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).slice(0, 5).map(entry => `${new Date(entry.recordedAt).toLocaleString('ja-JP')}：${entry.value === null ? '空欄' : `${entry.value}${tracker.unit}`}`).join(' / ') || 'まだ記録はありません'}</small></div>)}
    </section>
  </>
}
