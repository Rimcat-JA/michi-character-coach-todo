import type { CalendarEvent } from './domain'
import type { CalendarRulesState } from './calendar-resolver'
export const readOnlyCalendarForbiddenClaims = ['同期済み', '同期しました', '双方向'] as const
export const localCalendarEditNotice = 'この端末の予定だけ変更しました（元のICSは変更されていません）'
export function eventOrigin(event: CalendarEvent, state: CalendarRulesState | null | undefined) {
  const instance = state?.instances.find(row => row.entityId === event.id && row.spec.kind === 'event')
  const sources = instance?.spec.sourceRefs.map(ref => state!.sources.find(source => source.id === ref.sourceId)).filter(source => Boolean(source)) ?? []
  const provider = sources.some(source => source?.ics) ? 'ics_file' : sources.some(source => source?.csv?.snapshots.some(snapshot => snapshot.rows.some(row => row.mapped?.document?.format === 'pdf'))) ? 'pdf' : sources.some(source => source?.csv?.snapshots.some(snapshot => snapshot.rows.some(row => row.mapped?.document?.format === 'xlsx'))) ? 'xlsx' : sources.some(source => source?.csv) ? 'csv' : sources.length ? 'manual_source' : 'local'
  return { kind: sources.length ? 'imported' as const : 'local' as const, provider, sources: sources.map(source => ({ id: source!.id, title: source!.title, revision: source!.revision, importedAt: source!.importedAt })), generationKey: instance?.generationKey ?? null, locallyEdited: Boolean(event.locallyEdited || instance && ((event.revision ?? 1) !== instance.entityRevision || event.title !== instance.spec.title || event.startAt !== instance.spec.startAt || event.endAt !== instance.spec.endAt)), read: { status: 'available', reason: 'この端末に保存した資料を読み取ります' }, write: { status: 'unsupported', reason: '読取専用の資料です。変更はこの端末の計画だけに保存されます' } }
}
