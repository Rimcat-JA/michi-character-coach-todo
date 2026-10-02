// Node tests for electron/embedding.cjs: loopback-only fetching with strict
// validation. A same-process server is fine here (no spawnSync deadlock:
// everything awaits on the loop).
import { deepStrictEqual, equal, match, ok } from 'node:assert';
import { createServer } from 'node:http';
import test from 'node:test';
import { fetchEmbeddings } from './embedding.cjs';

const vectors = (dims, count, start = 0) => Array.from({ length: count }, (_, index) => Array.from({ length: dims }, (_, dim) => (start + index + dim) / 100));

function serverFor(handler) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => handler(req, body, res));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}
const reply = (res, payload, status = 200, raw = false) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(raw ? payload : JSON.stringify(payload));
};
const base = server => `http://127.0.0.1:${server.address().port}`;

test('loopback fixture returns bounded vectors without an API key', async () => {
  let seen = null;
  const server = await serverFor((req, body, res) => {
    seen = { url: req.url, auth: req.headers.authorization ?? null, body: JSON.parse(body) };
    reply(res, { data: vectors(4, 2).map((embedding, index) => ({ embedding, index })) });
  });
  try {
    const result = await fetchEmbeddings({ endpoint: base(server), model: 'fixture', inputs: ['見積書を送る', '勤怠を提出する'] });
    equal(result.dims, 4);
    deepStrictEqual(result.vectors, vectors(4, 2));
    equal(seen.url, '/v1/embeddings');
    equal(seen.auth, null);
    deepStrictEqual(seen.body, { model: 'fixture', input: ['見積書を送る', '勤怠を提出する'] });
  } finally { server.close(); }
});

test('DNS names, https, 0.0.0.0, link-local, credentials and redirects are refused', async () => {
  for (const endpoint of ['https://127.0.0.1:9', 'http://localhost:9', 'http://example.com:9', 'http://0.0.0.0:9', 'http://169.254.169.254:9', 'http://user:pass@127.0.0.1:9', 'http://127.0.0.1', '']) {
    await fetchEmbeddings({ endpoint, model: 'm', inputs: ['x'] }).then(() => { throw new Error(`accepted ${endpoint}`); }, error => ok(String(error?.message ?? error).length > 0));
  }
  const redirector = await serverFor((req, body, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); });
  try {
    await fetchEmbeddings({ endpoint: base(redirector), model: 'm', inputs: ['x'] }).then(() => { throw new Error('followed redirect'); }, error => match(String(error?.message ?? error), /./));
  } finally { redirector.close(); }
});

test('oversized, NaN, mismatched-dimension and count replies are refused', async () => {
  const bad = [
    { payload: { data: [{ embedding: [Number.NaN, 0], index: 0 }] }, inputs: ['x'] },
    { payload: { data: [{ embedding: [1], index: 0 }, { embedding: [1, 2], index: 1 }] }, inputs: ['x', 'y'] },
    { payload: { data: [] }, inputs: ['x'] },
    { payload: { data: [{ embedding: Array.from({ length: 5000 }, () => 0), index: 0 }] }, inputs: ['x'] },
  ];
  for (const { payload, inputs } of bad) {
    const server = await serverFor((req, body, res) => reply(res, payload));
    try {
      await fetchEmbeddings({ endpoint: base(server), model: 'm', inputs }).then(() => { throw new Error(`accepted ${JSON.stringify(payload).slice(0, 60)}`); }, () => {});
    } finally { server.close(); }
  }
  const big = await serverFor((req, body, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(9 * 1024 * 1024) });
    res.end('{}');
  });
  try {
    await fetchEmbeddings({ endpoint: base(big), model: 'm', inputs: ['x'] }).then(() => { throw new Error('accepted oversized'); }, () => {});
  } finally { big.close(); }
});

test('inputs are bounded and concurrent calls are refused', async () => {
  const server = await serverFor((req, body, res) => reply(res, { data: [{ embedding: [1], index: 0 }] }));
  try {
    const endpoint = base(server);
    await fetchEmbeddings({ endpoint, model: 'm', inputs: [] }).then(() => { throw new Error('accepted empty'); }, () => {});
    await fetchEmbeddings({ endpoint, model: 'm', inputs: Array.from({ length: 65 }, () => 'x') }).then(() => { throw new Error('accepted 65'); }, () => {});
    await fetchEmbeddings({ endpoint, model: 'm', inputs: ['x'.repeat(32001)] }).then(() => { throw new Error('accepted long'); }, () => {});
    const slow = await serverFor((req, body, res) => setTimeout(() => reply(res, { data: [{ embedding: [1], index: 0 }] }), 300));
    try {
      const first = fetchEmbeddings({ endpoint: base(slow), model: 'm', inputs: ['x'] });
      await fetchEmbeddings({ endpoint: base(slow), model: 'm', inputs: ['y'] }).then(() => { throw new Error('accepted concurrent'); }, error => match(String(error?.message ?? error), /1件ずつ/));
      await first;
    } finally { slow.close(); }
  } finally { server.close(); }
});

