import { newTaskInput, type TaskInput } from './commands'
import { addDays, emptyScore, validateDate } from './domain'

export type AssistedDraft = { input: TaskInput; notices: string[] }

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
  const pointMatches = [...raw.matchAll(/(?:^|[^\d])(\d{1,7})\s*(?:pt|ポイント)(?![\w])/gi), ...raw.matchAll(/\bpt:(\d{1,7})\b/gi)]
  const points = pointMatches.length === 1 && Number(pointMatches[0][1]) <= 100000 ? Number(pointMatches[0][1]) : null
  if (points !== null) input.score = { ...emptyScore(), mode: 'manual', manualPoints: points }
  else if (pointMatches.length) notices.push('ポイントの指定が複数または範囲外のため、手動で確認してください。')
  const minuteMatches = [...raw.matchAll(/(?:^|[^\d])(\d{1,5})\s*分/g)]
  const minutes = uniqueNumber(raw, /(?:^|[^\d])(\d{1,5})\s*分/g, 10080)
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
