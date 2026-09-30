import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createLocalFileBridge, parseEnvelope } = require('./local-file-bridge.cjs')
const future = milliseconds => new Date(Date.now() + milliseconds).toISOString()

async function fixture(callback, overrides = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'michi-filebridge-')), root = path.join(workspace, 'agent'), journalDirectory = path.join(workspace, 'app-private')
  await fs.mkdir(root); await fs.mkdir(journalDirectory)
  const task = { id: randomUUID(), revision: 1, title: '本人の25pt作業', notes: '元のメモ', scheduledDate: '2026-10-01', containerId: null, score: { mode: 'manual', manualPoints: 25 } }
  const registration = { schema_version: '1', owner_id: 'synthetic-owner', dataset_id: randomUUID(), policy_epoch: 5, source_permission_revision: 2, task_ids: [task.id], client: { id: randomUUID(), dataset_id: '', intended_host: 'codex', transport: 'stdio', status: 'active', revision: 1, grant_epoch: 1, grant: { keys: ['tasks:read', 'tasks:prepare', 'changes:submit', 'commands:read'], project_ids: [], fields: ['title', 'notes', 'scheduled_date'], mutation_mode: 'require_approval', max_operations_per_day: 100, max_schedule_shift_days: 31, max_point_delta: 0, allow_external_context: false, allow_handoffs: false, expires_at: future(3600000) } } }
  registration.client.dataset_id = registration.dataset_id
  let context = { ownerId: registration.owner_id, datasetId: registration.dataset_id, clientId: registration.client.id, policyEpoch: registration.policy_epoch, sourcePermissionRevision: registration.source_permission_revision, registrationRevision: registration.client.revision, grantEpoch: registration.client.grant_epoch, enabled: true }, applications = 0
  const proof = Object.freeze({ appIssued: randomUUID() }), signingKey = randomBytes(32)
  const options = { root, journalDirectory, signingKey, registration, getCurrentContext: async () => context, verifyHumanApproval: async (_binding, value) => value === proof, applyApprovedCommand: async prepared => { applications++; if (prepared.command.expected_revision !== task.revision) throw new Error('revision conflict'); if (Object.hasOwn(prepared.command.payload, 'notes')) task.notes = prepared.command.payload.notes; if (Object.hasOwn(prepared.command.payload, 'scheduled_date')) task.scheduledDate = prepared.command.payload.scheduled_date; task.revision++; return { commandId: prepared.command.command_id, digest: prepared.digest, taskIds: [task.id], appliedAt: new Date().toISOString() } }, ...overrides }
  const bridge = await createLocalFileBridge(options), manifest = await bridge.exportSnapshot([task])
  const command = { schema_version: '1', command_id: randomUUID(), snapshot_id: manifest.snapshot_id, expires_at: future(600000), type: 'task.update', target_id: task.id, expected_revision: 1, payload: { notes: '承認後のメモ', scheduled_date: '2026-10-02' } }
  const writeCommand = async (value = command) => { const name = `${value.command_id}.ready.json`; await fs.writeFile(path.join(root, 'inbox', name), JSON.stringify(value)); return name }
  try { await callback({ root, journalDirectory, workspace, bridge, manifest, task, registration, command, writeCommand, proof, options, setContext: value => { context = { ...context, ...value } }, applications: () => applications }) }
  finally {
    // Only delete the exact new temporary workspace created by this test.
    const resolved = path.resolve(workspace)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('michi-filebridge-'))
    assert.equal(await fs.realpath(resolved), resolved)
    await fs.rm(resolved, { recursive: true, force: true })
  }
}

test('snapshot→command→digest-bound app approval→signed result: manual25 remains', async () => fixture(async state => {
  const view = JSON.parse(await fs.readFile(path.join(state.root, 'views', 'tasks.active.json'), 'utf8'))
  assert.equal(view[0].title, state.task.title)
  assert.equal(JSON.stringify(view).includes('manualPoints'), false)
  const name = await state.writeCommand(), prepared = await state.bridge.prepareCommand(name)
  assert.equal(prepared.state, 'awaiting_approval'); assert.equal(state.applications(), 0)
  await assert.rejects(state.bridge.approve(prepared, { approved: true, actor: 'human' }), { code: 'HUMAN_APPROVAL_REQUIRED' })
  const token = await state.bridge.approve(prepared, state.proof), result = await state.bridge.execute(prepared, token)
  assert.equal(result.state, 'applied'); assert.equal(state.applications(), 1)
  assert.deepEqual(state.task.score, { mode: 'manual', manualPoints: 25 })
  assert.equal(state.task.notes, '承認後のメモ')
  const file = JSON.parse(await fs.readFile(path.join(state.root, 'results', `${state.command.command_id}.json`), 'utf8'))
  assert.equal(file.value.digest, prepared.digest); assert.match(file.signature, /^[a-f0-9]{64}$/)
  const replay = await state.bridge.prepareCommand(name)
  assert.equal(replay.state, 'finished'); assert.deepEqual(replay.result, result); assert.equal(state.applications(), 1)
  const restarted = await createLocalFileBridge(state.options)
  assert.equal((await restarted.prepareCommand(name)).state, 'finished'); assert.equal(state.applications(), 1)
}))

test('same ID changed payload, unknown approvals and protected fields reject', async () => fixture(async state => {
  const name = await state.writeCommand(), prepared = await state.bridge.prepareCommand(name), token = await state.bridge.approve(prepared, state.proof)
  await state.bridge.execute(prepared, token)
  await state.writeCommand({ ...state.command, payload: { notes: 'different' } })
  await assert.rejects(state.bridge.prepareCommand(name), { code: 'IDEMPOTENCY_MISMATCH' })
  for (const injected of [{ approved: true }, { actor: 'human' }, { policy_level: 'full' }, { sql: 'UPDATE ledger' }]) assert.throws(() => parseEnvelope(JSON.stringify({ ...state.command, ...injected })), { code: 'COMMAND_SCHEMA' })
  for (const payload of [{ manualPoints: 25 }, { status: 'done' }, { due: '2026-10-10' }, { notes: 'ok', ledger: 1 }]) assert.throws(() => parseEnvelope(JSON.stringify({ ...state.command, payload })), { code: 'UNSUPPORTED_FIELD' })
  assert.throws(() => parseEnvelope(JSON.stringify({ ...state.command, type: 'task.complete' })), { code: 'UNSUPPORTED_OPERATION' })
}))

test('owner/dataset/policy/source/grant revision/AI OFF invalidate pending approvals', async () => {
  for (const alteration of [{ ownerId: 'other' }, { datasetId: randomUUID() }, { policyEpoch: 6 }, { sourcePermissionRevision: 3 }, { registrationRevision: 2 }, { grantEpoch: 2 }, { enabled: false }]) await fixture(async state => {
    const prepared = await state.bridge.prepareCommand(await state.writeCommand()), token = await state.bridge.approve(prepared, state.proof)
    state.setContext(alteration)
    await assert.rejects(state.bridge.execute(prepared, token), { code: 'AUTHORITY_CHANGED' }); assert.equal(state.applications(), 0)
  })
})

test('snapshot view edits and manifest/registration signature tampering reject', async () => fixture(async state => {
  const name = await state.writeCommand()
  await fs.writeFile(path.join(state.root, 'views', 'tasks.active.json'), '[{"id":"fake"}]')
  await assert.rejects(state.bridge.prepareCommand(name), { code: 'SNAPSHOT_INVALID' })
  await state.bridge.exportSnapshot([state.task]); state.command.snapshot_id = JSON.parse(await fs.readFile(path.join(state.root, 'manifest.json'), 'utf8')).value.snapshot_id; await state.writeCommand()
  const manifest = JSON.parse(await fs.readFile(path.join(state.root, 'manifest.json'), 'utf8')); manifest.value.owner_id = 'other'
  await fs.writeFile(path.join(state.root, 'manifest.json'), JSON.stringify(manifest))
  await assert.rejects(state.bridge.prepareCommand(name), { code: 'SIGNATURE_INVALID' })
  const registration = JSON.parse(await fs.readFile(path.join(state.root, 'registration.json'), 'utf8')); registration.value.client.grant.mutation_mode = 'auto_within_bounds'
  await fs.writeFile(path.join(state.root, 'registration.json'), JSON.stringify(registration))
  await assert.rejects(state.bridge.prepareCommand(name), { code: 'SIGNATURE_INVALID' })
}))

test('expiry, foreign target/base revision and schedule bounds reject before application', async () => fixture(async state => {
  for (const [alteration, code] of [[{ expires_at: '2020-01-01T00:00:00.000Z' }, 'COMMAND_EXPIRED'], [{ target_id: randomUUID() }, 'REVISION_CONFLICT'], [{ expected_revision: 99 }, 'REVISION_CONFLICT'], [{ payload: { scheduled_date: '2026-12-30' } }, 'SCHEDULE_BOUND']]) {
    const command = { ...state.command, ...alteration }; await state.writeCommand(command)
    await assert.rejects(state.bridge.prepareCommand(`${command.command_id}.ready.json`), { code })
  }
  assert.equal(state.applications(), 0)
}))

test('command edits after approval, forged approval object and discarded authority reject', async () => fixture(async state => {
  const name = await state.writeCommand(), prepared = await state.bridge.prepareCommand(name), token = await state.bridge.approve(prepared, state.proof)
  await state.writeCommand({ ...state.command, payload: { notes: 'changed after review' } })
  await assert.rejects(state.bridge.execute(prepared, token), { code: 'COMMAND_CHANGED' })
  await state.writeCommand()
  await assert.rejects(state.bridge.execute(prepared, { ...token }), { code: 'HUMAN_APPROVAL_REQUIRED' })
  state.bridge.clearAuthorities()
  await assert.rejects(state.bridge.execute(prepared, token), { code: 'HUMAN_APPROVAL_REQUIRED' }); assert.equal(state.applications(), 0)
}))

test('path traversal, absolute/NTFS paths, symlink and hardlink reject', async () => fixture(async state => {
  for (const name of ['../db.ready.json', 'C:\\secret.ready.json', 'thing:stream.ready.json', '/tmp/x.ready.json']) await assert.rejects(state.bridge.prepareCommand(name), { code: 'COMMAND_FILENAME' })
  const outside = path.join(state.workspace, 'outside.json'); await fs.writeFile(outside, JSON.stringify(state.command))
  const filename = `${state.command.command_id}.ready.json`, target = path.join(state.root, 'inbox', filename)
  await fs.link(outside, target)
  await assert.rejects(state.bridge.prepareCommand(filename), { code: 'UNSAFE_LINK' }); await fs.unlink(target)
  // Directory junctions work without developer-mode symlink privileges on Windows.
  const inbox = path.join(state.root, 'inbox'); await fs.rmdir(inbox)
  await fs.symlink(state.journalDirectory, inbox, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(state.bridge.scanInbox(), { code: 'UNSAFE_LINK' }); assert.equal(state.applications(), 0)
}))

test('malformed one file does not stop scan; .tmp is ignored and256KiB is capped', async () => fixture(async state => {
  await state.writeCommand()
  const bad = `${randomUUID()}.ready.json`; await fs.writeFile(path.join(state.root, 'inbox', bad), '{not json')
  await fs.writeFile(path.join(state.root, 'inbox', `${randomUUID()}.tmp`), 'ignored')
  const oversized = `${randomUUID()}.ready.json`; await fs.writeFile(path.join(state.root, 'inbox', oversized), 'x'.repeat(256 * 1024 + 1))
  const results = await state.bridge.scanInbox()
  assert.equal(results.length, 3); assert.equal(results.filter(row => row.prepared).length, 1)
  assert.equal(results.find(row => row.filename === bad).error, 'INVALID_JSON')
  assert.equal(results.find(row => row.filename === oversized).error, 'FILE_SIZE')
}))

test('same approved command executes once under concurrent calls', async () => fixture(async state => {
  const prepared = await state.bridge.prepareCommand(await state.writeCommand()), first = await state.bridge.approve(prepared, state.proof), second = await state.bridge.approve(prepared, state.proof)
  const results = await Promise.all([state.bridge.execute(prepared, first), state.bridge.execute(prepared, second)])
  assert.equal(state.applications(), 1); assert.equal(results[0].state, 'applied'); assert.deepEqual(results[0], results[1])
}))

test('unknown outcome after claim/restart never automatically repeats effects', async () => fixture(async state => {
  const restartedOptions = { ...state.options, applyApprovedCommand: async () => { throw new Error('receipt lost after effect') } }, first = await createLocalFileBridge(restartedOptions)
  const prepared = await first.prepareCommand(await state.writeCommand()), token = await first.approve(prepared, state.proof), result = await first.execute(prepared, token)
  assert.equal(result.state, 'unknown')
  const restarted = await createLocalFileBridge(state.options), replay = await restarted.prepareCommand(`${state.command.command_id}.ready.json`)
  assert.equal(replay.state, 'finished'); assert.equal(replay.result.state, 'unknown'); assert.equal(state.applications(), 0)
}))

test('app-private replay record is authoritative when external result copy is deleted', async () => fixture(async state => {
  const name = await state.writeCommand(), prepared = await state.bridge.prepareCommand(name), token = await state.bridge.approve(prepared, state.proof)
  const result = await state.bridge.execute(prepared, token)
  await fs.unlink(path.join(state.root, 'results', `${state.command.command_id}.json`))
  const restarted = await createLocalFileBridge(state.options)
  assert.deepEqual((await restarted.prepareCommand(name)).result, result); assert.equal(state.applications(), 1)
}))

test('two different concurrent commands reserve the daily quota atomically before effects', async () => fixture(async state => {
  const registration = structuredClone(state.registration); registration.client.grant.max_operations_per_day = 1
  let applied = 0
  const bridge = await createLocalFileBridge({ ...state.options, registration, applyApprovedCommand: async prepared => { applied++; await new Promise(resolve => setTimeout(resolve, 20)); return { commandId: prepared.command.command_id, digest: prepared.digest, taskIds: [state.task.id], appliedAt: new Date().toISOString() } } })
  const manifest = await bridge.exportSnapshot([state.task]), first = { ...state.command, snapshot_id: manifest.snapshot_id }, second = { ...first, command_id: randomUUID(), payload: { notes: 'second' } }
  const a = await bridge.prepareCommand(await state.writeCommand(first)), b = await bridge.prepareCommand(await state.writeCommand(second))
  const results = await Promise.allSettled([bridge.execute(a, await bridge.approve(a, state.proof)), bridge.execute(b, await bridge.approve(b, state.proof))])
  assert.equal(applied, 1); assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'DAILY_BOUND')
  assert.equal((await fs.readdir(state.journalDirectory)).filter(name => name.endsWith('.claim.json')).length, 1)
}))

test('restart recovers an actual persisted receipt at the daily cap without repeating effects', async () => fixture(async state => {
  const registration = structuredClone(state.registration); registration.client.grant.max_operations_per_day = 1
  let receipt, applied = 0
  const options = { ...state.options, registration, applyApprovedCommand: async prepared => { applied++; receipt = { commandId: prepared.command.command_id, digest: prepared.digest, taskIds: [state.task.id], appliedAt: new Date().toISOString() }; return receipt }, recoverReceipt: async () => receipt }
  const bridge = await createLocalFileBridge(options), manifest = await bridge.exportSnapshot([state.task]), command = { ...state.command, snapshot_id: manifest.snapshot_id }
  const name = await state.writeCommand(command), prepared = await bridge.prepareCommand(name)
  await bridge.execute(prepared, await bridge.approve(prepared, state.proof))
  await fs.unlink(path.join(state.journalDirectory, `${command.command_id}.result.json`))
  const restarted = await createLocalFileBridge(options), again = await restarted.prepareCommand(name)
  const result = await restarted.execute(again, await restarted.approve(again, state.proof))
  assert.equal(result.state, 'applied'); assert.deepEqual(result.receipt, receipt); assert.equal(applied, 1)
}))

test('restart reads only a signed, bound, unexpired snapshot with unchanged view hash', async () => fixture(async state => {
  const restarted = await createLocalFileBridge(state.options)
  const snapshot = await restarted.readSnapshot()
  assert.deepEqual(snapshot, state.manifest); assert.equal(Object.isFrozen(snapshot), true)
  await fs.writeFile(path.join(state.root, 'views', 'tasks.active.json'), '[]')
  await assert.rejects(restarted.readSnapshot(), { code: 'SNAPSHOT_INVALID' })
  await restarted.exportSnapshot([state.task])
  const manifestPath = path.join(state.root, 'manifest.json'), signed = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  signed.value.entity_revisions[state.task.id] = 500
  await fs.writeFile(manifestPath, JSON.stringify(signed))
  await assert.rejects(restarted.readSnapshot(), { code: 'SIGNATURE_INVALID' })
  assert.equal(state.applications(), 0)
}))
