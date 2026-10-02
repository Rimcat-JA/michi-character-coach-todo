// Node tests for scripts/detection-eval.mjs. The fixture server runs in a
// separate process (spawnSync blocks this loop, so an in-process server
// could never answer). No real model, no external network.
import { equal, match, ok } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('../scripts/detection-eval.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('../scripts/detection-eval-fixture.mjs', import.meta.url));
const run = args => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });

async function withServer(fn) {
  const child = spawn(process.execPath, [fixture, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let port = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture server did not start')), 15000);
    child.stdout.on('data', chunk => {
      const match = String(chunk).match(/READY (\d+)/);
      if (match) { clearTimeout(timer); port = Number(match[1]); resolve(); }
    });
    child.on('error', reject);
  });
  try { await fn(port); } finally { child.kill(); }
}

const casesFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-'));
  const file = join(dir, 'cases.json');
  writeFileSync(file, JSON.stringify([
    { caseId: 'oracle-case', origin: 'synthetic', messages: [{ role: 'user', content: 'oracle-case text' }] },
    { caseId: 'empty-case', origin: 'synthetic', messages: [{ role: 'user', content: 'empty-case text' }] },
    { caseId: 'over-case', origin: 'synthetic', messages: [{ role: 'user', content: 'over-case text' }] },
  ]));
  return { dir, file, out: join(dir, 'results.jsonl') };
};

test('dry-run records plans with zero requests', async () => {
  // A closed port proves no fetch is attempted at all.
  const { file, out } = casesFile();
  const result = run(['--cases', file, '--endpoint', 'http://127.0.0.1:1', '--model', 'fixture', '--out', out]);
  equal(result.status, 0, result.stderr);
  const lines = readFileSync(out, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  equal(lines.length, 3);
  ok(lines.every(line => line.status === 'dry-run' && line.rawOutput === null && /^[a-f0-9]{64}$/.test(line.promptSha256)));
});

test('loopback --execute records verbatim oracle/empty/overproduce outputs append-only', async () => {
  await withServer(async port => {
    const { file, out } = casesFile();
    const first = run(['--cases', file, '--endpoint', `http://127.0.0.1:${port}`, '--model', 'fixture', '--out', out, '--execute']);
    equal(first.status, 0, first.stderr);
    const second = run(['--cases', file, '--endpoint', `http://127.0.0.1:${port}`, '--model', 'fixture', '--out', out, '--execute']);
    equal(second.status, 0, second.stderr);
    const lines = readFileSync(out, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    equal(lines.length, 6, 'append-only, never overwritten');
    const byId = Object.fromEntries(lines.slice(0, 3).map(line => [line.caseId, line]));
    ok(byId['oracle-case'].rawOutput.includes('見積書を送る'));
    equal(byId['empty-case'].rawOutput, '');
    ok(byId['over-case'].rawOutput.includes('捏造タスク'));
  });
});

test('non-loopback without --execute is refused; unreachable loopback fails once without retry', async () => {
  const { file, out, dir } = casesFile();
  const missing = join(dir, 'never.jsonl');
  const refused = run(['--cases', file, '--endpoint', 'https://example.com', '--model', 'x', '--out', missing]);
  ok(refused.status !== 0, 'refused without --execute');
  ok(!existsSync(missing), 'nothing recorded on refusal');
  await withServer(async () => {
    const unreachable = run(['--cases', file, '--endpoint', 'http://127.0.0.1:1', '--model', 'x', '--out', out, '--execute', '--max-cases', '1']);
    equal(unreachable.status, 0);
    const lines = readFileSync(out, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    equal(lines.length, 1);
    match(lines[0].status, /^error:/);
  });
});
