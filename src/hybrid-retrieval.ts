import { db } from './db'
import { refreshLocalRetrieval, searchLocalContext, type LocalRetrievalHit, type LocalRetrievalResult } from './local-retrieval'
import { changePolicyFor } from './change-set'
import { validateEmbeddingSettings } from './embedding-settings'
import { assertSourceProcessingActive } from './source-processing-guard'
import { spanLocation, type ContextSource, type ContextSnapshot } from './source-library'
import type { Settings } from './domain'

export type HybridHit = LocalRetrievalHit & { matchedBy: 'lexical' | 'vector' | 'both'; rankScore: number }
export type HybridResult = Omit<LocalRetrievalResult, 'engine' | 'hits'> & { engine: 'lexical' | 'hybrid'; hits: HybridHit[]; indexStates: { title: string; state: 'fresh' | 'stale' | 'missing' }[] }
export type EmbedFn = (inputs: string[]) => Promise<number[][]>
export type EmbeddingArtifactPayload = {
  v: 1; model: string; endpoint: string; dims: number; snapshotRevision: number; snapshotSha256: string;
  permissionRevision: number; sourcePermissionRevision: number;
  windows: { spanIds: string[]; vec: string; scale: number }[]
}
const canRead = (source: ContextSource, owner: string) => source.ownerId === owner && !source.deletedAt && (!source.retentionUntil || Date.parse(source.retentionUntil) > Date.now()) && source.permissions.acquire && source.permissions.retain && source.permissions.index
export const normalizeKana = (text: string) => text.normalize('NFKC').replace(/[ァ-ヶ]/g, char => String.fromCharCode(char.charCodeAt(0) - 0x60))
export function bigramDice(query: string, text: string) {
  const grams = (value: string) => { const t = normalizeKana(value), out = new Set<string>(); for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2)); return out }
  const a = grams(query), b = grams(text)
  return a.size && b.size ? 2 * [...a].filter(value => b.has(value)).length / (a.size + b.size) : 0
}
export function quantize(vector: number[]) {
  const scale = Math.max(...vector.map(Math.abs), 1e-9) / 127
  return { vec: btoa(String.fromCharCode(...vector.map(value => Math.round(value / scale) & 255))), scale }
}
export function dequantize(vec: string, scale: number) {
  return [...atob(vec)].map(char => (char.charCodeAt(0) > 127 ? char.charCodeAt(0) - 256 : char.charCodeAt(0)) * scale)
}
function cosine(a: number[], b: number[]) {
  let dot = 0, aa = 0, bb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2 }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0
}
/** A long span produces several windows, so no cited span silently loses its tail. */
export function embeddingWindows(spans: { id: string; text: string }[]) {
  const out: { spanIds: string[]; text: string }[] = []
  for (const span of spans) for (let offset = 0; offset < span.text.length; offset += 600) {
    const text = span.text.slice(offset, offset + 600)
    if (text.trim()) out.push({ spanIds: [span.id], text })
  }
  return out
}
function validVectors(vectors: number[][], count: number) {
  const dims = vectors?.[0]?.length
  if (!Array.isArray(vectors) || vectors.length !== count || !Number.isSafeInteger(dims) || dims < 1 || dims > 4096 || vectors.some(row => !Array.isArray(row) || row.length !== dims || row.some(value => typeof value !== 'number' || !Number.isFinite(value)))) throw new Error('埋め込みの応答が不正です')
  return dims
}
export function bridgeEmbedder(settings: Settings): EmbedFn | null {
  const bridge = typeof window === 'undefined' ? undefined : window.michiAI?.embedTexts
  return settings.embedding && bridge ? async inputs => (await bridge({ endpoint: settings.embedding!.endpoint, model: settings.embedding!.model, inputs })).vectors : null
}
export async function buildSourceEmbeddings(sourceId: string, embed: EmbedFn) {
  await assertSourceProcessingActive()
  const settings = await db.settings.get('main')
  if (!settings?.embedding) throw new Error('意味検索の接続を設定してください')
  validateEmbeddingSettings(settings.embedding)
  const source = await db.contextSources.get(sourceId), snapshot = source && await db.contextSnapshots.get(`${source.id}:${source.latestRevision}`)
  if (!source || !canRead(source, settings.profileId) || !snapshot || snapshot.ownerId !== settings.profileId) throw new Error('索引を作る資料の利用は許可されていません')
  const windows = embeddingWindows(snapshot.spans)
  if (!windows.length) throw new Error('索引にする本文がありません')
  const vectors: number[][] = []
  for (let start = 0; start < windows.length;) {
    let end = start, chars = 0
    while (end < windows.length && end - start < 64 && chars + windows[end].text.length <= 32000) chars += windows[end++].text.length
    await assertSourceProcessingActive()
    const current = await db.contextSources.get(sourceId), now = await db.settings.get('main')
    if (!current || !canRead(current, settings.profileId) || current.revision !== source.revision || !now || now.datasetId !== settings.datasetId || changePolicyFor(now).epoch !== changePolicyFor(settings).epoch) throw new Error('資料の版または設定が変わりました')
    const batch = await embed(windows.slice(start, end).map(item => item.text))
    validVectors(batch, end - start); vectors.push(...batch); start = end
  }
  const dims = validVectors(vectors, windows.length)
  const chunks: EmbeddingArtifactPayload[] = []
  let chunk: EmbeddingArtifactPayload = { v: 1, model: settings.embedding.model, endpoint: settings.embedding.endpoint, dims, snapshotRevision: snapshot.revision, snapshotSha256: snapshot.sha256, permissionRevision: source.permissionRevision, sourcePermissionRevision: changePolicyFor(settings).sourcePermissionRevision, windows: [] }
  for (let i = 0; i < windows.length; i++) {
    const entry = { spanIds: windows[i].spanIds, ...quantize(vectors[i]) }
    if (JSON.stringify({ ...chunk, windows: [...chunk.windows, entry] }).length > 190000) { chunks.push(chunk); chunk = { ...chunk, windows: [] } }
    chunk.windows.push(entry)
  }
  chunks.push(chunk)
  await db.transaction('rw', [db.settings, db.contextSources, db.contextSnapshots, db.sourceArtifacts, db.datasetState], async () => {
    await assertSourceProcessingActive()
    const now = await db.settings.get('main'), current = await db.contextSources.get(sourceId), saved = await db.contextSnapshots.get(snapshot.id)
    if (!now || now.profileId !== settings.profileId || now.datasetId !== settings.datasetId || changePolicyFor(now).epoch !== changePolicyFor(settings).epoch || !current || !canRead(current, settings.profileId) || current.revision !== source.revision || saved?.sha256 !== snapshot.sha256) throw new Error('資料の版または設定が変わりました')
    const old = (await db.sourceArtifacts.where('sourceId').equals(sourceId).toArray()).filter(row => row.kind === 'embedding')
    await db.sourceArtifacts.bulkDelete(old.map(row => row.id))
    await db.sourceArtifacts.bulkPut(chunks.map((payload, i) => ({ id: `embedding:${sourceId}:${snapshot.revision}:${i}`, ownerId: settings.profileId, sourceId, sourceRevision: snapshot.revision, permissionRevision: source.permissionRevision, kind: 'embedding' as const, payload: JSON.stringify(payload), createdAt: new Date().toISOString() })))
  })
  return { windows: windows.length, dims }
}
async function usableArtifacts(source: ContextSource, snapshot: ContextSnapshot, settings: Settings, dims?: number) {
  const rows = (await db.sourceArtifacts.where('sourceId').equals(source.id).toArray()).filter(row => row.kind === 'embedding')
  const windows: EmbeddingArtifactPayload['windows'] = []
  try {
    for (const row of rows) {
      const p = JSON.parse(row.payload) as EmbeddingArtifactPayload
      if (row.ownerId !== settings.profileId || row.sourceRevision !== snapshot.revision || row.permissionRevision !== source.permissionRevision || p.v !== 1 || p.model !== settings.embedding?.model || p.endpoint !== settings.embedding?.endpoint || !Number.isSafeInteger(p.dims) || p.dims < 1 || p.dims > 4096 || dims !== undefined && p.dims !== dims || p.snapshotRevision !== snapshot.revision || p.snapshotSha256 !== snapshot.sha256 || p.permissionRevision !== source.permissionRevision || p.sourcePermissionRevision !== changePolicyFor(settings).sourcePermissionRevision || !Array.isArray(p.windows)) return { state: 'stale' as const, windows: [] }
      for (const w of p.windows) {
        if (!Array.isArray(w.spanIds) || !w.spanIds.length || w.spanIds.some(id => !snapshot.spans.some(span => span.id === id)) || typeof w.vec !== 'string' || !Number.isFinite(w.scale) || w.scale <= 0 || dequantize(w.vec, w.scale).length !== p.dims) return { state: 'stale' as const, windows: [] }
        windows.push(w)
      }
    }
  } catch { return { state: 'stale' as const, windows: [] } }
  return { state: windows.length ? 'fresh' as const : 'missing' as const, windows }
}
export async function refreshHybridRetrieval(result: HybridResult): Promise<HybridResult | null> {
  const current = await refreshLocalRetrieval({ ...result, engine: 'lexical' })
  if (!current) return null
  const settings = await db.settings.get('main')
  if (!settings) return null
  const hits: HybridHit[] = []
  for (const raw of current.hits) {
    const hit = raw as HybridHit
    if (hit.kind === 'library' && hit.matchedBy !== 'lexical') {
      const source = await db.contextSources.get(hit.documentId), snapshot = await db.contextSnapshots.get(`${hit.documentId}:${hit.revision}`)
      if (!source || !snapshot || (await usableArtifacts(source, snapshot, settings)).state !== 'fresh') continue
    }
    hits.push(hit)
  }
  return { ...result, hits: hits.sort((a, b) => b.rankScore - a.rankScore || a.documentId.localeCompare(b.documentId) || a.id.localeCompare(b.id)), coverage: current.coverage }
}
export async function searchHybrid(query: string, fromDate: string, toDate: string, embed: EmbedFn | null): Promise<HybridResult | null> {
  const lexical = await searchLocalContext(query, fromDate, toDate)
  if (!lexical) return null
  const settings = (await db.settings.get('main'))!
  const eligible = (await db.contextSources.where('ownerId').equals(settings.profileId).toArray()).filter(source => canRead(source, settings.profileId) && source.coverage.fromDate <= toDate && source.coverage.toDate >= fromDate)
  let queryVector: number[] | null = null
  if (settings.embedding && embed) try { await assertSourceProcessingActive(); const vectors = await embed([query]); validVectors(vectors, 1); queryVector = vectors[0] } catch { /* Fall back to local text search. */ }
  const lexicalHits = [...lexical.hits].sort((a, b) => bigramDice(query, b.quote) - bigramDice(query, a.quote) || a.documentId.localeCompare(b.documentId) || a.id.localeCompare(b.id))
  const vectorHits: { hit: LocalRetrievalHit; score: number }[] = [], indexStates: HybridResult['indexStates'] = []
  for (const source of eligible) {
    const snapshot = await db.contextSnapshots.get(`${source.id}:${source.latestRevision}`)
    if (!snapshot || snapshot.ownerId !== settings.profileId) continue
    const artifact = await usableArtifacts(source, snapshot, settings, queryVector?.length)
    indexStates.push({ title: source.title, state: artifact.state })
    if (!queryVector || artifact.state !== 'fresh') continue
    const scores = new Map<string, number>()
    for (const w of artifact.windows) { const score = cosine(queryVector, dequantize(w.vec, w.scale)); for (const id of w.spanIds) scores.set(id, Math.max(scores.get(id) ?? -2, score)) }
    for (const [id, score] of scores) {
      const span = snapshot.spans.find(item => item.id === id)!
      vectorHits.push({ score, hit: { kind: 'library', id, documentId: source.id, revision: snapshot.revision, title: source.title, provider: source.provider, date: source.date, author: source.author ?? '未指定', quote: span.text, start: span.start, end: span.end, digest: snapshot.sha256, location: spanLocation(snapshot, id) } })
    }
  }
  vectorHits.sort((a, b) => b.score - a.score || a.hit.id.localeCompare(b.hit.id))
  const fused = new Map<string, HybridHit>(), key = (hit: LocalRetrievalHit) => `${hit.kind}:${hit.documentId}:${hit.id}`
  lexicalHits.forEach((hit, i) => fused.set(key(hit), { ...hit, matchedBy: 'lexical', rankScore: 1 / (61 + i) }))
  vectorHits.forEach(({ hit }, i) => { const old = fused.get(key(hit)); fused.set(key(hit), { ...hit, matchedBy: old ? 'both' : 'vector', rankScore: (old?.rankScore ?? 0) + 1 / (61 + i) }) })
  const engine = queryVector ? 'hybrid' as const : 'lexical' as const
  return refreshHybridRetrieval({ ...lexical, engine, hits: [...fused.values()], indexStates, notice: `資料は${engine === 'hybrid' ? '文字一致と意味の順位を統合' : '文字検索（ベクトル検索は利用できません）'}、コーチ会話は文字検索です。全履歴・未取得期間は未確認です。索引：最新${indexStates.filter(row => row.state === 'fresh').length}、要再作成${indexStates.filter(row => row.state === 'stale').length}、未作成${indexStates.filter(row => row.state === 'missing').length}。` })
}


