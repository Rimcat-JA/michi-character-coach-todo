import { processingAllowed, processingEpoch } from './external-authority'
import { createTasksAtomic, newTaskInput, type TaskInput } from './commands'
import { addDays, emptyScore, uid, validateDate, validateTaskDue, validateTaskInput } from './domain'
import { db } from './db'
import { contentDigest } from './canonical'
import { changePolicyFor } from './change-set'
import Dexie from 'dexie'

export type AssistedDraft = { input: TaskInput; notices: string[] }
export type SourcedDraft = AssistedDraft & { source: string }
/** The verified external actor behind a file/MCP creation; covered by the digest the owner approves (S21 shows it, not the coach). */
export type AssistActor = { kind: 'external-agent'; id: string; entrance: 'file' | 'mcp' | 'api'; commandId: string }
export type PreparedAssistedTasks = { id: string; profileId: string; datasetId: string; expiresAt: string; inputs: TaskInput[]; sources: string[]; origin: 'manual' | 'ai'; policyEpoch: number | null; processingEpoch: number; actor?: AssistActor; digest: string }
const assistActorValid = (actor: unknown) => Boolean(actor && typeof actor === 'object' && !Array.isArray(actor) && Object.keys(actor).length === 4 && (actor as AssistActor).kind === 'external-agent' && ['file', 'mcp', 'api'].includes((actor as AssistActor).entrance) && [(actor as AssistActor).id, (actor as AssistActor).commandId].every(value => typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value)))

function uniqueNumber(raw: string, pattern: RegExp, maximum: number): number | null {
  const values = [...raw.matchAll(pattern)].map(match => Number(match[1]))
  return values.length === 1 && Number.isInteger(values[0]) && values[0] <= maximum ? values[0] : null
}

function explicitDate(raw: string, baseDate: string, kind: 'due' | 'scheduled'): string | null {
  const indicator = kind === 'due' ? '(?:締[め]?切り|期限|までに?|!due:)' : '(?:予定日|実施日|@)'
  const date = '(明日|今日|\\d{4}-\\d{2}-\\d{2})'
  const before = new RegExp(`${indicator}[：:\\s]*${date}`, 'g')
  const after = kind === 'due' ? new RegExp(`${date}までに?`, 'g') : null
  const matches = [...new Set([...raw.matchAll(before), ...(after ? [...raw.matchAll(after)] : [])].map(match => match[1]))]
  if (matches.length !== 1) return null
  const resolved = matches[0] === '明日' ? addDays(baseDate, 1) : matches[0] === '今日' ? baseDate : matches[0]
  try { validateDate(resolved, '日付'); return resolved } catch { return null }
}

export function draftFromText(raw: string, baseDate: string): AssistedDraft {
  if (!raw.trim() || raw.length > 2000) throw new Error('原文は1〜2000文字で入力してください')
  validateDate(baseDate, '基準日')
  const input = newTaskInput()
  input.title = raw.trim()
  const notices: string[] = []
  const pointMatches = [...raw.matchAll(/(?:^|[^\d.+-])(\d{1,7})\s*(?:pt|ポイント)(?![\w])/gi), ...raw.matchAll(/\bpt:(\d{1,7})\b/gi)]
  const points = pointMatches.length === 1 && Number(pointMatches[0][1]) <= 100000 ? Number(pointMatches[0][1]) : null
  if (points !== null) input.score = { ...emptyScore(), mode: 'manual', manualPoints: points }
  else if (pointMatches.length) notices.push('ポイントの指定が複数または範囲外のため、手動で確認してください。')
  const minuteMatches = [...raw.matchAll(/(?:^|[^\d.+-])(\d{1,5})\s*分/g)]
  const minutes = uniqueNumber(raw, /(?:^|[^\d.+-])(\d{1,5})\s*分/g, 10080)
  if (minutes !== null && !/移動込み|往復込み|合計.*分/.test(raw)) input.score.minutes = minutes
  else if (minuteMatches.length) notices.push('所要時間の内訳が不明です。作業時間を確認してください。')
  input.dueDate = explicitDate(raw, baseDate, 'due')
  input.scheduledDate = explicitDate(raw, baseDate, 'scheduled')
  if (/明日|今日|\d{4}-\d{2}-\d{2}/.test(raw) && !input.dueDate && !input.scheduledDate) notices.push('日付の意味が曖昧です。予定日か期限かを確認してください。')
  return { input, notices }
}

export function acceptTitleQuote(raw: string, answer: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(answer) } catch { throw new Error('AIの候補を読めませんでした。原文から手動で入力してください。') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'title_quote')) throw new Error('AIの候補形式が不正です。原文から手動で入力してください。')
  const quote = (parsed as { title_quote: unknown }).title_quote
  if (typeof quote !== 'string' || !quote.trim() || quote.length > 300 || !raw.includes(quote) || !/[^\d\s.,、。]/.test(quote)) throw new Error('AIの候補が原文と一致しません。原文から手動で入力してください。')
  return quote.trim()
}

export function draftsFromText(raw: string, baseDate: string): SourcedDraft[] {
  if (!raw.trim() || raw.length > 2000) throw new Error('原文は1〜2000文字で入力してください')
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length > 20) throw new Error('一度に作る候補は20件までです')
  return lines.map(source => ({ ...draftFromText(source, baseDate), source }))
}

export function acceptAssistedDrafts(raw: string, answer: string, baseDate: string): SourcedDraft[] {
  let parsed: unknown
  try { parsed = JSON.parse(answer) } catch { throw new Error('AIの候補を読めませんでした') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'tasks')) throw new Error('AIの候補形式が不正です')
  const tasks = (parsed as { tasks: unknown }).tasks
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 20) throw new Error('候補は1〜20件で指定してください')
  let cursor = 0
  const drafts = tasks.map(task => {
    if (!task || typeof task !== 'object' || Array.isArray(task) || Object.keys(task).length !== 2 || typeof task.source_quote !== 'string' || !task.source_quote.trim() || typeof task.title_quote !== 'string') throw new Error('AIの候補形式が不正です')
    const start = raw.indexOf(task.source_quote, cursor)
    if (start < 0 || /[^\s。、;；]/.test(raw.slice(cursor, start))) throw new Error('原文の一部が欠けているか、候補が重複しています')
    cursor = start + task.source_quote.length
    const title = acceptTitleQuote(task.source_quote, JSON.stringify({ title_quote: task.title_quote }))
    const draft = draftFromText(task.source_quote, baseDate)
    return { ...draft, source: task.source_quote, input: { ...draft.input, title } }
  })
  if (/[^\s。、;；]/.test(raw.slice(cursor))) throw new Error('原文の一部が欠けています')
  return drafts
}

export async function prepareAssistedTasks(drafts: SourcedDraft[], origin: 'manual' | 'ai', actor?: AssistActor): Promise<PreparedAssistedTasks> {
  if (!drafts.length || drafts.length > 20) throw new Error('候補は1〜20件で指定してください')
  if (!['manual', 'ai'].includes(origin) || actor !== undefined && (origin !== 'ai' || !assistActorValid(actor)) || drafts.some(draft => typeof draft.source !== 'string' || !draft.source.trim() || draft.source.length > 2000)) throw new Error('候補の出典が不正です')
  for (const { input } of drafts) {
    validateTaskInput(input)
    for (const value of [input.scheduledDate, input.dueDate]) validateDate(value, '日付')
    validateTaskDue(input)
  }
  const settings = await db.settings.get('main')
  if (!settings) throw new Error('端末の設定が見つかりません')
  // AI proposals follow the AI-processing and AI-change stops; raw-text drafts saved by the owner do not.
  const policy = changePolicyFor(settings)
  if (origin === 'ai' && (!processingAllowed(settings, actor ?? {kind:'coach',id:'app-coach'}) || !policy.aiChangesEnabled)) throw new Error('AIによる変更案の受付は停止中です。原文から下書きを使ってください')
  const payload = { id: uid(), profileId: settings.profileId, datasetId: settings.datasetId, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), inputs: structuredClone(drafts.map(draft => draft.input)), sources: drafts.map(draft => draft.source), origin, policyEpoch: origin === 'ai' ? policy.epoch : null, processingEpoch: origin === 'ai' ? processingEpoch(settings, actor ?? {kind:'coach',id:'app-coach'}) : 0, ...(actor ? { actor: { kind: actor.kind, id: actor.id, entrance: actor.entrance, commandId: actor.commandId } } : {}) }
  return { ...payload, digest: await contentDigest(payload) }
}

export async function applyAssistedTasks(prepared: PreparedAssistedTasks, confirmedDigest: string): Promise<string[]> {
  const { digest, ...payload } = prepared
  if (!prepared.inputs.length || prepared.inputs.length > 20 || prepared.sources.length !== prepared.inputs.length || !['manual', 'ai'].includes(prepared.origin) || prepared.actor !== undefined && !assistActorValid(prepared.actor)) throw new Error('確認した候補の形式が不正です')
  if (digest !== confirmedDigest || digest !== await Dexie.waitFor(contentDigest(payload))) throw new Error('確認後に内容が変わりました。もう一度確認してください')
  if (!Number.isFinite(Date.parse(prepared.expiresAt)) || Date.parse(prepared.expiresAt) <= Date.now()) throw new Error('確認の有効期限が切れました')
  return db.transaction('rw', [db.tasks, db.assessments, db.commands, db.audits, db.containers, db.settings, db.labelGroups, db.labelDefinitions], async () => {
    const settings = await db.settings.get('main')
    if (settings?.profileId !== prepared.profileId || settings?.datasetId !== prepared.datasetId) throw new Error('確認したデータセットと一致しません')
    // Stops and resumes both bump the epoch, so a proposal prepared before a stop never survives it.
    if (prepared.origin === 'ai') { const policy = changePolicyFor(settings); if (!processingAllowed(settings, prepared.actor ?? {kind:'coach',id:'app-coach'}) || !policy.aiChangesEnabled || policy.epoch !== prepared.policyEpoch || processingEpoch(settings, prepared.actor ?? {kind:'coach',id:'app-coach'}) !== prepared.processingEpoch) throw new Error('AIの停止または権限の変更により、この案は使えません。作り直してください') }
    const ids = await createTasksAtomic(prepared.inputs, `assist:${prepared.id}`)
    const auditId = `assist-approval:${prepared.id}`
    if (!await db.audits.get(auditId)) await db.audits.add({ id: auditId, taskId: null, operation: 'assist.approved', at: new Date().toISOString(), detail: `本人承認 ${confirmedDigest}; origin=${prepared.origin === 'ai' ? 'ai_accepted' : 'human'}; tasks=${ids.join(',')}${prepared.actor ? `; actor=external-agent:${prepared.actor.id}; entrance=${prepared.actor.entrance}; command=${prepared.actor.commandId}` : ''}` })
    return ids
  })
}
