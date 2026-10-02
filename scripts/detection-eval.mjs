// Offline-first evaluation runner for detection prompts (N04-G5).
// Default is dry-run (no network). Loopback execution needs --execute but no key.
// Any other endpoint needs --execute, a key env var and prints a cost warning.
// No retries. Results are appended (never overwritten) as JSONL with the prompt
// SHA-256, model, case and the verbatim output. Only synthetic regression or
// designated-holdout inputs are accepted; anything else is refused.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

const PROMPT_VERSION = 'detection-eval-prompt/v1';
const promptHash = item => createHash('sha256').update(JSON.stringify({ version: PROMPT_VERSION, messages: item.messages })).digest('hex');

const args = Object.fromEntries(process.argv.slice(2).flatMap((arg, index, all) => {
  if (!arg.startsWith('--')) return [];
  const equal = arg.indexOf('=');
  if (equal !== -1) return [[arg.slice(2, equal), arg.slice(equal + 1)]];
  const next = all[index + 1];
  return [[arg.slice(2), next && !next.startsWith('--') ? next : 'true']];
}).filter(pair => pair.length));

const fail = message => { process.stderr.write(`detection-eval: ${message}\n`); process.exit(1); };
if (args.help) { process.stdout.write(`Usage: node scripts/detection-eval.mjs --cases <file> --endpoint <url> --model <id> --out <jsonl> [--execute] [--key-env VAR] [--max-cases N]\n`); process.exit(0); }
const casesFile = args.cases, endpoint = args.endpoint, model = args.model, out = args.out;
if (!casesFile || !endpoint || !model || !out) fail('missing --cases/--endpoint/--model/--out');
const maxCases = args['max-cases'] === undefined ? Infinity : Number(args['max-cases']);
if (!(maxCases === Infinity || (Number.isSafeInteger(maxCases) && maxCases >= 1))) fail('bad --max-cases');

let cases;
try { cases = JSON.parse(readFileSync(casesFile, 'utf8')); } catch { fail(`cannot read cases ${casesFile}`); }
if (!Array.isArray(cases)) fail('cases file must be a JSON array');
const records = cases.slice(0, maxCases);
for (const item of records) {
  if (!item || typeof item.caseId !== 'string' || !Array.isArray(item.messages) || !item.messages.length) fail(`bad case ${JSON.stringify(item?.caseId)}`);
  // Only synthetic regression or designated-holdout inputs may be evaluated here.
  if (item.origin !== 'synthetic' && !(typeof item.origin === 'string' && item.origin.startsWith('holdout:'))) fail(`refused non-synthetic input ${item.caseId}`);
}

let endpointUrl;
try { endpointUrl = new URL(endpoint); } catch { fail(`bad endpoint ${endpoint}`); }
if (endpointUrl.username || endpointUrl.password) fail('endpoint credentials are refused');
const loopback = (endpointUrl.hostname === '127.0.0.1' || endpointUrl.hostname === '[::1]') && (endpointUrl.protocol === 'http:' || endpointUrl.protocol === 'https:');
const execute = args.execute === 'true' || args.execute === true;
if (!execute && !loopback) fail('this endpoint needs --execute (dry-run is loopback-only; pass --execute with --key-env for real runs, or use dry-run against 127.0.0.1)');
if (!execute) {
  for (const item of records) appendFileSync(out, `${JSON.stringify({ promptVersion: PROMPT_VERSION, promptSha256: promptHash(item), model, caseId: item.caseId, origin: item.origin, status: 'dry-run', rawOutput: null, at: new Date().toISOString() })}\n`);
  process.stdout.write(`dry-run: ${records.length} cases planned, no network use\n`);
  process.exit(0);
}
let key = null;
if (!loopback) {
  const keyEnv = args['key-env'];
  if (!keyEnv) fail('non-loopback execution needs --key-env VAR');
  key = process.env[keyEnv];
  if (!key) fail(`key env ${keyEnv} is empty`);
  process.stderr.write('detection-eval: WARNING: real-model execution may incur API costs and sends case text to the endpoint\n');
}

const post = async item => {
  const response = await fetch(new URL('/v1/chat/completions', endpointUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages: item.messages }),
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`endpoint ${response.status}`);
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
};

let done = 0;
for (const item of records) {
  // No retry: one attempt per case, failures are recorded, not retried.
  let rawOutput = null, status = 'ok';
  try { rawOutput = await post(item); } catch (error) { status = `error:${String(error?.message ?? error).slice(0, 200)}`; }
  appendFileSync(out, `${JSON.stringify({ promptVersion: PROMPT_VERSION, promptSha256: promptHash(item), model, caseId: item.caseId, origin: item.origin, status, rawOutput, at: new Date().toISOString() })}\n`);
  done++;
}
process.stdout.write(`executed: ${done} cases appended to ${out}\n`);
