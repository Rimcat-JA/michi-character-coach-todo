import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import { selectedGoalContext, selectedTaskContext } from './ai'
import { appendCoachReply, beginCoachTurn, cancelCoachTurn, createCoachConversation, deleteCoachConversation, readCoachConversation, saveCoachDraft, searchCoachHistory, type CoachTurn } from './chat-history'
import { today, type Goal, type GoalCheckIn, type Settings, type Task } from './domain'
import { DEFAULT_CHARACTER } from './character'

type Props = { settings: Settings; tasks: Task[]; goals: Goal[]; checkIns: GoalCheckIn[]; aiReady: boolean; template: (text: string) => string; onBusy: (value: boolean) => void }
export default function SavedCoachConversation({ settings, tasks, goals, checkIns, aiReady, template, onBusy }: Props) {
  const conversations = useLiveQuery(() => db.coachConversations.where('ownerId').equals(settings.profileId).toArray(), [settings.profileId])
  const own = (conversations ?? []).filter(item => !item.deletedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const [selectedId, setSelectedId] = useState(''), [buffer, setBuffer] = useState<{ id: string; text: string } | null>(null)
  const active = own.find(item => item.id === selectedId) ?? own[0]
  const history = useLiveQuery(() => active ? readCoachConversation(active.id) : null, [active?.id, settings.profileId, settings.changePolicy?.epoch])
  const message = active ? buffer?.id === active.id ? buffer.text : active.draft : ''
  const initial = useRef<Promise<string> | null>(null), writes = useRef<Promise<unknown>>(Promise.resolve())
  const [taskId, setTaskId] = useState(''), [goalId, setGoalId] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const [query, setQuery] = useState(''), [from, setFrom] = useState('2020-01-01'), [to, setTo] = useState(today), [result, setResult] = useState<Awaited<ReturnType<typeof searchCoachHistory>> | null>(null)
  const [resultEpoch, setResultEpoch] = useState<number | null>(null)
  useEffect(() => { const timer = window.setTimeout(() => setResult(null), 0); return () => window.clearTimeout(timer) }, [settings.changePolicy?.epoch])
  const preview = [selectedTaskContext(tasks.find(task => task.id === taskId)), selectedGoalContext(goals.find(goal => goal.id === goalId), checkIns)].filter(Boolean).join('\n\n')
  useEffect(() => {
    if (conversations === undefined || own.length) return
    let alive = true
    initial.current ??= createCoachConversation()
    void initial.current.then(id => { if (alive) setSelectedId(id) }).catch(error => { if (alive) setNotice(String(error?.message ?? error)) })
    return () => { alive = false }
  }, [conversations, own.length])
  async function create() { try { const id = await createCoachConversation(); setSelectedId(id); setBuffer(null); setResult(null) } catch (error) { setNotice(String(error instanceof Error ? error.message : error)) } }
  function editDraft(value: string) {
    if (!active) return
    const id = active.id
    setBuffer({ id, text: value })
    writes.current = writes.current.catch(() => undefined).then(async () => {
      const current = await readCoachConversation(id)
      await saveCoachDraft(id, current.conversation.draftRevision, value)
    }).catch(error => { setNotice(`下書きの保存に失敗しました。入力を保持しています。${error instanceof Error ? error.message : String(error)}`) })
  }
  async function send() {
    if (!active || !message.trim() || busy || active.pendingMessageId) return
    const id = active.id, text = message
    setBusy(true); onBusy(true); setNotice('')
    let turn: CoachTurn | undefined
    try {
      await writes.current
      let current = await readCoachConversation(id)
      if (current.conversation.draft !== text) { await saveCoachDraft(id, current.conversation.draftRevision, text); current = await readCoachConversation(id) }
      const remote = Boolean(aiReady && window.michiAI && navigator.onLine)
      turn = await beginCoachTurn(id, current.conversation.revision, { text, mode: remote ? 'ai' : 'local', taskId: remote ? taskId || null : null, goalId: remote ? goalId || null : null })
      setBuffer({ id, text: '' })
      const answer = remote ? await window.michiAI!.chat({ model: turn.model!, message: text, selectedTask: turn.selectedContext, character: settings.characterProfile ?? DEFAULT_CHARACTER }) : template(text)
      await appendCoachReply(turn, answer, remote ? 'live_ai' : 'template')
      setNotice('本人の文章と応答をこの端末に保存しました。')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (turn) { try { await appendCoachReply(turn, `応答を確定できませんでした。本人の文章は保存済みです。${detail}`, 'notice') } catch { /* Deleted conversation stays deleted. */ } }
      setNotice(`応答を確定できませんでした。${detail}`)
    } finally { setBusy(false); onBusy(false) }
  }
  async function remove() {
    if (!active || busy) return
    try { await writes.current; const current = await readCoachConversation(active.id); await deleteCoachConversation(active.id, current.conversation.revision); initial.current = null; setSelectedId(''); setBuffer(null); setResult(null); setNotice('会話の本文・下書き・応答を削除しました。') }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }
  async function cancelPending() { if (!active?.pendingMessageId) return; try { await cancelCoachTurn(active.id, active.pendingMessageId); setNotice('応答待ちを解除しました。本人の文章は残っています。') } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } }
  return <section className="card conversation saved-conversation">
    <div className="conversation-top"><div className="small-avatar">✦</div><div><strong>{settings.coachName}</strong><small>{aiReady ? 'AI応答 · 選択したデータだけ送信' : '端末内の定型応答'}</small></div></div>
    <div className="conversation-controls"><label className="field">保存した会話<select aria-label="保存したコーチ会話" value={active?.id ?? ''} disabled={busy} onChange={event => { setSelectedId(event.target.value); setBuffer(null); setNotice('') }}>{own.map(item => <option key={item.id} value={item.id}>{item.title} · {new Date(item.createdAt).toLocaleString('ja-JP')}</option>)}</select></label><button className="text-button" disabled={busy} onClick={create}>新しい会話</button><button className="text-button" disabled={!active || busy} onClick={remove}>この会話を削除</button></div>
    <div className="messages"><div className="message coach">こんにちは。今日は何を整理しましょうか？</div>{(history?.messages ?? []).map(item => <div key={item.id} className={`message ${item.role === 'user' ? 'you' : 'coach'}`}><p>{item.text}</p><small>{item.origin === 'human' ? '本人の文章' : item.origin === 'live_ai' ? `AI応答 · ${item.model}` : item.origin === 'template' ? '端末内の定型文' : '応答状況'} · {new Date(item.createdAt).toLocaleString('ja-JP')}</small>{item.selectedSources.length > 0 && <details><summary>選んだ出典 {item.selectedSources.length}件</summary>{item.selectedSources.map(source => <small key={`${source.kind}:${source.id}`}>{source.kind} · {source.id} · 版{source.revision}{source.digest ? ` · ${source.digest.slice(0, 12)}…` : ''}<br /></small>)}</details>}</div>)}{busy && <div className="message coach">応答を待っています…</div>}</div>
    {aiReady && <div className="coach-share"><label className="field">OpenRouterへ送る保存済みタスク<select aria-label="会話へ送るタスク" value={taskId} disabled={busy} onChange={event => setTaskId(event.target.value)}><option value="">送らない</option>{tasks.filter(task => !task.deletedAt).map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><label className="field">OpenRouterへ送る目標とチェックイン<select value={goalId} disabled={busy} onChange={event => setGoalId(event.target.value)}><option value="">送らない</option>{goals.filter(goal => !goal.deletedAt).map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></label>{preview && <details><summary>送信する保存情報を表示</summary><pre>{preview}</pre></details>}<small>入力文と選んだ現行データを送ります。過去の会話を送信する操作はありません。</small></div>}
    <div className="chat-input"><input aria-label="コーチ相談の下書き" value={message} maxLength={6000} disabled={!active || busy || Boolean(active.pendingMessageId)} onChange={event => editDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) void send() }} placeholder="今日、何から始めよう？" /><button className="primary-button" onClick={send} disabled={!active || !message.trim() || busy || Boolean(active.pendingMessageId)}>送信</button></div>
    {active?.pendingMessageId && !busy && <button className="text-button" onClick={cancelPending}>応答待ちを解除して手動で続ける</button>}
    <p className="muted conversation-privacy">会話と入力途中の文章は端末内に保存します。会話の削除で本文・下書き・応答を消去します。</p>
    <details className="conversation-search"><summary>保存した会話を文字検索</summary><label className="field">検索語<input aria-label="会話の検索語" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} /></label><div className="form-grid"><label className="field">開始日<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label className="field">終了日<input type="date" value={to} onChange={event => setTo(event.target.value)} /></label></div><button className="secondary-button" onClick={async () => { try { setResultEpoch(settings.changePolicy?.epoch ?? 0); setResult(await searchCoachHistory(query, from, to)) } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } }}>端末内の会話を検索</button>{result && resultEpoch === (settings.changePolicy?.epoch ?? 0) && <><p className="muted">{result.notice}</p>{result.hits.filter(hit => own.some(row => row.id === hit.conversation.id)).map(hit => <div key={hit.message.id}><button className="text-button" onClick={() => { setSelectedId(hit.conversation.id); setBuffer(null) }}>{hit.conversation.title} · {hit.message.role === 'user' ? '本人' : 'コーチ'} · {new Date(hit.message.createdAt).toLocaleString('ja-JP')}</button><p>{hit.quote}</p><small>出典：会話 {hit.conversation.id} / 文章 {hit.message.id} / 文字 {hit.start}〜{hit.end}</small></div>)}</>}</details>
    {notice && <p className="conversation-privacy" role="status">{notice}</p>}
  </section>
}
