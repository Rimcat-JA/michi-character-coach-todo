import Dexie from 'dexie'
import { db } from './db'
import { uid } from './domain'
import { contentDigest } from './canonical'
import { changePolicyFor } from './change-set'
import { bindCalendarAcquisitionGuard, type CalendarConfigurationProposal } from './calendar-rules-save'
import { validateCalendarRulesState } from './calendar-rules-validation'
import type { ScheduleRefreshCandidate, ScheduleRefreshInbox, ScheduleRefreshStatus } from './schedule-refresh-types'
const acquisitionBytes = new Map<string, Uint8Array>()
export const clearScheduleRefreshBytes = () => acquisitionBytes.clear()
export async function scheduleRefreshBytes(row: ScheduleRefreshInbox): Promise<Uint8Array<ArrayBuffer>> {
  let bytes = acquisitionBytes.get(row.id)
  if (!bytes) {
    const bridge = row.format === 'caldav' ? window.michiCalDAV : window.michiScheduleRefresh
    const candidate = await bridge?.request({ action: 'candidate', id: row.subscriptionId }) as ScheduleRefreshCandidate | null
    if (candidate) await receiveScheduleRefresh(candidate)
    bytes = acquisitionBytes.get(row.id)
  }
  if (!bytes || await digest(bytes) !== row.bodySha256) throw new Error('取得本文は再確認が必要です。新しい資料を取得して一覧から開いてください')
  return new Uint8Array(bytes)
}
async function digest(bytes: Uint8Array) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map(byte => byte.toString(16).padStart(2, '0')).join('') }
export async function receiveScheduleRefresh(value: ScheduleRefreshCandidate) {
  const receivingSettings = await db.settings.get('main')
  if (((await db.datasetState.get('main'))?.mode ?? 'active') !== 'active' || !receivingSettings || changePolicyFor(receivingSettings).stops?.routines) return null
  if (!value || Object.keys(value).length !== 10 || !['subscriptionId', 'sourceId', 'format', 'fetchedAt', 'bodySha256', 'bytes', 'qaFixture', 'ownerId', 'datasetId', 'policyEpoch'].every(key => Object.hasOwn(value, key)) || typeof value.subscriptionId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.subscriptionId) || typeof value.sourceId !== 'string' || !value.sourceId || value.sourceId.length > 200 || !['ics', 'csv', 'pdf', 'xlsx', 'caldav'].includes(value.format) || typeof value.qaFixture !== 'boolean' || typeof value.fetchedAt !== 'string' || !Number.isFinite(Date.parse(value.fetchedAt)) || new Date(value.fetchedAt).toISOString() !== value.fetchedAt || !(value.bytes instanceof Uint8Array) || !value.bytes.length || value.bytes.length > (['pdf', 'xlsx'].includes(value.format) ? 25 * 1024 * 1024 : 1048576) || !/^[a-f0-9]{64}$/.test(value.bodySha256) || await digest(value.bytes) !== value.bodySha256) throw new Error('取得資料のサイズ・原本hashが不正です')
  return db.transaction('rw', db.settings, db.calendarRules, db.scheduleRefreshInbox, async () => {
    const settings = await db.settings.get('main'), state = await db.calendarRules.get('main')
    if (!settings || state?.ownerId !== settings.profileId || state.datasetId !== settings.datasetId || value.ownerId !== settings.profileId || value.datasetId !== settings.datasetId || value.policyEpoch !== changePolicyFor(settings).epoch || changePolicyFor(settings).stops?.routines || !state.sources.some(source => source.id === value.sourceId)) throw new Error('取得資料の本人・取込元・権限が一致しません')
    const rows = await db.scheduleRefreshInbox.where('subscriptionId').equals(value.subscriptionId).toArray()
    const repeated = rows.find(row => row.ownerId === settings.profileId && row.datasetId === settings.datasetId && row.bodySha256 === value.bodySha256 && ['pending', 'applied', 'dismissed'].includes(row.state))
    if (repeated) { if (repeated.state === 'pending') { if ([...acquisitionBytes.entries()].reduce((size, [id, bytes]) => size + (id === repeated.id ? 0 : bytes.length), value.bytes.length) > 64 * 1024 * 1024) throw new Error('確認待ち本文の容量上限です'); acquisitionBytes.set(repeated.id, new Uint8Array(value.bytes)) } return repeated.id }
    for (const row of rows.filter(row => row.state === 'pending')) { acquisitionBytes.delete(row.id); await db.scheduleRefreshInbox.update(row.id, { state: 'superseded', body: null, previewDigest: null }) }
    const old = await db.scheduleRefreshInbox.orderBy('fetchedAt').toArray()
    for (const row of old.filter(row => row.state !== 'pending').slice(0, Math.max(0, old.length - 100))) await db.scheduleRefreshInbox.delete(row.id)
    if (old.filter(row => row.state === 'pending').length >= 100) throw new Error('確認待ちの取得資料が多すぎます')
    if ([...acquisitionBytes.values()].reduce((size, bytes) => size + bytes.length, value.bytes.length) > 64 * 1024 * 1024) throw new Error('確認待ち本文の容量上限です。先に保存する資料を確認してください')
    const id = uid()
    await db.scheduleRefreshInbox.add({ id, ownerId: settings.profileId, datasetId: settings.datasetId, policyEpoch: changePolicyFor(settings).epoch, sourceId: value.sourceId, subscriptionId: value.subscriptionId, format: value.format, fetchedAt: value.fetchedAt, bodySha256: value.bodySha256, body: null, previewDigest: null, state: 'pending', qaFixture: value.qaFixture })
    acquisitionBytes.set(id, new Uint8Array(value.bytes))
    return id
  })
}
export async function bindScheduleRefreshPreview(proposal: CalendarConfigurationProposal, inboxId: string, originalHash: string) {
  const row = await db.scheduleRefreshInbox.get(inboxId)
  if (!row || row.state !== 'pending' || row.bodySha256 !== originalHash || row.ownerId !== proposal.ownerId || row.datasetId !== proposal.datasetId || row.policyEpoch !== proposal.policyEpoch) throw new Error('取得資料は更新・失効しました。新しい差分を確認してください')
  await scheduleRefreshBytes(row)
  const expectedSource = proposal.next.sources.find(source => source.id === row.sourceId)
  if (!expectedSource || (row.format === 'caldav' ? expectedSource.caldav?.snapshots.at(-1)?.sha256 : row.format === 'ics' ? expectedSource.bodyHash : expectedSource.csv?.snapshots.at(-1)?.fingerprint) !== originalHash) throw new Error('取得資料と確認案の原本が一致しません')
  const binding = await contentDigest({ inboxId, originalHash, proposalDigest: proposal.digest })
  await db.scheduleRefreshInbox.update(inboxId, { previewDigest: binding })
  bindCalendarAcquisitionGuard(proposal, {
    assertCurrent: async settings => {
      const current = await db.scheduleRefreshInbox.get(inboxId)
      if (!current || current.state !== 'pending' || current.bodySha256 !== originalHash || current.previewDigest !== binding || current.ownerId !== settings.profileId || current.datasetId !== settings.datasetId || current.policyEpoch !== changePolicyFor(settings).epoch) throw new Error('新しい資料の取得・本人権限の変更により確認案が失効しました')
      const bytes = acquisitionBytes.get(inboxId)
      if (!bytes || await Dexie.waitFor(digest(bytes)) !== originalHash) throw new Error('取得資料の原本hashが変わりました')
    },
    markApplied: async () => { await db.scheduleRefreshInbox.update(inboxId, { state: 'applied', body: null, previewDigest: null }) },
  })
}
export async function pendingScheduleRefreshFile(row: ScheduleRefreshInbox) {
  const current = await db.scheduleRefreshInbox.get(row.id)
  if (!current || current.state !== 'pending' || current.bodySha256 !== row.bodySha256) throw new Error('取得資料が変わりました')
  return new File([await scheduleRefreshBytes(current)], `schedule-refresh.${current.format}`, { type: current.format === 'ics' ? 'text/calendar' : current.format === 'pdf' ? 'application/pdf' : 'application/octet-stream' })
}
export async function acknowledgeScheduleRefresh(row: ScheduleRefreshInbox) { acquisitionBytes.delete(row.id); await (row.format === 'caldav' ? window.michiCalDAV : window.michiScheduleRefresh)?.request({ action: 'acknowledge', id: row.subscriptionId, bodySha256: row.bodySha256 }) }
/** Explicitly decline a candidate without changing source facts or generated events. */
export async function dismissScheduleRefresh(row: ScheduleRefreshInbox, event: Event) {
  if (!(event instanceof Event) || !event.isTrusted || !['click', 'submit'].includes(Object.getOwnPropertyDescriptor(Event.prototype, 'type')!.get!.call(event))) throw new Error('取得資料の本人確認ボタンから操作してください')
  await db.transaction('rw', db.settings, db.datasetState, db.calendarRules, db.scheduleRefreshInbox, db.audits, async () => {
    const settings = await db.settings.get('main'), current = await db.scheduleRefreshInbox.get(row.id), state = await db.calendarRules.get('main')
    if (((await db.datasetState.get('main'))?.mode ?? 'active') !== 'active' || !settings || changePolicyFor(settings).stops?.routines || !current || current.state !== 'pending' || current.bodySha256 !== row.bodySha256 || current.ownerId !== settings.profileId || current.datasetId !== settings.datasetId || current.policyEpoch !== changePolicyFor(settings).epoch || state?.ownerId !== settings.profileId || state.datasetId !== settings.datasetId || !state.sources.some(source => source.id === current.sourceId)) throw new Error('取得資料・本人権限が変更されたか、データが凍結されています')
    await db.scheduleRefreshInbox.update(current.id, { state: 'dismissed', body: null, previewDigest: null })
    await db.audits.add({ id: uid(), taskId: null, operation: 'calendar.acquisition.dismiss', at: new Date().toISOString(), detail: JSON.stringify({ inboxId: current.id, sourceId: current.sourceId, bodySha256: current.bodySha256, factsChanged: false, externalWrite: false }) })
  })
  await acknowledgeScheduleRefresh(row)
}
export async function refreshStatuses() { const [files, caldav] = await Promise.all([window.michiScheduleRefresh?.request({ action: 'list' }) ?? [], window.michiCalDAV?.request({ action: 'list' }) ?? []]); return [...files as ScheduleRefreshStatus[], ...caldav as ScheduleRefreshStatus[]] }
export async function recordScheduleAcquisitionStatus(rows: ScheduleRefreshStatus[], at = new Date().toISOString()) {
  if (((await db.datasetState.get('main'))?.mode ?? 'active') !== 'active') return
  await db.transaction('rw', db.settings, db.calendarRules, db.scheduleRefreshInbox, async () => {
    const settings = await db.settings.get('main'), state = await db.calendarRules.get('main')
    if (!settings || !state || state.ownerId !== settings.profileId || state.datasetId !== settings.datasetId) return
    let changed = false
    for (const row of rows) {
      const source = state.sources.find(source => source.id === row.sourceId)
      if (!source) continue
      const provider = row.format === 'caldav' ? 'caldav' as const : row.kind === 'url' && row.format === 'ics' ? 'ics_url' as const : 'file_watch' as const
      const staleByFetch = row.status === 'stale' || row.status === 'paused'
      if (staleByFetch) for (const pending of await db.scheduleRefreshInbox.where('subscriptionId').equals(row.id).filter(item => item.state === 'pending').toArray()) { acquisitionBytes.delete(pending.id); await db.scheduleRefreshInbox.update(pending.id, { state: 'superseded', body: null, previewDigest: null }) }
      const expired = source.ics?.retentionUntil && source.ics.retentionUntil <= at || source.csv?.retentionUntil && source.csv.retentionUntil <= at || source.csv?.retiredAt
      const status = staleByFetch ? 'stale' : source.acquisition?.staleByFetch && !expired ? 'current' : source.status
      if (source.acquisition?.provider !== provider || source.acquisition.qaFixture !== row.qaFixture || source.acquisition.staleByFetch !== staleByFetch || source.status !== status) {
        source.acquisition = { provider, qaFixture: row.qaFixture, staleByFetch }; source.status = status; changed = true
      }
    }
    if (changed) { state.revision++; validateCalendarRulesState(state, settings.profileId, settings.datasetId); await db.calendarRules.put(state) }
  })
}
export async function purgeScheduleRefreshInbox(at = new Date().toISOString()) {
  await db.transaction('rw', db.scheduleRefreshInbox, db.calendarRules, db.settings, async () => {
    const settings = await db.settings.get('main'), state = await db.calendarRules.get('main')
    for (const row of await db.scheduleRefreshInbox.where('state').equals('pending').toArray()) {
      const source = state?.sources.find(source => source.id === row.sourceId), until = source?.ics?.retentionUntil ?? source?.csv?.retentionUntil
      if (!settings || row.ownerId !== settings.profileId || row.datasetId !== settings.datasetId || row.policyEpoch !== changePolicyFor(settings).epoch || !source || until && until <= at || Date.parse(row.fetchedAt) + 86400000 <= Date.parse(at)) {
        acquisitionBytes.delete(row.id);await db.scheduleRefreshInbox.update(row.id, { state: 'superseded', body: null, previewDigest: null })
      }
    }
  })
}
