// Loopback fixture server for detection-eval offline tests and Windows QA.
// Behavior is selected by a marker in the request text: empty-case -> '',
// over-case -> overproducing output, anything else -> oracle output.
// Usage: node scripts/detection-eval-fixture.mjs [port]  (0 = random; prints READY <port>)
import { createServer } from 'node:http';

const oracleOutput = JSON.stringify({ schema_version: '1', changes: [{ action: 'create', target_task_id: null, expected_revision: null, title: '見積書を送る', assignee_id: 'owner', basis: 'explicit_request', obligation_state: 'requested', change_fields: ['title', 'assignee'], due: { kind: 'none', value: null, timezone: null, raw: null }, recurrence: null, applicability_ref: null, rule_ref: null, evidence: [] }], review_items: [], ignored: [] });
const overOutput = JSON.stringify({ schema_version: '1', changes: [{ action: 'create', target_task_id: null, expected_revision: null, title: '捏造タスク', assignee_id: 'owner', basis: 'explicit_request', obligation_state: 'requested', change_fields: ['title'], due: { kind: 'none', value: null, timezone: null, raw: null }, recurrence: null, applicability_ref: null, rule_ref: null, evidence: [] }], review_items: [], ignored: [] });

const server = createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const content = body.includes('empty-case') ? '' : body.includes('over-case') ? overOutput : oracleOutput;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
const port = Number(process.argv[2] ?? 0);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`READY ${server.address().port}\n`);
});
