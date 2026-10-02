const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { createFileBridgeService } = require('./file-bridge-service.cjs')
const { validateFileBridgeRegistration } = require('./local-file-bridge.cjs')
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
function fail(code) { const error = new Error(code); error.code = code; throw error }
/** Writes only a revocation marker to an app-selected old copy. It never mints a registration. */
async function revokeStoredCopy(agentDirectory, config) {
  const root = path.join(agentDirectory, config.registration.client.id)
  if (config.root !== root || !uuid(config.registration.client.id)) fail('CONFIG_INVALID')
  for (const directory of [agentDirectory, root]) {
    let stat; try { stat = await fs.lstat(directory) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(directory, await fs.realpath(directory)) !== '') fail('UNSAFE_LINK')
  }
  const before = await fs.lstat(root), target = path.join(root, 'revoked.json')
  try {
    const fd = await fs.open(target, 'wx', 0o600)
    try { await fd.writeFile(JSON.stringify({ revoked: true }), 'utf8'); await fd.sync() } finally { await fd.close() }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const stat = await fs.lstat(target); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('UNSAFE_LINK')
  }
  const after = await fs.lstat(root)
  if (before.ino !== after.ino || before.dev !== after.dev || after.isSymbolicLink() || path.relative(root, await fs.realpath(root)) !== '') fail('ROOT_CHANGED')
}

/** Independent coordinators own each client's folder, journal, scan references and leases.
 * Selection is presentation only: an already-issued reference always routes to its original coordinator. */
async function createFileBridgeHub(options) {
  const slots = new Map(), references = new Map(), leases = new Map()
  let state = { version: 2, selectedClientId: null, connections: [] }, queue = Promise.resolve(), generation = 0
  async function mutate(change) {
    const operation = queue.then(async () => { const next = change(structuredClone(state)); await options.saveConfiguration(next); state = next })
    queue = operation.catch(() => {}); return operation
  }
  const saved = await options.loadConfiguration()
  if (saved) {
    // Read-only migration: legacy grants are still subject to the new default-OFF switch.
    if (saved.root && saved.registration) state = { version: 2, selectedClientId: saved.registration.client.id, connections: [saved] }
    else state = saved
    if (!state || Object.keys(state).length !== 3 || state.version !== 2 || !Array.isArray(state.connections) || state.connections.length > 50 || state.selectedClientId !== null && !uuid(state.selectedClientId)) fail('CONFIG_INVALID')
    const ids = new Set()
    for (const config of state.connections) {
      if (!config || Object.keys(config).length !== 2) fail('CONFIG_INVALID')
      validateFileBridgeRegistration(config.registration)
      const id = config.registration.client.id
      if (!uuid(id) || ids.has(id) || config.root !== path.join(options.agentDirectory, id)) fail('CONFIG_INVALID')
      ids.add(id)
    }
    if (state.selectedClientId !== null && !ids.has(state.selectedClientId)) fail('CONFIG_INVALID')
  }
  async function newSlot(config = null) {
    const createdGeneration = generation
    const slot = { service: null, config, id: config?.registration.client.id ?? null, revoked: false, proofs: new Map() }
    slot.service = await createFileBridgeService({ ...options,
      getSettings: async () => { const settings = await options.getSettings(); return slot.revoked || createdGeneration !== generation ? { ...settings, externalAI: { ...settings.externalAI, enabled: false } } : settings },
      verifyNativeProof: async (kind, reference, nonce) => {
        const forwarded = slot.proofs.get(nonce); slot.proofs.delete(nonce)
        return forwarded ? forwarded.kind === kind && forwarded.reference === reference : options.verifyNativeProof(kind, reference, nonce)
      },
      loadConfiguration: async () => slot.config,
      saveConfiguration: async value => {
        const previousId = slot.id
        await mutate(current => {
          const replacing=current.connections.some(item=>item.registration.client.id===previousId)
          current.connections = current.connections.filter(item => item.registration.client.id !== previousId)
          if (value) { if (current.connections.length >= 50) fail('CONNECTION_LIMIT'); current.connections.push(value); if(!replacing||current.selectedClientId===previousId)current.selectedClientId = value.registration.client.id }
          else if (current.selectedClientId === previousId) current.selectedClientId = null
          return current
        })
        slot.config = value; slot.id = value?.registration.client.id ?? previousId
      }
    })
    return slot
  }
  async function getSlot(id) {
    if (!uuid(id)) fail('NOT_CONNECTED')
    if (!slots.has(id)) {
      const config = state.connections.find(item => item.registration.client.id === id)
      if (!config) fail('NOT_CONNECTED')
      // Reserve the promise before awaiting: simultaneous calls cannot duplicate a coordinator.
      slots.set(id, newSlot(config))
    }
    return slots.get(id)
  }
  const empty = () => ({ version: 1, available: true, connected: false, root: null, registration: null, snapshot: null, results: [], notice: '外部AIを許可し、共有するタスクを選んで接続してください。' })
  async function status() { await queue; return state.selectedClientId ? (await getSlot(state.selectedClientId)).service.status() : empty() }
  async function configure(request, proof) {
    await queue
    const expectedGeneration = generation
    if (state.connections.length >= 50) fail('CONNECTION_LIMIT')
    const slot = await newSlot()
    try { const result = await slot.service.configure(request, proof); if (expectedGeneration !== generation || !result.connected) fail('AUTHORITY_CHANGED'); slots.set(result.registration.client.id, Promise.resolve(slot)); return result }
    catch (error) { slot.revoked = true; await slot.service.invalidate().catch(() => {}); throw error }
  }
  async function selectClient(request) {
    if (!request || Object.keys(request).length !== 1 || !uuid(request.clientId)) fail('CONFIG_INVALID')
    const slot = await getSlot(request.clientId), result = await slot.service.status()
    if (!result.connected) fail('NOT_CONNECTED')
    await mutate(current => ({ ...current, selectedClientId: request.clientId })); return result
  }
  async function listConnections() {
    await queue
    const configs = [...state.connections], results = []
    for (const config of configs) results.push(await (await getSlot(config.registration.client.id)).service.status())
    return results.filter(result => result.connected)
  }
  async function disconnect(request, proof) {
    if (!request || Object.keys(request).length !== 1 || !uuid(request.clientId)) fail('CONFIG_INVALID')
    const slot = await getSlot(request.clientId)
    if (!await options.verifyNativeProof('disconnect', request.clientId, proof)) fail('HUMAN_APPROVAL_REQUIRED')
    // Stop new reads/leases before awaiting disk IO or a prior receipt query.
    slot.revoked = true
    const forwarded = crypto.randomUUID(), config = slot.config
    slot.proofs.set(forwarded, {kind:'disconnect',reference:request.clientId})
    try { return await slot.service.disconnect(request, forwarded) }
    finally {
      if (config) await revokeStoredCopy(options.agentDirectory, config)
      slots.delete(request.clientId)
      for (const [reference, value] of references) if (value === slot) references.delete(reference)
    }
  }
  async function revise(request,proof){
    if(!request||!uuid(request.clientId))fail('CONFIG_INVALID')
    const expectedGeneration=generation,slot=await getSlot(request.clientId);let changed=false
    try{const result=await slot.service.revise(request,proof);changed=true;if(generation!==expectedGeneration||slot.revoked||!result.connected)fail('AUTHORITY_CHANGED');return result}
    catch(error){if(!['REVISION_CONFLICT','CONFIG_INVALID','HUMAN_APPROVAL_REQUIRED','TASK_SCOPE','AUTOMATION_SCOPE','AUTOMATION_NOT_GRANTED','REGISTRATION_INVALID','REVISION_BUSY'].includes(error.code)){slot.revoked=true;await slot.service.invalidate().catch(()=>{})}throw error}
    finally{if(changed||slot.revoked){for(const [ref,value]of references)if(value===slot)references.delete(ref);for(const [id,value]of leases)if(value===slot)leases.delete(id)}}
  }
  async function invalidateClient(request){
    if(!request||Object.keys(request).length!==1||!uuid(request.clientId))fail('CONFIG_INVALID')
    const slot=await getSlot(request.clientId),config=slot.config;slot.revoked=true
    try{await slot.service.invalidate()}finally{if(config)await revokeStoredCopy(options.agentDirectory,config);slots.delete(request.clientId);for(const [ref,value]of references)if(value===slot)references.delete(ref);for(const [id,value]of leases)if(value===slot)leases.delete(id)}
  }
  async function invalidate() {
    generation++ // Every slot, including a configure still awaiting IO, fails closed immediately.
    const configs = [...state.connections], errors = []
    for (const pending of slots.values()) { const slot = await pending; slot.revoked = true }
    references.clear(); leases.clear()
    for (const config of configs) {
      const pending = slots.get(config.registration.client.id)
      try { if (pending) await (await pending).service.invalidate(); await revokeStoredCopy(options.agentDirectory, config) } catch (error) { errors.push(error) }
    }
    slots.clear()
    try { await mutate(() => ({ version: 2, selectedClientId: null, connections: [] })) } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, '外部接続の取消中にエラーが発生しました')
  }
  async function exportSnapshot(request) { const slot = await getSlot(state.selectedClientId); return slot.service.exportSnapshot(request) }
  async function scanInbox() {
    const slot = await getSlot(state.selectedClientId), result = await slot.service.scanInbox()
    for (const [reference, value] of references) if (value === slot) references.delete(reference)
    for (const entry of result.entries) if (entry.reference) references.set(entry.reference, slot)
    if (references.size > 5000) fail('INBOX_FULL')
    return result
  }
  const referenceSlot = request => { const slot = references.get(request?.reference); if (!slot || slot.revoked) fail('LEASE_INVALID'); return slot }
  async function authorize(method, request, proof) { if (leases.size >= 5000) fail('LEASE_LIMIT'); const slot = referenceSlot(request), lease = await slot.service[method](request, proof); leases.set(lease.leaseId, slot); return lease }
  async function finish(method, request) {
    const slot = leases.get(request?.leaseId)
    if (!slot || references.get(request.reference) !== slot) fail('LEASE_INVALID')
    try { return await slot.service[method](request) } finally { leases.delete(request.leaseId); references.delete(request.reference) }
  }
  // On startup, OFF/freeze/stops invalidate saved copies instead of leaving apparently live manifests.
  const initial = await options.getSettings()
  if (initial.externalAI?.enabled !== true || initial.externalAI.version !== 1 || initial.changePolicy?.aiChangesEnabled === false || initial.datasetMode && initial.datasetMode !== 'active') await invalidate()
  return Object.freeze({ status, configure, revise, selectClient, listConnections, disconnect, invalidate, invalidateClient, exportSnapshot, scanInbox,
    commandResult: async request => { if (!request || Object.keys(request).length!==2 || !uuid(request.clientId) || !uuid(request.commandId)) fail('COMMAND_ID_INVALID'); return (await getSlot(request.clientId)).service.commandResult(request.commandId) },
    clientStatus: async request => { if (!request || Object.keys(request).length!==1 || !uuid(request.clientId)) fail('CONFIG_INVALID'); return (await getSlot(request.clientId)).service.status() },
    authorizeApplication: (request, proof) => authorize('authorizeApplication', request, proof),
    authorizeAutomaticApplication: request => authorize('authorizeAutomaticApplication', request),
    recordApplied: request => finish('recordApplied', request), cancelApplication: request => finish('cancelApplication', request),
    recordRejected: async request => { const slot = referenceSlot(request); try { return await slot.service.recordRejected(request) } finally { references.delete(request.reference) } }
  })
}
module.exports = { createFileBridgeHub, revokeStoredCopy }
