import { useState } from 'react'
import { createTask, type TaskInput } from './commands'
import { today } from './domain'
import type { Settings } from './domain'
import { acceptTitleQuote, draftFromText, type AssistedDraft } from './task-assist'

export default function TaskAssistView({ settings, run }: { settings: Settings; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [raw, setRaw] = useState('')
  const [draft, setDraft] = useState<AssistedDraft | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const aiAvailable = Boolean(settings.aiEnabled && settings.aiModel && window.michiAI)
  function changeInput(change: Partial<TaskInput>) { setDraft(current => current && { ...current, input: { ...current.input, ...change } }) }
  function makeDraft() {
    try { const next = draftFromText(raw, today()); setDraft(next); setNotice('原文から下書きを作りました。内容を確認して保存してください。'); return next }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return null }
  }
  async function askAI() {
    const next = makeDraft()
    if (!next) return
    if (!aiAvailable) { setNotice('AIは停止中です。原文から作った下書きを編集できます。'); return }
    setBusy(true)
    try {
      const answer = await window.michiAI!.assistTask({ model: settings.aiModel!, text: raw })
      const title = acceptTitleQuote(raw, answer)
      setDraft({ ...next, input: { ...next.input, title } })
      setNotice('AIは原文中の一節だけを提案しました。値を確認してから保存してください。')
    } catch (error) { setNotice(`${error instanceof Error ? error.message : String(error)} 原文と下書きは残っています。`) }
    finally { setBusy(false) }
  }
  async function save() {
    if (!draft) return
    if (await run(() => createTask(draft.input), '確認したタスクを保存しました')) { setRaw(''); setDraft(null); setNotice('') }
  }
  return <section className="card task-assist">
    <div className="card-heading"><div><span className="eyebrow">TASK INPUT</span><h2>文章からタスク入力</h2><small>候補を編集してから、この端末に保存します。</small></div><button className="text-button" onClick={() => setOpen(value => !value)}>{open ? '閉じる' : '開く'}</button></div>
    {open && <div className="task-assist-body">
      <label className="field">原文<textarea aria-label="タスクの原文" value={raw} maxLength={2000} rows={3} disabled={busy} onChange={event => { setRaw(event.target.value); setDraft(null); setNotice('') }} placeholder="例：明日までに図書館へ返却。25pt、移動込み45分" /></label>
      <div className="task-assist-actions"><button className="secondary-button" disabled={!raw.trim() || busy} onClick={makeDraft}>原文から下書き</button><button className="secondary-button" disabled={!raw.trim() || busy} onClick={askAI}>{busy ? 'AIを待っています…' : 'AIでタイトル候補を作る'}</button></div>
      <p className="muted">AIを使う場合は、この原文だけをOpenRouterへ送ります。点数と日付は端末内で明示された値だけを読み取り、曖昧な値は空欄にします。</p>
      {notice && <p role="status">{notice}</p>}
      {draft && <div className="task-assist-preview"><h3>保存前の確認</h3>{draft.notices.map((text, index) => <p className="muted" key={index}>{text}</p>)}<div className="form-grid">
        <label className="field full-field">タイトル<input aria-label="候補タイトル" maxLength={300} value={draft.input.title} onChange={event => changeInput({ title: event.target.value })} /></label>
        <label className="field">予定日<input aria-label="候補予定日" type="date" value={draft.input.scheduledDate ?? ''} onChange={event => changeInput({ scheduledDate: event.target.value || null })} /></label>
        <label className="field">締め切り<input aria-label="候補締め切り" type="date" value={draft.input.dueDate ?? ''} onChange={event => changeInput({ dueDate: event.target.value || null })} /></label>
        <label className="field">手動ポイント<input aria-label="候補ポイント" type="number" min={0} max={100000} value={draft.input.score.mode === 'manual' ? draft.input.score.manualPoints ?? '' : ''} onChange={event => { const value = event.target.value; setDraft(current => current && { ...current, input: { ...current.input, score: { ...current.input.score, mode: value === '' ? 'unset' : 'manual', manualPoints: value === '' ? null : Number(value) } } }) }} /></label>
        <label className="field">作業時間（分）<input aria-label="候補作業時間" type="number" min={0} max={10080} value={draft.input.score.minutes ?? ''} onChange={event => setDraft(current => current && { ...current, input: { ...current.input, score: { ...current.input.score, minutes: event.target.value === '' ? null : Number(event.target.value) } } })} /></label>
      </div><button className="primary-button" disabled={!draft.input.title.trim() || busy} onClick={save}>確認した内容を保存</button></div>}
    </div>}
  </section>
}
