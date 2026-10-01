const fs = require('node:fs/promises')
const constants = require('node:fs').constants
const path = require('node:path')
const crypto = require('node:crypto')

const LIMIT = 256 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype)
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const string = (value, max = 200) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min
const uuid = value => typeof value === 'string' && UUID.test(value)
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
function fail(code, message) { const error = new Error(message || code); error.code = code; throw error }
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  fail('INVALID_JSON', '保存できないJSONです')
}
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex')
const bytesDigest = value => crypto.createHash('sha256').update(value).digest('hex')
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze) }; return value }
function date(value) { if (value === null) return true; if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00Z`); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value }
function validateRegistration(registration) {
  if (!exact(registration, ['schema_version', 'owner_id', 'dataset_id', 'policy_epoch', 'source_permission_revision', 'task_ids', 'client']) || registration.schema_version !== '1' || !string(registration.owner_id) || !uuid(registration.dataset_id) || !integer(registration.policy_epoch) || !integer(registration.source_permission_revision) || !Array.isArray(registration.task_ids) || registration.task_ids.length > 100 || registration.task_ids.some(id => !uuid(id)) || new Set(registration.task_ids).size !== registration.task_ids.length) fail('REGISTRATION_INVALID')
  const client = registration.client
  if (!exact(client, ['id', 'dataset_id', 'intended_host', 'transport', 'status', 'revision', 'grant_epoch', 'grant']) || !uuid(client.id) || client.dataset_id !== registration.dataset_id || !['chatgpt', 'claude', 'codex', 'claude_code', 'other'].includes(client.intended_host) || client.transport !== 'stdio' || client.status !== 'active' || !integer(client.revision, 1) || !integer(client.grant_epoch, 1)) fail('REGISTRATION_INVALID')
  const grant = client.grant
  const grantKeys = ['keys', 'project_ids', 'fields', 'mutation_mode', 'max_operations_per_day', 'max_schedule_shift_days', 'max_point_delta', 'allow_external_context', 'allow_handoffs', 'expires_at']
  if (!exact(grant, grantKeys) && !exact(grant, [...grantKeys, 'automation'])) fail('REGISTRATION_INVALID')
  if (!Array.isArray(grant.keys) || grant.keys.some(key => !['tasks:read', 'tasks:prepare', 'changes:submit', 'commands:read'].includes(key)) || new Set(grant.keys).size !== grant.keys.length || !Array.isArray(grant.project_ids) || grant.project_ids.length > 100 || grant.project_ids.some(id => !uuid(id)) || new Set(grant.project_ids).size !== grant.project_ids.length || !Array.isArray(grant.fields) || grant.fields.some(field => !['title', 'notes', 'scheduled_date'].includes(field)) || new Set(grant.fields).size !== grant.fields.length || !['require_approval', 'auto_within_bounds'].includes(grant.mutation_mode) || (grant.mutation_mode === 'auto_within_bounds') !== Object.hasOwn(grant, 'automation') || !integer(grant.max_operations_per_day) || grant.max_operations_per_day > 100 || !integer(grant.max_schedule_shift_days) || grant.max_schedule_shift_days > 31 || grant.max_point_delta !== 0 || grant.allow_external_context !== false || grant.allow_handoffs !== false || !timestamp(grant.expires_at)) fail('REGISTRATION_INVALID', 'このローカル接続は本人承認によるタイトル・メモ・予定日だけに対応しています')
  // Owner-delegated automatic application: notes/scheduled date only, inside stricter bounds than the grant.
  if (grant.mutation_mode === 'auto_within_bounds' && (!exact(grant.automation, ['max_schedule_shift_days', 'max_operations_per_day']) || !integer(grant.automation.max_schedule_shift_days) || grant.automation.max_schedule_shift_days > grant.max_schedule_shift_days || !integer(grant.automation.max_operations_per_day, 1) || grant.automation.max_operations_per_day > grant.max_operations_per_day || grant.fields.some(field => !['notes', 'scheduled_date'].includes(field)))) fail('REGISTRATION_INVALID', '範囲内の自動適用はメモと予定日だけに設定できます')
}
function parseEnvelope(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > LIMIT) fail('COMMAND_TOO_LARGE')
  let command
  try { command = JSON.parse(text) } catch { fail('INVALID_JSON') }
  if (!exact(command, ['schema_version', 'command_id', 'snapshot_id', 'expires_at', 'type', 'target_id', 'expected_revision', 'payload']) || command.schema_version !== '1' || !uuid(command.command_id) || !uuid(command.snapshot_id) || !timestamp(command.expires_at) || !object(command.payload)) fail('COMMAND_SCHEMA', 'コマンド形式が不正です。本文の承認・actor・SQL・権限は受け付けません')
  if (!['task.create', 'task.update'].includes(command.type)) fail('UNSUPPORTED_OPERATION', '手動点数・完了・取消・周期・ルーティンの操作は未対応です')
  const fields = Object.keys(command.payload)
  if (!fields.length || fields.some(field => !['title', 'notes', 'scheduled_date'].includes(field)) || command.type === 'task.update' && fields.includes('title')) fail('UNSUPPORTED_FIELD', 'メモと予定日の変更だけに対応しています')
  if (Object.hasOwn(command.payload, 'title') && !string(command.payload.title, 300) || Object.hasOwn(command.payload, 'notes') && (typeof command.payload.notes !== 'string' || command.payload.notes.length > 50000) || Object.hasOwn(command.payload, 'scheduled_date') && !date(command.payload.scheduled_date)) fail('INVALID_PAYLOAD')
  if (command.type === 'task.create') { if (command.target_id !== null || command.expected_revision !== null || !Object.hasOwn(command.payload, 'title')) fail('INVALID_TARGET') }
  else if (!uuid(command.target_id) || !integer(command.expected_revision, 1)) fail('INVALID_TARGET')
  return command
}

/** Main-process boundary. Credentials and human proof are supplied by the app, never inbox JSON. */
async function createLocalFileBridge({ root, journalDirectory, signingKey, registration, getCurrentContext, verifyHumanApproval, applyApprovedCommand, recoverReceipt }) {
  if (!Buffer.isBuffer(signingKey) || signingKey.length < 32 || !string(root, 4000) || !path.isAbsolute(root) || !string(journalDirectory, 4000) || !path.isAbsolute(journalDirectory) || typeof getCurrentContext !== 'function') fail('CONFIG_INVALID')
  validateRegistration(registration)
  const key = Buffer.from(signingKey), reg = freeze(structuredClone(registration)), rootPath = path.resolve(root), pending = new Map(), approvals = new WeakMap(), running = new Map()
  let claimQueue = Promise.resolve()
  const initial = await fs.lstat(rootPath)
  if (!initial.isDirectory() || initial.isSymbolicLink()) fail('UNSAFE_ROOT')
  const realRoot = await fs.realpath(rootPath)
  if (path.resolve(realRoot).toLowerCase() !== rootPath.toLowerCase()) fail('UNSAFE_ROOT')
  const journalRoot = path.resolve(journalDirectory)
  if (journalRoot.toLowerCase() === rootPath.toLowerCase() || journalRoot.toLowerCase().startsWith(`${rootPath.toLowerCase()}${path.sep}`)) fail('UNSAFE_JOURNAL', '再送防止の記録はagent用folderの外に保存してください')
  const journalStat = await fs.lstat(journalRoot)
  if (!journalStat.isDirectory() || journalStat.isSymbolicLink()) fail('UNSAFE_JOURNAL')
  const realJournal = await fs.realpath(journalRoot)
  if (path.resolve(realJournal).toLowerCase() !== journalRoot.toLowerCase()) fail('UNSAFE_JOURNAL')
  function sign(value) { return crypto.createHmac('sha256', key).update(canonical(value)).digest('hex') }
  function signed(value) { return { value, signature: sign(value) } }
  function verify(record) { if (!exact(record, ['value', 'signature']) || typeof record.signature !== 'string' || !/^[a-f0-9]{64}$/.test(record.signature)) fail('SIGNATURE_INVALID'); const expected = Buffer.from(sign(record.value), 'hex'), actual = Buffer.from(record.signature, 'hex'); if (!crypto.timingSafeEqual(expected, actual)) fail('SIGNATURE_INVALID'); return record.value }
  function resolve(relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes(':') || relative.includes('\\') || relative.split('/').some(piece => !piece || piece === '.' || piece === '..' || !/^[\w.-]+$/.test(piece))) fail('UNSAFE_PATH')
    const absolute = path.resolve(rootPath, ...relative.split('/'))
    if (absolute === rootPath || !absolute.startsWith(`${rootPath}${path.sep}`)) fail('UNSAFE_PATH')
    return absolute
  }
  async function safePath(relative, allowMissing = false) {
    const absolute = resolve(relative), currentRoot = await fs.lstat(rootPath)
    if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || await fs.realpath(rootPath) !== realRoot) fail('ROOT_CHANGED')
    let current = rootPath
    const parts = relative.split('/')
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index])
      try {
        const stat = await fs.lstat(current)
        if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) fail('UNSAFE_LINK')
        if (index < parts.length - 1 && !stat.isDirectory()) fail('UNSAFE_PATH')
        const real = await fs.realpath(current)
        if (!real.startsWith(`${realRoot}${path.sep}`)) fail('UNSAFE_PATH')
      } catch (error) { if (error.code === 'ENOENT' && allowMissing && index === parts.length - 1) return absolute; throw error }
    }
    return absolute
  }
  async function read(relative, maximum = LIMIT) {
    const absolute = await safePath(relative), before = await fs.lstat(absolute)
    if (!before.isFile() || before.size > maximum) fail('FILE_SIZE')
    const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) fail('FILE_CHANGED')
      const bytes = await handle.readFile(), after = await handle.stat()
      if (bytes.length > maximum || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || !samePath(await fs.realpath(absolute), absolute)) fail('FILE_CHANGED')
      await safePath(relative)
      return bytes
    } finally { await handle.close() }
  }
  async function write(relative, value, exclusive = false) {
    const absolute = await safePath(relative, true), text = canonical(value)
    if (Buffer.byteLength(text, 'utf8') > LIMIT) fail('FILE_SIZE')
    if (exclusive) { const handle = await fs.open(absolute, 'wx', 0o600); try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }; return }
    const parts = relative.split('/'), name = parts.pop(), temp = [...parts, `.${name}.${crypto.randomUUID()}.tmp`].join('/'), tempAbsolute = await safePath(temp, true)
    const handle = await fs.open(tempAbsolute, 'wx', 0o600)
    try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
    try { await safePath(relative, true); await safePath(temp); await fs.rename(tempAbsolute, absolute) } catch (error) { await fs.unlink(tempAbsolute).catch(() => {}); throw error }
  }
  async function privatePath(name, allowMissing = false) {
    if (!new RegExp(`^${UUID.source.slice(1, -1)}\\.(?:claim|result)\\.json$`, 'i').test(name)) fail('UNSAFE_JOURNAL')
    const stat = await fs.lstat(journalRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(journalRoot) !== realJournal) fail('UNSAFE_JOURNAL')
    const absolute = path.join(journalRoot, name)
    try { const file = await fs.lstat(absolute); if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || !samePath(await fs.realpath(absolute), absolute)) fail('UNSAFE_JOURNAL') } catch (error) { if (!(allowMissing && error.code === 'ENOENT')) throw error }
    return absolute
  }
  async function readPrivate(name) {
    const absolute = await privatePath(name), before = await fs.lstat(absolute), handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try { const stat = await handle.stat(); if (stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1 || stat.size > LIMIT) fail('UNSAFE_JOURNAL'); const bytes = await handle.readFile(), after = await handle.stat(); if (bytes.length > LIMIT || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) fail('FILE_CHANGED'); await privatePath(name); return verify(JSON.parse(bytes.toString('utf8'))) } finally { await handle.close() }
  }
  async function writePrivate(name, value, exclusive = false) {
    const absolute = await privatePath(name, true), text = canonical(signed(value))
    if (Buffer.byteLength(text, 'utf8') > LIMIT) fail('FILE_SIZE')
    const handle = await fs.open(absolute, exclusive ? 'wx' : 'w', 0o600)
    try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
  }
  async function authorize() {
    const context = await getCurrentContext(), client = reg.client
    if (!exact(context, ['ownerId', 'datasetId', 'clientId', 'policyEpoch', 'sourcePermissionRevision', 'registrationRevision', 'grantEpoch', 'enabled']) || context.ownerId !== reg.owner_id || context.datasetId !== reg.dataset_id || context.clientId !== client.id || context.policyEpoch !== reg.policy_epoch || context.sourcePermissionRevision !== reg.source_permission_revision || context.registrationRevision !== client.revision || context.grantEpoch !== client.grant_epoch || context.enabled !== true || Date.parse(client.grant.expires_at) <= Date.now()) fail('AUTHORITY_CHANGED', '本人・接続・データセット・利用許可または期限が変わりました')
    return context
  }
  for (const directory of ['views', 'inbox', 'results']) {
    const directoryPath = resolve(directory)
    await fs.mkdir(directoryPath, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    await safePath(directory)
  }
  await authorize()
  const regRecord = signed(reg)
  await write('registration.json', regRecord)
  async function currentRegistration() { await authorize(); try { await read('revoked.json'); fail('AUTHORITY_CHANGED') } catch (error) { if (error.code !== 'ENOENT') throw error }; const disk = verify(JSON.parse((await read('registration.json')).toString('utf8'))); if (canonical(disk) !== canonical(reg)) fail('REGISTRATION_CHANGED') }
  async function exportSnapshot(tasks) {
    await currentRegistration()
    if (!reg.client.grant.keys.includes('tasks:read') || !Array.isArray(tasks) || tasks.length > 100 || new Set(tasks.map(task => task.id)).size !== tasks.length) fail('SCOPE_DENIED')
    const views = tasks.map(task => {
      if (!object(task) || !uuid(task.id) || !reg.task_ids.includes(task.id) || !integer(task.revision, 1) || !string(task.title, 300) || typeof task.notes !== 'string' || task.notes.length > 50000 || !date(task.scheduledDate) || reg.client.grant.project_ids.length && !reg.client.grant.project_ids.includes(task.containerId)) fail('TASK_SCOPE')
      const view = { id: task.id, revision: task.revision }
      if (reg.client.grant.fields.includes('title')) view.title = task.title
      if (reg.client.grant.fields.includes('notes')) view.notes = task.notes
      if (reg.client.grant.fields.includes('scheduled_date')) view.scheduled_date = task.scheduledDate
      return view
    })
    const viewText = canonical(views), at = new Date().toISOString(), snapshotId = crypto.randomUUID()
    const manifest = { schema_version: '1', snapshot_id: snapshotId, owner_id: reg.owner_id, dataset_id: reg.dataset_id, client_id: reg.client.id, policy_epoch: reg.policy_epoch, source_permission_revision: reg.source_permission_revision, registration_revision: reg.client.revision, grant_epoch: reg.client.grant_epoch, generated_at: at, expires_at: new Date(Math.min(Date.now() + 24 * 60 * 60 * 1000, Date.parse(reg.client.grant.expires_at))).toISOString(), view_path: 'views/tasks.active.json', view_sha256: bytesDigest(viewText), entity_revisions: Object.fromEntries(views.map(task => [task.id, task.revision])), registration_sha256: digest(reg) }
    await write(manifest.view_path, views)
    await write('manifest.json', signed(manifest))
    return freeze(structuredClone(manifest))
  }
  async function manifestFor(command) {
    const manifest = verify(JSON.parse((await read('manifest.json')).toString('utf8')))
    if (!exact(manifest, ['schema_version', 'snapshot_id', 'owner_id', 'dataset_id', 'client_id', 'policy_epoch', 'source_permission_revision', 'registration_revision', 'grant_epoch', 'generated_at', 'expires_at', 'view_path', 'view_sha256', 'entity_revisions', 'registration_sha256']) || manifest.schema_version !== '1' || manifest.snapshot_id !== command.snapshot_id || manifest.owner_id !== reg.owner_id || manifest.dataset_id !== reg.dataset_id || manifest.client_id !== reg.client.id || manifest.policy_epoch !== reg.policy_epoch || manifest.source_permission_revision !== reg.source_permission_revision || manifest.registration_revision !== reg.client.revision || manifest.grant_epoch !== reg.client.grant_epoch || manifest.registration_sha256 !== digest(reg) || manifest.view_path !== 'views/tasks.active.json' || !timestamp(manifest.expires_at) || Date.parse(manifest.expires_at) <= Date.now() || !object(manifest.entity_revisions) || bytesDigest(await read(manifest.view_path)) !== manifest.view_sha256) fail('SNAPSHOT_INVALID')
    if (command.type === 'task.update' && (!reg.task_ids.includes(command.target_id) || manifest.entity_revisions[command.target_id] !== command.expected_revision)) fail('REVISION_CONFLICT')
    return manifest
  }
  async function readSnapshot() {
    await currentRegistration()
    const value = verify(JSON.parse((await read('manifest.json')).toString('utf8')))
    const manifest = await manifestFor({ snapshot_id: value.snapshot_id, type: 'task.create' })
    return freeze(structuredClone(manifest))
  }
  async function prepareCommand(filename) {
    await currentRegistration()
    if (typeof filename !== 'string' || !new RegExp(`^${UUID.source.slice(1, -1)}\\.ready\\.json$`, 'i').test(filename)) fail('COMMAND_FILENAME')
    const command = parseEnvelope((await read(`inbox/${filename}`)).toString('utf8'))
    if (`${command.command_id}.ready.json`.toLowerCase() !== filename.toLowerCase()) fail('COMMAND_FILENAME')
    if (Date.parse(command.expires_at) <= Date.now() || Date.parse(command.expires_at) > Date.now() + 24 * 60 * 60 * 1000 || Date.parse(command.expires_at) > Date.parse(reg.client.grant.expires_at)) fail('COMMAND_EXPIRED')
    const grant = reg.client.grant
    if (!grant.keys.includes('tasks:prepare') || !grant.keys.includes('changes:submit') || Object.keys(command.payload).some(field => !grant.fields.includes(field)) || !grant.max_operations_per_day) fail('SCOPE_DENIED')
    const commandDigest = digest({ command, owner_id: reg.owner_id, dataset_id: reg.dataset_id, client_id: reg.client.id, policy_epoch: reg.policy_epoch, source_permission_revision: reg.source_permission_revision, registration_revision: reg.client.revision, grant_epoch: reg.client.grant_epoch })
    const result = await resultFor(command.command_id).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (result && result.digest !== commandDigest) fail('IDEMPOTENCY_MISMATCH')
    if (result) return freeze({ state: 'finished', result })
    const manifest = await manifestFor(command)
    const view = JSON.parse((await read(manifest.view_path)).toString('utf8')).find(task => task.id === command.target_id)
    if (command.type === 'task.update' && Object.hasOwn(command.payload, 'scheduled_date') && command.payload.scheduled_date && view?.scheduled_date) {
      const days = Math.abs((Date.parse(command.payload.scheduled_date) - Date.parse(view.scheduled_date)) / 86400000)
      if (days > grant.max_schedule_shift_days) fail('SCHEDULE_BOUND')
    }
    const prepared = freeze({ state: 'awaiting_approval', command: structuredClone(command), digest: commandDigest, principal: { id: reg.client.id, kind: 'external-agent' }, ownerId: reg.owner_id, datasetId: reg.dataset_id, policyEpoch: reg.policy_epoch, sourcePermissionRevision: reg.source_permission_revision, snapshotId: manifest.snapshot_id, expectedRevision: command.expected_revision, expiresAt: command.expires_at })
    pending.set(command.command_id, prepared)
    return prepared
  }
  async function approve(prepared, appProof, automatic = false) {
    await currentRegistration()
    if (pending.get(prepared?.command?.command_id) !== prepared || Date.parse(prepared.expiresAt) <= Date.now() || typeof verifyHumanApproval !== 'function') fail('HUMAN_APPROVAL_REQUIRED')
    if (automatic && (reg.client.grant.mutation_mode !== 'auto_within_bounds' || prepared.command.type !== 'task.update' || Object.keys(prepared.command.payload).some(field => !['notes', 'scheduled_date'].includes(field)))) fail('AUTOMATION_NOT_GRANTED')
    const proofContext = { digest: prepared.digest, ownerId: reg.owner_id, datasetId: reg.dataset_id, clientId: reg.client.id, policyEpoch: reg.policy_epoch, sourcePermissionRevision: reg.source_permission_revision, expiresAt: prepared.expiresAt, automatic: automatic === true }
    if (await verifyHumanApproval(freeze(proofContext), appProof) !== true) fail('HUMAN_APPROVAL_REQUIRED')
    await currentRegistration(); await manifestFor(prepared.command); await unchangedCommand(prepared)
    const token = freeze({ id: crypto.randomUUID(), commandId: prepared.command.command_id, digest: prepared.digest })
    approvals.set(token, { prepared, used: false, automatic: automatic === true }); return token
  }
  async function resultFor(commandId) {
    if (!uuid(commandId)) fail('INVALID_COMMAND_ID')
    const result = await readPrivate(`${commandId}.result.json`)
    if (result.command_id !== commandId || result.owner_id !== reg.owner_id || result.dataset_id !== reg.dataset_id || result.client_id !== reg.client.id || !/^[a-f0-9]{64}$/.test(result.digest) || !['applied', 'failed', 'unknown'].includes(result.state)) fail('RESULT_INVALID')
    return result
  }
  async function unchangedCommand(prepared) {
    const latest = parseEnvelope((await read(`inbox/${prepared.command.command_id}.ready.json`)).toString('utf8'))
    if (canonical(latest) !== canonical(prepared.command)) fail('COMMAND_CHANGED', '確認後にコマンドが変更されました。新しい内容を再確認してください')
  }
  function validateReceipt(prepared, receipt) {
    if (!exact(receipt, ['commandId', 'digest', 'taskIds', 'appliedAt']) || receipt.commandId !== prepared.command.command_id || receipt.digest !== prepared.digest || !Array.isArray(receipt.taskIds) || receipt.taskIds.length !== 1 || receipt.taskIds.some(id => !uuid(id)) || !timestamp(receipt.appliedAt) || prepared.command.type === 'task.update' && receipt.taskIds[0] !== prepared.command.target_id) fail('RECEIPT_INVALID')
  }
  async function execute(prepared, token) {
    await currentRegistration()
    const flight = running.get(prepared?.command?.command_id)
    if (flight) {
      const approval = approvals.get(token)
      if (!approval || approval.prepared !== prepared || approval.used) fail('HUMAN_APPROVAL_REQUIRED')
      approval.used = true
      const result = await flight; await currentRegistration(); return result
    }
    const work = executeOnce(prepared, token)
    running.set(prepared?.command?.command_id, work)
    try { return await work } finally { running.delete(prepared?.command?.command_id) }
  }
  async function executeOnce(prepared, token) {
    await currentRegistration()
    const approval = approvals.get(token)
    if (!approval || approval.prepared !== prepared || pending.get(prepared.command.command_id) !== prepared || approval.used || Date.parse(prepared.expiresAt) <= Date.now() || typeof applyApprovedCommand !== 'function') fail('HUMAN_APPROVAL_REQUIRED')
    await manifestFor(prepared.command); await unchangedCommand(prepared)
    const prior = await resultFor(prepared.command.command_id).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (prior) { if (prior.digest !== prepared.digest) fail('IDEMPOTENCY_MISMATCH'); return prior }
    // Serialize only the quota check + durable reservation, never the callback
    // waiting for the renderer. A previous real receipt is recovery, not a new operation.
    const previous = claimQueue
    let release
    claimQueue = new Promise(resolve => { release = resolve })
    await previous
    let recovery = null
    try {
      await currentRegistration(); await manifestFor(prepared.command); await unchangedCommand(prepared)
      const name = `${prepared.command.command_id}.claim.json`
      const old = await readPrivate(name).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (old) {
        if (old.digest !== prepared.digest || old.owner_id !== reg.owner_id || old.dataset_id !== reg.dataset_id || old.client_id !== reg.client.id) fail('IDEMPOTENCY_MISMATCH')
        const recovered = typeof recoverReceipt === 'function' ? await recoverReceipt(prepared) : null
        if (recovered) validateReceipt(prepared, recovered)
        recovery = { receipt: recovered || null }
      } else {
        const claims = await fs.readdir(journalRoot)
        let today = 0
        for (const item of claims.filter(item => UUID.test(item.replace(/\.claim\.json$/, '')) && item.endsWith('.claim.json'))) { const record = await readPrivate(item); if (record.client_id === reg.client.id && record.started_at?.slice(0, 10) === new Date().toISOString().slice(0, 10)) today++ }
        if (today >= reg.client.grant.max_operations_per_day) fail('DAILY_BOUND')
        if (approval.automatic && await automaticClaimsToday() >= reg.client.grant.automation.max_operations_per_day) fail('AUTO_DAILY_BOUND')
        const claim = { command_id: prepared.command.command_id, digest: prepared.digest, owner_id: reg.owner_id, dataset_id: reg.dataset_id, client_id: reg.client.id, started_at: new Date().toISOString(), automatic: approval.automatic === true }
        await writePrivate(name, claim, true)
      }
    } finally { release() }
    if (recovery) { approval.used = true; return finish(prepared, recovery.receipt ? 'applied' : 'unknown', recovery.receipt) }
    approval.used = true
    try {
      await currentRegistration()
      const receipt = await applyApprovedCommand(prepared, token)
      validateReceipt(prepared, receipt)
      return finish(prepared, 'applied', receipt)
    } catch { return finish(prepared, 'unknown', null) }
  }
  async function finish(prepared, state, receipt) {
    const result = { schema_version: '1', command_id: prepared.command.command_id, digest: prepared.digest, owner_id: reg.owner_id, dataset_id: reg.dataset_id, client_id: reg.client.id, state, receipt: receipt || null, finished_at: new Date().toISOString() }
    try { await writePrivate(`${result.command_id}.result.json`, result, true) } catch (error) { if (error.code !== 'EEXIST') throw error; const existing = await readPrivate(`${result.command_id}.result.json`); if (canonical(existing) !== canonical(result)) fail('RESULT_MISMATCH') }
    await write(`results/${result.command_id}.json`, signed(result)); pending.delete(result.command_id); return freeze(result)
  }
  async function scanInbox() {
    await currentRegistration()
    const files = await fs.readdir(await safePath('inbox')), results = []
    for (const filename of files.filter(file => file.endsWith('.ready.json')).slice(0, 100)) {
      try { results.push({ filename, prepared: await prepareCommand(filename) }) } catch (error) { results.push({ filename, error: error.code || 'COMMAND_REJECTED' }) }
    }
    return results
  }
  async function automaticClaimsToday() {
    let count = 0
    for (const item of (await fs.readdir(journalRoot)).filter(name => name.endsWith('.claim.json') && UUID.test(name.replace(/\.claim\.json$/, '')))) { const record = await readPrivate(item); if (record.client_id === reg.client.id && record.automatic === true && record.started_at?.slice(0, 10) === new Date().toISOString().slice(0, 10)) count++ }
    return count
  }
  function clearAuthorities() { pending.clear() }
  async function revoke() { clearAuthorities(); await write('revoked.json', signed({ schema_version: '1', client_id: reg.client.id, dataset_id: reg.dataset_id, revoked_at: new Date().toISOString() })) }
  return Object.freeze({ exportSnapshot, readSnapshot, prepareCommand, approve, execute, scanInbox, readResult: async id => { await currentRegistration(); return resultFor(id) }, clearAuthorities, revoke })
}
module.exports = { createLocalFileBridge, parseEnvelope, canonicalFileJSON: canonical, fileCommandDigest: digest, validateFileBridgeRegistration: validateRegistration }
