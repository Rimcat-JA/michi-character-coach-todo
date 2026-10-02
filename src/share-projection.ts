import type { Completion, Task } from './domain'
import { SHARE_FIELDS, type ShareField, type ShareProjection } from './share-types'

/** One message for every source reference a recipient meets, so existence, title and count of the owner's sources never leak (17.4). */
export const SHARE_MASKED_SOURCE = '共有されていない出典です'
export const SHARE_NOTE_MAX = 2000
const SPAN = 20
const SOURCE_LINK = /michi:\/\/source\/[^\s)\]>]*/gi
// Detection citations look like "[<source_id> <revision> <span>] quote".
const SOURCE_CITATION = /\[[A-Za-z0-9_:.-]{6,}\s[^\]\n]*\]/g
export function maskSourceReferences(value: string): string { return value.replace(SOURCE_LINK, `［${SHARE_MASKED_SOURCE}］`).replace(SOURCE_CITATION, `［${SHARE_MASKED_SOURCE}］`) }
/** The recipient resolves any source link only against nothing: existing and non-existing ids give the identical answer. */
export function resolveSharedSourceLink(reference: string): string { void reference; return SHARE_MASKED_SOURCE }

export function projectTask(task: Task, completion: Completion | undefined, shareId: string, fields: ShareField[]): ShareProjection {
  validateShareFields(fields)
  const projection: ShareProjection = { share_task_id: shareId }
  for (const field of fields) {
    if (field === 'title') projection.title = maskSourceReferences(task.title)
    if (field === 'status') projection.status = task.status
    if (field === 'scheduled_date') projection.scheduled_date = task.scheduledDate
    if (field === 'due_date') projection.due_date = task.dueDate
    if (field === 'effective_points') projection.effective_points = completion?.currentAt ? completion.netPoints : task.effectivePoints
  }
  return projection
}
export function validateShareFields(fields: unknown): asserts fields is ShareField[] {
  if (!Array.isArray(fields) || !fields.length || new Set(fields).size !== fields.length || fields.some(field => !SHARE_FIELDS.includes(field))) throw new Error('共有する項目を1つ以上選んでください')
}
const date = (value: unknown) => value === null || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
/** Exact keys only, and only the fields the grant declared. */
export function validateProjection(value: unknown, shareId: string, fields: ShareField[]): asserts value is ShareProjection {
  validateShareFields(fields)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('共有内容が不正です')
  const row = value as Record<string, unknown>, keys = ['share_task_id', ...fields]
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) || row.share_task_id !== shareId) throw new Error('共有内容の項目が不正です')
  if ('title' in row && (typeof row.title !== 'string' || !row.title.length || row.title.length > 300 || row.title !== maskSourceReferences(row.title))) throw new Error('共有されたタイトルが不正です')
  if ('status' in row && !['open', 'completed'].includes(row.status as string)) throw new Error('共有された状態が不正です')
  if ('scheduled_date' in row && !date(row.scheduled_date) || 'due_date' in row && !date(row.due_date)) throw new Error('共有された日付が不正です')
  if ('effective_points' in row && row.effective_points !== null && (!Number.isInteger(row.effective_points) || (row.effective_points as number) < 0 || (row.effective_points as number) > 100000)) throw new Error('共有されたポイントが不正です')
}
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
/** A shared title must not carry a verbatim span of 20+ characters from a private source either (same rule as the share note). References are masked by projectTask; verbatim spans are rejected here. */
export function validateShareTitle(title: string, privateTexts: string[]): string {
  const value = normalize(title)
  if (!value) throw new Error('共有するタイトルがありません')
  const texts = privateTexts.map(normalize).filter(text => text.length >= SPAN)
  for (let start = 0; start + SPAN <= value.length; start++) {
    const span = value.slice(start, start + SPAN)
    if (texts.some(text => text.includes(span))) throw new Error('共有するタイトルに個人資料の原文（20文字以上の一致）が含まれています')
  }
  return title
}
/** A note written for the recipient must not carry a verbatim span of 20+ characters from a private source, nor a source reference. */
export function validateShareNote(note: string, privateTexts: string[], sourceIds: string[]): string {
  if (typeof note !== 'string' || note.length > SHARE_NOTE_MAX) throw new Error(`共有メモは${SHARE_NOTE_MAX}文字以内にしてください`)
  const value = normalize(note)
  if (!value) return ''
  if (/michi:\/\/source\//i.test(value) || sourceIds.some(id => value.includes(`[${id}`) || value.includes(id))) throw new Error('共有メモに資料への参照は入れられません')
  const texts = privateTexts.map(normalize).filter(text => text.length >= SPAN)
  for (let start = 0; start + SPAN <= value.length; start++) {
    const span = value.slice(start, start + SPAN)
    if (texts.some(text => text.includes(span))) throw new Error('共有メモに個人資料の原文（20文字以上の一致）が含まれています')
  }
  return value
}
