import { useState } from 'react'
import type { TaskInput } from './commands'
import { today, type Settings } from './domain'
import { changePolicyFor } from './change-set'
import { acceptAssistedDrafts, applyAssistedTasks, draftsFromText, prepareAssistedTasks, type PreparedAssistedTasks, type SourcedDraft } from './task-assist'

export default function TaskAssistView({ settings, run }: { settings: Settings; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [raw, setRaw] = useState('')
  const [drafts, setDrafts] = useState<SourcedDraft[]>([])
  const [prepared, setPrepared] = useState<PreparedAssistedTasks | null>(null)
  const [origin, setOrigin] = useState<'manual' | 'ai'>('manual')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const aiChangesOn = settings.aiEnabled && changePolicyFor(settings).aiChangesEnabled, aiAvailable = Boolean(aiChangesOn && settings.aiModel && window.michiAI)
  // The save itself re-checks the stops and the epoch; this only keeps a stopped AI proposal from looking savable.
  const aiProposalStopped = origin === 'ai' && !aiChangesOn
  function changeInput(index: number, change: Partial<TaskInput>) {
    setPrepared(null)
    setDrafts(current => current.map((draft, i) => i === index ? { ...draft, input: { ...draft.input, ...change } } : draft))
  }
  function makeDraft() {
    try { const next = draftsFromText(raw, today()); setDrafts(next); setPrepared(null); setOrigin('manual'); setNotice('原文から下書きを作りました。内容を確認してください。'); return next }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return null }
  }
  async function askAI() {
    if (!makeDraft()) return
    if (!aiAvailable) { setNotice('AIは停止中です。原文から作った下書きを編集できます。'); return }
    setBusy(true)
    try {
      const answer = await window.michiAI!.assistTask({ model: settings.aiModel!, text: raw })
      setDrafts(acceptAssistedDrafts(raw, answer, today()))
      setOrigin('ai')
      setNotice('原文に含まれるタスク候補です。点数と日付を確認してください。')
    } catch (error) { setNotice(`${error instanceof Error ? error.message : String(error)} 原文と下書きは残っています。`) }
    finally { setBusy(false) }
  }
  async function prepare() {
    setBusy(true)
    try { setPrepared(await prepareAssistedTasks(drafts, origin)); setNotice('この内容への承認で保存します。編集すると確認をやり直します。') }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  async function save() {
    if (!prepared) return
    setBusy(true)
    try {
      if (await run(() => applyAssistedTasks(prepared, prepared.digest), `${prepared.inputs.length}件のタスクを保存しました`)) { setRaw(''); setDrafts([]); setPrepared(null); setNotice('') }
    } finally { setBusy(false) }
  }
  return <section className="card task-assist">
    <div className="card-heading"><div><span className="eyebrow">TASK INPUT</span><h2>文章からタスク入力</h2><small>候補を編集し、確認した内容をまとめて保存します。</small></div><button className="text-button" onClick={() => setOpen(value => !value)}>{open ? '閉じる' : '開く'}</button></div>
    {open && <div className="task-assist-body">
      <label className="field">原文<textarea aria-label="タスクの原文" value={raw} maxLength={2000} rows={3} disabled={busy} onChange={event => { setRaw(event.target.value); setDrafts([]); setPrepared(null); setNotice('') }} placeholder={'明日までに図書館へ返却。25pt\n予定日2026-10-01にメールを書く。10pt'} /></label>
      <div className="task-assist-actions"><button className="secondary-button" disabled={!raw.trim() || busy} onClick={makeDraft}>原文から下書き</button><button className="secondary-button" disabled={!raw.trim() || busy} onClick={askAI}>{busy ? '処理中…' : 'AIでタスク候補を作る'}</button></div>
      <p className="muted">AIを使う場合は、この原文だけをOpenRouterへ送ります。点数と日付は端末内で明示された値だけを読み取り、曖昧な値は空欄にします。AIを使わない場合は1行を1候補として扱います。</p>
      {notice && <p role="status">{notice}</p>}
      {drafts.map((draft, index) => <div className="task-assist-preview" key={index}>
        <h3>候補 {index + 1}</h3><blockquote>{draft.source}</blockquote>{draft.notices.map((text, i) => <p className="muted" key={i}>{text}</p>)}
        <fieldset disabled={busy}><div className="form-grid">
          <label className="field full-field">タイトル<input aria-label={`候補${index + 1}タイトル`} maxLength={300} value={draft.input.title} onChange={event => changeInput(index, { title: event.target.value })} /></label>
          <label className="field">予定日<input aria-label={`候補${index + 1}予定日`} type="date" value={draft.input.scheduledDate ?? ''} onChange={event => changeInput(index, { scheduledDate: event.target.value || null })} /></label>
          <label className="field">締め切り<input aria-label={`候補${index + 1}締め切り`} type="date" value={draft.input.dueDate ?? ''} onChange={event => changeInput(index, { dueDate: event.target.value || null })} /></label>
          <label className="field">手動ポイント<input aria-label={`候補${index + 1}ポイント`} type="number" min={0} max={100000} value={draft.input.score.mode === 'manual' ? draft.input.score.manualPoints ?? '' : ''} onChange={event => changeInput(index, { score: { ...draft.input.score, mode: event.target.value === '' ? 'unset' : 'manual', manualPoints: event.target.value === '' ? null : Number(event.target.value) } })} /></label>
          <label className="field">作業時間（分）<input aria-label={`候補${index + 1}作業時間`} type="number" min={0} max={10080} value={draft.input.score.minutes ?? ''} onChange={event => changeInput(index, { score: { ...draft.input.score, minutes: event.target.value === '' ? null : Number(event.target.value) } })} /></label>
        </div></fieldset><button className="text-button" disabled={busy} onClick={() => { setDrafts(current => current.filter((_, i) => i !== index)); setPrepared(null) }}>この候補を除く</button>
      </div>)}
      {!!drafts.length && <button className="secondary-button" disabled={busy} onClick={prepare}>変更内容を確認</button>}
      {prepared && <div className="task-assist-approval"><strong>新規タスク {prepared.inputs.length}件 · 外部への書き込みなし</strong><ul>{prepared.inputs.map((input, index) => <li key={index}>{input.title} · {input.score.manualPoints ?? '未設定'}pt · 予定 {input.scheduledDate ?? 'なし'} · 期限 {input.dueDate ?? 'なし'}</li>)}</ul><button className="primary-button" disabled={busy || aiProposalStopped} onClick={save}>この内容を承認して保存</button>{aiProposalStopped && <p role="status">AIによる変更案の受付は停止中です。原文から下書きを使ってください。</p>}</div>}
    </div>}
  </section>
}
