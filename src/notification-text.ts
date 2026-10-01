import type { CharacterProfile } from './domain'
import type { NotificationFacts } from './coach-facts'

export type NotificationTextRequest = { model: string; facts: NotificationFacts; character: CharacterProfile }
export type NotificationTextTransport = (request: NotificationTextRequest) => Promise<string>
const actionClaim = /(?:変更|完了|登録|追加|削除|移動|延期|設定|送信|予約|調整|記録)(?:しました|しておきました|済み|済です|いたしました)|やっておきました|片付けました|終わらせました/
const newObligation = /ついでに|あわせて|併せて|追加で|新しく|ほかにも|他にも|も(?:やろう|やりましょう|しよう|しましょう|片付け|進め)|必要なら/
const relativeDate = /明日|明後日|あさって|今日|本日|昨日|来週|今週|来月|今月|週末|月末|年内/
const url = /https?:|www\.|[a-z0-9-]+\.(?:com|net|org|jp|io|ai|dev|app)\b/i
const deadlineState = /過ぎ|切れ|超過|遅れ|遅延|期限(?:は|が)?(?:なし|ありません|ない)|延長|猶予/
/** Whole renderings of the deadline itself (ISO, 年月日, 月日, M/D, with or without leading zeros), longest first. */
function allowedDates(facts: NotificationFacts) {
  const [year, month, day] = facts.dueDate.split('-'), values = new Set([facts.dueDate])
  for (const m of new Set([month, String(Number(month))])) for (const d of new Set([day, String(Number(day))])) for (const value of [`${year}年${m}月${d}日`, `${m}月${d}日`, `${m}/${d}`]) values.add(value)
  return [...values].sort((a, b) => b.length - a.length)
}
/**
 * Heuristic gate for saved AI wording: no digits except the deadline itself and no deadline-state claims. It cannot prove meaning, so failures keep the factual
 * template and accepted text is always labelled as AI wording with its model.
 */
export function validateNotificationText(answer: unknown, facts: NotificationFacts, otherTitles: string[] = []): string {
  if (typeof answer !== 'string') throw new Error('通知文の形式が不正です')
  const value = answer.trim(), normalized = value.normalize('NFKC'), title = facts.title.normalize('NFKC')
  if (!value || value.length > 200) throw new Error('通知文は1〜200文字にしてください')
  if (/[\r\n]/.test(value)) throw new Error('通知文は一段落にしてください')
  if (url.test(normalized)) throw new Error('通知文にURLを含めません')
  if (!normalized.includes(title)) throw new Error('通知文に対象タスク名がありません')
  // Only the deadline date itself may carry digits: swapped dates, times and counts all leave a digit behind.
  const rest = normalized.split(title).join('')
  if (/\d/.test(allowedDates(facts).reduce((left, date) => left.split(date).join(''), rest))) throw new Error('通知文に事実にない数字・日付があります')
  if (deadlineState.test(rest)) throw new Error('通知文で期限の状態を述べません')
  if (relativeDate.test(normalized.replace(title, ''))) throw new Error('通知文に相対的な日付を含めません')
  if (actionClaim.test(normalized)) throw new Error('通知文で実行・変更済みと述べません')
  if (newObligation.test(normalized.replace(title, ''))) throw new Error('通知文に新しい義務や追加作業を含めません')
  for (const other of otherTitles.map(item => item.normalize('NFKC').trim())) if (other.length >= 2 && !title.includes(other) && normalized.includes(other)) throw new Error('通知文に別のタスクを含めません')
  return value
}
/** Returns validated saved wording or null. Errors (budget, timeout, invalid text) keep the factual template. */
export async function draftNotificationText(transport: NotificationTextTransport | undefined, request: NotificationTextRequest, otherTitles: string[]): Promise<{ text: string | null; error: string | null }> {
  if (!transport) return { text: null, error: 'AI接続がありません' }
  try { return { text: validateNotificationText(await transport(structuredClone(request)), request.facts, otherTitles), error: null } }
  catch (error) { return { text: null, error: error instanceof Error ? error.message : String(error) } }
}
