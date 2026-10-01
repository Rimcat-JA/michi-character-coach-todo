import { db } from './db'
import Dexie from 'dexie'
import { ConflictError } from './commands'
import { changePolicyFor } from './change-set'
import { uid, validateDate, type Settings } from './domain'
import { selectedGoalContext, selectedTaskContext } from './ai'
import { memoryForSelectedChat, purgeExpiredMemories } from './coach-memory'
import { purgeExpiredSources } from './source-library'
import { loadTaskEgress, recordEgressAudit, type TaskEgress } from './egress-policy'
import { defaultCoachConversationRetention } from './retention-defaults'

export type ChatSourceRef = { kind: 'task' | 'goal' | 'goal-checkin' | 'library' | 'memory'; id: string; revision: number; digest: string | null; permissionRevision: number | null }
export type CoachConversation = { id: string; ownerId: string; title: string; timezone: string; revision: number; draft: string; draftRevision: number; pendingMessageId: string | null; createdAt: string; updatedAt: string; deletedAt: string | null; retentionUntil?: string | null }
export type CoachMessage = { id: string; conversationId: string; ownerId: string; sequence: number; role: 'user' | 'assistant'; origin: 'human' | 'live_ai' | 'template' | 'notice'; text: string; model: string | null; provider: 'openrouter' | null; replyTo: string | null; selectedSources: ChatSourceRef[]; policyEpoch: number | null; sourcePermissionRevision: number | null; createdAt: string }
export type CoachTurn = { conversationId: string; userMessageId: string; ownerId: string; datasetId: string; mode: 'local' | 'ai'; model: string | null; policyEpoch: number; sourcePermissionRevision: number; selectedSources: ChatSourceRef[]; selectedContext: string | null }
export type CoachTurnInput = { text: string; mode: 'local' | 'ai'; taskId?: string | null; goalId?: string | null; sourceIds?: string[]; memoryIds?: string[]; expectedContextDigest?: string }

const textLimit = 10000
const activeTurns = new Map<string, string>()
export function clearCoachTurnAuthority(): void { activeTurns.clear() }
const tables = () => [db.coachConversations, db.coachMessages, db.settings, db.tasks, db.goals, db.goalCheckIns, db.dayNotes, db.reviewRecords, db.coachMemories, db.memoryTombstones, db.contextSources, db.contextSnapshots, db.sourceSummaries, db.taskSourceEvidence, db.audits]
async function settings() { const row = await db.settings.get('main'); if (!row?.profileId.trim() || !row.datasetId.trim()) throw new Error('本人の設定がありません'); return row }
function text(value: unknown, allowEmpty = false): asserts value is string { if (typeof value !== 'string' || value.length > textLimit || !allowEmpty && !value.trim()) throw new Error('会話の本文は1〜10000文字で指定してください') }
function revision(value: number) { if (!Number.isSafeInteger(value) || value < 1) throw new Error('会話の版を確認してください') }
function nextRevision(value: number) { revision(value); if (!Number.isSafeInteger(value + 1)) throw new Error('会話の版が上限に達しています'); return value + 1 }
const timestamp = (previous: string) => { const at = new Date().toISOString(); return at < previous ? previous : at }
async function conversation(id: string, ownerId: string) { const row = await db.coachConversations.get(id); if (!row || row.ownerId !== ownerId || row.deletedAt || row.retentionUntil && Date.parse(row.retentionUntil) <= Date.now()) throw new Error('本人の会話がありません'); return row }
function modelId(model: unknown): asserts model is string { if (typeof model !== 'string' || !/^[\w~./:-]{3,120}$/.test(model)) throw new Error('AIモデルIDを確認してください') }
async function digest(value: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('') }

/** retentionUntil omitted = design default of 180 days; null = the owner explicitly chose no expiry. */
export async function createCoachConversation(title = 'コーチとの会話', timezone = Intl.DateTimeFormat().resolvedOptions().timeZone, retentionUntil: string | null = defaultCoachConversationRetention()): Promise<string> {
  if (typeof title !== 'string' || !title.trim() || title.length > 200 || typeof timezone !== 'string' || timezone.length > 100) throw new Error('会話名とtimezoneを確認してください')
  if (retentionUntil !== null && (typeof retentionUntil !== 'string' || !Number.isFinite(Date.parse(retentionUntil)) || new Date(retentionUntil).toISOString() !== retentionUntil || Date.parse(retentionUntil) <= Date.now())) throw new Error('会話の保持期限は未来の日時で指定してください')
  try { new Intl.DateTimeFormat('en-CA', { timeZone: timezone }) } catch { throw new Error('timezoneを確認してください') }
  return db.transaction('rw', db.coachConversations, db.settings, async () => {
    const current = await settings(), id = uid(), at = new Date().toISOString()
    if (await db.coachConversations.where('ownerId').equals(current.profileId).count() >= 10000) throw new Error('会話は10000件まで保存できます')
    await db.coachConversations.add({ id, ownerId: current.profileId, title: title.trim(), timezone, revision: 1, draft: '', draftRevision: 1, pendingMessageId: null, retentionUntil, createdAt: at, updatedAt: at, deletedAt: null })
    return id
  })
}

export async function saveCoachDraft(id: string, expectedDraftRevision: number, value: string): Promise<number> {
  text(value, true); revision(expectedDraftRevision)
  return db.transaction('rw', db.coachConversations, db.settings, async () => {
    const current = await settings(), row = await conversation(id, current.profileId)
    if (row.draftRevision !== expectedDraftRevision) throw new ConflictError()
    if (row.draft === value) return row.draftRevision
    const draftRevision = nextRevision(row.draftRevision)
    await db.coachConversations.put({ ...row, draft: value, draftRevision, updatedAt: timestamp(row.updatedAt) })
    return draftRevision
  })
}

async function selectedContext(input: CoachTurnInput, current: Settings): Promise<{ refs: ChatSourceRef[]; context: string | null; checkInBodies: string[]; taskEgress: TaskEgress | null }> {
  const refs: ChatSourceRef[] = [], parts: string[] = [], checkInBodies: string[] = []
  let taskEgress: TaskEgress | null = null
  if (input.taskId) {
    const task = await db.tasks.get(input.taskId)
    if (!task || task.deletedAt) throw new Error('選択したタスクがありません')
    refs.push({ kind: 'task', id: task.id, revision: task.revision, digest: null, permissionRevision: null })
    // Quotes behind the task ride along only with every source's index+aiEgress+model consent; refs bind them to the reply.
    taskEgress = await loadTaskEgress(task, { kind: 'ai-model', route: 'coach-chat', model: input.mode === 'ai' ? current.aiModel ?? null : null })
    for (const ref of taskEgress.refs) refs.push({ kind: 'library', id: ref.sourceId, revision: ref.snapshotRevision, digest: ref.sha256, permissionRevision: ref.permissionRevision })
    parts.push(selectedTaskContext({ ...task, notes: taskEgress.notes }, taskEgress.evidence)!)
  }
  if (input.goalId) {
    const goal = await db.goals.get(input.goalId)
    if (!goal || goal.ownerId !== current.profileId || goal.deletedAt) throw new Error('本人が選択した目標がありません')
    refs.push({ kind: 'goal', id: goal.id, revision: goal.revision, digest: null, permissionRevision: null })
    const checkIns = (await db.goalCheckIns.where('goalId').equals(goal.id).toArray()).filter(row => !row.deletedAt).sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3)
    for (const item of checkIns) {
      refs.push({ kind: 'goal-checkin', id: item.id, revision: Math.max(1, item.summaryRevision), digest: null, permissionRevision: null })
      checkInBodies.push(JSON.stringify([item.answer, item.summary, item.summaryRevision, item.updatedAt]))
    }
    parts.push(selectedGoalContext(goal, checkIns)!)
  }
  for (const id of input.sourceIds ?? []) {
    const source = await db.contextSources.get(id)
    if (!source || source.ownerId !== current.profileId || source.deletedAt || source.retentionUntil !== null && Date.parse(source.retentionUntil) <= Date.now() || !source.permissions.acquire || !source.permissions.retain || !source.permissions.index) throw new Error('選択した資料の利用は許可されていません')
    if (input.mode === 'ai' && (!source.permissions.aiEgress || !source.allowedModels.includes(current.aiModel!))) throw new Error('選択した資料のAI送信は許可されていません')
    const snapshot = await db.contextSnapshots.get(`${id}:${source.latestRevision}`)
    if (!snapshot || snapshot.ownerId !== current.profileId) throw new Error('選択した資料本文がありません')
    refs.push({ kind: 'library', id, revision: snapshot.revision, digest: snapshot.sha256, permissionRevision: source.permissionRevision })
    parts.push(`選択した資料: ${source.title}\n${snapshot.text}`)
  }
  for (const id of input.memoryIds ?? []) {
    const { memory, digest } = await memoryForSelectedChat(id, current.profileId, input.mode === 'ai' ? current.aiModel! : null)
    refs.push({ kind: 'memory', id, revision: memory.revision, digest, permissionRevision: null })
    parts.push(`本人が選んだ記憶 (${memory.kind === 'explicit' ? '本人が明示したメモ' : '推測・未確認、事実として断定しない'}): ${memory.text}`)
  }
  const unique = refs.filter((ref, index) => refs.findIndex(other => other.kind === ref.kind && other.id === ref.id) === index)
  return { refs: unique, context: parts.join('\n\n').slice(0, 6000) || null, checkInBodies, taskEgress }
}
function sameRefs(left: ChatSourceRef[], right: ChatSourceRef[]) { return JSON.stringify(left) === JSON.stringify(right) }
function validateSelections(input: Omit<CoachTurnInput, 'text'>) {
  if (!input || !['local', 'ai'].includes(input.mode) || [input.taskId, input.goalId].some(value => value !== undefined && value !== null && (typeof value !== 'string' || !value.trim() || value.length > 200)) || [input.sourceIds, input.memoryIds].some(ids => ids !== undefined && (!Array.isArray(ids) || ids.length > 10 || ids.some(value => typeof value !== 'string' || !value.trim() || value.length > 200) || new Set(ids).size !== ids.length))) throw new Error('選択する会話データを確認してください')
}
async function preparedContext(input: CoachTurnInput, current: Settings) {
  const prepared = await selectedContext(input, current), checkInDigests = await Promise.all(prepared.checkInBodies.map(value => Dexie.waitFor(digest(value))))
  let index = 0; for (const ref of prepared.refs) if (ref.kind === 'goal-checkin') ref.digest = checkInDigests[index++]
  return prepared
}
async function contextDigest(prepared: Awaited<ReturnType<typeof preparedContext>>, current: Settings) { return Dexie.waitFor(digest(JSON.stringify([prepared.context, prepared.refs, current.profileId, current.datasetId, changePolicyFor(current).epoch, current.aiModel ?? null]))) }
export async function previewCoachTurnContext(input: Omit<CoachTurnInput, 'text'>): Promise<{ context: string | null; sources: ChatSourceRef[]; digest: string; withheldQuotes: number; notesWithheld: boolean }> {
  validateSelections(input)
  const current = await settings(); if (input.mode === 'ai') { if (!current.aiEnabled) throw new Error('AIは停止中です'); modelId(current.aiModel) }
  const prepared = await preparedContext({ ...input, text: '' }, current)
  return { context: prepared.context, sources: prepared.refs, digest: await contextDigest(prepared, current), withheldQuotes: prepared.taskEgress?.withheldQuotes ?? 0, notesWithheld: prepared.taskEgress?.notesWithheld ?? false }
}

export async function beginCoachTurn(id: string, expectedRevision: number, input: CoachTurnInput): Promise<CoachTurn> {
  text(input?.text); revision(expectedRevision)
  validateSelections(input)
  await purgeExpiredSources(); await purgeExpiredMemories(); await purgeExpiredConversations()
  if (input.mode === 'ai' && input.text.length > 6000) throw new Error('AIへの送信文は6000文字までです。本人の下書きは10000文字まで保存できます')
  const initial = await settings()
  if (input.mode === 'ai') { if (!initial.aiEnabled) throw new Error('AIは停止中です。本人の下書きは保存できます'); modelId(initial.aiModel) }
  const prepared = await preparedContext(input, initial)
  if (input.expectedContextDigest !== undefined && input.expectedContextDigest !== await contextDigest(prepared, initial)) throw new ConflictError()
  const turn = await db.transaction('rw', tables(), async () => {
    const current = await settings(), row = await conversation(id, current.profileId), policy = changePolicyFor(current)
    if (current.profileId !== initial.profileId || current.datasetId !== initial.datasetId || current.aiEnabled !== initial.aiEnabled || current.aiModel !== initial.aiModel || policy.epoch !== changePolicyFor(initial).epoch || row.revision !== expectedRevision) throw new ConflictError()
    if (row.pendingMessageId) throw new Error('前の応答を待っています。中断してから再送してください')
    const fresh = await preparedContext(input, current)
    if (fresh.context !== prepared.context || JSON.stringify(fresh.checkInBodies) !== JSON.stringify(prepared.checkInBodies)) throw new ConflictError()
    if (!sameRefs(fresh.refs, prepared.refs)) throw new ConflictError()
    const messages = await db.coachMessages.where('conversationId').equals(id).toArray()
    if (messages.length >= 9999 || await db.coachMessages.where('ownerId').equals(current.profileId).count() >= 99999) throw new Error('会話メッセージの保存上限に達しています')
    const sequence = Math.max(0, ...messages.map(message => message.sequence)) + 1, userMessageId = uid(), at = timestamp(row.updatedAt)
    await db.coachMessages.add({ id: userMessageId, conversationId: id, ownerId: current.profileId, sequence, role: 'user', origin: 'human', text: input.text, model: null, provider: null, replyTo: null, selectedSources: prepared.refs, policyEpoch: null, sourcePermissionRevision: null, createdAt: at })
    // Clear only the submitted draft. A newer/different draft remains available.
    const clearDraft = row.draft === input.text
    await db.coachConversations.put({ ...row, revision: nextRevision(row.revision), ...(clearDraft ? { draft: '', draftRevision: nextRevision(row.draftRevision) } : {}), pendingMessageId: userMessageId, updatedAt: at })
    if (input.mode === 'ai' && fresh.taskEgress && input.taskId) await recordEgressAudit({ kind: 'ai-model', route: 'coach-chat', model: current.aiModel ?? null }, [{ taskId: input.taskId, egress: fresh.taskEgress }])
    return { conversationId: id, userMessageId, ownerId: current.profileId, datasetId: current.datasetId, mode: input.mode, model: input.mode === 'ai' ? current.aiModel! : null, policyEpoch: policy.epoch, sourcePermissionRevision: policy.sourcePermissionRevision, selectedSources: prepared.refs, selectedContext: prepared.context }
  })
  activeTurns.set(turn.userMessageId, JSON.stringify(turn))
  return turn
}

async function referencesCurrent(refs: ChatSourceRef[], current: Settings, model: string | null): Promise<boolean> {
  for (const ref of refs) {
    if (ref.kind === 'task') { const task = await db.tasks.get(ref.id); if (!task || task.deletedAt || task.revision !== ref.revision) return false }
    else if (ref.kind === 'goal') { const goal = await db.goals.get(ref.id); if (!goal || goal.deletedAt || goal.ownerId !== current.profileId || goal.revision !== ref.revision) return false }
    else if (ref.kind === 'goal-checkin') {
      const item = await db.goalCheckIns.get(ref.id), goal = item ? await db.goals.get(item.goalId) : null
      if (!item || item.deletedAt || !goal || goal.deletedAt || goal.ownerId !== current.profileId || Math.max(1, item.summaryRevision) !== ref.revision || await Dexie.waitFor(digest(JSON.stringify([item.answer, item.summary, item.summaryRevision, item.updatedAt]))) !== ref.digest) return false
    } else if (ref.kind === 'memory') {
      try { const present = await memoryForSelectedChat(ref.id, current.profileId, model); if (present.memory.revision !== ref.revision || present.digest !== ref.digest) return false } catch { return false }
    } else {
      const source = await db.contextSources.get(ref.id), snapshot = source ? await db.contextSnapshots.get(`${source.id}:${source.latestRevision}`) : null
      if (!source || source.deletedAt || source.ownerId !== current.profileId || source.retentionUntil !== null && Date.parse(source.retentionUntil) <= Date.now() || !source.permissions.acquire || !source.permissions.retain || !source.permissions.index || source.latestRevision !== ref.revision || source.permissionRevision !== ref.permissionRevision || !snapshot || snapshot.ownerId !== current.profileId || snapshot.sha256 !== ref.digest || model !== null && (!source.permissions.aiEgress || !source.allowedModels.includes(model))) return false
    }
  }
  return true
}

export async function appendCoachReply(turn: CoachTurn, value: string, origin: 'live_ai' | 'template' | 'notice'): Promise<string> {
  text(value)
  await purgeExpiredSources(); await purgeExpiredMemories(); await purgeExpiredConversations()
  if (!turn || activeTurns.get(turn.userMessageId) !== JSON.stringify(turn)) throw new ConflictError()
  if (!['live_ai', 'template', 'notice'].includes(origin) || origin === 'live_ai' && (turn.mode !== 'ai' || !turn.model)) throw new Error('会話の生成種別を確認してください')
  const result = await db.transaction('rw', tables(), async () => {
    const current = await settings(), row = await conversation(turn.conversationId, current.profileId), policy = changePolicyFor(current), user = await db.coachMessages.get(turn.userMessageId)
    if (current.profileId !== turn.ownerId || current.datasetId !== turn.datasetId || row.pendingMessageId !== turn.userMessageId || !user || user.ownerId !== current.profileId || user.role !== 'user' || user.conversationId !== row.id || !sameRefs(user.selectedSources, turn.selectedSources)) throw new ConflictError()
    if (origin !== 'notice' && (!await referencesCurrent(turn.selectedSources, current, origin === 'live_ai' ? turn.model : null) || origin === 'live_ai' && (!current.aiEnabled || current.aiModel !== turn.model || policy.epoch !== turn.policyEpoch || policy.sourcePermissionRevision !== turn.sourcePermissionRevision))) throw new ConflictError()
    const messages = await db.coachMessages.where('conversationId').equals(row.id).toArray(), id = uid(), at = timestamp(row.updatedAt)
    if (messages.some(message => message.replyTo === turn.userMessageId)) throw new ConflictError()
    await db.coachMessages.add({ id, conversationId: row.id, ownerId: current.profileId, sequence: Math.max(0, ...messages.map(message => message.sequence)) + 1, role: 'assistant', origin, text: value, model: origin === 'live_ai' ? turn.model : null, provider: origin === 'live_ai' ? 'openrouter' : null, replyTo: user.id, selectedSources: origin === 'notice' ? [] : turn.selectedSources, policyEpoch: origin === 'live_ai' ? turn.policyEpoch : null, sourcePermissionRevision: origin === 'live_ai' ? turn.sourcePermissionRevision : null, createdAt: at })
    await db.coachConversations.put({ ...row, revision: nextRevision(row.revision), pendingMessageId: null, updatedAt: at })
    return id
  })
  activeTurns.delete(turn.userMessageId)
  return result
}

export async function cancelCoachTurn(id: string, pendingMessageId: string): Promise<void> {
  await db.transaction('rw', db.coachConversations, db.settings, async () => { const current = await settings(), row = await conversation(id, current.profileId); if (row.pendingMessageId !== pendingMessageId) throw new ConflictError(); await db.coachConversations.put({ ...row, pendingMessageId: null, revision: nextRevision(row.revision), updatedAt: timestamp(row.updatedAt) }) })
  activeTurns.delete(pendingMessageId)
}

export async function readCoachConversation(id: string): Promise<{ conversation: CoachConversation; messages: CoachMessage[] }> {
  return db.transaction('r', tables(), async () => {
    const current = await settings(), row = await conversation(id, current.profileId)
    const messages = (await db.coachMessages.where('conversationId').equals(id).toArray()).filter(message => message.ownerId === current.profileId).sort((a, b) => a.sequence - b.sequence)
    const visible: CoachMessage[] = []
    for (const message of messages) {
      // Historic task edits do not erase conversations. Library consent revocation does.
      const library = message.selectedSources.filter(ref => ref.kind === 'library' || ref.kind === 'memory')
      if (message.role === 'user' || !library.length || await referencesCurrent(library, current, message.origin === 'live_ai' ? message.model : null)) visible.push(message)
    }
    return { conversation: row, messages: visible }
  })
}

export async function deleteCoachConversation(id: string, expectedRevision: number): Promise<void> {
  revision(expectedRevision)
  const pending = await db.transaction('rw', db.coachConversations, db.coachMessages, db.settings, async () => { const current = await settings(), row = await conversation(id, current.profileId); if (row.revision !== expectedRevision) throw new ConflictError(); const at = timestamp(row.updatedAt); await db.coachMessages.where('conversationId').equals(id).delete(); await db.coachConversations.put({ ...row, title: '削除した会話', draft: '', draftRevision: nextRevision(row.draftRevision), pendingMessageId: null, revision: nextRevision(row.revision), deletedAt: at, updatedAt: at }); return row.pendingMessageId })
  if (pending) activeTurns.delete(pending)
}

// Called inside the source library's transaction, which includes both chat tables.
export async function purgeChatSourceResponses(sourceId: string, ownerId: string): Promise<number> {
  const messages = await db.coachMessages.where('ownerId').equals(ownerId).toArray(), affected = new Set<string>()
  let removed = 0
  const sourceMemoryIds = new Set((await db.coachMemories.where('ownerId').equals(ownerId).toArray()).filter(memory => memory.sources.some(ref => ref.kind === 'library' && ref.refId === sourceId || ref.kind === 'derived-summary' && ref.refId === `library:${sourceId}`)).map(memory => memory.id))
  for (const message of messages) if (message.selectedSources.some(ref => ref.kind === 'library' && ref.id === sourceId || ref.kind === 'memory' && sourceMemoryIds.has(ref.id))) {
    const row = await db.coachConversations.get(message.conversationId)
    if (!row || row.ownerId !== ownerId || row.deletedAt) continue
    if (message.role === 'assistant') { await db.coachMessages.delete(message.id); affected.add(row.id); removed++ }
    if (row.pendingMessageId === message.id) { await db.coachConversations.put({ ...row, pendingMessageId: null }); activeTurns.delete(message.id); affected.add(row.id) }
  }
  for (const id of affected) { const row = (await db.coachConversations.get(id))!; await db.coachConversations.put({ ...row, revision: nextRevision(row.revision), updatedAt: timestamp(row.updatedAt) }) }
  return removed
}

export async function purgeChatMemoryResponses(memoryId: string, ownerId: string): Promise<void> {
  const messages = await db.coachMessages.where('ownerId').equals(ownerId).toArray(), affected = new Set<string>()
  for (const message of messages) if (message.selectedSources.some(ref => ref.kind === 'memory' && ref.id === memoryId)) {
    const row = await db.coachConversations.get(message.conversationId); if (!row || row.ownerId !== ownerId || row.deletedAt) continue
    if (message.role === 'assistant') { await db.coachMessages.delete(message.id); affected.add(row.id) }
    if (row.pendingMessageId === message.id) { await db.coachConversations.put({ ...row, pendingMessageId: null }); activeTurns.delete(message.id); affected.add(row.id) }
  }
  for (const id of affected) { const row = (await db.coachConversations.get(id))!; await db.coachConversations.put({ ...row, revision: nextRevision(row.revision), updatedAt: timestamp(row.updatedAt) }) }
}

export async function searchCoachHistory(query: string, fromDate: string, toDate: string): Promise<{ hits: { conversation: CoachConversation; message: CoachMessage; start: number; end: number; quote: string }[]; coverage: { fromDate: string; toDate: string; complete: false } | null; notice: string }> {
  if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('検索語は1〜200文字で指定してください')
  validateDate(fromDate, '検索開始日'); validateDate(toDate, '検索終了日'); if (!fromDate || !toDate || fromDate > toDate) throw new Error('検索期間を確認してください')
  const current = await settings(), rows = (await db.coachConversations.where('ownerId').equals(current.profileId).toArray()).filter(row => !row.deletedAt && (!row.retentionUntil || Date.parse(row.retentionUntil) > Date.now())), hits: { conversation: CoachConversation; message: CoachMessage; start: number; end: number; quote: string }[] = []
  const dates: string[] = [], term = query.trim()
  for (const row of rows) {
    const { messages } = await readCoachConversation(row.id)
    for (const message of messages) {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: row.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(message.createdAt)), date = `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}-${parts.find(part => part.type === 'day')!.value}`
      dates.push(date)
      if (date < fromDate || date > toDate || hits.length >= 100) continue
      const start = message.text.indexOf(term)
      if (start >= 0) hits.push({ conversation: row, message, start, end: start + term.length, quote: message.text.slice(start, start + term.length) })
    }
  }
  dates.sort()
  return { hits, coverage: dates.length ? { fromDate: dates[0], toDate: dates[dates.length - 1], complete: false } : null, notice: 'この端末に保存した会話だけのキーワード検索です。未保存・削除した会話、外部サービスの未取得期間は確認していません。' }
}

export async function setConversationRetention(id: string, expectedRevision: number, retentionUntil: string | null): Promise<void> {
  if (retentionUntil !== null && (typeof retentionUntil !== 'string' || !Number.isFinite(Date.parse(retentionUntil)) || new Date(retentionUntil).toISOString() !== retentionUntil || Date.parse(retentionUntil) <= Date.now())) throw new Error('会話の保持期限は未来の日時で指定してください')
  await db.transaction('rw', db.coachConversations, db.settings, async () => { const current = await settings(), row = await conversation(id, current.profileId); if (row.revision !== expectedRevision) throw new ConflictError(); await db.coachConversations.put({ ...row, retentionUntil, revision: nextRevision(row.revision), updatedAt: timestamp(row.updatedAt) }) })
}
export async function purgeExpiredConversations(): Promise<number> {
  return db.transaction('rw', db.coachConversations, db.coachMessages, db.settings, async () => {
    const current = await settings(), rows = await db.coachConversations.where('ownerId').equals(current.profileId).toArray(); let count = 0
    for (const row of rows) if (!row.deletedAt && row.retentionUntil && Date.parse(row.retentionUntil) <= Date.now()) {
      const at = timestamp(row.updatedAt); await db.coachMessages.where('conversationId').equals(row.id).delete(); if (row.pendingMessageId) activeTurns.delete(row.pendingMessageId)
      await db.coachConversations.put({ ...row, title: '削除した会話', draft: '', draftRevision: nextRevision(row.draftRevision), pendingMessageId: null, revision: nextRevision(row.revision), deletedAt: at, updatedAt: at }); count++
    }
    return count
  })
}
