import Dexie from 'dexie'
import { db } from './db'
import { uid } from './domain'
import { contentDigest } from './canonical'
import { changePolicyFor } from './change-set'
import { bindCalendarAcquisitionGuard, type CalendarConfigurationProposal } from './calendar-rules-save'
import { validateCalendarRulesState } from './calendar-rules-validation'
import type { ScheduleRefreshCandidate, ScheduleRefreshInbox, ScheduleRefreshStatus } from './schedule-refresh-types'
async function digest(bytes: Uint8Array) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map(byte => byte.toString(16).padStart(2, '0')).join('') }
export async function receiveScheduleRefresh(value: ScheduleRefreshCandidate) {
  if (!value || Object.keys(value).length !== 7 || !['subscriptionId', 'sourceId', 'format', 'fetchedAt', 'bodySha256', 'bytes', 'qaFixture'].every(key => Object.hasOwn(value, key)) || typeof value.subscriptionId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.subscriptionId) || typeof value.sourceId !== 'string' || !value.sourceId || value.sourceId.length > 200 || !['ics', 'csv', 'pdf', 'xlsx'].includes(value.format) || typeof value.qaFixture !== 'boolean' || typeof value.fetchedAt !== 'string' || !Number.isFinite(Date.parse(value.fetchedAt)) || new Date(value.fetchedAt).toISOString() !== value.fetchedAt || !(value.bytes instanceof Uint8Array) || !value.bytes.length || value.bytes.length > (['pdf', 'xlsx'].includes(value.format) ? 25 * 1024 * 1024 : 1048576) || !/^[a-f0-9]{64}$/.test(value.bodySha256) || await digest(value.bytes) !== value.bodySha256) throw new Error('取得資料のサイズ・原本hashが不正です')
  if (((await db.datasetState.get('main'))?.mode ?? 'active') !== 'active') return null
  return db.transaction('rw', db.settings, db.calendarRules, db.scheduleRefreshInbox, async () => {
    const settings = await db.settings.get('main'), state = await db.calendarRules.get('main')
    if (!settings || state?.ownerId !== settings.profileId || state.datasetId !== settings.datasetId || !state.sources.some(source => source.id === value.sourceId)) throw new Error('取得資料の本人・取込元が一致しません')
    const rows = await db.scheduleRefreshInbox.where('subscriptionId').equals(value.subscriptionId).toArray()
    const repeated = rows.find(row => row.ownerId === settings.profileId && row.datasetId === settings.datasetId && row.bodySha256 === value.bodySha256 && ['pending', 'applied', 'dismissed'].includes(row.state))
    if (repeated) return repeated.id
    for (const row of rows.filter(row => row.state === 'pending')) await db.scheduleRefreshInbox.update(row.id, { state: 'superseded', body: null, previewDigest: null })
    const old = await db.scheduleRefreshInbox.orderBy('fetchedAt').toArray()
    for (const row of old.filter(row => row.state !== 'pending').slice(0, Math.max(0, old.length - 100))) await db.scheduleRefreshInbox.delete(row.id)
    if (old.filter(row => row.state === 'pending').length >= 100) throw new Error('確認待ちの取得資料が多すぎます')
    const id = uid()
    await db.scheduleRefreshInbox.add({ id, ownerId: settings.profileId, datasetId: settings.datasetId, policyEpoch: changePolicyFor(settings).epoch, sourceId: value.sourceId, subscriptionId: value.subscriptionId, format: value.format, fetchedAt: value.fetchedAt, bodySha256: value.bodySha256, body: new Blob([new Uint8Array(value.bytes)]), previewDigest: null, state: 'pending', qaFixture: value.qaFixture })
    return id
  })
}
export async function bindScheduleRefreshPreview(proposal: CalendarConfigurationProposal, inboxId: string, originalHash: string) {
  const row = await db.scheduleRefreshInbox.get(inboxId)
  if (!row || row.state !== 'pending' || row.bodySha256 !== originalHash || row.ownerId !== proposal.ownerId || row.datasetId !== proposal.datasetId || row.policyEpoch !== proposal.policyEpoch || !row.body) throw new Error('取得資料は更新・失効しました。新しい差分を確認してください')
  if (await digest(new Uint8Array(await row.body.arrayBuffer())) !== row.bodySha256) throw new Error('取得資料の原本hashが変わりました')
  const expectedSource = proposal.next.sources.find(source => source.id === row.sourceId)
  if (!expectedSource || (row.format === 'ics' ? expectedSource.bodyHash : expectedSource.csv?.snapshots.at(-1)?.fingerprint) !== originalHash) throw new Error('取得資料と確認案の原本が一致しません')
  const binding = await contentDigest({ inboxId, originalHash, proposalDigest: proposal.digest })
  await db.scheduleRefreshInbox.update(inboxId, { previewDigest: binding })
  bindCalendarAcquisitionGuard(proposal, {
    assertCurrent: async settings => {
      const current = await db.scheduleRefreshInbox.get(inboxId)
      if (!current || current.state !== 'pending' || current.bodySha256 !== originalHash || current.previewDigest !== binding || current.ownerId !== settings.profileId || current.datasetId !== settings.datasetId || current.policyEpoch !== changePolicyFor(settings).epoch || !current.body) throw new Error('新しい資料の取得・本人権限の変更により確認案が失効しました')
      if (await Dexie.waitFor(digest(new Uint8Array(await Dexie.waitFor(current.body.arrayBuffer())))) !== originalHash) throw new Error('取得資料の原本hashが変わりました')
    },
    markApplied: async () => { await db.scheduleRefreshInbox.update(inboxId, { state: 'applied', body: null, previewDigest: null }) },
  })
}
export async function pendingScheduleRefreshFile(row: ScheduleRefreshInbox) {
  const current = await db.scheduleRefreshInbox.get(row.id)
  if (!current || current.state !== 'pending' || !current.body || current.bodySha256 !== row.bodySha256 || await digest(new Uint8Array(await current.body.arrayBuffer())) !== current.bodySha256) throw new Error('取得資料が変わりました')
  return new File([current.body], `schedule-refresh.${current.format}`, { type: current.format === 'ics' ? 'text/calendar' : current.format === 'pdf' ? 'application/pdf' : 'application/octet-stream' })
}
export async function acknowledgeScheduleRefresh(row: ScheduleRefreshInbox) { await window.michiScheduleRefresh?.request({ action: 'acknowledge', id: row.subscriptionId, bodySha256: row.bodySha256 }) }
export async function refreshStatuses() { return (await window.michiScheduleRefresh?.request({ action: 'list' }) ?? []) as ScheduleRefreshStatus[] }
export async function recordScheduleAcquisitionStatus(rows: ScheduleRefreshStatus[], at = new Date().toISOString()) {
  if (((await db.datasetState.get('main'))?.mode ?? 'active') !== 'active') return
  await db.transaction('rw', db.settings, db.calendarRules, async () => {
    const settings = await db.settings.get('main'), state = await db.calendarRules.get('main')
    if (!settings || !state || state.ownerId !== settings.profileId || state.datasetId !== settings.datasetId) return
    let changed = false
    for (const row of rows) {
      const source = state.sources.find(source => source.id === row.sourceId)
      if (!source) continue
      const provider = row.kind === 'url' && row.format === 'ics' ? 'ics_url' as const : 'file_watch' as const
      const staleByFetch = row.status === 'stale' || row.status === 'paused'
      const expired = source.ics?.retentionUntil && source.ics.retentionUntil <= at || source.csv?.retentionUntil && source.csv.retentionUntil <= at || source.csv?.retiredAt
      const status = staleByFetch ? 'stale' : source.acquisition?.staleByFetch && !expired ? 'current' : source.status
      if (source.acquisition?.provider !== provider || source.acquisition.qaFixture !== row.qaFixture || source.acquisition.staleByFetch !== staleByFetch || source.status !== status) {
        source.acquisition = { provider, qaFixture: row.qaFixture, staleByFetch }; source.status = status; changed = true
      }
    }
    if (changed) { state.revision++; validateCalendarRulesState(state, settings.profileId, settings.datasetId); await db.calendarRules.put(state) }
  })
}
