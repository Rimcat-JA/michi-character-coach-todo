const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { createLocalFileBridge, canonicalFileJSON, validateFileBridgeRegistration } = require('./local-file-bridge.cjs')

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
function fail(code) { const error = new Error(code); error.code = code; throw error }
const policy = settings => settings.changePolicy ?? { epoch: 0, sourcePermissionRevision: 0, aiChangesEnabled: true }
const receiptKey = id => `filebridge:applied:${id}`

/** Coordinates the durable file claim BEFORE the renderer's atomic DB write. */
async function createFileBridgeService({ agentDirectory, journalDirectory, signingKey, getSettings, getTasks, getReceipt, loadConfiguration, saveConfiguration, verifyNativeProof, leaseMilliseconds = 60000 }) {
  let connection = null, initializing = null
  const entries = new Map(), leases = new Map(), proofs = new WeakSet()
  await fs.mkdir(agentDirectory, { recursive: true }); await fs.mkdir(journalDirectory, { recursive: true })
  async function currentContext(registration) {
    const settings = await getSettings(), current = policy(settings)
    return { ownerId: settings.profileId, datasetId: settings.datasetId, clientId: registration.client.id, policyEpoch: current.epoch, sourcePermissionRevision: current.sourcePermissionRevision, registrationRevision: registration.client.revision, grantEpoch: registration.client.grant_epoch, enabled: Boolean(connection?.registration.client.id === registration.client.id && settings.aiEnabled && current.aiChangesEnabled) }
  }
  function receiptFor(lease, stored) {
    if (!stored || stored.key !== receiptKey(lease.prepared.command.command_id) || stored.hash !== lease.binding.applicationDigest || typeof stored.resultId !== 'string') return null
    let value; try { value = JSON.parse(stored.resultId) } catch { return null }
    const keys = ['version', 'commandId', 'fileDigest', 'applicationDigest', 'ownerId', 'datasetId', 'clientId', 'policyEpoch', 'sourcePermissionRevision', 'registrationRevision', 'grantEpoch', 'taskIds', 'appliedAt']
    const reg = lease.registration, prepared = lease.prepared
    if (!exact(value, keys) || value.version !== 1 || value.commandId !== prepared.command.command_id || value.fileDigest !== prepared.digest || value.applicationDigest !== lease.binding.applicationDigest || value.ownerId !== reg.owner_id || value.datasetId !== reg.dataset_id || value.clientId !== reg.client.id || value.policyEpoch !== reg.policy_epoch || value.sourcePermissionRevision !== reg.source_permission_revision || value.registrationRevision !== reg.client.revision || value.grantEpoch !== reg.client.grant_epoch || !Array.isArray(value.taskIds) || value.taskIds.length !== 1 || !uuid(value.taskIds[0]) || prepared.command.type === 'task.update' && value.taskIds[0] !== prepared.command.target_id || typeof value.appliedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.appliedAt) || !Number.isFinite(Date.parse(value.appliedAt)) || new Date(value.appliedAt).toISOString() !== value.appliedAt) return null
    return { application: value, file: { commandId: value.commandId, digest: value.fileDigest, taskIds: value.taskIds, appliedAt: value.appliedAt } }
  }
  async function recover(registration, prepared) {
    const stored = await getReceipt(receiptKey(prepared.command.command_id))
    if (!stored || typeof stored.resultId !== 'string') return null
    let value; try { value = JSON.parse(stored.resultId) } catch { return null }
    return receiptFor({ registration, prepared, binding: { applicationDigest: value.applicationDigest } }, stored)?.file ?? null
  }
  async function activate(configuration) {
    if (!exact(configuration, ['root', 'registration']) || configuration.root !== path.join(agentDirectory, configuration.registration?.client?.id ?? '')) fail('CONFIG_INVALID')
    validateFileBridgeRegistration(configuration.registration)
    const reg = configuration.registration, privateRoot = path.join(journalDirectory, reg.client.id)
    await fs.mkdir(configuration.root, { recursive: true }); await fs.mkdir(privateRoot, { recursive: true })
    const next = { ...configuration, bridge: null, snapshot: null, results: [] }
    connection = next
    try {
      next.bridge = await createLocalFileBridge({ root: next.root, journalDirectory: privateRoot, signingKey, registration: reg, getCurrentContext: () => currentContext(reg), verifyHumanApproval: (_context, proof) => proofs.has(proof), recoverReceipt: prepared => recover(reg, prepared), applyApprovedCommand: async prepared => {
        const lease = [...leases.values()].find(value => value.prepared === prepared && value.registration === reg)
        if (!lease) fail('LEASE_MISSING')
        lease.ready.resolve(lease.public)
        return lease.committed.promise
      } })
      if (typeof next.bridge.readSnapshot === 'function') next.snapshot = await next.bridge.readSnapshot().catch(error => { if (error.code === 'ENOENT') return null; throw error })
      return next
    } catch (error) { connection = null; throw error }
  }
  async function ensure() {
    if (connection) return connection
    if (!initializing) initializing = (async () => { const saved = await loadConfiguration(); if (!saved) return null; try { return await activate(saved) } catch { await saveConfiguration(null); return null } })().finally(() => { initializing = null })
    return initializing
  }
  async function status() {
    const current = await ensure()
    if (!current) return { version: 1, available: true, connected: false, root: null, registration: null, snapshot: null, results: [], notice: '接続すると、選択したタスクだけをローカルフォルダーへ書き出します。' }
    const context = await currentContext(current.registration)
    if (!context.enabled || context.ownerId !== current.registration.owner_id || context.datasetId !== current.registration.dataset_id || context.policyEpoch !== current.registration.policy_epoch || context.sourcePermissionRevision !== current.registration.source_permission_revision || Date.parse(current.registration.client.grant.expires_at) <= Date.now()) { await invalidate(); return status() }
    const results = [...new Map(current.results.map(result => [result.command_id, result])).values()].slice(-100)
    return { version: 1, available: true, connected: true, root: current.root, registration: structuredClone(current.registration), snapshot: current.snapshot, results, notice: '手動ポイント・期限・完了・周期は変更できません。登録済み範囲内の変更も本人承認が必要です。' }
  }
  async function configure(request, nativeProof) {
    if (!await verifyNativeProof('configure', '', nativeProof)) fail('HUMAN_APPROVAL_REQUIRED')
    if (!exact(request, ['ownerId', 'datasetId', 'policyEpoch', 'sourcePermissionRevision', 'intendedHost', 'taskIds', 'fields', 'lifetimeHours']) || !Number.isInteger(request.lifetimeHours) || request.lifetimeHours < 1 || request.lifetimeHours > 168) fail('CONFIG_INVALID')
    await ensure()
    const settings = await getSettings(), current = policy(settings)
    if (request.ownerId !== settings.profileId || request.datasetId !== settings.datasetId || request.policyEpoch !== current.epoch || request.sourcePermissionRevision !== current.sourcePermissionRevision || !settings.aiEnabled || !current.aiChangesEnabled) fail('AUTHORITY_CHANGED')
    if (!Array.isArray(request.taskIds) || request.taskIds.length > 100 || request.taskIds.some(id => !uuid(id)) || new Set(request.taskIds).size !== request.taskIds.length) fail('TASK_SCOPE')
    const tasks = await getTasks(request.taskIds)
    if (tasks.length !== request.taskIds.length || tasks.some(task => task.deletedAt)) fail('TASK_SCOPE')
    const id = crypto.randomUUID(), registration = { schema_version: '1', owner_id: request.ownerId, dataset_id: request.datasetId, policy_epoch: current.epoch, source_permission_revision: current.sourcePermissionRevision, task_ids: [...request.taskIds], client: { id, dataset_id: request.datasetId, intended_host: request.intendedHost, transport: 'stdio', status: 'active', revision: 1, grant_epoch: 1, grant: { keys: ['tasks:read', 'tasks:prepare', 'changes:submit', 'commands:read'], project_ids: [], fields: [...request.fields], mutation_mode: 'require_approval', max_operations_per_day: 20, max_schedule_shift_days: 7, max_point_delta: 0, allow_external_context: false, allow_handoffs: false, expires_at: new Date(Date.now() + request.lifetimeHours * 3600000).toISOString() } } }
    validateFileBridgeRegistration(registration)
    await invalidate()
    const configuration = { root: path.join(agentDirectory, id), registration }
    await activate(configuration); await saveConfiguration(configuration)
    return status()
  }
  async function exportSnapshot(request) {
    if (!exact(request, ['tasks']) || !Array.isArray(request.tasks)) fail('TASK_SCOPE')
    const current = await ensure(); if (!current) fail('NOT_CONNECTED')
    const ids = request.tasks.map(task => task?.id)
    if (ids.length > 100 || ids.some(id => !current.registration.task_ids.includes(id)) || new Set(ids).size !== ids.length) fail('TASK_SCOPE')
    const tasks = await getTasks(ids)
    if (tasks.length !== ids.length || tasks.some(task => task.deletedAt)) fail('TASK_SCOPE')
    current.snapshot = await current.bridge.exportSnapshot(tasks)
    return status()
  }
  async function scanInbox() {
    const current = await ensure(); if (!current) fail('NOT_CONNECTED')
    if ([...leases.values()].some(lease => !lease.settled)) fail('APPLICATION_IN_PROGRESS')
    entries.clear()
    const results = []
    for (const item of await current.bridge.scanInbox()) {
      if (item.error) results.push({ state: 'rejected', filename: item.filename, error: item.error })
      else if (item.prepared.state === 'finished') { results.push({ state: 'finished', filename: item.filename, result: item.prepared.result }); current.results.push(item.prepared.result) }
      else { const reference = crypto.randomUUID(); entries.set(reference, { prepared: item.prepared, registration: current.registration, bridge: current.bridge }); results.push({ state: 'awaiting_approval', filename: item.filename, reference, prepared: item.prepared }) }
    }
    return { status: await status(), entries: results }
  }
  function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
  async function authorizeApplication(binding, nativeProof) {
    if (!exact(binding, ['reference', 'fileDigest', 'applicationDigest', 'ownerId', 'datasetId', 'policyEpoch', 'sourcePermissionRevision']) || !digest(binding.fileDigest) || !digest(binding.applicationDigest)) fail('LEASE_INVALID')
    if (!await verifyNativeProof('approve', binding.reference, nativeProof)) fail('HUMAN_APPROVAL_REQUIRED')
    const entry = entries.get(binding.reference), current = await ensure()
    if (!entry || !current || entry.registration !== current.registration) fail('LEASE_INVALID')
    const prepared = entry.prepared, reg = entry.registration
    if (prepared.digest !== binding.fileDigest || prepared.ownerId !== binding.ownerId || prepared.datasetId !== binding.datasetId || prepared.policyEpoch !== binding.policyEpoch || prepared.sourcePermissionRevision !== binding.sourcePermissionRevision || [...leases.values()].some(value => value.prepared.command.command_id === prepared.command.command_id && !value.settled)) fail('LEASE_INVALID')
    const leaseId = crypto.randomUUID(), ready = deferred(), committed = deferred(), expiresAt = new Date(Math.min(Date.now() + leaseMilliseconds, Date.parse(prepared.expiresAt))).toISOString()
    committed.promise.catch(() => {})
    const lease = { ...entry, binding: structuredClone(binding), public: { ...binding, version: 1, leaseId, clientId: reg.client.id, registrationRevision: reg.client.revision, grantEpoch: reg.client.grant_epoch, expiresAt }, ready, committed, settled: false, work: null, timer: null }
    leases.set(leaseId, lease)
    const appProof = Object.freeze({ id: crypto.randomUUID() }); proofs.add(appProof)
    try {
      const approval = await entry.bridge.approve(prepared, appProof)
      lease.timer = setTimeout(() => { committed.reject(new Error('LEASE_EXPIRED')); ready.reject(new Error('LEASE_EXPIRED')) }, Math.max(1, Date.parse(expiresAt) - Date.now())); lease.timer.unref?.()
      lease.work = entry.bridge.execute(prepared, approval).then(result => { lease.settled = true; clearTimeout(lease.timer); current.results.push(result); ready.reject(new Error(result.state === 'applied' ? 'ALREADY_APPLIED' : 'APPLICATION_UNKNOWN')); return result }, error => { lease.settled = true; clearTimeout(lease.timer); ready.reject(error); throw error })
      lease.work.catch(() => {})
      return await ready.promise
    } catch (error) { clearTimeout(lease.timer); leases.delete(leaseId); throw error }
  }
  async function recordApplied(request) {
    if (!exact(request, ['leaseId', 'reference', 'receipt'])) fail('LEASE_INVALID')
    const lease = leases.get(request.leaseId)
    if (!lease || lease.binding.reference !== request.reference) fail('LEASE_INVALID')
    const actual = receiptFor(lease, await getReceipt(receiptKey(lease.prepared.command.command_id)))
    if (!actual || canonicalFileJSON(actual.application) !== canonicalFileJSON(request.receipt)) fail('RECEIPT_INVALID')
    lease.committed.resolve(actual.file)
    return lease.work
  }
  async function cancelApplication(request) {
    if (!exact(request, ['leaseId', 'reference'])) fail('LEASE_INVALID')
    const lease = leases.get(request.leaseId); if (!lease || lease.binding.reference !== request.reference) fail('LEASE_INVALID')
    const actual = receiptFor(lease, await getReceipt(receiptKey(lease.prepared.command.command_id)))
    if (actual) lease.committed.resolve(actual.file); else lease.committed.reject(new Error('APPLICATION_CANCELLED'))
    return lease.work
  }
  async function invalidate() {
    if (initializing) await initializing.catch(() => null)
    const active = connection, errors = []
    active?.bridge.clearAuthorities(); entries.clear()
    for (const lease of leases.values()) if (!lease.settled) {
      try {
        const actual = receiptFor(lease, await getReceipt(receiptKey(lease.prepared.command.command_id)))
        if (actual) lease.committed.resolve(actual.file); else lease.committed.reject(new Error('AUTHORITY_CHANGED'))
      } catch (error) { lease.committed.reject(new Error('RECEIPT_UNAVAILABLE')); errors.push(error) }
    }
    try { await active?.bridge.revoke() } catch (error) { errors.push(error) }
    finally { connection = null; try { await saveConfiguration(null) } catch (error) { errors.push(error) } }
    if (errors.length) throw new AggregateError(errors, '外部接続の取消中にエラーが発生しました')
  }
  async function disconnect(request, nativeProof) {
    if (!exact(request, ['clientId']) || !await verifyNativeProof('disconnect', request.clientId, nativeProof)) fail('HUMAN_APPROVAL_REQUIRED')
    if (connection && request.clientId !== connection.registration.client.id) fail('AUTHORITY_CHANGED')
    await invalidate(); return status()
  }
  return Object.freeze({ status, configure, disconnect, exportSnapshot, scanInbox, authorizeApplication, recordApplied, cancelApplication, invalidate })
}

module.exports = { createFileBridgeService }
