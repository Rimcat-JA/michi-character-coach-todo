import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { createLocalFileBridge } = require('./local-file-bridge.cjs')
const { createMCPFileClient } = require('./mcp-file-client.cjs')
const { parseTaskEdit } = require('./file-edit-commands.cjs')
async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir()), workspace = await fs.mkdtemp(path.join(temp, 'michi-edit-tests-'))
  t.after(async () => { assert.equal(path.dirname(workspace), temp); assert.ok(path.basename(workspace).startsWith('michi-edit-tests-')); assert.equal(await fs.realpath(workspace), workspace); await fs.rm(workspace, { recursive: true, force: true }) })
  const root = path.join(workspace, crypto.randomUUID()), journal = path.join(workspace, 'private')
  await fs.mkdir(root); await fs.mkdir(journal)
  const task = { id: crypto.randomUUID(), revision: 1, title: '本人のタスク', notes: '保存済みメモ', scheduledDate: '2026-10-02', dueDate: '2026-10-10', score: { mode: 'manual', manualPoints: 25 }, containerId: null }
  const datasetId = crypto.randomUUID(), clientId = path.basename(root), registration = { schema_version: '1', owner_id: 'synthetic-owner', dataset_id: datasetId, policy_epoch: 1, source_permission_revision: 1, task_ids: [task.id], client: { id: clientId, dataset_id: datasetId, intended_host: 'codex', transport: 'stdio', status: 'active', revision: 1, grant_epoch: 1, grant: { keys: ['tasks:read', 'tasks:prepare', 'changes:submit', 'commands:read'], project_ids: [], fields: ['title', 'notes', 'scheduled_date', 'due_date', 'manual_points'], mutation_mode: 'require_approval', max_operations_per_day: 20, max_schedule_shift_days: 7, max_point_delta: 0, allow_external_context: false, allow_handoffs: false, expires_at: new Date(Date.now() + 3600000).toISOString() } } }
  let count = 0, enabled = true; const proof = Object.freeze({})
  const bridge = await createLocalFileBridge({ root, journalDirectory: journal, signingKey: crypto.randomBytes(32), registration, getCurrentContext: async () => ({ ownerId: registration.owner_id, datasetId, clientId, policyEpoch: 1, sourcePermissionRevision: 1, registrationRevision: 1, grantEpoch: 1, enabled }), verifyHumanApproval: async (_binding, value) => value === proof, applyApprovedCommand: async prepared => { count++; Object.assign(task, { scheduledDate: prepared.command.payload.scheduled_date, revision: task.revision + 1 }); return { commandId: prepared.command.command_id, digest: prepared.digest, taskIds: [task.id], appliedAt: new Date().toISOString() } } })
  await bridge.exportSnapshot([task])
  const file = path.join(root, 'edits', 'tasks', `${task.id}.md`), original = await fs.readFile(file, 'utf8'), client = await createMCPFileClient(root)
  return { root, file, original, client, bridge, task, proof, count: () => count, setEnabled: value => enabled = value }
}
test('edit export and real validate/submit CLI lead only to an owner-approved one-time date change', async t => {
  const f = await fixture(t), cli = fileURLToPath(new URL('../scripts/michi-cli.mjs', import.meta.url))
  assert.deepEqual(await f.client.taskEdits(), [])
  await fs.writeFile(f.file, f.original.replace('scheduled_date: "2026-10-02"', 'scheduled_date: "2026-10-04"'))
  for (const mode of ['validate', 'submit', 'submit']) {
    const result = spawnSync(process.execPath, [cli, mode, '--bridge', f.root], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).notApplied, true)
  }
  assert.equal((await fs.readdir(path.join(f.root, 'inbox'))).length, 1); assert.equal(f.count(), 0)
  const entry = (await f.bridge.scanInbox())[0]; assert.deepEqual(entry.prepared.command.payload, { scheduled_date: '2026-10-04' })
  await assert.rejects(f.bridge.execute(entry.prepared, { approved: true }), error => error.code === 'HUMAN_APPROVAL_REQUIRED')
  const result = await f.bridge.execute(entry.prepared, await f.bridge.approve(entry.prepared, f.proof))
  assert.equal(result.state, 'applied'); assert.equal(f.count(), 1); assert.equal(f.task.dueDate, '2026-10-10'); assert.equal(f.task.score.manualPoints, 25)
  const retry = spawnSync(process.execPath, [cli, 'submit', '--bridge', f.root], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(retry.status, 0); assert.equal(JSON.parse(retry.stdout).results[0].replayed, true); assert.equal(f.count(), 1)
  assert.equal((await f.client.result({ commandId: entry.prepared.command.command_id })).record.value.state, 'applied')
})
test('restricted header rejects YAML authority syntax, duplicates, extra keys, multiple documents and invalid UTF-8', async t => {
  const f = await fixture(t)
  for (const line of ['title: !tag hi', 'title: &a hi', 'title: *a', 'title: [x]', 'title: {x: y}', 'title: "ok"\ntitle: "dup"', 'approved: true', 'actor: "owner"', 'title: null']) {
    await fs.writeFile(f.file, f.original.replace(/^title: .*$/m, line)); await assert.rejects(f.client.taskEdits())
  }
  assert.throws(() => parseTaskEdit(f.original + '\n---\ntitle: "second"'))
  assert.throws(() => parseTaskEdit(Buffer.from([0xc0, 0xaf])), error => error.code === 'EDIT_UTF8')
  assert.throws(() => parseTaskEdit('x'.repeat(256 * 1024 + 1)), error => error.code === 'EDIT_TOO_LARGE')
  assert.equal((await fs.readdir(path.join(f.root, 'inbox'))).length, 0)
})
test('readonly due, score, metadata and undisclosed values cannot be changed; omitted fields stay unchanged', async t => {
  const f = await fixture(t)
  for (const [from, to] of [['due: "2026-10-10"', 'due: "2026-10-11"'], ['score: 25', 'score: 36'], ['base_revision: 1', 'base_revision: 2'], ['enabled_fields: "title notes scheduled_date"', 'enabled_fields: "due"']]) {
    await fs.writeFile(f.file, f.original.replace(from, to)); await assert.rejects(f.client.taskEdits())
  }
  await fs.writeFile(f.file, f.original.replace(/^title: .*\n/m, '').replace(/^due: .*\n/m, '').replace(/^score: .*\n/m, '').replace('scheduled_date: "2026-10-02"', 'scheduled_date: null'))
  assert.deepEqual((await f.client.taskEdits())[0].payload, { scheduled_date: null })
})
test('BOM/CRLF header is accepted and missing copies are a no-op', async t => {
  const f = await fixture(t), split = f.original.indexOf('\n---\n') + 5
  await fs.writeFile(f.file, '\uFEFF' + f.original.slice(0, split).replace(/\n/g, '\r\n') + f.original.slice(split))
  assert.deepEqual(await f.client.taskEdits(), [])
  await fs.unlink(f.file); assert.deepEqual(await f.client.taskEdits(), [])
})
test('hardlinked files and redirected edit directories are rejected without publishing', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'alias.md')
  await fs.link(f.file, alias); await assert.rejects(f.client.taskEdits(), error => error.code === 'UNSAFE_LINK'); await fs.unlink(alias)
  const directory = path.dirname(f.file), moved = path.join(f.root, 'old-edits'); await fs.rename(directory, moved)
  await fs.symlink(moved, directory, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.client.taskEdits(), error => error.code === 'UNSAFE_LINK'); assert.equal((await fs.readdir(path.join(f.root, 'inbox'))).length, 0)
})
test('snapshot refresh makes held proposals stale and revocation prevents further edit reads', async t => {
  const f = await fixture(t)
  await fs.writeFile(f.file, f.original.replace('scheduled_date: "2026-10-02"', 'scheduled_date: "2026-10-03"'))
  const held = (await f.client.taskEdits())[0]; await f.bridge.exportSnapshot([f.task])
  await assert.rejects(f.client.proposeUpdate(held), error => error.code === 'PROPOSAL_INVALID')
  await fs.writeFile(f.file, f.original); await assert.rejects(f.client.taskEdits(), error => error.code === 'EDIT_SNAPSHOT_MISMATCH')
  await f.bridge.revoke(); await assert.rejects(f.client.taskEdits(), error => error.code === 'CONNECTION_REVOKED')
})
