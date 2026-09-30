import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import type { Settings } from './domain'
import { createCoachMemory, deleteCoachMemory, editCoachMemory, memorySourceFromOption, setMemoryRetention, type CoachMemory, type MemoryKind, type MemorySourceOption, type MemorySourceRef } from './coach-memory'
import { sourceDb } from './source-library'
import { purgeExpiredCoachContext } from './context-retention'

type Run = (fn: () => Promise<unknown>, success?: string) => Promise<boolean>
const kindLabel = (kind: MemoryKind) => kind === 'explicit' ? '本人が明示したメモ' : '推測・未確認'
const sourceKind = (kind: string) => kind === 'human' ? '本人入力' : kind === 'derived-summary' ? '要約の出典' : kind === 'library' ? '保存済み資料本文' : kind === 'day-note' ? '日記の本人本文' : kind === 'review' ? 'レビューの本人回答' : '目標チェックイン'
const localTime = (at: string | null | undefined) => { if (!at) return ''; const date = new Date(at); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }

function MemoryItem({ memory, execute, sourceText }: { memory: CoachMemory; execute: Run; sourceText: (source: MemorySourceRef) => string }) {
  const [editing, setEditing] = useState(false), [text, setText] = useState(memory.text), [kind, setKind] = useState(memory.kind), [revision, setRevision] = useState(memory.revision)
  const [retention, setRetention] = useState(() => localTime(memory.retentionUntil))
  return <article className="card setting-section">
    <div className="card-heading"><strong>{kindLabel(memory.kind)}</strong><small>版 {memory.revision}</small></div>
    {editing ? <>
      <label className="field">種類<select value={kind} onChange={event => setKind(event.target.value as MemoryKind)}><option value="explicit">本人が明示したメモ</option><option value="inferred">推測・未確認</option></select></label>
      <label className="field">本文<textarea aria-label="記憶の訂正文" rows={3} maxLength={2000} value={text} onChange={event => setText(event.target.value)} /></label>
      <div className="export-buttons"><button className="secondary-button" disabled={!text.trim()} onClick={async () => { if (await execute(() => editCoachMemory(memory.id, revision, kind, text), '記憶を訂正しました')) setEditing(false) }}>訂正を保存</button><button className="text-button" onClick={() => setEditing(false)}>閉じる</button></div>
    </> : <><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{memory.text}</p><div className="export-buttons"><button className="secondary-button" onClick={() => { setText(memory.text); setKind(memory.kind); setRevision(memory.revision); setEditing(true) }}>訂正する</button><button className="text-button" onClick={() => execute(() => deleteCoachMemory(memory.id, memory.revision), '記憶を削除し、同じ出典の再登録を止めました')}>削除する</button></div></>}
    <details><summary>出典と変更履歴</summary>{memory.sources.map((source, index) => <div key={index}><p className="muted" style={{ overflowWrap: 'anywhere' }}>{sourceKind(source.kind)} · {source.kind === 'human' ? '本人が保存したメモ' : source.refId} · 出典版 {source.revision}{source.digest ? ` · 要約識別 ${source.digest.slice(0, 12)}…` : ''}</p><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{sourceText(source)}</p></div>)}{memory.history.map(event => <div className="setting-line" key={event.revision}><div><strong>{kindLabel(event.kind)} 版{event.revision}</strong><small>{new Date(event.at).toLocaleString('ja-JP')}</small><p>{event.text}</p></div></div>)}</details>
    <details><summary>保持期限を設定する</summary><p>現在: {memory.retentionUntil ? new Date(memory.retentionUntil).toLocaleString('ja-JP') : '期限なし'}。期限到達後は利用を停止します。画面を開く・戻る時と60秒ごとの確認、書出し時に本文・変更履歴・記憶由来の応答を消去します。再登録防止の出典情報は残します。</p><label className="field">新しい保持期限（端末の時刻、空欄で期限なし）<input type="datetime-local" value={retention} onChange={event => setRetention(event.target.value)} /></label><button className="secondary-button" onClick={() => execute(() => setMemoryRetention(memory.id, memory.revision, retention ? new Date(retention).toISOString() : null), '記憶の保持期限を保存しました')}>保持期限を保存</button></details>
  </article>
}

export default function CoachMemoryView({ settings, run }: { settings: Settings; run?: Run }) {
  const [clock, setClock] = useState(() => Date.now())
  const [text, setText] = useState(''), [kind, setKind] = useState<MemoryKind>('explicit'), [sourceChoice, setSourceChoice] = useState('manual'), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { const refresh = () => { setClock(Date.now()); void purgeExpiredCoachContext().catch(error => setNotice(error instanceof Error ? error.message : String(error))) }, timer = window.setInterval(refresh, 60000); refresh(); window.addEventListener('focus', refresh); return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh) } }, [settings.profileId, settings.datasetId])
  const memories = useLiveQuery(() => db.coachMemories.where('ownerId').equals(settings.profileId).toArray(), [settings.profileId]) ?? []
  const tombstones = useLiveQuery(() => db.memoryTombstones.where('ownerId').equals(settings.profileId).count(), [settings.profileId]) ?? 0
  const notes = useLiveQuery(() => db.dayNotes.where('ownerId').equals(settings.profileId).toArray(), [settings.profileId]) ?? []
  const reviews = useLiveQuery(() => db.reviewRecords.where('ownerId').equals(settings.profileId).toArray(), [settings.profileId]) ?? []
  const goals = useLiveQuery(() => db.goals.where('ownerId').equals(settings.profileId).toArray(), [settings.profileId]) ?? []
  const checkIns = useLiveQuery(() => db.goalCheckIns.toArray(), []) ?? []
  const library = useLiveQuery(() => sourceDb.contextSources.where('ownerId').equals(settings.profileId).toArray(), [settings.profileId]) ?? []
  const librarySnapshots = useLiveQuery(() => sourceDb.contextSnapshots.where('ownerId').equals(settings.profileId).toArray(), [settings.profileId]) ?? []
  const librarySummaries = useLiveQuery(() => sourceDb.sourceSummaries.where('ownerId').equals(settings.profileId).toArray(), [settings.profileId]) ?? []
  const permittedLibrary = library.filter(source => !source.deletedAt && source.permissions.acquire && source.permissions.retain && source.permissions.index && (!source.retentionUntil || Date.parse(source.retentionUntil) > clock))
  const goalIds = new Set(goals.filter(goal => !goal.deletedAt).map(goal => goal.id))
  const options: MemorySourceOption[] = [
    ...notes.filter(note => !note.deletedAt).flatMap(note => [{ label: `${note.date} 日記の本人本文`, kind: 'day-note' as const, refId: note.id, summary: false }, ...(note.aiSummary && note.summaryOfHumanRevision === note.humanRevision ? [{ label: `${note.date} 日記の要約`, kind: 'day-note' as const, refId: note.id, summary: true }] : [])]),
    ...reviews.filter(record => !record.deletedAt).flatMap(record => [{ label: `${record.date} ${record.kind === 'morning' ? '朝' : record.kind === 'evening' ? '夕' : '週次'}レビューの本人回答`, kind: 'review' as const, refId: record.id, summary: false }, ...(record.aiSummary && record.summaryOfAnswerRevision === record.answerRevision && record.summaryOfActualRevision === record.actualRevision ? [{ label: `${record.date} ${record.kind === 'morning' ? '朝' : record.kind === 'evening' ? '夕' : '週次'}レビューの要約`, kind: 'review' as const, refId: record.id, summary: true }] : [])]),
    ...checkIns.filter(checkIn => !checkIn.deletedAt && goalIds.has(checkIn.goalId)).flatMap(checkIn => [{ label: `${checkIn.date} 目標の本人回答`, kind: 'goal-checkin' as const, refId: checkIn.id, summary: false }, ...(checkIn.summary ? [{ label: `${checkIn.date} 目標の要約`, kind: 'goal-checkin' as const, refId: checkIn.id, summary: true }] : [])]),
    ...permittedLibrary.flatMap(source => [{ label: `${source.date} 資料 ${source.title}`, kind: 'library' as const, refId: source.id, summary: false }, ...(source.permissions.aiEgress && librarySummaries.some(summary => summary.sourceId === source.id && summary.sourceRevision === source.latestRevision && summary.permissionRevision === source.permissionRevision && summary.policyEpoch === (settings.changePolicy?.epoch ?? 0) && summary.sourcePermissionRevision === (settings.changePolicy?.sourcePermissionRevision ?? 0)) ? [{ label: `${source.date} 資料要約 ${source.title}`, kind: 'library' as const, refId: source.id, summary: true }] : [])])
  ].sort((left, right) => right.label.localeCompare(left.label)).slice(0, 200)
  const optionKey = (option: MemorySourceOption) => JSON.stringify([option.kind, option.refId, option.summary])
  const own = memories.filter(memory => !memory.deletedAt && (!memory.retentionUntil || Date.parse(memory.retentionUntil) > clock)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  function sourceText(source: MemorySourceRef): string {
    if (source.kind === 'human') return '本人が保存ボタンで入力したメモです。'
    const summary = source.kind === 'derived-summary', split = source.refId.indexOf(':')
    const sourceType = summary ? source.refId.slice(0, split) : source.kind, sourceId = summary ? source.refId.slice(split + 1) : source.refId
    let content: string | null | undefined
    if (sourceType === 'day-note') {
      const note = notes.find(item => item.id === sourceId && !item.deletedAt)
      content = summary ? note?.summaryRevision === source.revision ? note.aiSummary : note?.history.find(event => event.kind === 'summary' && event.revision === source.revision)?.text : note?.humanRevision === source.revision ? note.humanText : note?.history.find(event => event.kind === 'human' && event.revision === source.revision)?.text
    } else if (sourceType === 'review') {
      const review = reviews.find(item => item.id === sourceId && !item.deletedAt)
      if (summary) { const historical = review?.history.find(event => event.kind === 'summary' && event.revision === source.revision); content = review?.summaryRevision === source.revision ? review.aiSummary : historical?.kind === 'summary' ? historical.summary : null }
      else { const historical = review?.history.find(event => event.kind === 'answer' && event.revision === source.revision); content = review?.answerRevision === source.revision ? review.answer : historical?.kind === 'answer' ? historical.answer : null }
    } else if (sourceType === 'library') {
      const document = permittedLibrary.find(item => item.id === sourceId)
      if (document) content = summary ? librarySummaries.filter(item => item.sourceId === sourceId && item.sourceRevision === source.revision && item.sha256 === source.digest && item.permissionRevision === document.permissionRevision && item.policyEpoch === (settings.changePolicy?.epoch ?? 0) && item.sourcePermissionRevision === (settings.changePolicy?.sourcePermissionRevision ?? 0)).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.text : librarySnapshots.find(item => item.sourceId === sourceId && item.revision === source.revision)?.text
    } else {
      const checkIn = checkIns.find(item => item.id === sourceId && !item.deletedAt && goalIds.has(item.goalId))
      content = checkIn?.summaryRevision === source.revision ? summary ? checkIn.summary : checkIn.answer : summary ? checkIn?.history[source.revision - 1]?.summary : null
    }
    return content === undefined || content === null ? '出典は更新・削除されました。現行のコーチ文脈への再利用から除外します。' : content.length > 3000 ? `${content.slice(0, 3000)}\n（出典の先頭3000文字を表示）` : content || '出典の本人本文は空欄です。'
  }
  async function execute(operation: () => Promise<unknown>, success = '') {
    try {
      const ok = run ? await run(operation, success) : (await operation(), true)
      setNotice(ok ? success : '保存できませんでした。入力した内容は残っています。')
      return ok
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return false }
  }
  async function save() {
    if (busy || !text.trim()) return
    setBusy(true)
    try {
      const selected = options.find(option => optionKey(option) === sourceChoice)
      if (sourceChoice !== 'manual' && !selected) throw new Error('出典が更新・削除されました。もう一度選んでください')
      const source = selected ? await memorySourceFromOption(selected, settings.profileId) : undefined
      if (await execute(() => createCoachMemory({ kind, text, ...(source ? { sources: [source] } : {}) }), '本人が選んだ記憶を保存しました')) { setText(''); setSourceChoice('manual') }
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <section className="card setting-section">
    <div className="setting-heading"><div><h2>本人についてのメモ</h2><p>本人が明示した内容と未確認の推測を区別して、訂正・削除できます。</p></div></div>
    <div className="form-grid"><label className="field">種類<select aria-label="記憶の種類" value={kind} disabled={busy} onChange={event => setKind(event.target.value as MemoryKind)}><option value="explicit">本人が明示したメモ</option><option value="inferred">推測・未確認</option></select></label><label className="field">出典<select aria-label="記憶の出典" value={sourceChoice} disabled={busy} onChange={event => setSourceChoice(event.target.value)}><option value="manual">この本人入力</option>{options.map(option => <option key={optionKey(option)} value={optionKey(option)}>{option.label}</option>)}</select></label></div>
    <label className="field">記憶として残す内容<textarea aria-label="記憶として残す内容" rows={3} maxLength={2000} value={text} disabled={busy} onChange={event => setText(event.target.value)} placeholder="例：朝は短い提案を希望する" /></label>
    <button className="secondary-button" disabled={busy || !text.trim()} onClick={save}>本人が選んだ記憶を保存</button>
    <p className="muted">この画面で保存した内容は端末内に保存します。ここではAIへ送信しません。コーチ会話で本人が選んだ記憶だけをプレビューして送信できます。資料の文章から本人属性を自動で追加する処理はありません。</p>
    <p className="muted">削除・訂正した推測は、同じ出典と同じ版から別の内容で再登録できません。再利用防止の出典記録は{tombstones}件です。削除した内容と変更履歴はローカル保存に残り、現在の記憶から除外します。</p>
    {own.map(memory => <MemoryItem key={memory.id} memory={memory} execute={execute} sourceText={sourceText} />)}
    {own.length === 0 && <p className="muted">保存した記憶はまだありません。</p>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
