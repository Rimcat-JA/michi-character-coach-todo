import type { SourceProvider } from './source-library'

/** Design 23.2 defaults. They apply only to newly created data; existing rows are never rewritten. */
export const retentionDefaults = { importedConversationDays: 90, coachConversationDays: 180, rejectedCandidateDays: 30 } as const
const day = 24 * 60 * 60 * 1000
export function retentionAfterDays(days: number, now = Date.now()): string { return new Date(now + days * day).toISOString() }
/** Conversation exports, web quotes and mail quotes are third-party conversation text; local documents are chosen by the owner. */
export function isConversationProvider(provider: SourceProvider): boolean { return provider !== 'local' }
export function defaultSourceRetention(provider: SourceProvider, now = Date.now()): string | null { return isConversationProvider(provider) ? retentionAfterDays(retentionDefaults.importedConversationDays, now) : null }
export function defaultCoachConversationRetention(now = Date.now()): string { return retentionAfterDays(retentionDefaults.coachConversationDays, now) }
export function candidateExpired(createdAt: string, now = Date.now()): boolean { const at = Date.parse(createdAt); return Number.isFinite(at) && at + retentionDefaults.rejectedCandidateDays * day <= now }
/** Date input (YYYY-MM-DD, end of that local day) used by the import screens. */
export function retentionDateInput(iso: string | null): string { if (!iso) return ''; const date = new Date(iso); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
export function retentionFromDateInput(value: string, unlimited: boolean): string | null {
  if (unlimited) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('保持期限を入力するか、『期限なし（長期保存）』を明示的に選んでください')
  const at = new Date(`${value}T23:59:59.999`)
  if (!Number.isFinite(at.getTime())) throw new Error('保持期限の日付を確認してください')
  return at.toISOString()
}
export type RetentionDraft = { date: string; unlimited: boolean }
export const retentionDraft = (iso: string | null): RetentionDraft => ({ date: retentionDateInput(iso), unlimited: iso === null })
/** Throws until the owner gives a date or explicitly picks long-term storage. */
export const retentionValue = (draft: RetentionDraft) => retentionFromDateInput(draft.date, draft.unlimited)
