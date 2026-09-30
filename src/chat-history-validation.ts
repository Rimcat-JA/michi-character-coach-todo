import type { ChatSourceRef, CoachConversation, CoachMessage } from './chat-history'

function fail(): never { throw new Error('バックアップのコーチ会話が不正です') }
function object(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) fail(); return value as Record<string, unknown> }
const string = (value: unknown, max: number, empty = false): value is string => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0)
const integer = (value: unknown, min = 1): value is number => Number.isSafeInteger(value) && (value as number) >= min
function timestamp(value: unknown): asserts value is string { if (!string(value, 30) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail() }
function sources(value: unknown): ChatSourceRef[] {
  if (!Array.isArray(value) || value.length > 25) fail()
  const ids = new Set<string>()
  for (const raw of value) {
    const row = object(raw, ['kind', 'id', 'revision', 'digest', 'permissionRevision'])
    if (!['task', 'goal', 'goal-checkin', 'library', 'memory'].includes(row.kind as string) || !string(row.id, 200) || !integer(row.revision) || ids.has(`${row.kind}:${row.id}`)) fail()
    if (row.kind === 'library' || row.kind === 'goal-checkin' || row.kind === 'memory') { if (!string(row.digest, 64) || !/^[a-f0-9]{64}$/.test(row.digest)) fail() } else if (row.digest !== null) fail()
    if (row.kind === 'library' ? !integer(row.permissionRevision) : row.permissionRevision !== null) fail()
    ids.add(`${row.kind}:${row.id}`)
  }
  return value as ChatSourceRef[]
}

export function validateChatHistoryRecords(conversations: unknown, messages: unknown, ownerId: string): void {
  if (conversations === undefined && messages === undefined) return
  if (!string(ownerId, 200) || conversations !== undefined && !Array.isArray(conversations) || messages !== undefined && !Array.isArray(messages)) fail()
  const rows = (conversations ?? []) as unknown[], messageRows = (messages ?? []) as unknown[]
  if (rows.length > 10000 || messageRows.length > 100000) fail()
  const byId = new Map<string, CoachConversation>(), messageById = new Map<string, CoachMessage>(), sequences = new Set<string>(), replies = new Set<string>(), counts = new Map<string, number>()
  for (const raw of rows) {
    const row = object(raw, ['id', 'ownerId', 'title', 'timezone', 'revision', 'draft', 'draftRevision', 'pendingMessageId', 'createdAt', 'updatedAt', 'deletedAt'], ['retentionUntil'])
    if (!string(row.id, 200) || byId.has(row.id) || row.ownerId !== ownerId || !string(row.title, 200) || !string(row.timezone, 100) || !integer(row.revision) || !string(row.draft, 10000, true) || !integer(row.draftRevision) || row.pendingMessageId !== null && !string(row.pendingMessageId, 200)) fail()
    try { new Intl.DateTimeFormat('en-CA', { timeZone: row.timezone }) } catch { fail() }
    timestamp(row.createdAt); timestamp(row.updatedAt)
    if (row.retentionUntil !== undefined && row.retentionUntil !== null) timestamp(row.retentionUntil)
    if (row.updatedAt < row.createdAt) fail()
    if (row.deletedAt !== null) { timestamp(row.deletedAt); if (row.deletedAt !== row.updatedAt || row.deletedAt < row.createdAt || row.draft !== '' || row.pendingMessageId !== null || row.title !== '削除した会話') fail() }
    byId.set(row.id, row as CoachConversation)
  }
  for (const raw of messageRows) {
    const row = object(raw, ['id', 'conversationId', 'ownerId', 'sequence', 'role', 'origin', 'text', 'model', 'provider', 'replyTo', 'selectedSources', 'policyEpoch', 'sourcePermissionRevision', 'createdAt'])
    if (!string(row.id, 200) || messageById.has(row.id) || !string(row.conversationId, 200) || row.ownerId !== ownerId || !integer(row.sequence) || !string(row.text, 10000) || !['user', 'assistant'].includes(row.role as string) || !['human', 'live_ai', 'template', 'notice'].includes(row.origin as string)) fail()
    const parent = byId.get(row.conversationId)
    timestamp(row.createdAt)
    if (!parent || parent.deletedAt || row.createdAt < parent.createdAt || row.createdAt > parent.updatedAt || sequences.has(`${parent.id}:${row.sequence}`)) fail()
    sources(row.selectedSources)
    if (row.role === 'user') {
      if (row.origin !== 'human' || row.replyTo !== null || row.model !== null || row.provider !== null || row.policyEpoch !== null || row.sourcePermissionRevision !== null) fail()
    } else {
      if (row.origin === 'human' || !string(row.replyTo, 200) || replies.has(row.replyTo)) fail()
      if (row.origin === 'live_ai') { if (!string(row.model, 120) || !/^[\w~./:-]{3,120}$/.test(row.model) || row.provider !== 'openrouter' || !integer(row.policyEpoch, 0) || !integer(row.sourcePermissionRevision, 0)) fail() }
      else if (row.model !== null || row.provider !== null || row.policyEpoch !== null || row.sourcePermissionRevision !== null || row.origin === 'notice' && (row.selectedSources as unknown[]).length !== 0) fail()
      replies.add(row.replyTo)
    }
    counts.set(parent.id, (counts.get(parent.id) ?? 0) + 1)
    if (counts.get(parent.id)! > 10000) fail()
    sequences.add(`${parent.id}:${row.sequence}`); messageById.set(row.id, row as CoachMessage)
  }
  for (const row of messageById.values()) if (row.role === 'assistant') {
    const user = messageById.get(row.replyTo!)
    if (!user || user.role !== 'user' || user.conversationId !== row.conversationId || user.sequence >= row.sequence || user.createdAt > row.createdAt || row.origin !== 'notice' && JSON.stringify(user.selectedSources) !== JSON.stringify(row.selectedSources)) fail()
  }
  for (const row of byId.values()) if (row.pendingMessageId !== null) {
    const user = messageById.get(row.pendingMessageId)
    if (!user || user.role !== 'user' || user.conversationId !== row.id || replies.has(user.id) || [...messageById.values()].some(message => message.conversationId === row.id && message.sequence > user.sequence)) fail()
  }
}
