import { db } from './db'
import { contentDigest } from './canonical'
import { uid, type Task } from './domain'
import { applyBreakdownProposal, type BreakdownProposal } from './breakdown'
import { changePolicyFor } from './change-set'
import { operationMode } from './automation-policy'

export type CoachSplitPart = { name: string; points: number | null }
export type CoachSplitParse = { kind: 'split'; parts: CoachSplitPart[] } | { kind: 'clarify'; message: string } | null
/** Each value is the person's own number or an app default the person explicitly confirmed. */
export type SplitPointOrigin = 'human' | 'app_default' | 'app_default_confirmed'
export type CoachSplitProposal = { id: string; taskId: string; parentRevision: number; parentPoints: number; instruction: string; parts: { name: string; title: string; points: number; origin: SplitPointOrigin }[] }
/** Recurrence wording goes to the routine (周期) flow with its own approvals, never to a task ChangeSet. */
export const recurrencePattern = /毎日|毎週|毎月|毎年|隔週|第\d+(?:営業日|週)|月末|営業日|曜日ごと|毎朝|毎晩/
export function consultationKind(text: string, openTitles: string[] = []): 'routine' | 'split' | 'clarify' | 'task' {
  // Recurrence words inside a quoted or existing task title name the target, not a new cycle.
  let rest = text.normalize('NFKC').replace(/[「『"“][^」』"”]{1,300}[」』"”]/g, '')
  for (const title of openTitles.map(item => item.normalize('NFKC').trim()).filter(item => item.length >= 2).sort((a, b) => b.length - a.length)) rest = rest.split(title).join('')
  if (recurrencePattern.test(rest)) return 'routine'
  return parseCoachSplit(text)?.kind ?? 'task'
}
const splitVerb = /(?:に|へ)(?:分けて|分割して|分割|分ける|わけて)/
/** Deterministic parse: explicit part names (and optional explicit points) only; 半分/減らして asks instead. */
export function parseCoachSplit(text: string): CoachSplitParse {
  const value = text.normalize('NFKC').trim()
  if (!splitVerb.test(value)) return /半分|減らして|少なくして|小さくして|軽くして|削って/.test(value) ? { kind: 'clarify', message: '分割（作業を複数に分ける）か、範囲を減らす（このタスクの内容を見直す）かを確認させてください。ポイントは自動で半分にしません。' } : null
  let segment = value.slice(0, value.search(splitVerb))
  const object = segment.lastIndexOf('を'); if (object >= 0) segment = segment.slice(object + 1)
  const parts = segment.split(/と|、|,|・/).map(item => item.trim()).filter(Boolean).map(item => {
    const match = item.match(/^(.*?)(\d+)\s*(?:pt|ポイント|点)$/i)
    return match ? { name: match[1].replace(/[はがで]$/, '').trim(), points: Number(match[2]) } : { name: item, points: null }
  })
  if (parts.length < 2 || parts.length > 10) throw new Error('分ける作業名を「AとBに分けて」のように2〜10個指定してください')
  if (parts.some(part => !part.name || part.name.length > 60) || new Set(parts.map(part => part.name)).size !== parts.length) throw new Error('作業名を重複なく1〜60文字で指定してください')
  if (parts.some(part => part.points !== null) && parts.some(part => part.points === null)) throw new Error('各部分のポイントをすべて指定するか、すべて省略してください')
  if (parts.some(part => part.points !== null && (!Number.isSafeInteger(part.points) || part.points > 100000))) throw new Error('ポイントは0〜100000の整数です')
  return { kind: 'split', parts }
}
function parentPoints(task: Task) {
  if (task.deletedAt || task.status !== 'open') throw new Error('未完了のタスクだけ分割できます')
  if (!['manual', 'allocated'].includes(task.score.mode) || task.score.manualPoints === null) throw new Error('分割前に必要ポイントを本人が確定してください（推定値は配分しません）')
  return task.score.manualPoints
}
/** Even split defaults (remainder on the last part) are flagged app_default until the person confirms each one. */
export function buildCoachSplitProposal(task: Task, parts: CoachSplitPart[], instruction: string, id: string = uid()): CoachSplitProposal {
  const total = parentPoints(task), base = Math.floor(total / parts.length)
  return { id, taskId: task.id, parentRevision: task.revision, parentPoints: total, instruction, parts: parts.map((part, index) => ({ name: part.name, title: `${task.title}：${part.name}`, points: part.points ?? (index === parts.length - 1 ? total - base * (parts.length - 1) : base), origin: part.points === null ? 'app_default' : 'human' })) }
}
/** Rejects invented parts, renamed parts and a sum different from the parent's confirmed points. */
export function validateCoachSplit(proposal: CoachSplitProposal, names: string[]) {
  if (proposal.parts.length !== names.length || proposal.parts.some((part, index) => part.name !== names[index] || !part.title.includes(names[index]) || !part.title.trim() || part.title.length > 300)) throw new Error('本人が指定した作業名と分割案が一致しません')
  if (proposal.parts.some(part => !Number.isSafeInteger(part.points) || part.points < 0 || part.points > 100000)) throw new Error('各部分のポイントを0〜100000の整数にしてください')
  const sum = proposal.parts.reduce((total, part) => total + part.points, 0)
  if (sum !== proposal.parentPoints) throw new Error(`配分の合計（${sum}pt）を親の${proposal.parentPoints}ptに合わせてください`)
  if (proposal.parts.some(part => part.origin === 'app_default')) throw new Error('アプリの既定値（均等割り）を確認するか、値を入力してください')
}
function trustedClick(event: Event) {
  const getType = Object.getOwnPropertyDescriptor(Event.prototype, 'type')?.get
  try { if (!(event instanceof Event) || !event.isTrusted || !getType || !['click', 'submit'].includes(getType.call(event))) throw new Error() }
  catch { throw new Error('アプリの本人確認ボタンから承認してください') }
}
/** Native-click approval around the existing breakdown invariants (parent → 0pt, children allocated, ledger only on completion). */
export async function applyCoachSplitFromUI(proposal: CoachSplitProposal, names: string[], owner: { ownerId: string; datasetId: string }, event: Event): Promise<string[]> {
  trustedClick(event)
  proposal = structuredClone(proposal)
  validateCoachSplit(proposal, names)
  const settings = await db.settings.get('main')
  if (!settings || settings.profileId !== owner.ownerId || settings.datasetId !== owner.datasetId) throw new Error('本人・データセットが変わりました')
  // The coach entrance follows the S20 operation table; a stopped split is never applied from the coach.
  if (operationMode(changePolicyFor(settings), 'task.split') === 'deny') throw new Error('コーチからのタスク分割は停止しています（自動化設定）')
  const breakdown: BreakdownProposal = { id: proposal.id, taskId: proposal.taskId, parentRevision: proposal.parentRevision, reason: 'instruction', steps: proposal.parts.map(part => ({ title: part.title, points: part.points })) }
  return applyBreakdownProposal(breakdown, { origin: 'coach_split_from_instruction', instructionDigest: await contentDigest({ instruction: proposal.instruction, taskId: proposal.taskId, parentRevision: proposal.parentRevision }) })
}
