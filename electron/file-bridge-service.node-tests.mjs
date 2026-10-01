import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
const { createFileBridgeService } = createRequire(import.meta.url)('./file-bridge-service.cjs')

async function fixture(t, { getReceiptOverride } = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'michi-filebridge-service-'))
  t.after(async () => { const resolved = path.resolve(root); assert.equal(path.dirname(resolved), path.resolve(await fs.realpath(os.tmpdir()))); assert.ok(path.basename(resolved).startsWith('michi-filebridge-service-')); await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })
  const settings = { profileId: 'owner', datasetId: crypto.randomUUID(), aiEnabled: true, changePolicy: { epoch: 1, sourcePermissionRevision: 1, aiChangesEnabled: true } }
  const task = { id: crypto.randomUUID(), revision: 1, title: '正式タスク', notes: '本人のメモ', scheduledDate: '2026-10-01', containerId: null, deletedAt: null }
  const receipts = new Map(), proofs = new Map(); let configuration = null
  const native = (kind, reference = '') => { const nonce = crypto.randomUUID(); proofs.set(nonce, { kind, reference }); return nonce }
  const service = await createFileBridgeService({ agentDirectory: path.join(root, 'agents'), journalDirectory: path.join(root, 'private'), signingKey: Buffer.alloc(32, 7), getSettings: async () => settings, getTasks: async ids => ids.includes(task.id) ? [task] : [], getReceipt: async id => getReceiptOverride ? getReceiptOverride(id, receipts) : receipts.get(id), loadConfiguration: async () => configuration, saveConfiguration: async value => { configuration = value }, verifyNativeProof: (kind, reference, nonce) => { const proof = proofs.get(nonce); proofs.delete(nonce); return proof?.kind === kind && proof?.reference === reference } })
  const config = { ownerId: settings.profileId, datasetId: settings.datasetId, policyEpoch: 1, sourcePermissionRevision: 1, intendedHost: 'codex', taskIds: [task.id], fields: ['title', 'notes', 'scheduled_date'], lifetimeHours: 24 }
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
  return { root, service, settings, task, status, config, native, command, persist, receipts }
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
