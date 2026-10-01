import Dexie from 'dexie'
import { db } from './db'
import { contentDigest } from './canonical'
import { changePolicyFor } from './change-set'
import { uid, type Settings } from './domain'
import type { CalendarRulesState } from './calendar-resolver'
import { applyCalendarProposalFromUI, bindCalendarConfigurationGuard, discardCalendarConfigurationProposal } from './calendar-rules-save'
import { csvTargetReferences, verifyCSVOriginalDigests, type PreparedCalendarCSVImport } from './calendar-csv-import'

const issued = new Map<string, PreparedCalendarCSVImport>()
let generation = 0
/** Reminder bookkeeping or backup timestamps in Settings do not change who may approve CSV material. */
function authorityView(settings: Settings) { const policy = changePolicyFor(settings); return { profileId: settings.profileId, datasetId: settings.datasetId, epoch: policy.epoch, sourcePermissionRevision: policy.sourcePermissionRevision } }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }
export const captureCalendarCSVAuthorityGeneration = () => generation
export function clearCalendarCSVImportAuthority() { generation++; for (const prepared of issued.values()) if (prepared.configuration) discardCalendarConfigurationProposal(prepared.configuration); issued.clear() }
export function cancelCalendarCSVImport(prepared: PreparedCalendarCSVImport) { if (issued.get(prepared.id) !== prepared) return; issued.delete(prepared.id); if (prepared.configuration) discardCalendarConfigurationProposal(prepared.configuration) }
function assertLive(prepared: PreparedCalendarCSVImport, issuedGeneration: number) {
  if (generation !== issuedGeneration || issued.get(prepared.id) !== prepared) throw new Error('登録済みのCSV確認案ではありません')
  if (Date.parse(prepared.expiresAt) <= Date.now() || prepared.target.retentionUntil && prepared.target.retentionUntil <= new Date().toISOString()) { cancelCalendarCSVImport(prepared); throw new Error('CSV確認案または選択行の保持期限に達しました') }
}
export async function registerCalendarCSVImport(input: Pick<PreparedCalendarCSVImport, 'preview' | 'configuration' | 'target'>, settings: Settings, state: CalendarRulesState, issuedGeneration: number): Promise<PreparedCalendarCSVImport> {
  if (input.configuration) await verifyCSVOriginalDigests([{ ...state, ...input.configuration.next, revision: state.revision + 1 }])
  const policy = changePolicyFor(settings), createdAt = new Date().toISOString()
  const payload = { ...input, id: uid(), ownerId: settings.profileId, datasetId: settings.datasetId, policyEpoch: policy.epoch, sourcePermissionRevision: policy.sourcePermissionRevision, baseDigest: await contentDigest({ settings: authorityView(settings), state }), referencesDigest: await contentDigest(csvTargetReferences(state, input.target)), createdAt, expiresAt: new Date(Date.now() + 86400000).toISOString() }
  const prepared = freeze({ ...payload, digest: await contentDigest(payload) })
  if (generation !== issuedGeneration) { if (input.configuration) discardCalendarConfigurationProposal(input.configuration); throw new Error('確認中にCSVの保存先・権限が変わりました') }
  for (const value of issued.values()) if (Date.parse(value.expiresAt) <= Date.now()) cancelCalendarCSVImport(value)
  if (issued.size >= 100) { if (input.configuration) discardCalendarConfigurationProposal(input.configuration); throw new Error('未適用のCSV確認案が多すぎます') }
  issued.set(prepared.id, prepared)
  if (prepared.configuration) bindCalendarConfigurationGuard(prepared.configuration, {
    assertLive: () => assertLive(prepared, issuedGeneration), resultId: prepared.preview.sourceId, businessKey: null, candidateKey: null, businessHash: '', candidateHash: '',
    detail: { origin: 'manual_csv', ownerId: prepared.ownerId, datasetId: prepared.datasetId, sourceId: prepared.preview.sourceId, format: prepared.target.kind, fingerprint: prepared.preview.parsed.fileSha256, bodyHash: prepared.preview.parsed.bodyHash, selectedCount: prepared.preview.selectedCount, excludedDraft: prepared.preview.excludedDraft, excludedOtherPerson: prepared.preview.excludedOtherPerson, policyEpoch: prepared.policyEpoch, sourcePermissionRevision: prepared.sourcePermissionRevision },
    assertCurrent: async (current, latest) => {
      assertLive(prepared, issuedGeneration)
      const currentPolicy = changePolicyFor(current)
      if (current.profileId !== prepared.ownerId || current.datasetId !== prepared.datasetId || currentPolicy.epoch !== prepared.policyEpoch || currentPolicy.sourcePermissionRevision !== prepared.sourcePermissionRevision) { cancelCalendarCSVImport(prepared); throw new Error('CSVの本人・保存先・権限が変わりました') }
      await Dexie.waitFor(verifyCSVOriginalDigests([latest]))
      if (await Dexie.waitFor(contentDigest(csvTargetReferences(latest, prepared.target))) !== prepared.referencesDigest) throw new Error('CSV確認後に本人の対象・活動・カレンダーが変わりました')
      const receipt = await db.commands.get(`calendar:${prepared.configuration!.id}`)
      if (!receipt && await Dexie.waitFor(contentDigest({ settings: authorityView(current), state: latest })) !== prepared.baseDigest) throw new Error('CSV確認後に資料やカレンダー設定の実値が変わりました')
      if (receipt) {
        const source = latest.sources.find(row => row.id === prepared.preview.sourceId), expected = prepared.configuration!.next.sources.find(row => row.id === prepared.preview.sourceId)!
        const snapshot = expected.csv!.snapshots.at(-1)!
        const stored = source?.csv?.snapshots.find(row => row.revision === snapshot.revision)
        if (!stored || source?.status !== 'current' || await Dexie.waitFor(contentDigest(stored)) !== await Dexie.waitFor(contentDigest(snapshot))) throw new Error('保存済みCSVの選択行・版が変わりました')
      }
      assertLive(prepared, issuedGeneration)
    },
  })
  return prepared
}
export async function applyCalendarCSVImportFromUI(prepared: PreparedCalendarCSVImport, digest: string, event: Event): Promise<string> {
  if (!prepared || issued.get(prepared.id) !== prepared || digest !== prepared.digest) throw new Error('登録済みのCSV確認案ではありません')
  if (!prepared.configuration || prepared.preview.noOp) throw new Error('保存するCSV差分がありません。既存資料・予定は保持します')
  const { digest: expected, ...payload } = prepared
  if (await contentDigest(payload) !== expected || issued.get(prepared.id) !== prepared) throw new Error('確認済みCSV案が変更・失効しました')
  return applyCalendarProposalFromUI(prepared.configuration, event)
}
