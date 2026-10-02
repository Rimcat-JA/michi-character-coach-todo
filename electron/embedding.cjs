// Loopback-only embedding fetch for hybrid search (K03-G1). The renderer never
// contacts an embedding model directly: this module POSTs to an IP-literal
// loopback endpoint (127.0.0.1 or ::1, no DNS, no redirect, no API key) with
// one request at a time, bounded inputs and a strictly validated reply.
let running = false;

function fail(message) { throw new Error(message); }

function assertLoopbackBase(value) {
  if (typeof value !== 'string' || !value) fail('埋め込みサービスのURLを確認してください');
  let url = null;
  try { url = new URL(value); } catch { fail('埋め込みサービスのURLを確認してください'); }
  if (url.protocol !== 'http:') fail('埋め込みサービスはhttpのloopbackだけを使います');
  if (url.username || url.password) fail('埋め込みサービスのURLに認証情報を入れられません');
  const host = url.hostname.toLowerCase();
  // URL normalizes [::1] to ::1; 0.0.0.0, link-local and DNS names are refused.
  if (host !== '127.0.0.1' && host !== '[::1]') fail('埋め込みサービスは127.0.0.1か[::1]だけを使います');
  if (url.search || url.hash) fail('埋め込みサービスのURLを確認してください');
  if (!url.port) fail('埋め込みサービスのポートを指定してください');
  return `${url.protocol}//${url.host}`;
}

function assertInputs(inputs) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 64) fail('埋め込みの入力は1〜64件にしてください');
  let total = 0;
  for (const text of inputs) {
    if (typeof text !== 'string' || !text.trim() || text.length > 32000) fail('埋め込みの入力は1〜32000文字にしてください');
    total += text.length;
  }
  if (total > 32000) fail('埋め込みは1回32,000文字以内にしてください');
}

function assertReply(body, count) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.data) || body.data.length !== count) fail('埋め込みの応答が不正です');
  const dims = body.data[0]?.embedding?.length;
  if (!Number.isSafeInteger(dims) || dims < 1 || dims > 4096) fail('埋め込みの次元が不正です');
  for (const row of body.data) {
    if (!row || typeof row !== 'object' || !Array.isArray(row.embedding) || row.embedding.length !== dims || row.embedding.some(value => typeof value !== 'number' || !Number.isFinite(value))) fail('埋め込みの応答が不正です');
  }
  return dims;
}

/** POSTs {model, input} once. Throws on any validation, network or timeout failure. */
async function fetchEmbeddings({ endpoint, model, inputs }, fetchImpl = globalThis.fetch) {
  const base = assertLoopbackBase(endpoint);
  if (typeof model !== 'string' || !model.trim() || model.length > 120) fail('埋め込みモデルを確認してください');
  assertInputs(inputs);
  if (running) fail('埋め込みは1件ずつ実行します。終わってから再実行してください');
  running = true;
  try {
    const response = await fetchImpl(`${base}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: inputs }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) fail(`埋め込みサービスが応答しませんでした (${response.status})`);
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > 8 * 1024 * 1024) fail('埋め込みの応答が大きすぎます');
    const reader = response.body.getReader();
    const parts = []; let size = 0;
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 8 * 1024 * 1024) { await reader.cancel(); fail('埋め込みの応答が大きすぎます'); } parts.push(Buffer.from(value)); } } finally { reader.releaseLock(); }
    const text = Buffer.concat(parts).toString('utf8');
    let body = null;
    try { body = JSON.parse(text); } catch { fail('埋め込みの応答が不正です'); }
    const dims = assertReply(body, inputs.length);
    if (body.data.some(row => !Number.isSafeInteger(row.index) || row.index < 0 || row.index >= inputs.length) || new Set(body.data.map(row => row.index)).size !== inputs.length) fail('埋め込みの入力番号が不正です');
    return { dims, vectors: [...body.data].sort((a, b) => a.index - b.index).map(row => row.embedding) };
  } finally { running = false; }
}

module.exports = { assertLoopbackBase, fetchEmbeddings };
