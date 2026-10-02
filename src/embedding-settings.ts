import type { EmbeddingSettings } from './domain'

/** Mirrors electron/embedding.cjs: only an http IP-literal loopback endpoint with an explicit port; never a DNS name. */
export function loopbackEmbeddingEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 300) return false
  let url: URL
  try { url = new URL(value) } catch { return false }
  return url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && Boolean(url.port) && !url.username && !url.password && !url.search && !url.hash
}
export function validateEmbeddingSettings(value: unknown): asserts value is EmbeddingSettings {
  const row = value as Record<string, unknown>
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 3 || row.provider !== 'loopback-openai-compatible' || !loopbackEmbeddingEndpoint(row.endpoint) || typeof row.model !== 'string' || !/^[\w~./:-]{1,120}$/.test(row.model)) throw new Error('埋め込みサービスの設定は http://127.0.0.1 または http://[::1] のポート付きアドレスとモデル名だけにしてください')
}
