import { canonicalJSON, contentDigest } from './canonical'
import { calculateScore, emptyScore, uid, validateScore, type ScoreInput, type Task } from './domain'

export type TripAttributes = Pick<ScoreInput, 'minutes' | 'difficulty' | 'uncertainty' | 'coordination' | 'physical'>
export type CompleteTripAttributes = { [K in keyof TripAttributes]: number }
export type TripBundleInput = { title: string; travelMinutes: number; members: { taskId: string; attributes: TripAttributes }[]; allocationMode?: 'auto' | 'manual'; allocations?: Record<string, number> }
export type TripBundleMember = { taskId: string; baseRevision: number; attributes: CompleteTripAttributes; allocatedPoints: number; allocatedTravelMinutes: number; standalonePoints: number; previousScore: ScoreInput; previousEffectivePoints: number | null; previousCompletion?: { completionId: string; hadLastConfirmedPoints: boolean; lastConfirmedPoints: number | null } }
export type TripBundleProposal = { id: string; input: TripBundleInput; ruleVersion: 'v1'; totalPoints: number; totalMinutes: number; members: TripBundleMember[]; manualConfirmationIds: string[]; digest: string }
export type TripBundle = { id: string; ownerId: string; title: string; travelMinutes: number; allocationMode: 'auto' | 'manual'; ruleVersion: 'v1'; totalPoints: number; totalMinutes: number; members: TripBundleMember[]; revision: number; createdAt: string; updatedAt: string; frozenAt: string | null }

const attributeKeys = ['minutes', 'difficulty', 'uncertainty', 'coordination', 'physical'] as const
const limits = { minutes: 10080, difficulty: 4, uncertainty: 3, coordination: 3, physical: 3 }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype)
const filled = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 200
function integer(value: unknown, max: number, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) throw new Error(`${label}は0〜${max}の整数で指定してください`)
}
function attributes(value: unknown): CompleteTripAttributes {
  if (!record(value) || Object.keys(value).length !== attributeKeys.length || Object.keys(value).some(key => !attributeKeys.includes(key as typeof attributeKeys[number]))) throw new Error('共通外出の作業属性が不正です')
  for (const key of attributeKeys) integer(value[key], limits[key], `${key}（不明な項目は先に確認してください）`)
  return Object.fromEntries(attributeKeys.map(key => [key, value[key]])) as CompleteTripAttributes
}
const attributePoints = (a: CompleteTripAttributes) => 4 * a.difficulty + 3 * a.uncertainty + 3 * a.coordination + 2 * a.physical
const weight = (a: CompleteTripAttributes) => Math.max(1, 2 * Math.ceil(a.minutes / 15) + attributePoints(a))

export function allocateTripShares(total: number, members: { taskId: string; weight: number }[]): { taskId: string; amount: number }[] {
  integer(total, 100000, '配分合計')
  if (!Array.isArray(members) || members.length < 1 || members.length > 200) throw new Error('共通外出は1〜200件で指定してください')
  const ids = new Set<string>()
  for (const member of members) {
    if (!filled(member.taskId) || ids.has(member.taskId)) throw new Error('配分対象のIDが重複または不正です')
    integer(member.weight, 100000, '配分の重み'); ids.add(member.taskId)
  }
  const sum = members.reduce((value, member) => value + BigInt(member.weight), 0n)
  if (!sum) throw new Error('配分の重みを1件以上設定してください')
  const shares = members.map(member => {
    const numerator = BigInt(total) * BigInt(member.weight)
    return { taskId: member.taskId, amount: Number(numerator / sum), remainder: numerator % sum }
  })
  const remaining = total - shares.reduce((value, member) => value + member.amount, 0)
  const ordered = [...shares].sort((a, b) => a.remainder !== b.remainder ? a.remainder > b.remainder ? -1 : 1 : a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)
  for (let i = 0; i < remaining; i++) ordered[i].amount++
  return shares.map(({ taskId, amount }) => ({ taskId, amount }))
}

function normalizeInput(input: TripBundleInput): TripBundleInput {
  if (!record(input) || Object.keys(input).some(key => !['title', 'travelMinutes', 'members', 'allocationMode', 'allocations'].includes(key)) || typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 200) throw new Error('共通外出の名前を1〜200文字で指定してください')
  integer(input.travelMinutes, 10080, '共通の移動分数')
  if (!Array.isArray(input.members) || input.members.length < 1 || input.members.length > 200) throw new Error('共通外出は1〜200件で指定してください')
  const ids = new Set<string>()
  const members = input.members.map(member => {
    if (!record(member) || Object.keys(member).some(key => !['taskId', 'attributes'].includes(key)) || !filled(member.taskId) || ids.has(member.taskId)) throw new Error('共通外出のタスクIDが重複または不正です')
    ids.add(member.taskId)
    return { taskId: member.taskId, attributes: attributes(member.attributes) }
  }).sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)
  const allocationMode = input.allocationMode ?? 'auto'
  if (!['auto', 'manual'].includes(allocationMode)) throw new Error('配分方法が不正です')
  if (allocationMode === 'auto') {
    if (input.allocations !== undefined) throw new Error('自動配分に手動配分値を混在させないでください')
    return { title: input.title.trim(), travelMinutes: input.travelMinutes, members, allocationMode }
  }
  if (!record(input.allocations) || Object.keys(input.allocations).length !== members.length || Object.keys(input.allocations).some(id => !ids.has(id))) throw new Error('手動配分には全タスクを一度ずつ指定してください')
  const allocations = Object.fromEntries(members.map(({ taskId }) => { integer(input.allocations![taskId], 100000, '配分ポイント'); return [taskId, input.allocations![taskId]] }))
  return { title: input.title.trim(), travelMinutes: input.travelMinutes, members, allocationMode, allocations }
}

export async function prepareTripBundle(tasks: Task[], input: TripBundleInput, id: string = uid()): Promise<TripBundleProposal> {
  if (!filled(id)) throw new Error('共通外出案のIDが不正です')
  const normalized = normalizeInput(input)
  const weights = normalized.members.map(member => ({ taskId: member.taskId, weight: weight(member.attributes as CompleteTripAttributes) }))
  const totalMinutes = normalized.travelMinutes + normalized.members.reduce((sum, member) => sum + member.attributes.minutes!, 0)
  const totalPoints = Math.max(20, 2 * Math.ceil(totalMinutes / 15) + normalized.members.reduce((sum, member) => sum + attributePoints(member.attributes as CompleteTripAttributes), 0) + 10)
  integer(totalPoints, 100000, '共通外出の合計ポイント')
  const allocated = normalized.allocationMode === 'manual' ? normalized.allocations! : Object.fromEntries(allocateTripShares(totalPoints, weights).map(member => [member.taskId, member.amount]))
  if (Object.values(allocated).reduce((sum, value) => sum + value, 0) !== totalPoints) throw new Error(`配分合計を共通外出の${totalPoints}ptに合わせてください`)
  const travel = Object.fromEntries(allocateTripShares(normalized.travelMinutes, weights).map(member => [member.taskId, member.amount]))
  const members = normalized.members.map(member => {
    const task = tasks.find(item => item.id === member.taskId)
    if (!task || task.deletedAt || task.status !== 'open') throw new Error('共通外出には未完了のタスクを選んでください')
    if (task.score.mode === 'allocated') throw new Error('既に配分されているタスクは共通外出へ追加できません')
    validateScore(task.score)
    const complete = member.attributes as CompleteTripAttributes
    const standalonePoints = calculateScore({ ...emptyScore(), mode: 'formula', ...complete, travelMinutes: normalized.travelMinutes, outing: true }).effective!
    return { taskId: task.id, baseRevision: task.revision, attributes: complete, allocatedPoints: allocated[task.id], allocatedTravelMinutes: travel[task.id], standalonePoints, previousScore: { ...task.score }, previousEffectivePoints: task.effectivePoints }
  })
  const unsigned = { id, input: normalized, ruleVersion: 'v1' as const, totalPoints, totalMinutes, members, manualConfirmationIds: members.filter(member => member.previousScore.mode === 'manual').map(member => member.taskId) }
  return { ...unsigned, digest: await contentDigest(unsigned) }
}

export async function validateTripBundleProposal(proposal: TripBundleProposal, tasks: Task[], bundles: TripBundle[], confirmedManualIds: string[]): Promise<void> {
  if (!record(proposal) || Object.keys(proposal).some(key => !['id', 'input', 'ruleVersion', 'totalPoints', 'totalMinutes', 'members', 'manualConfirmationIds', 'digest'].includes(key))) throw new Error('共通外出案が不正です')
  const fresh = await prepareTripBundle(tasks, proposal.input, proposal.id)
  if (fresh.digest !== proposal.digest || canonicalJSON(fresh) !== canonicalJSON(proposal)) throw new Error('別の画面で更新されたか、配分案が変更されました。案を作り直してください')
  if (bundles.some(bundle => bundle.members.some(member => fresh.members.some(candidate => candidate.taskId === member.taskId)))) throw new Error('タスクは既に別の共通外出へまとめられています')
  if (!Array.isArray(confirmedManualIds) || new Set(confirmedManualIds).size !== confirmedManualIds.length || confirmedManualIds.some(id => !fresh.manualConfirmationIds.includes(id)) || fresh.manualConfirmationIds.some(id => !confirmedManualIds.includes(id))) throw new Error('手動ポイントを配分へ切り替える項目を本人が確認してください')
}

export function tripMemberScore(member: TripBundleMember): ScoreInput {
  return { ...member.previousScore, ...member.attributes, mode: 'allocated', manualPoints: member.allocatedPoints, travelMinutes: member.allocatedTravelMinutes, outing: true }
}

export function tripBundleFromProposal(proposal: TripBundleProposal, ownerId: string, at = new Date().toISOString()): TripBundle {
  if (!filled(ownerId) || !timestamp(at)) throw new Error('共通外出の保存情報が不正です')
  return { id: proposal.id, ownerId, title: proposal.input.title, travelMinutes: proposal.input.travelMinutes, allocationMode: proposal.input.allocationMode ?? 'auto', ruleVersion: proposal.ruleVersion, totalPoints: proposal.totalPoints, totalMinutes: proposal.totalMinutes, members: structuredClone(proposal.members), revision: 1, createdAt: at, updatedAt: at, frozenAt: null }
}

export function freezeTripBundle(bundle: TripBundle, taskId: string, at = new Date().toISOString()): TripBundle {
  if (bundle.frozenAt || !bundle.members.some(member => member.taskId === taskId)) return bundle
  if (!timestamp(at)) throw new Error('共通外出の完了時刻が不正です')
  return { ...bundle, frozenAt: at, updatedAt: at, revision: bundle.revision + 1 }
}

export function assertTripBundleCanRemove(bundle: TripBundle, tasks: Task[]): void {
  if (bundle.frozenAt || bundle.members.some(member => tasks.find(task => task.id === member.taskId)?.status === 'completed')) throw new Error('一部完了した共通外出は構成と配分が固定されています')
}

export function assertTripTaskScoreChangeAllowed(taskId: string, before: ScoreInput, after: ScoreInput, bundles: TripBundle[]): void {
  if (bundles.some(bundle => bundle.members.some(member => member.taskId === taskId)) && canonicalJSON(before) !== canonicalJSON(after)) throw new Error('共通外出の配分はタスクから直接変更できません。未完了のまとめを取り消してから変更してください')
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

export function validateTripBundleRecord(value: unknown, tasks: Task[], ownerId: string): asserts value is TripBundle {
  if (!record(value) || Object.keys(value).some(key => !['id', 'ownerId', 'title', 'travelMinutes', 'allocationMode', 'ruleVersion', 'totalPoints', 'totalMinutes', 'members', 'revision', 'createdAt', 'updatedAt', 'frozenAt'].includes(key)) || !filled(value.id) || value.ownerId !== ownerId || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200 || value.ruleVersion !== 'v1' || !['auto', 'manual'].includes(value.allocationMode as string) || !Number.isInteger(value.revision) || (value.revision as number) < 1 || !timestamp(value.createdAt) || !timestamp(value.updatedAt) || (value.frozenAt !== null && !timestamp(value.frozenAt))) throw new Error('共通外出の保存データが不正です')
  integer(value.travelMinutes, 10080, '共通の移動分数')
  integer(value.totalPoints, 100000, '共通外出の合計ポイント')
  if (!Array.isArray(value.members) || !value.members.length || value.members.length > 200) throw new Error('共通外出の構成が不正です')
  const ids = new Set<string>()
  const members: TripBundleMember[] = value.members.map(member => {
    if (!record(member) || Object.keys(member).some(key => !['taskId', 'baseRevision', 'attributes', 'allocatedPoints', 'allocatedTravelMinutes', 'standalonePoints', 'previousScore', 'previousEffectivePoints', 'previousCompletion'].includes(key)) || !filled(member.taskId) || ids.has(member.taskId) || !Number.isInteger(member.baseRevision) || (member.baseRevision as number) < 1 || !record(member.previousScore) || Object.keys(member.previousScore).length !== Object.keys(emptyScore()).length || Object.keys(member.previousScore).some(key => !Object.hasOwn(emptyScore(), key)) || !['unset', 'manual', 'formula'].includes(member.previousScore.mode as string)) throw new Error('共通外出の作業データが不正です')
    if (member.previousCompletion !== undefined) {
      const previous = member.previousCompletion
      if (!record(previous) || Object.keys(previous).length !== 3 || Object.keys(previous).some(key => !['completionId', 'hadLastConfirmedPoints', 'lastConfirmedPoints'].includes(key)) || !filled(previous.completionId) || typeof previous.hadLastConfirmedPoints !== 'boolean' || (!previous.hadLastConfirmedPoints && previous.lastConfirmedPoints !== null)) throw new Error('共通外出の以前の完了設定が不正です')
      if (previous.lastConfirmedPoints !== null) integer(previous.lastConfirmedPoints, 100000, '以前の確定ポイント')
    }
    ids.add(member.taskId)
    const complete = attributes(member.attributes)
    integer(member.allocatedPoints, 100000, '配分ポイント'); integer(member.allocatedTravelMinutes, 10080, '配分移動分数'); integer(member.standalonePoints, 100000, '単独外出ポイント')
    const previousScore = member.previousScore as unknown as ScoreInput
    validateScore(previousScore)
    if (member.previousEffectivePoints !== calculateScore(previousScore).effective) throw new Error('共通外出の変更前ポイントが不正です')
    const typed = { ...member, attributes: complete } as unknown as TripBundleMember
    if (calculateScore({ ...emptyScore(), mode: 'formula', ...complete, travelMinutes: value.travelMinutes as number, outing: true }).effective !== member.standalonePoints) throw new Error('共通外出の参考ポイントが不正です')
    const task = tasks.find(item => item.id === member.taskId)
    if (!task || canonicalJSON(task.score) !== canonicalJSON(tripMemberScore(typed)) || task.effectivePoints !== member.allocatedPoints) throw new Error('共通外出とタスクの配分が一致しません')
    return typed
  })
  const weights = members.map(member => ({ taskId: member.taskId, weight: weight(member.attributes) }))
  const totalMinutes = (value.travelMinutes as number) + members.reduce((sum, member) => sum + member.attributes.minutes, 0)
  const totalPoints = Math.max(20, 2 * Math.ceil(totalMinutes / 15) + members.reduce((sum, member) => sum + attributePoints(member.attributes), 0) + 10)
  const expectedTravel = allocateTripShares(value.travelMinutes as number, weights)
  if (value.totalMinutes !== totalMinutes || value.totalPoints !== totalPoints || members.reduce((sum, member) => sum + member.allocatedPoints, 0) !== totalPoints || members.some(member => member.allocatedTravelMinutes !== expectedTravel.find(row => row.taskId === member.taskId)?.amount)) throw new Error('共通外出の合計または移動配分が不正です')
  if (value.allocationMode === 'auto') {
    const expectedPoints = allocateTripShares(totalPoints, weights)
    if (members.some(member => member.allocatedPoints !== expectedPoints.find(row => row.taskId === member.taskId)?.amount)) throw new Error('共通外出の自動配分が不正です')
  }
  if (!value.frozenAt && members.some(member => tasks.find(task => task.id === member.taskId)?.status === 'completed')) throw new Error('完了した共通外出の固定状態が不正です')
}
