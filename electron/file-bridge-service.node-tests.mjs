import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
const { createFileBridgeService } = createRequire(import.meta.url)('./file-bridge-service.cjs')

async function fixture(t, { getReceiptOverride, auto = null } = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'michi-filebridge-service-'))
  t.after(async () => { const resolved = path.resolve(root); assert.equal(path.dirname(resolved), path.resolve(await fs.realpath(os.tmpdir()))); assert.ok(path.basename(resolved).startsWith('michi-filebridge-service-')); await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })
  // N09 operation table as main reads it from the app DB; only operation/mode/shift matter here.
  const operations = [{ operation: 'task.text', mode: 'auto_within_bounds', max_schedule_days_delta: null }, { operation: 'task.schedule', mode: 'auto_within_bounds', max_schedule_days_delta: 3 }]
  const settings = { profileId: 'owner', datasetId: crypto.randomUUID(), aiEnabled: true, changePolicy: { epoch: 1, sourcePermissionRevision: 1, aiChangesEnabled: true, ...(auto ? { operations } : {}) } }
  const task = { id: crypto.randomUUID(), revision: 1, title: '正式タスク', notes: '本人のメモ', scheduledDate: '2026-10-01', containerId: null, deletedAt: null }
  const receipts = new Map(), proofs = new Map(); let configuration = null
  const native = (kind, reference = '') => { const nonce = crypto.randomUUID(); proofs.set(nonce, { kind, reference }); return nonce }
  const service = await createFileBridgeService({ agentDirectory: path.join(root, 'agents'), journalDirectory: path.join(root, 'private'), signingKey: Buffer.alloc(32, 7), getSettings: async () => settings, getTasks: async ids => ids.includes(task.id) ? [task] : [], getReceipt: async id => getReceiptOverride ? getReceiptOverride(id, receipts) : receipts.get(id), loadConfiguration: async () => configuration, saveConfiguration: async value => { configuration = value }, verifyNativeProof: (kind, reference, nonce) => { const proof = proofs.get(nonce); proofs.delete(nonce); return proof?.kind === kind && proof?.reference === reference } })
  const config = { ownerId: settings.profileId, datasetId: settings.datasetId, policyEpoch: 1, sourcePermissionRevision: 1, intendedHost: 'codex', taskIds: [task.id], fields: auto ? ['notes', 'scheduled_date'] : ['title', 'notes', 'scheduled_date'], lifetimeHours: 24, ...(auto ? { automation: auto } : {}) }
  await service.configure(config, native('configure'))
  const status = await service.exportSnapshot({ tasks: [{ id: task.id, title: '偽装タイトル' }] })
  async function command(payload = { notes: '本人が確認した変更案' }) {
    const value = { schema_version: '1', command_id: crypto.randomUUID(), snapshot_id: status.snapshot.snapshot_id, expires_at: new Date(Date.now() + 3600000).toISOString(), type: 'task.update', target_id: task.id, expected_revision: 1, payload }
    await fs.writeFile(path.join(status.root, 'inbox', `${value.command_id}.ready.json`), JSON.stringify(value))
    const scan = await service.scanInbox(), entry = scan.entries.find(item => item.prepared?.command.command_id === value.command_id)
    assert.equal(entry.state, 'awaiting_approval')
    const binding = { reference: entry.reference, fileDigest: entry.prepared.digest, applicationDigest: 'b'.repeat(64), ownerId: settings.profileId, datasetId: settings.datasetId, policyEpoch: 1, sourcePermissionRevision: 1 }
    return { value, entry, binding }
  }
  function persist(value, binding, lease) {
    const receipt = { version: 1, commandId: value.command_id, fileDigest: binding.fileDigest, applicationDigest: binding.applicationDigest, ownerId: settings.profileId, datasetId: settings.datasetId, clientId: lease.clientId, policyEpoch: 1, sourcePermissionRevision: 1, registrationRevision: lease.registrationRevision, grantEpoch: lease.grantEpoch, taskIds: [task.id], appliedAt: new Date().toISOString() }
    const key = `filebridge:applied:${value.command_id}`
    receipts.set(key, { key, hash: binding.applicationDigest, resultId: JSON.stringify(receipt), at: receipt.appliedAt }); return receipt
  }
  return { root, service, settings, task, status, config, native, command, persist, receipts, configuration: () => configuration }
}

test('native proof cannot be supplied by command JSON or reused', async t => {
  const f = await fixture(t), { binding } = await f.command()
  await assert.rejects(f.service.authorizeApplication(binding, 'approved'), /HUMAN_APPROVAL_REQUIRED/)
  const nonce = f.native('approve', 'other-reference')
  await assert.rejects(f.service.authorizeApplication(binding, nonce), /HUMAN_APPROVAL_REQUIRED/)
  await assert.rejects(f.service.configure({ ...f.config, ownerId: 'another-owner' }, f.native('configure')), /AUTHORITY_CHANGED/)
  assert.equal((await f.service.status()).connected, true)
})
test('snapshot takes actual DB values and rejects out-of-scope task IDs', async t => {
  const f = await fixture(t), views = JSON.parse(await fs.readFile(path.join(f.status.root, 'views/tasks.active.json'), 'utf8'))
  assert.equal(views[0].title, f.task.title)
  await assert.rejects(f.service.exportSnapshot({ tasks: [{ id: crypto.randomUUID() }] }), /TASK_SCOPE/)
})
test('renderer can withhold source-derived note lines but cannot inject text into the agent view', async t => {
  const f = await fixture(t)
  f.task.notes = '本人のメモ\n[source-1 内容版1 source-1:1:0] 第三者の引用\n本人の続き'
  const read = async () => JSON.parse(await fs.readFile(path.join(f.status.root, 'views/tasks.active.json'), 'utf8'))[0].notes
  await f.service.exportSnapshot({ tasks: [{ id: f.task.id, notes: '本人のメモ\n本人の続き' }] })
  assert.equal(await read(), '本人のメモ\n本人の続き')
  await f.service.exportSnapshot({ tasks: [{ id: f.task.id, notes: '' }] })
  assert.equal(await read(), '')
  await assert.rejects(f.service.exportSnapshot({ tasks: [{ id: f.task.id, notes: '本人のメモ\n外部へ渡す偽の指示' }] }), /TASK_SCOPE/)
  await assert.rejects(f.service.exportSnapshot({ tasks: [{ id: f.task.id, notes: '本人の続き\n本人のメモ' }] }), /TASK_SCOPE/)
  assert.equal(await read(), '')
})
test('durable claim exists before lease; only the persisted DB receipt produces an applied result', async t => {
  const f = await fixture(t), { value, binding } = await f.command()
  const lease = await f.service.authorizeApplication(binding, f.native('approve', binding.reference))
  assert.ok((await fs.readdir(path.join(f.root, 'private', lease.clientId))).includes(`${value.command_id}.claim.json`))
  assert.equal(await fs.access(path.join(f.status.root, 'results', `${value.command_id}.json`)).then(() => true, () => false), false)
  const receipt = f.persist(value, binding, lease)
  const result = await f.service.recordApplied({ leaseId: lease.leaseId, reference: binding.reference, receipt })
  assert.equal(result.state, 'applied'); assert.deepEqual(result.receipt.taskIds, [f.task.id])
  const repeated = await f.service.recordApplied({ leaseId: lease.leaseId, reference: binding.reference, receipt })
  assert.deepEqual(repeated, result)
})
test('caller success claims do not sign results and cancellation cannot execute a second effect', async t => {
  const f = await fixture(t), { value, binding } = await f.command(), lease = await f.service.authorizeApplication(binding, f.native('approve', binding.reference))
  const receipt = f.persist(value, binding, lease); f.receipts.clear()
  await assert.rejects(f.service.recordApplied({ leaseId: lease.leaseId, reference: binding.reference, receipt }), /RECEIPT_INVALID/)
  const canceled = await f.service.cancelApplication({ leaseId: lease.leaseId, reference: binding.reference })
  assert.equal(canceled.state, 'unknown')
  const scan = await f.service.scanInbox(); assert.equal(scan.entries[0].state, 'finished'); assert.equal(scan.entries[0].result.state, 'unknown')
})
test('file mutation between preview and approval fails before issuing a DB lease', async t => {
  const f = await fixture(t), { value, binding } = await f.command()
  await fs.writeFile(path.join(f.status.root, 'inbox', `${value.command_id}.ready.json`), JSON.stringify({ ...value, payload: { notes: '差替え' } }))
  await assert.rejects(f.service.authorizeApplication(binding, f.native('approve', binding.reference)), /コマンドが変更/)
  assert.equal(f.receipts.size, 0)
})
test('revocation acknowledges a DB commit already made and revokes remaining authority', async t => {
  const f = await fixture(t), { value, binding } = await f.command(), lease = await f.service.authorizeApplication(binding, f.native('approve', binding.reference))
  const receipt = f.persist(value, binding, lease)
  await f.service.invalidate()
  assert.equal((await f.service.status()).connected, false)
  const result = await f.service.recordApplied({ leaseId: lease.leaseId, reference: binding.reference, receipt })
  assert.equal(result.state, 'applied')
})
test('AI OFF after a lease cancels an uncommitted attempt and disables the client', async t => {
  const f = await fixture(t), { binding } = await f.command(), lease = await f.service.authorizeApplication(binding, f.native('approve', binding.reference))
  f.settings.aiEnabled = false
  assert.equal((await f.service.status()).connected, false)
  const result = await f.service.cancelApplication({ leaseId: lease.leaseId, reference: binding.reference })
  assert.equal(result.state, 'unknown'); assert.equal(f.receipts.size, 0)
})
test('receipt read failure still revokes the external copy and disables the saved connection', async t => {
  let unreadable = false
  const f = await fixture(t, { getReceiptOverride: async (id, receipts) => { if (unreadable) throw new Error('DB unavailable'); return receipts.get(id) } })
  const { binding } = await f.command()
  await f.service.authorizeApplication(binding, f.native('approve', binding.reference))
  unreadable = true
  await assert.rejects(f.service.invalidate(), /取消中にエラー/)
  assert.equal((await f.service.status()).connected, false)
  const marker = JSON.parse(await fs.readFile(path.join(f.status.root, 'revoked.json'), 'utf8'))
  assert.equal(marker.value.client_id, f.status.registration.client.id)
  assert.match(marker.signature, /^[a-f0-9]{64}$/)
  assert.equal(f.receipts.size, 0)
})
test('an automatic lease needs main\'s own signed auto grant inside its bounds and quota', async t => {
  const f = await fixture(t, { auto: { maxScheduleShiftDays: 2, maxOperationsPerDay: 1 } })
  assert.equal(f.status.registration.client.grant.mutation_mode, 'auto_within_bounds')
  assert.deepEqual(f.status.registration.client.grant.automation, { max_schedule_shift_days: 2, max_operations_per_day: 1 })
  const far = await f.command({ scheduled_date: '2026-10-05' })
  await assert.rejects(f.service.authorizeAutomaticApplication(far.binding), /AUTO_SCHEDULE_BOUND/)
  const near = await f.command({ scheduled_date: '2026-10-02' }), lease = await f.service.authorizeAutomaticApplication(near.binding)
  assert.equal(lease.automatic, true)
  const claim = JSON.parse(await fs.readFile(path.join(f.root, 'private', lease.clientId, `${near.value.command_id}.claim.json`), 'utf8'))
  assert.equal((claim.value ?? claim).automatic, true)
  const result = await f.service.recordApplied({ leaseId: lease.leaseId, reference: near.binding.reference, receipt: f.persist(near.value, near.binding, lease) })
  assert.equal(result.state, 'applied')
  // The owner-set daily quota (1) is enforced by main at the durable claim, without a click.
  const second = await f.command({ notes: '二件目' })
  await assert.rejects(f.service.authorizeAutomaticApplication(second.binding), /AUTO_DAILY_BOUND/)
  assert.equal(f.receipts.size, 1)
  // A native approval of the same entry still works: the quota limits only the automatic path.
  const approved = await f.service.authorizeApplication(second.binding, f.native('approve', second.binding.reference))
  assert.equal(approved.automatic, false)
})
test('without a delegated grant, with a changed N09 table or after a stop, automatic leases are refused', async t => {
  const manual = await fixture(t), entry = await manual.command({ notes: '自動にしたい' })
  await assert.rejects(manual.service.authorizeAutomaticApplication(entry.binding), /AUTOMATION_NOT_GRANTED/)
  await assert.rejects(manual.service.configure({ ...manual.config, fields: ['notes'], automation: { maxScheduleShiftDays: 1, maxOperationsPerDay: 1 } }, manual.native('configure')), /AUTOMATION_NOT_GRANTED/)
  await assert.rejects(manual.service.configure({ ...manual.config, automation: { maxScheduleShiftDays: 1, maxOperationsPerDay: 1 } }, manual.native('configure')), /AUTOMATION_SCOPE/)
  const f = await fixture(t, { auto: { maxScheduleShiftDays: 2, maxOperationsPerDay: 5 } }), queued = await f.command({ scheduled_date: '2026-10-02' })
  f.settings.changePolicy.operations = f.settings.changePolicy.operations.map(rule => rule.operation === 'task.schedule' ? { ...rule, mode: 'require_approval' } : rule)
  await assert.rejects(f.service.authorizeAutomaticApplication(queued.binding), /AUTOMATION_NOT_GRANTED/)
  f.settings.changePolicy.operations = f.settings.changePolicy.operations.map(rule => ({ ...rule, mode: 'auto_within_bounds' }))
  f.settings.changePolicy.aiChangesEnabled = false
  await assert.rejects(f.service.authorizeAutomaticApplication(queued.binding), /AUTOMATION_NOT_GRANTED/)
  assert.equal(f.receipts.size, 0)
})
test('a tampered registration cannot create or widen automatic authority', async t => {
  const f = await fixture(t, { auto: { maxScheduleShiftDays: 2, maxOperationsPerDay: 5 } }), queued = await f.command({ notes: '範囲内のメモ' })
  const file = path.join(f.status.root, 'registration.json'), record = JSON.parse(await fs.readFile(file, 'utf8'))
  record.value.client.grant.automation.max_schedule_shift_days = 7
  await fs.writeFile(file, JSON.stringify(record))
  await assert.rejects(f.service.authorizeAutomaticApplication(queued.binding), /SIGNATURE_INVALID|REGISTRATION_CHANGED/)
  assert.equal(f.receipts.size, 0)
  // A saved configuration edited to claim auto mode without main's bounds is not loaded at all.
  const saved = structuredClone(f.configuration())
  delete saved.registration.client.grant.automation
  let stored = saved
  const reloaded = await createFileBridgeService({ agentDirectory: path.join(f.root, 'agents'), journalDirectory: path.join(f.root, 'private'), signingKey: Buffer.alloc(32, 7), getSettings: async () => f.settings, getTasks: async () => [f.task], getReceipt: async () => undefined, loadConfiguration: async () => stored, saveConfiguration: async value => { stored = value }, verifyNativeProof: () => false })
  assert.equal((await reloaded.status()).connected, false)
  assert.equal(stored, null)
})
test('file bridge invalidate leaves the PC-operation and GitHub private stores untouched', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'michi-filebridge-isolation-'))
  t.after(async () => { const resolved = path.resolve(root); assert.equal(path.dirname(resolved), path.resolve(await fs.realpath(os.tmpdir()))); assert.ok(path.basename(resolved).startsWith('michi-filebridge-isolation-')); await fs.rm(resolved, { recursive: true, force: true }) })
  const others = ['local-actions-private', 'github-achievements-private']
  const listing = async () => Object.fromEntries(await Promise.all(others.map(async name => [name, (await fs.readdir(path.join(root, name), { recursive: true })).sort()])))
  const contents = () => Promise.all(others.map(name => fs.readFile(path.join(root, name, 'connection.bin'), 'utf8')))
  for (const name of others) { await fs.mkdir(path.join(root, name, 'journal'), { recursive: true }); await fs.writeFile(path.join(root, name, 'connection.bin'), `${name}-sentinel`); await fs.writeFile(path.join(root, name, 'journal', 'entry.json'), '{}') }
  const settings = { profileId: 'owner', datasetId: crypto.randomUUID(), aiEnabled: true, changePolicy: { epoch: 1, sourcePermissionRevision: 1, aiChangesEnabled: true } }
  const task = { id: crypto.randomUUID(), revision: 1, title: '正式タスク', notes: '', scheduledDate: '2026-10-01', containerId: null, deletedAt: null }
  let configuration = null
  const proofs = new Set(['configure-proof'])
  const service = await createFileBridgeService({ agentDirectory: path.join(root, 'agents'), journalDirectory: path.join(root, 'local-agent-private', 'journal'), signingKey: Buffer.alloc(32, 9), getSettings: async () => settings, getTasks: async ids => ids.includes(task.id) ? [task] : [], getReceipt: async () => undefined, loadConfiguration: async () => configuration, saveConfiguration: async value => { configuration = value }, verifyNativeProof: (_kind, _reference, nonce) => proofs.delete(nonce) })
  await service.configure({ ownerId: 'owner', datasetId: settings.datasetId, policyEpoch: 1, sourcePermissionRevision: 1, intendedHost: 'codex', taskIds: [task.id], fields: ['notes'], lifetimeHours: 1 }, 'configure-proof')
  const before = await listing(), sentinel = await contents()
  await service.invalidate()
  assert.equal((await service.status()).connected, false)
  assert.deepEqual(await listing(), before)
  assert.deepEqual(await contents(), sentinel)
})
test('K12: a stated rejection is signed with its code only while the DB holds no receipt', async t => {
  const f = await fixture(t), { value, binding } = await f.command(), lease = await f.service.authorizeApplication(binding, f.native('approve', binding.reference))
  await assert.rejects(f.service.cancelApplication({ leaseId: lease.leaseId, reference: binding.reference, outcome: { state: 'applied', code: 'X' } }), /LEASE_INVALID/)
  await assert.rejects(f.service.cancelApplication({ leaseId: lease.leaseId, reference: binding.reference, outcome: { state: 'conflict', code: 'CONFLICT', extra: true } }), /LEASE_INVALID/)
  const rejected = await f.service.cancelApplication({ leaseId: lease.leaseId, reference: binding.reference, outcome: { state: 'conflict', code: 'CONFLICT' } })
  assert.equal(rejected.state, 'conflict'); assert.equal(rejected.code, 'CONFLICT'); assert.equal(rejected.receipt, null)
  const signed = JSON.parse(await fs.readFile(path.join(f.status.root, 'results', `${value.command_id}.json`), 'utf8'))
  assert.equal(signed.value.code, 'CONFLICT'); assert.match(signed.signature, /^[a-f0-9]{64}$/)
  // With a persisted receipt the stated rejection is ignored: the applied fact wins.
  const second = await f.command(), lease2 = await f.service.authorizeApplication(second.binding, f.native('approve', second.binding.reference))
  f.persist(second.value, second.binding, lease2)
  const applied = await f.service.cancelApplication({ leaseId: lease2.leaseId, reference: second.binding.reference, outcome: { state: 'denied', code: 'CHANGES_STOPPED' } })
  assert.equal(applied.state, 'applied'); assert.equal(Object.hasOwn(applied, 'code'), false)
})
test('K12: recordRejected closes a scanned, unleased command with the app code and never applies it', async t => {
  const f = await fixture(t), { value, entry } = await f.command()
  await assert.rejects(f.service.recordRejected({ reference: entry.reference, state: 'approved', code: 'CHANGES_STOPPED' }), /REJECTION_INVALID/)
  await assert.rejects(f.service.recordRejected({ reference: crypto.randomUUID(), state: 'denied', code: 'CHANGES_STOPPED' }), /REJECTION_INVALID/)
  const result = await f.service.recordRejected({ reference: entry.reference, state: 'denied', code: 'CHANGES_STOPPED' })
  assert.deepEqual({ state: result.state, code: result.code, receipt: result.receipt, command: result.command_id }, { state: 'denied', code: 'CHANGES_STOPPED', receipt: null, command: value.command_id })
  await assert.rejects(f.service.authorizeApplication({ reference: entry.reference, fileDigest: entry.prepared.digest, applicationDigest: 'b'.repeat(64), ownerId: f.settings.profileId, datasetId: f.settings.datasetId, policyEpoch: 1, sourcePermissionRevision: 1 }, f.native('approve', entry.reference)), /LEASE_INVALID/)
  const scan = await f.service.scanInbox(), finished = scan.entries.find(item => item.state === 'finished')
  assert.equal(finished.result.state, 'denied'); assert.equal(finished.result.code, 'CHANGES_STOPPED'); assert.equal(f.receipts.size, 0)
  // While a lease is open, a scanned command cannot be rejected around it.
  const other = await f.command(), lease = await f.service.authorizeApplication(other.binding, f.native('approve', other.binding.reference))
  await assert.rejects(f.service.recordRejected({ reference: other.entry.reference, state: 'denied', code: 'CHANGES_STOPPED' }), /REJECTION_INVALID/)
  await f.service.cancelApplication({ leaseId: lease.leaseId, reference: other.binding.reference })
})
test('K12/N03: split and series grants are written only from the owner configuration and validated in main', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.configure({ ...f.config, allowSplit: 'yes', ruleIds: [] }, f.native('configure')), /CONFIG_INVALID/)
  await assert.rejects(f.service.configure({ ...f.config, allowSplit: true, ruleIds: [crypto.randomUUID()] }, f.native('configure')), /RULE_SCOPE/)
  await assert.rejects(f.service.configure({ ...f.config, approved: true }, f.native('configure')), /CONFIG_INVALID/)
  const status = await f.service.configure({ ...f.config, allowSplit: true, ruleIds: [] }, f.native('configure'))
  assert.ok(status.registration.client.grant.keys.includes('tasks:split')); assert.ok(!status.registration.client.grant.keys.includes('routines:prepare')); assert.equal(Object.hasOwn(status.registration, 'rule_ids'), false)
})
