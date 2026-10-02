import { db } from './db'
import { searchSources } from './source-library'
import { spanLocation } from './source-library'
import { readCoachConversation, searchCoachHistory } from './chat-history'
import { changePolicyFor } from './change-set'
import { validateDate } from './domain'

export type LocalRetrievalHit = { kind: 'library' | 'conversation'; id: string; documentId: string; revision: number; title: string; provider: string; date: string; author: string; quote: string; start: number; end: number; digest: string | null; location?: string | null }
export type LocalRetrievalResult = { ownerId: string; datasetId: string; engine: 'lexical'; hits: LocalRetrievalHit[]; coverage: { kind: 'library' | 'conversation'; id: string; fromDate: string; toDate: string; complete: false }[]; notice: string }
export async function searchLocalContext(query: string, fromDate: string, toDate: string): Promise<LocalRetrievalResult | null> {
  if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('検索語を1〜200文字で指定してください')
  validateDate(fromDate, '開始日'); validateDate(toDate, '終了日'); if (!fromDate || !toDate || fromDate > toDate) throw new Error('検索期間を確認してください')
  const settings = await db.settings.get('main'); if (!settings) throw new Error('本人の設定がありません')
  // Queries are read-only; expired rows are excluded before quotes are returned.
  const library = await searchSources(query, fromDate, toDate), conversation = await searchCoachHistory(query, fromDate, toDate)
  const hits: LocalRetrievalHit[] = []
  for (const hit of library.hits) { const snapshot = await db.contextSnapshots.get(`${hit.source.id}:${hit.snapshotRevision}`); if (snapshot) hits.push({ kind: 'library', id: hit.span.id, documentId: hit.source.id, revision: hit.snapshotRevision, title: hit.source.title, provider: hit.source.provider, date: hit.source.date, author: hit.source.author ?? '不明（取込時に未指定）', quote: hit.span.text, start: hit.span.start, end: hit.span.end, digest: snapshot.sha256, location: spanLocation(snapshot, hit.span.id) }) }
  for (const hit of conversation.hits) hits.push({ kind: 'conversation', id: hit.message.id, documentId: hit.conversation.id, revision: hit.message.sequence, title: hit.conversation.title, provider: 'この端末のコーチ会話', date: hit.message.createdAt, author: hit.message.role === 'user' ? '本人' : hit.message.origin === 'live_ai' ? `AI (${hit.message.model})` : '端末内の定型応答/状況', quote: hit.quote, start: hit.start, end: hit.end, digest: null })
  const result: LocalRetrievalResult = { ownerId: settings.profileId, datasetId: settings.datasetId, engine: 'lexical', hits, coverage: [...library.coverage.map(item => ({ kind: 'library' as const, id: item.sourceId, fromDate: item.fromDate, toDate: item.toDate, complete: false as const })), ...(conversation.coverage ? [{ kind: 'conversation' as const, id: 'local-conversations', ...conversation.coverage }] : [])], notice: '端末内の資料と保存したコーチ会話を文字で検索しました。意味検索・vector検索は未提供です。検索結果だけで外部の全履歴確認済みとは言えません。資料は取得範囲と指定期間が重なるものを対象とし、行ごとの発言日時は未解析です。未取得・未保存・削除した期間は確認していません。' }
  return refreshLocalRetrieval(result)
}

export async function refreshLocalRetrieval(result: LocalRetrievalResult): Promise<LocalRetrievalResult | null> {
  let settings = await db.settings.get('main'); if (!settings || settings.profileId !== result.ownerId || settings.datasetId !== result.datasetId) return null
  settings = await db.settings.get('main'); if (!settings || settings.profileId !== result.ownerId || settings.datasetId !== result.datasetId) return null
  const accepted: LocalRetrievalHit[] = []
  for (const hit of result.hits) {
    if (hit.kind === 'library') {
      const source = await db.contextSources.get(hit.documentId), snapshot = await db.contextSnapshots.get(`${hit.documentId}:${hit.revision}`)
      if (!source || source.ownerId !== result.ownerId || source.deletedAt || source.retentionUntil !== null && Date.parse(source.retentionUntil) <= Date.now() || !source.permissions.acquire || !source.permissions.retain || !source.permissions.index || source.latestRevision !== hit.revision || !snapshot || snapshot.ownerId !== result.ownerId || snapshot.sha256 !== hit.digest || snapshot.text.slice(hit.start, hit.end) !== hit.quote) continue
      accepted.push(hit)
    } else {
      try { const current = await readCoachConversation(hit.documentId), message = current.messages.find(row => row.id === hit.id); if (message && message.sequence === hit.revision && message.text.slice(hit.start, hit.end) === hit.quote) accepted.push(hit) } catch { /* Deleted/expired/unauthorized conversation is excluded. */ }
    }
  }
  // Coverage also observes current ACL even when there were no matching quotes.
  const coverage: LocalRetrievalResult['coverage'] = []
  for (const range of result.coverage) {
    if (range.kind === 'library') {
      const source = await db.contextSources.get(range.id)
      if (source?.ownerId === result.ownerId && !source.deletedAt && source.permissions.acquire && source.permissions.retain && source.permissions.index && (source.retentionUntil === null || Date.parse(source.retentionUntil) > Date.now())) coverage.push(range)
    } else if (accepted.some(hit => hit.kind === 'conversation')) coverage.push(range)
  }
  const latest = await db.settings.get('main')
  if (!latest || latest.profileId !== result.ownerId || latest.datasetId !== result.datasetId || changePolicyFor(latest).epoch !== changePolicyFor(settings).epoch) return null
  return { ...result, hits: accepted.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 200), coverage }
}
