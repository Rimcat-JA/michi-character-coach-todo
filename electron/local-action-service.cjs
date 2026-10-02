const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { createLocalActionService, signLocalActionRequest, verifyLocalActionResult } = require('./local-actions.cjs')
const { createLocalActionTriggers, validateAutomation } = require('./local-action-triggers.cjs')
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
function fail(code) { const error = new Error(code); error.code = code; throw error }
function canonical(value) { if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; fail('INVALID_INPUT') }
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex')
const policy = settings => settings.changePolicy ?? { epoch: 0, sourcePermissionRevision: 0, aiChangesEnabled: true, taskUpdate: 'require_approval' }
// N09 local_action.run; older settings without an operation table keep the taskUpdate=deny rule.
const actionsDenied = p => Array.isArray(p.operations) ? p.operations.find(rule => rule?.operation === 'local_action.run')?.mode !== 'require_approval' : p.taskUpdate === 'deny'
const receiptKey = requestId => `localaction:result:${requestId}`
function validateInput(input) {
  if (!exact(input, ['title', 'executable', 'cwd', 'argv', 'schema']) || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120 || typeof input.executable !== 'string' || input.executable.length > 4000 || !path.isAbsolute(input.executable) || typeof input.cwd !== 'string' || input.cwd.length > 4000 || !path.isAbsolute(input.cwd) || !Array.isArray(input.argv) || input.argv.length > 64 || !input.schema || typeof input.schema !== 'object' || Array.isArray(input.schema) || Object.keys(input.schema).length > 16) fail('DEFINITION_INVALID')
  for (const [name, rule] of Object.entries(input.schema)) {
    if (!token(name) || !rule || typeof rule !== 'object') fail('DEFINITION_INVALID')
    if (rule.type === 'string') { if (!exact(rule, ['type', 'enum', 'maxLength']) || !Number.isInteger(rule.maxLength) || rule.maxLength < 1 || rule.maxLength > 300 || !Array.isArray(rule.enum) || !rule.enum.length || rule.enum.length > 16 || new Set(rule.enum).size !== rule.enum.length || rule.enum.some(value => typeof value !== 'string' || !value || value.length > rule.maxLength || /^[\s-]|[\0\r\n;&|<>`$]/.test(value))) fail('DEFINITION_INVALID') }
    else if (rule.type === 'number') { if (!exact(rule, ['type', 'min', 'max']) || !Number.isSafeInteger(rule.min) || !Number.isSafeInteger(rule.max) || rule.min < 0 || rule.max > 1000000 || rule.min > rule.max) fail('DEFINITION_INVALID') }
    else if (rule.type === 'boolean') { if (!exact(rule, ['type'])) fail('DEFINITION_INVALID') }
    else fail('DEFINITION_INVALID')
  }
  if (input.argv.some(arg => typeof arg === 'string' ? arg.length > 4096 || /[\0\r\n]/.test(arg) || /^(?:-[ec]|--eval|--command|-command|-encodedcommand|\/c|\/k)$/i.test(arg) : !exact(arg, ['param']) || !token(arg.param) || !Object.hasOwn(input.schema, arg.param))) fail('UNSAFE_ARGUMENT')
  // Interpreter definitions expose only built-in help/version; literal scripts
  // and eval programs are not part of this UI's registered-action capability.
  if (/^(?:node|python(?:3(?:\.\d+)?)?|ruby|perl|php|lua|deno|bun)(?:\.exe)?$/i.test(path.basename(input.executable)) && (Object.keys(input.schema).length || !input.argv.length || input.argv.some(arg => typeof arg !== 'string' || !['--version', '--help', '-v', '-V', '/?'].includes(arg)))) fail('UNSAFE_EXECUTABLE')
}
async function inspectExecutable(executable) {
  const resolved = path.resolve(executable), root = path.parse(resolved).root
  if (process.platform === 'win32' && (/^[\\/]{2}/.test(resolved) || resolved.slice(2).includes(':') || path.extname(resolved).toLowerCase() !== '.exe')) fail('INVALID_PATH')
  let current = root
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); const stat = await fs.lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) fail('UNSAFE_PATH_LINK') }
  const stat = await fs.lstat(resolved)
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024 || path.relative(resolved, await fs.realpath(resolved)) !== '') fail('INVALID_PATH')
  const handle = await fs.open(resolved, 'r')
  try { const before = await handle.stat(), bytes = await handle.readFile(), after = await handle.stat(); if (before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('EXECUTABLE_CHANGED'); return crypto.createHash('sha256').update(bytes).digest('hex') } finally { await handle.close() }
}
function primitiveDefinition(def) { const { title: _title, automation, ...registration } = def; return {...registration,...(automation?.lowRisk?{lowRisk:true,delegation:{ownerId:def.ownerId,policyEpoch:automation.policyEpoch,sourcePermissionRevision:automation.sourcePermissionRevision,events:automation.events,expiresAt:automation.expiresAt}}:{})} }
/** No caller gets a signing key or controls owner, nonce, identity, command or approval. */
async function createLocalActionCoordinator({ signingKey, journalDirectory, deviceId, getSettings, getReceipt, loadConfiguration, saveConfiguration, loadResults, saveResults, verifyNativeProof, getFact=async()=>null, loadTriggers=async()=>[], saveTriggers=async()=>{}, spawn, now = Date.now }) {
  if (!Buffer.isBuffer(signingKey) || signingKey.length !== 32 || !token(deviceId)) fail('CONFIG_INVALID')
  let configuration = null, service = null, loaded = false, history = [], queue = Promise.resolve()
  const inspections = new Map(), requests = new Map(), proofs = new WeakSet()
  async function context() { const settings = await getSettings(), p = policy(settings); return { ownerId: settings.profileId, datasetId: settings.datasetId, deviceId, policyEpoch: p.epoch, sourcePermissionRevision: p.sourcePermissionRevision, enabled: Boolean(configuration && (!settings.datasetMode||settings.datasetMode==='active') && settings.aiEnabled && p.aiChangesEnabled && !actionsDenied(p) && configuration.ownerId === settings.profileId && configuration.datasetId === settings.datasetId && configuration.policyEpoch === p.epoch && configuration.sourcePermissionRevision === p.sourcePermissionRevision) } }
  async function create(config) { return createLocalActionService({ signingKey, journalDirectory, registrations: config.definitions.map(primitiveDefinition), getCurrentContext: context, verifyHumanApproval: (_review, proof) => proofs.has(proof), ...(spawn ? { spawn } : {}), now }) }
  async function ensure() {
    if (loaded) return
    const saved = await loadConfiguration(), results = await loadResults()
    if (!Array.isArray(results) || results.length > 100 || results.some(result => !verifyLocalActionResult(result, signingKey))) fail('HISTORY_INVALID')
    history = results
    if (saved) {
      if (!exact(saved, ['version', 'ownerId', 'datasetId', 'deviceId', 'policyEpoch', 'sourcePermissionRevision', 'definitions']) || saved.version !== 1 || saved.deviceId !== deviceId || !Array.isArray(saved.definitions) || saved.definitions.length > 20) fail('CONFIG_INVALID')
      for (const def of saved.definitions) { if (!exact(def, ['title', 'executable', 'cwd', 'argv', 'schema', 'id', 'revision', 'ownerId', 'datasetId', 'deviceId', 'executableRoot', 'sha256',...(def.automation?['automation']:[])]) || def.ownerId !== saved.ownerId || def.datasetId !== saved.datasetId || def.deviceId !== deviceId) fail('CONFIG_INVALID'); validateInput({ title: def.title, executable: def.executable, cwd: def.cwd, argv: def.argv, schema: def.schema });if(def.automation)validateAutomation(def.automation,{now:now(),allowExpired:true}) }
      configuration = structuredClone(saved)
      try { service = await create(configuration) } catch (error) { configuration = null; service = null; await saveConfiguration(null); throw error }
    }
    loaded = true
  }
  async function invalidate() { await ensure(); service?.clearAuthorities(); service = null; configuration = null; inspections.clear(); requests.clear(); triggers.clear();await saveConfiguration(null) }
  async function status() {
    await ensure()
    const c = await context()
    if (configuration && !c.enabled) await invalidate()
    return { version: 1, available: true, enabled: (await context()).enabled, ownerId: c.ownerId, datasetId: c.datasetId, deviceId, definitions: configuration?.definitions.map(def => structuredClone(def)) ?? [], results: history.filter(result => result.ownerId === c.ownerId && result.datasetId === c.datasetId).map(result => structuredClone(result)), pending:[...requests.entries()].filter(([_id,r])=>r.envelope.event!=='owner-click'&&!r.result&&r.review.expiresAt>now()).map(([reference,r])=>({version:1,reference,event:r.envelope.event,review:structuredClone(r.review)})),runs:await triggers.runs(), notice: '固定操作は本人が確認します。自動実行は別途確認したイベント・固定引数・期限・回数だけ。タスクの完了・ポイント加算には使いません。過去のイベントは再実行しません。' }
  }
  async function inspectDefinition(input, nativeProof) {
    if (!await verifyNativeProof('configure', 'inspect', nativeProof)) fail('HUMAN_APPROVAL_REQUIRED')
    await ensure(); validateInput(input)
    const settings = await getSettings(), p = policy(settings)
    if (!settings.aiEnabled || !p.aiChangesEnabled || actionsDenied(p)) fail('LOCAL_ACTIONS_DISABLED')
    const definition = { ...structuredClone(input), id: crypto.randomUUID(), revision: 1, ownerId: settings.profileId, datasetId: settings.datasetId, deviceId, executableRoot: path.dirname(path.resolve(input.executable)), sha256: await inspectExecutable(input.executable) }
    // Registration validation verifies executable identity, cwd and typed argv;
    // constructing the primitive never launches an executable.
    await create({ definitions: [definition] })
    const payload = { version: 1, reference: crypto.randomUUID(), ownerId: settings.profileId, datasetId: settings.datasetId, deviceId, policyEpoch: p.epoch, sourcePermissionRevision: p.sourcePermissionRevision, definition, expiresAt: now() + 5 * 60000 }, inspected = { ...payload, digest: digest(payload) }
    inspections.set(inspected.reference, inspected)
    return structuredClone(inspected)
  }
  async function mutate(work) { const previous = queue; let release; queue = new Promise(resolve => { release = resolve }); await previous; try { return await work() } finally { release() } }
  async function configure(request, nativeProof) {
    if (!exact(request, ['reference', 'digest']) || !await verifyNativeProof('configure', request.reference, nativeProof)) fail('HUMAN_APPROVAL_REQUIRED')
    await ensure()
    return mutate(async () => {
      const inspected = inspections.get(request.reference), settings = await getSettings(), p = policy(settings)
      if (!inspected || inspected.digest !== request.digest || inspected.expiresAt <= now() || inspected.ownerId !== settings.profileId || inspected.datasetId !== settings.datasetId || inspected.policyEpoch !== p.epoch || inspected.sourcePermissionRevision !== p.sourcePermissionRevision || !settings.aiEnabled || !p.aiChangesEnabled || actionsDenied(p)) fail('AUTHORITY_CHANGED')
      const sameScope = configuration?.ownerId === settings.profileId && configuration?.datasetId === settings.datasetId && configuration?.policyEpoch === p.epoch && configuration?.sourcePermissionRevision === p.sourcePermissionRevision
      const defs = sameScope ? configuration.definitions : []
      if (defs.length >= 20) fail('DEFINITION_LIMIT')
      const next = { version: 1, ownerId: settings.profileId, datasetId: settings.datasetId, deviceId, policyEpoch: p.epoch, sourcePermissionRevision: p.sourcePermissionRevision, definitions: [...defs, structuredClone(inspected.definition)] }
      const nextService = await create(next)
      const latest = await getSettings(), latestPolicy = policy(latest)
      if (!latest.aiEnabled || !latestPolicy.aiChangesEnabled || actionsDenied(latestPolicy) || latest.profileId !== next.ownerId || latest.datasetId !== next.datasetId || latestPolicy.epoch !== next.policyEpoch || latestPolicy.sourcePermissionRevision !== next.sourcePermissionRevision) fail('AUTHORITY_CHANGED')
      await saveConfiguration(next); service?.clearAuthorities(); configuration = next; service = nextService; requests.clear(); inspections.delete(request.reference)
      return status()
    })
  }
  async function remove(request, nativeProof) {
    if (!exact(request, ['actionId']) || !await verifyNativeProof('configure', `remove:${request.actionId}`, nativeProof)) fail('HUMAN_APPROVAL_REQUIRED')
    await ensure()
    return mutate(async () => {
      if (!configuration || !(await context()).enabled || !configuration.definitions.some(def => def.id === request.actionId)) fail('UNREGISTERED_ACTION')
      const next = { ...configuration, definitions: configuration.definitions.filter(def => def.id !== request.actionId) }, nextService = await create(next)
      await saveConfiguration(next); service.clearAuthorities(); configuration = next; service = nextService; requests.clear(); inspections.clear()
      return status()
    })
  }
  async function prepare(input) {
    if (!exact(input, ['actionId', 'event', 'params']) || input.event !== 'owner-click' || !token(input.actionId) || !input.params || typeof input.params !== 'object' || Array.isArray(input.params) || Object.keys(input.params).length > 16 || Object.values(input.params).some(value => !['string', 'number', 'boolean'].includes(typeof value))) fail('INVALID_INPUT')
    await ensure(); const c = await context(), def = configuration?.definitions.find(value => value.id === input.actionId)
    if (!c.enabled || !service || !def) fail('UNREGISTERED_ACTION')
    for (const [name, rule] of Object.entries(def.schema)) if (rule.type === 'number' && !Number.isSafeInteger(input.params[name])) fail('INVALID_ARGUMENT')
    for (const [key, entry] of requests) if (entry.envelope.expiresAt <= now()) requests.delete(key)
    if (requests.size >= 100) fail('REQUEST_LIMIT')
    const stamp = now(), envelope = signLocalActionRequest({ version: 1, requestId: crypto.randomUUID(), nonce: crypto.randomUUID(), issuedAt: stamp, expiresAt: stamp + 60000, ownerId: c.ownerId, datasetId: c.datasetId, deviceId, policyEpoch: c.policyEpoch, sourcePermissionRevision: c.sourcePermissionRevision, definitionRevision: def.revision, actionId: def.id, event: input.event, params: structuredClone(input.params) }, signingKey)
    const review = await service.prepare(envelope), reference = crypto.randomUUID()
    if (!review.approvalRequired) fail('AUTOMATIC_EXECUTION_DISABLED')
    requests.set(reference, { envelope, review, service, result: null, flight: null })
    return { version: 1, reference, event: input.event, review }
  }
  async function execute(input, nativeProof) {
    if (!exact(input, ['reference', 'digest']) || !await verifyNativeProof('approve', input.reference, nativeProof)) fail('HUMAN_APPROVAL_REQUIRED')
    await ensure(); const entry = requests.get(input.reference)
    if (!entry || entry.review.digest !== input.digest || entry.service !== service || !(await context()).enabled) fail('UNVERIFIED_REQUEST')
    if (entry.result) return structuredClone(entry.result)
    if (entry.flight) return entry.flight
    entry.flight = (async () => {
      const proof = Object.freeze({ id: crypto.randomUUID() }); proofs.add(proof)
      const grant = await service.approve(entry.envelope, proof), result = await service.execute(entry.envelope, grant)
      if (!verifyLocalActionResult(result, signingKey)) fail('RESULT_INVALID')
      entry.result = result
      await remember(result)
      return structuredClone(result)
    })()
    try { return await entry.flight } finally { entry.flight = null }
  }
  async function recordReceipt(input) {
    if (!exact(input, ['requestId', 'digest'])) fail('INVALID_INPUT')
    await ensure(); const result = history.find(item => item.requestId === input.requestId && item.digest === input.digest)
    const stored = await getReceipt(receiptKey(input.requestId))
    if (!result || !stored || stored.hash !== result.digest || typeof stored.resultId !== 'string') fail('RECEIPT_MISSING')
    let value; try { value = JSON.parse(stored.resultId) } catch { fail('RECEIPT_INVALID') }
    if (canonical(value) !== canonical(result) || stored.at !== new Date(result.completedAt).toISOString()) fail('RECEIPT_INVALID')
  }
  async function remember(result){if(!verifyLocalActionResult(result,signingKey))fail('RESULT_INVALID');history=[...history.filter(r=>r.requestId!==result.requestId),result].slice(-100);try{await saveResults(history)}catch{/* The signed primitive journal remains authoritative. */}}
  async function replaceConfiguration(next){const nextService=await create(next),c=await context();if(!c.enabled||next.ownerId!==c.ownerId||next.datasetId!==c.datasetId||next.policyEpoch!==c.policyEpoch||next.sourcePermissionRevision!==c.sourcePermissionRevision)fail('AUTHORITY_CHANGED');await saveConfiguration(next);service?.clearAuthorities();configuration=next;service=nextService;requests.clear()}
  const triggers=createLocalActionTriggers({now,ensure,context,getConfiguration:()=>configuration,replaceConfiguration,getService:()=>service,getFact,loadTriggers,saveTriggers,verifyNativeProof,mutate,signRequest:value=>signLocalActionRequest(value,signingKey),remember,deviceId,verifyResult:result=>verifyLocalActionResult(result,signingKey),prepareNative:async(envelope,review)=>{for(const [id,r]of requests)if(r.review.expiresAt<=now()&&!r.flight)requests.delete(id);const reference='trigger:'+envelope.requestId;if(!requests.has(reference)){if(requests.size>=100)fail('PENDING_LIMIT');requests.set(reference,{envelope,review,service,result:null,flight:null})}return {version:1,reference,event:envelope.event,review}}})
  return Object.freeze({ status, inspectDefinition, configure, remove, prepare, execute, recordReceipt, invalidate,inspectAutomation:triggers.inspectAutomation,configureAutomation:triggers.configureAutomation,revokeAutomation:triggers.revokeAutomation,trigger:triggers.trigger })
}
module.exports = { createLocalActionCoordinator, validateLocalActionDefinitionInput: validateInput }
