import type { Task } from './domain'

export type CoachTargetCandidate = { id: string; title: string; scheduledDate: string | null; dueDate: string | null; revision: number }
/** Explicit context only: a notification the person replied to, the selected task, or the task discussed last. */
export type CoachTargetContext = { selectedTaskId?: string | null; notificationTaskIds?: string[]; lastDiscussedTaskId?: string | null }
export type CoachTargetResolution =
  | { status: 'unique'; task: CoachTargetCandidate; via: 'notification' | 'quoted' | 'title' | 'subject' | 'context' }
  | { status: 'ambiguous'; candidates: CoachTargetCandidate[] }
  | { status: 'none'; candidates: CoachTargetCandidate[] }
const demonstrative = /あれ|これ|それ|さっきの|この(?:タスク|件|作業)|その(?:タスク|件|作業)|例の/
const timeWord = /^(今日|明日|明後日|昨日|今週|来週|今月|来月|今朝|今夜|今晩|午前|午後)$/
const norm = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
const candidate = (task: Task): CoachTargetCandidate => ({ id: task.id, title: task.title, scheduledDate: task.scheduledDate, dueDate: task.dueDate, revision: task.revision })
const order = (a: Task, b: Task) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.title.localeCompare(b.title, 'ja') || (a.id < b.id ? -1 : 1)
function longestCommon(a: string, b: string) {
  let best = 0
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) { let k = 0; while (a[i + k] && a[i + k] === b[j + k]) k++; if (k > best) best = k }
  return best
}
function pick(matches: Task[], via: Extract<CoachTargetResolution, { status: 'unique' }>['via']): CoachTargetResolution | null {
  if (matches.length === 1) return { status: 'unique', task: candidate(matches[0]), via }
  if (matches.length > 1) return { status: 'ambiguous', candidates: [...matches].sort(order).slice(0, 10).map(candidate) }
  return null
}
/**
 * Deterministic target resolution for a consultation. Completed and deleted tasks are never candidates.
 * Fuzzy matches only narrow the choice: every result still needs the person's choice or approval.
 */
export function resolveCoachTarget(text: string, tasks: Task[], context: CoachTargetContext = {}): CoachTargetResolution {
  const open = tasks.filter(task => !task.deletedAt && task.status === 'open'), message = norm(text)
  const notified = open.filter(task => context.notificationTaskIds?.includes(task.id))
  // A reply to a notification binds to that notification's task(s) only.
  if (context.notificationTaskIds?.length) {
    if (notified.length === 1) return { status: 'unique', task: candidate(notified[0]), via: 'notification' }
    if (!notified.length) return { status: 'none', candidates: [] }
  }
  const pool = notified.length ? notified : open
  for (const quote of [...text.matchAll(/[「『"“]([^」』"”]{1,300})[」』"”]/g)].map(match => norm(match[1]))) {
    const found = pick(pool.filter(task => norm(task.title) === quote), 'quoted') ?? pick(pool.filter(task => norm(task.title).includes(quote)), 'quoted')
    if (found) return found
  }
  const pointing = demonstrative.test(text)
  if (!pointing) {
    const contained = pool.filter(task => norm(task.title).length >= 2 && message.includes(norm(task.title)))
    const longest = contained.length ? Math.max(...contained.map(task => norm(task.title).length)) : 0, titled = contained.filter(task => norm(task.title).length === longest)
    // Subject phrase before the first particle, e.g. 「報告書を明日に」 → 報告書, read without date/condition words so 今日/明日 never name a task.
    const fuzzy = norm(text.replace(/\d{4}-\d{1,2}-\d{1,2}|明後日|あさって|今日|本日|明日|あした|今週|来週|無理|疲れ\S*|移して|ずらして|延期して?/g, ''))
    const subject = fuzzy.split(/を|は|って|の件|も|が/).map(part => part.replace(/[、。,，.!！?？・]/g, '')).find(part => part && !timeWord.test(part)) ?? ''
    const subjected = subject.length >= 2 ? pool.filter(task => norm(task.title).includes(subject)) : []
    // Title and subject must corroborate each other; a short title that merely appears in the text is not enough on its own.
    if (titled.length === 1 && (subjected.some(task => task.id === titled[0].id) || !subjected.length && longest > 2)) return { status: 'unique', task: candidate(titled[0]), via: 'title' }
    if (titled.length > 1 || titled.length === 1 && subjected.length) return { status: 'ambiguous', candidates: [...new Set([...titled, ...subjected])].sort(order).slice(0, 10).map(candidate) }
    const found = pick(subjected, 'subject'); if (found) return found
    // Character overlap is only a guess: it narrows the chooser, never selects.
    const scored = pool.map(task => ({ task, score: longestCommon(norm(task.title), fuzzy) })).filter(item => item.score >= 2).sort((a, b) => b.score - a.score)
    if (scored.length) { const best = scored[0].score; return { status: 'ambiguous', candidates: scored.filter(item => item.score >= best - 1).map(item => item.task).sort(order).slice(0, 10).map(candidate) } }
  } else {
    // あれ/これ/それ resolve only from explicit context and only when exactly one id is present.
    const ids = [...new Set([...(context.notificationTaskIds ?? []), ...(context.selectedTaskId ? [context.selectedTaskId] : []), ...(context.lastDiscussedTaskId ? [context.lastDiscussedTaskId] : [])])]
    const known = pool.filter(task => ids.includes(task.id))
    if (ids.length === 1 && known.length === 1) return { status: 'unique', task: candidate(known[0]), via: 'context' }
    if (known.length > 1) return { status: 'ambiguous', candidates: known.sort(order).slice(0, 10).map(candidate) }
  }
  // A multi-task notification (Smart List) never changes several tasks at once: the person chooses.
  return notified.length ? { status: 'ambiguous', candidates: notified.sort(order).slice(0, 10).map(candidate) } : { status: 'none', candidates: [] }
}
/** The optional AI step may only echo one id from the deterministic list; anything else falls back to the chooser. */
export function parseCoachTargetAnswer(answer: unknown, candidates: CoachTargetCandidate[]): string {
  let parsed: unknown
  try { parsed = typeof answer === 'string' ? JSON.parse(answer) : null } catch { throw new Error('対象候補の回答を読めませんでした。候補から選んでください') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'taskId')) throw new Error('対象候補の回答形式が不正です。候補から選んでください')
  const id = (parsed as { taskId: unknown }).taskId
  if (id === null) throw new Error('AIも対象を一つに決められませんでした。候補から選んでください')
  if (typeof id !== 'string' || !candidates.some(item => item.id === id)) throw new Error('候補にないタスクが返されました。候補から選んでください')
  return id
}
