import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import { appendCoachReply, beginCoachTurn, cancelCoachTurn, createCoachConversation, deleteCoachConversation, previewCoachTurnContext, readCoachConversation, saveCoachDraft, setConversationRetention, type CoachTurn } from './chat-history'
import { type Goal, type GoalCheckIn, type Settings, type Task } from './domain'
import { DEFAULT_CHARACTER } from './character'
import { availableMemoryContext } from './coach-memory'
import LocalRetrievalView from './LocalRetrievalView'
import { VoiceMediaView } from './VoiceMediaView'
import { purgeExpiredCoachContext } from './context-retention'

type Props = { settings: Settings; tasks: Task[]; goals: Goal[]; checkIns: GoalCheckIn[]; aiReady: boolean; template: (text: string) => string; onBusy: (value: boolean) => void }
export default function SavedCoachConversation({ settings, tasks, goals, aiReady, template, onBusy }: Props) {
  const [clock, setClock] = useState(() => Date.now())
  const conversations = useLiveQuery(() => db.coachConversations.where('ownerId').equals(settings.profileId).toArray(), [settings.profileId])
  const own = (conversations ?? []).filter(item => !item.deletedAt && (!item.retentionUntil || Date.parse(item.retentionUntil) > clock)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const [selectedId, setSelectedId] = useState(''), [buffer, setBuffer] = useState<{ id: string; text: string } | null>(null)
  const active = own.find(item => item.id === selectedId) ?? own[0]
  const history = useLiveQuery(() => active ? readCoachConversation(active.id) : null, [active?.id, settings.profileId, settings.changePolicy?.epoch])
  const message = active ? buffer?.id === active.id ? buffer.text : active.draft : ''
  const initial = useRef<Promise<string> | null>(null), writes = useRef<Promise<unknown>>(Promise.resolve())
  const [taskId, setTaskId] = useState(''), [goalId, setGoalId] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const [sourceIds, setSourceIds] = useState<string[]>([]), [memoryIds, setMemoryIds] = useState<string[]>([]), [retention, setRetention] = useState(''), [spokenId, setSpokenId] = useState(''), [voiceHidden, setVoiceHidden] = useState(false)
  const sources = useLiveQuery(() => db.contextSources.where('ownerId').equals(settings.profileId).toArray(), [settings.profileId]) ?? []
  const memories = useLiveQuery(() => availableMemoryContext(settings.profileId), [settings.profileId, settings.changePolicy?.epoch, clock])
  const options = [...(memories?.explicit ?? []).map(item => ({ ...item, label: '本人が明示したメモ' })), ...(memories?.inferred ?? []).map(item => ({ ...item, label: '推測・未確認' }))]
  const preview = useLiveQuery(async () => { if (!aiReady) return null; try { return { value: await previewCoachTurnContext({ mode: 'ai', taskId: taskId || null, goalId: goalId || null, sourceIds, memoryIds }), error: '' } } catch (failure) { return { value: null, error: failure instanceof Error ? failure.message : String(failure) } } }, [aiReady, taskId, goalId, sourceIds, memoryIds, settings.profileId, settings.datasetId, settings.aiModel, settings.changePolicy?.epoch, clock])
  useEffect(() => { const refresh = () => { setClock(Date.now()); void purgeExpiredCoachContext().catch(error => setNotice(String(error instanceof Error ? error.message : error))) }, timer = window.setInterval(refresh, 60000); refresh(); window.addEventListener('focus', refresh); return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh) } }, [settings.profileId, settings.datasetId])
  useEffect(() => {
    if (conversations === undefined || own.length) return
    let alive = true
    initial.current ??= createCoachConversation()
    void initial.current.then(id => { if (alive) setSelectedId(id) }).catch(error => { if (alive) setNotice(String(error?.message ?? error)) })
    return () => { alive = false }
  }, [conversations, own.length])
  async function create() { try { const id = await createCoachConversation(); setSelectedId(id); setBuffer(null) } catch (error) { setNotice(String(error instanceof Error ? error.message : error)) } }
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
      if (remote && !preview?.value) throw new Error('選択情報の送信プレビューを確認してから送信してください')
      turn = await beginCoachTurn(id, current.conversation.revision, { text, mode: remote ? 'ai' : 'local', taskId: remote ? taskId || null : null, goalId: remote ? goalId || null : null, sourceIds: remote ? sourceIds : [], memoryIds: remote ? memoryIds : [], ...(remote ? { expectedContextDigest: preview!.value!.digest } : {}) })
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
    try { await writes.current; const current = await readCoachConversation(active.id); await deleteCoachConversation(active.id, current.conversation.revision); initial.current = null; setSelectedId(''); setBuffer(null); setNotice('会話の本文・下書き・応答を削除しました。') }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }
  async function cancelPending() { if (!active?.pendingMessageId) return; try { await cancelCoachTurn(active.id, active.pendingMessageId); setNotice('応答待ちを解除しました。本人の文章は残っています。') } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } }
  const assistantResponses = (history?.messages ?? []).filter(item => item.role === 'assistant' && item.origin !== 'notice'), spoken = assistantResponses.find(item => item.id === spokenId)
  return <section className="card conversation saved-conversation">
    <div className="conversation-top"><div className="small-avatar">✦</div><div><strong>{settings.coachName}</strong><small>{aiReady ? 'AI応答 · 選択したデータだけ送信' : '端末内の定型応答'}</small></div></div>
    <div className="conversation-controls"><label className="field">保存した会話<select aria-label="保存したコーチ会話" value={active?.id ?? ''} disabled={busy} onChange={event => { setSelectedId(event.target.value); setBuffer(null); setNotice('') }}>{own.map(item => <option key={item.id} value={item.id}>{item.title} · {new Date(item.createdAt).toLocaleString('ja-JP')}</option>)}</select></label><button className="text-button" disabled={busy} onClick={create}>新しい会話</button><button className="text-button" disabled={!active || busy} onClick={remove}>この会話を削除</button></div>
    <div className="messages"><div className="message coach">こんにちは。今日は何を整理しましょうか？</div>{(history?.messages ?? []).map(item => <div key={item.id} className={`message ${item.role === 'user' ? 'you' : 'coach'}`}><p>{item.text}</p><small>{item.origin === 'human' ? '本人の文章' : item.origin === 'live_ai' ? `AI応答 · ${item.model}` : item.origin === 'template' ? '端末内の定型文' : '応答状況'} · {new Date(item.createdAt).toLocaleString('ja-JP')}</small>{item.selectedSources.length > 0 && <details><summary>選んだ出典 {item.selectedSources.length}件</summary>{item.selectedSources.map(source => <small key={`${source.kind}:${source.id}`}>{source.kind} · {source.id} · 版{source.revision}{source.digest ? ` · ${source.digest.slice(0, 12)}…` : ''}<br /></small>)}</details>}</div>)}{busy && <div className="message coach">応答を待っています…</div>}</div>
    {aiReady && <div className="coach-share"><label className="field">OpenRouterへ送る保存済みタスク<select aria-label="会話へ送るタスク" value={taskId} disabled={busy} onChange={event => setTaskId(event.target.value)}><option value="">送らない</option>{tasks.filter(task => !task.deletedAt).map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><label className="field">OpenRouterへ送る目標とチェックイン<select value={goalId} disabled={busy} onChange={event => setGoalId(event.target.value)}><option value="">送らない</option>{goals.filter(goal => !goal.deletedAt).map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></label>
      <details><summary>送る資料を本人が選ぶ ({sourceIds.length}件)</summary>{sources.filter(source => !source.deletedAt && (!source.retentionUntil || Date.parse(source.retentionUntil) > clock)).map(source => { const allowed = source.permissions.acquire && source.permissions.retain && source.permissions.index && source.permissions.aiEgress && source.allowedModels.includes(settings.aiModel ?? ''); return <label key={source.id} style={{ display: 'block', marginTop: 8 }}><input type="checkbox" checked={sourceIds.includes(source.id)} disabled={busy || !allowed || !sourceIds.includes(source.id) && sourceIds.length >= 10} onChange={event => setSourceIds(ids => event.target.checked ? [...ids, source.id] : ids.filter(id => id !== source.id))} /> {source.title} · {source.provider} · {allowed ? `選択モデル ${settings.aiModel} への送信許可あり` : 'このモデルへの送信不許可（資料の権限設定で変更できます）'}</label> })}</details>
      <details><summary>送る記憶を本人が選ぶ ({memoryIds.length}件)</summary>{options.map(memory => <label key={memory.id} style={{ display: 'block', marginTop: 8, overflowWrap: 'anywhere' }}><input type="checkbox" checked={memoryIds.includes(memory.id)} disabled={busy || !memoryIds.includes(memory.id) && memoryIds.length >= 10} onChange={event => setMemoryIds(ids => event.target.checked ? [...ids, memory.id] : ids.filter(id => id !== memory.id))} /> {memory.label}: {memory.text}</label>)}<p className="muted">推測は未確認の内容として送ります。選択した記憶の出典が持つAI送信許可・保持期限も確認します。</p></details>
      <button className="text-button" disabled={busy} onClick={() => { setSourceIds([]); setMemoryIds([]) }}>資料と記憶の選択を解除</button>
      {preview?.value && <details><summary>実際に送る保存情報を確認（最大6000文字）</summary><p>送信先: OpenRouter / {settings.aiModel}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{preview.value.context || '保存情報は選んでいません。入力文だけ送ります。'}</pre></details>}{preview?.error && <p role="alert">{preview.error}</p>}<small>入力文とプレビュー内の現行データだけを送ります。記憶・資料の初期選択はなしです。過去会話は自動送信しません。</small></div>}
    <div className="chat-input"><input aria-label="コーチ相談の下書き" value={message} maxLength={6000} disabled={!active || busy || Boolean(active.pendingMessageId)} onChange={event => editDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) void send() }} placeholder="今日、何から始めよう？" /><button className="primary-button" onClick={send} disabled={!active || !message.trim() || busy || Boolean(active.pendingMessageId) || aiReady && !preview?.value}>送信</button></div>
    {active?.pendingMessageId && !busy && <button className="text-button" onClick={cancelPending}>応答待ちを解除して手動で続ける</button>}
    <p className="muted conversation-privacy">会話と入力途中の文章は端末内に保存します。会話の削除で本文・下書き・応答を消去します。</p>
    <details><summary>この会話の保持期限</summary><p>現在: {active?.retentionUntil ? new Date(active.retentionUntil).toLocaleString('ja-JP') : '期限なし'}。期限到達後は利用を停止します。画面を開く・戻る時と60秒ごとの確認、書出し時に本文・下書き・応答を消去します。</p><label className="field">新しい保持期限（端末の時刻、空欄で期限なし）<input type="datetime-local" value={retention} onChange={event => setRetention(event.target.value)} /></label><button className="secondary-button" disabled={!active || busy} onClick={async () => { if (!active) return; try { const current = await readCoachConversation(active.id); await setConversationRetention(active.id, current.conversation.revision, retention ? new Date(retention).toISOString() : null); setNotice('会話の保持期限を保存しました') } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } }}>保持期限を保存</button></details>
    <LocalRetrievalView settings={settings} onConversation={id => { setSelectedId(id); setBuffer(null) }} />
    {!voiceHidden && <><label className="field" style={{ marginTop: 12 }}>本人が選ぶ読み上げ対象<select aria-label="読み上げる保存済み応答" value={spoken?.id ?? ''} onChange={event => setSpokenId(event.target.value)}><option value="">読み上げ対象を選んでいません</option>{assistantResponses.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString('ja-JP')} · {item.text.slice(0, 60)}</option>)}</select></label>
    {spoken && <details><summary>選択した読み上げ本文</summary><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{spoken.text}</p></details>}</>}
    <VoiceMediaView responseText={spoken?.text ?? ''} onTranscript={!active || busy || active.pendingMessageId ? undefined : text => editDraft((message + (message ? '\n' : '') + text).slice(0, 6000))} hidden={voiceHidden} onHiddenChange={setVoiceHidden} />
    {notice && <p className="conversation-privacy" role="status">{notice}</p>}
  </section>
}
