const crypto = require('node:crypto')
const { createPrivateJSONStore } = require('./private-json-store.cjs')
const { scheduleURL } = require('./schedule-network.cjs')
const EVENTS = ['task.created', 'task.completed', 'task.reopened']
const RETRY_MINUTES = [1, 2, 4, 8, 16, 30]
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
function fail(code) { throw Object.assign(new Error(code), { code }) }
function webhookURL(value, loopback) {
  if (typeof value !== 'string' || typeof loopback !== 'boolean') fail('WEBHOOK_URL_INVALID')
  let url; try { url = new URL(value) } catch { fail('WEBHOOK_URL_INVALID') }
  if (loopback && url.protocol === 'http:' && url.hostname === 'localhost') url.hostname = '127.0.0.1'
  return scheduleURL(url.href, loopback)
}
function signature(secret, timestamp, rawBody) { return 't=' + timestamp + ',v1=' + crypto.createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex') }
function retryDelay(attempts, retryAfter, now) {
  const base = RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)] * 60000
  let advised = /^\d+$/.test(retryAfter ?? '') ? Number(retryAfter) * 1000 : Date.parse(retryAfter ?? '') - now
  if (!Number.isFinite(advised) || advised < 0) advised = 0
  return Math.max(base, Math.min(advised, 86400000))
}
async function createWebhookService({ directory, safeStorage, gateway, getContext, readDatabase, verifyNativeProof, now = Date.now }) {
  const store = await createPrivateJSONStore({ directory, safeStorage, maxBytes: 1024 * 1024 })
  let config = null, queue = Promise.resolve(), busy = false
  const serialize = action => { const work = queue.then(action); queue = work.catch(() => {}); return work }
  async function load() {
    if (config) return
    const c = await store.load('config.bin', { version: 1, subscriptions: [] })
    if (!exact(c, ['version', 'subscriptions']) || c.version !== 1 || !Array.isArray(c.subscriptions) || c.subscriptions.length > 50 || c.subscriptions.some(s => !exact(s, ['id','url','events','includeTitle','loopback','secret','createdAt','revokedAt','ownerId','datasetId','policyEpoch','sourcePermissionRevision']) || !uuid(s.id) || !uuid(s.ownerId) || !uuid(s.datasetId) || !/^[a-f0-9]{64}$/.test(s.secret) || !Array.isArray(s.events) || !s.events.length || new Set(s.events).size !== s.events.length || s.events.some(e => !EVENTS.includes(e)) || typeof s.includeTitle !== 'boolean' || !Number.isFinite(Date.parse(s.createdAt)) || s.revokedAt !== null && !Number.isFinite(Date.parse(s.revokedAt)) || !Number.isSafeInteger(s.policyEpoch) || s.policyEpoch < 0 || !Number.isSafeInteger(s.sourcePermissionRevision) || s.sourcePermissionRevision < 0 || webhookURL(s.url, s.loopback).href !== s.url)) fail('WEBHOOK_CONFIG_INVALID')
    config = c
  }
  async function context() {
    const { settings: s, datasetState } = await getContext(), p = s?.changePolicy
    // Legacy settings have no operation table. A present but incomplete/invalid table
    // must not grant the external.write capability by omission.
    const externalAllowed = p?.operations === undefined || Array.isArray(p.operations) && p.operations.filter(rule => rule?.operation === 'external.write').length === 1 && p.operations.find(rule => rule?.operation === 'external.write').mode === 'require_approval'
    return { ownerId: s?.profileId, datasetId: s?.datasetId, policyEpoch: p?.epoch ?? 0, sourcePermissionRevision: p?.sourcePermissionRevision ?? 0, enabled: !!s && s.aiEnabled === true && p?.aiChangesEnabled !== false && externalAllowed && (datasetState?.mode ?? 'active') === 'active' }
  }
  const matches = (s, c) => s.ownerId === c.ownerId && s.datasetId === c.datasetId && s.policyEpoch === c.policyEpoch && s.sourcePermissionRevision === c.sourcePermissionRevision
  const publicSub = ({ secret: _secret, ...s }) => structuredClone(s)
  async function add(input, proof) {
    if (!exact(input, ['url','events','includeTitle','loopback']) || !await verifyNativeProof('add', proof)) fail('HUMAN_APPROVAL_REQUIRED')
    if (!Array.isArray(input.events) || !input.events.length || input.events.length > 3 || new Set(input.events).size !== input.events.length || input.events.some(e => !EVENTS.includes(e)) || typeof input.includeTitle !== 'boolean') fail('WEBHOOK_INPUT_INVALID')
    const url = webhookURL(input.url, input.loopback)
    return serialize(async () => {
      await load(); const c = await context(); if (!c.enabled || !uuid(c.ownerId) || !uuid(c.datasetId)) fail('AUTHORITY_CHANGED')
      if (config.subscriptions.length >= 50) fail('WEBHOOK_LIMIT')
      const secret = crypto.randomBytes(32).toString('hex'), sub = { id: crypto.randomUUID(), url: url.href, events: [...input.events], includeTitle: input.includeTitle, loopback: input.loopback, secret, createdAt: new Date(now()).toISOString(), revokedAt: null, ownerId: c.ownerId, datasetId: c.datasetId, policyEpoch: c.policyEpoch, sourcePermissionRevision: c.sourcePermissionRevision }
      const next = { ...config, subscriptions: [...config.subscriptions, sub] }; await store.save('config.bin', next); config = next
      return { subscription: publicSub(sub), secret }
    })
  }
  async function revoke(id = null) { return serialize(async () => { await load(); if (id !== null && !uuid(id)) fail('WEBHOOK_ID_INVALID'); const next = { ...config, subscriptions: config.subscriptions.map(s => id === null || s.id === id ? { ...s, revokedAt: new Date(now()).toISOString() } : s) }; await store.save('config.bin', next); config = next; return true }) }
  const filename = (sub, event) => 'd-' + sub.id + '-' + event.id + '.bin'
  const publicDelivery = d => ({ id: d.id, subscriptionId: d.subscriptionId, eventId: d.eventId, event: d.event, state: d.state, attempts: d.attempts, nextAt: d.nextAt, updatedAt: d.updatedAt, ...(d.httpStatus ? { httpStatus: d.httpStatus } : {}), ...(d.error ? { error: d.error } : {}) })
  async function records() {
    const names = (await store.list()).filter(name => /^d-[a-f0-9-]{36}-[a-f0-9-]{36}\.bin$/i.test(name)), rows = []
    for (const name of names) { const row = await store.load(name); if (!row || filename({ id: row.subscriptionId }, { id: row.eventId }) !== name || !uuid(row.id) || !uuid(row.eventId) || !uuid(row.subscriptionId) || !Number.isInteger(row.attempts) || row.attempts < 0 || row.attempts > 7 || !['in_flight','retrying','unknown','delivered','rejected','blocked_by_policy','cancelled','exhausted'].includes(row.state) || !/^[a-f0-9]{64}$/.test(row.digest)) fail('WEBHOOK_JOURNAL_INVALID'); rows.push(row) }
    return rows
  }
  async function status() { await queue; await load(); const c = await context(), history = await records(), settled = new Set(history.filter(d=>['delivered','rejected','cancelled','exhausted'].includes(d.state)).map(d=>d.subscriptionId+':'+d.eventId)), rows = await readDatabase('integrationOutbox',null); return { subscriptions: config.subscriptions.map(s => ({ ...publicSub(s), active: c.enabled && !s.revokedAt && matches(s,c) })), deliveries: history.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0,100).map(publicDelivery), settledEventIds:rows.filter(row=>rowValid(row)&&row.subscriptionIds.every(id=>settled.has(id+':'+row.id))).map(row=>row.id), notice: '秘密は端末内に保存します。通知はID・日時・ポイントのみ（タイトルは個別の明示許可時だけ）。送信結果が不明な場合は成功にしません。通常イベントは初回＋最大6回の再送。試験用pingは一回だけ送ります。同じイベントIDで受信側が重複を拒否します。' } }
  function rowValid(row) {
    const p = row?.payload
    return exact(row,['id','at','state','subscriptionIds','payload','ownerId','datasetId','policyEpoch','sourcePermissionRevision']) && uuid(row.id) && row.state === 'pending' && Number.isFinite(Date.parse(row.at)) && uuid(row.ownerId) && uuid(row.datasetId) && Number.isSafeInteger(row.policyEpoch) && Number.isSafeInteger(row.sourcePermissionRevision) && Array.isArray(row.subscriptionIds) && row.subscriptionIds.length <= 50 && row.subscriptionIds.every(uuid) && (exact(p,['id','type','occurred_at','task_id','dataset_id','points']) || exact(p,['id','type','occurred_at','task_id','dataset_id','points','title'])) && p.id === row.id && p.occurred_at === row.at && EVENTS.includes(p.type) && uuid(p.task_id) && p.dataset_id === row.datasetId && (p.points === null || Number.isInteger(p.points) && p.points >= 0 && p.points <= 100000) && (p.title === undefined || typeof p.title === 'string' && p.title.length <= 300)
  }
  async function deliver(sub, row, ping = false) {
    const payload = structuredClone(row.payload); if (!sub.includeTitle) delete payload.title
    const body = JSON.stringify(payload), name = filename(sub,row), hash = digest(body)
    let previous = await store.load(name), state = previous ?? { id: crypto.randomUUID(), subscriptionId: sub.id, eventId: row.id, event: payload.type, state: 'retrying', attempts: 0, nextAt: null, updatedAt: new Date(now()).toISOString(), digest: hash }
    if (state.digest !== hash || state.subscriptionId !== sub.id || state.eventId !== row.id) fail('WEBHOOK_EVENT_CHANGED')
    const save = async changes => { state = { ...state, ...changes, updatedAt: new Date(now()).toISOString() }; await store.save(name,state); return publicDelivery(state) }
    if (['delivered','rejected','cancelled','exhausted'].includes(state.state)) return publicDelivery(state)
    const c = await context()
    if (!c.enabled || sub.revokedAt || !matches(sub,c) || !matches(row,c) || !ping && (!sub.events.includes(payload.type) || row.at < sub.createdAt)) return save({ state: 'cancelled', error: 'AUTHORITY_CHANGED', nextAt: null })
    if (state.state === 'in_flight') return save({ state: 'unknown', error: 'INTERRUPTED_DELIVERY', nextAt: now() + retryDelay(state.attempts,null,now()) })
    if (state.nextAt && state.nextAt > now()) return publicDelivery(state)
    if (state.attempts >= 7) return save({ state: 'exhausted', nextAt: null })
    try { await gateway.assertAllowed('webhook') } catch (e) { if (e.code === 'NETWORK_POLICY_OFFLINE') return save({ state: 'blocked_by_policy', error: e.code, nextAt: ping ? null : now() + 60000 }); throw e }
    // Claim is durable before dispatch. A restart cannot manufacture a delivered response.
    await save({ state: 'in_flight', attempts: state.attempts + 1, nextAt: null, error: undefined })
    const latest = await context()
    if (!latest.enabled || !matches(sub,latest) || !matches(row,latest)) return save({state:'cancelled',error:'AUTHORITY_CHANGED',nextAt:null,attempts:state.attempts-1})
    const timestamp = String(Math.floor(now()/1000))
    let response
    try {
      gateway.authorizeWebhookOrigin(new URL(sub.url).origin, sub.loopback)
      response = await gateway.fetch('webhook',sub.url,{ method:'POST', headers:{ 'Content-Type':'application/json', 'Michi-Signature':signature(Buffer.from(sub.secret,'hex'),timestamp,body), 'Michi-Event-Id':row.id, 'Michi-Delivery-Attempt':String(state.attempts) }, body })
    } catch (e) {
      if (e.code === 'NETWORK_POLICY_OFFLINE') return save({ state: 'blocked_by_policy', attempts: state.attempts - 1, error: e.code, nextAt: ping ? null : now() + 60000 })
      if (['SCHEDULE_PRIVATE_ADDRESS','SCHEDULE_HTTPS_REQUIRED','NETWORK_HOST_NOT_ALLOWED'].includes(e.code)) return save({state:'rejected',error:e.code,nextAt:null})
      return save({ state: 'unknown', error:'DELIVERY_RESPONSE_UNKNOWN', nextAt: !ping && state.attempts < 7 ? now() + retryDelay(state.attempts,null,now()) : null })
    } finally { gateway.revokeWebhookOrigin(new URL(sub.url).origin) }
    if (response.status >= 200 && response.status < 300) return save({ state:'delivered',httpStatus:response.status,nextAt:null })
    if (response.status >= 300 && response.status < 500 && response.status !== 429) return save({ state:'rejected',httpStatus:response.status,error:response.status < 400 ? 'REDIRECT_REJECTED' : 'RECEIVER_REJECTED',nextAt:null })
    if (ping) return save({ state:'rejected',httpStatus:response.status,error:'PING_TEST_FAILED',nextAt:null })
    return save({ state:state.attempts < 7 ? 'retrying' : 'exhausted',httpStatus:response.status,error:'RECEIVER_RETRYABLE',nextAt:state.attempts < 7 ? now()+retryDelay(state.attempts,response.headers.get('Retry-After'),now()) : null })
  }
  async function dispatch() {
    if (busy) return []; busy = true
    try { return await serialize(async () => { await load(); const rows = await readDatabase('integrationOutbox',null), output=[], history=await records(), terminal=new Set(history.filter(d=>['delivered','rejected','cancelled','exhausted'].includes(d.state)).map(d=>d.subscriptionId+':'+d.eventId)); if (!Array.isArray(rows)) fail('WEBHOOK_OUTBOX_INVALID'); for (const row of rows.slice().sort((a,b)=>String(a.at).localeCompare(String(b.at)))) { if (!rowValid(row)) continue; for (const sub of config.subscriptions.filter(s=>row.subscriptionIds.includes(s.id))) {if(terminal.has(sub.id+':'+row.id))continue;const previous=history.find(d=>d.subscriptionId===sub.id&&d.eventId===row.id),c=await context();if(previous?.nextAt>now()&&!sub.revokedAt&&c.enabled&&matches(sub,c)&&matches(row,c))continue;output.push(await deliver(sub,row));if(output.length>=100)return output} } return output }) } finally { busy = false }
  }
  async function test(input,proof) { if (!exact(input,['id']) || !uuid(input.id) || !await verifyNativeProof('test:'+input.id,proof)) fail('HUMAN_APPROVAL_REQUIRED'); return serialize(async()=>{ await load(); const sub=config.subscriptions.find(s=>s.id===input.id); if(!sub) fail('WEBHOOK_NOT_FOUND'); const c=await context(),id=crypto.randomUUID(),at=new Date(now()).toISOString(); return deliver(sub,{...c,id,at,payload:{id,type:'webhook.ping',occurred_at:at,dataset_id:c.datasetId,points:null}},true) }) }
  return { add,revoke,status,dispatch,test,invalidate:()=>revoke(null) }
}
module.exports = { createWebhookService, webhookURL, signature, retryDelay, RETRY_MINUTES }
