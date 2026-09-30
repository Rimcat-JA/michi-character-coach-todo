import { db } from './db'
import { addDays, calculateScore, emptyScore, today, uid, validateDate, validateTaskInput, type Assessment, type Routine, type Task } from './domain'
import { containerPath } from './containers'
import { validateLabelsForOwner } from './labels'
import { assertTripTaskScoreChangeAllowed, freezeTripBundle } from './trip-bundles'
import { cancelCoachNotificationTarget } from './coach-notification-save'

export class ConflictError extends Error { constructor() { super('別の画面で更新されました。再読み込みして差分を確認してください。') } }
const now = () => new Date().toISOString()
const tables = [db.tasks, db.assessments, db.completions, db.ledger, db.routines, db.sessions, db.commands, db.audits, db.containers, db.settings, db.labelGroups, db.labelDefinitions]
async function receipt<T>(key: string, payload: unknown, run: () => Promise<T>, includeTrips = false): Promise<T> {
  const hash = JSON.stringify(payload)
  return db.transaction('rw', includeTrips ? [...tables, db.tripBundles] : tables, async () => {
    const prior = await db.commands.get(key)
    if (prior) {
      if (prior.hash !== hash) throw new Error('IDEMPOTENCY_MISMATCH')
      return prior.resultId as T
    }
    const result = await run()
    await db.commands.add({ key, hash, resultId: String(result ?? ''), at: now() })
    return result
  })
}
export type TaskInput = Pick<Task, 'title' | 'notes' | 'project' | 'labels' | 'scheduledDate' | 'dueDate' | 'targetDate' | 'reviewDate' | 'availableFrom' | 'importance' | 'score'> & { containerId?: string | null; deferredUntil?: string | null; frog?: number | null; weight?: number | null; energyNeed?: number | null; focusNeed?: number | null; positiveFeeling?: number | null }
export const newTaskInput = (): TaskInput => ({ title: '', notes: '', project: '', containerId: null, labels: [], scheduledDate: null, dueDate: null, targetDate: null, reviewDate: null, availableFrom: null, deferredUntil: null, importance: 1, frog: null, weight: null, energyNeed: null, focusNeed: null, positiveFeeling: null, score: emptyScore() })

async function resolvedProject(input: TaskInput): Promise<string> {
  if (!input.containerId) return input.project
  const containers = await db.containers.toArray(), item = containers.find(value => value.id === input.containerId)
  const settings = await db.settings.get('main')
  if (!item || item.deletedAt || item.ownerId !== settings?.profileId) throw new Error('カテゴリ・プロジェクトにアクセスできません')
  return containerPath(item.id, containers)
}

export async function addTask(input: TaskInput, generationKey: string, routineId: string | null): Promise<string> {
  validateTaskInput(input)
  await validateLabelsForOwner(input.labels)
  for (const [name, value] of [['予定日', input.scheduledDate], ['締め切り', input.dueDate], ['目標日', input.targetDate], ['見直し日', input.reviewDate], ['開始可能日', input.availableFrom], ['延期終了日', input.deferredUntil ?? null]] as const) validateDate(value, name)
  const result = calculateScore(input.score)
  const project = await resolvedProject(input)
  const id = uid(), assessmentId = uid(), at = now()
  const task: Task = { ...input, project, firstScheduledDate: input.scheduledDate, title: input.title.trim(), labels: [...input.labels], score: { ...input.score }, id, generationKey, routineId, effectivePoints: result.effective, assessmentId, status: 'open', revision: 1, createdAt: at, updatedAt: at, deletedAt: null }
  const assessment: Assessment = { id: assessmentId, taskId: id, score: { ...input.score }, result, createdAt: at, origin: routineId ? 'routine' : 'human', ruleVersion: 'v1' }
  await db.tasks.add(task); await db.assessments.add(assessment)
  await db.audits.add({ id: uid(), taskId: id, operation: 'create', at, detail: routineId ? 'ルーティンから作成' : '本人が作成' })
  return id
}
export async function createTask(input: TaskInput, key: string = uid()) {
  return receipt(key, { operation: 'create', input }, () => addTask(input, key, null))
}
export async function createTasksAtomic(inputs: TaskInput[], key: string = uid()): Promise<string[]> {
  if (inputs.length < 1 || inputs.length > 100) throw new Error('一括登録は1〜100件で指定してください')
  const hash = JSON.stringify({ operation: 'bulk_create', inputs })
  return db.transaction('rw', [db.tasks, db.assessments, db.commands, db.audits, db.containers, db.settings, db.labelGroups, db.labelDefinitions], async () => {
    const prior = await db.commands.get(key)
    if (prior) {
      if (prior.hash !== hash) throw new Error('IDEMPOTENCY_MISMATCH')
      return JSON.parse(prior.resultId) as string[]
    }
    const ids: string[] = []
    for (const [index, input] of inputs.entries()) ids.push(await addTask(input, `${key}:${index}`, null))
    await db.commands.add({ key, hash, resultId: JSON.stringify(ids), at: now() })
    return ids
  })
}
export type BulkTaskPatch = Partial<Pick<Task, 'project' | 'scheduledDate' | 'dueDate' | 'importance'>>
export async function bulkUpdateTasksAtomic(items: { id: string; revision: number }[], patch: BulkTaskPatch, key: string = uid()): Promise<string[]> {
  if (items.length < 1 || items.length > 100 || new Set(items.map(item => item.id)).size !== items.length) throw new Error('一括編集は重複のない1〜100件で指定してください')
  const fields = Object.keys(patch)
  if (!fields.length || fields.some(field => !['project', 'scheduledDate', 'dueDate', 'importance'].includes(field))) throw new Error('一括編集の項目が不正です')
  if ('project' in patch && (typeof patch.project !== 'string' || patch.project.length > 300)) throw new Error('プロジェクト名が不正です')
  if ('scheduledDate' in patch) {
    if (patch.scheduledDate === undefined) throw new Error('予定日が不正です')
    validateDate(patch.scheduledDate, '予定日')
  }
  if ('dueDate' in patch) {
    if (patch.dueDate === undefined) throw new Error('締め切りが不正です')
    validateDate(patch.dueDate, '締め切り')
  }
  if ('importance' in patch && (!Number.isInteger(patch.importance) || patch.importance! < 0 || patch.importance! > 3)) throw new Error('重要度は0〜3で指定してください')
  const hash = JSON.stringify({ operation: 'bulk_update', items, patch })
  return db.transaction('rw', db.tasks, db.commands, db.audits, async () => {
    const prior = await db.commands.get(key)
    if (prior) {
      if (prior.hash !== hash) throw new Error('IDEMPOTENCY_MISMATCH')
      return JSON.parse(prior.resultId) as string[]
    }
    const tasks = await Promise.all(items.map(item => db.tasks.get(item.id)))
    if (tasks.some((task, index) => !task || task.deletedAt || task.revision !== items[index].revision)) throw new ConflictError()
    const at = now()
    for (const task of tasks as Task[]) {
      await db.tasks.put({ ...task, ...patch, revision: task.revision + 1, updatedAt: at })
      await db.audits.add({ id: uid(), taskId: task.id, operation: 'bulk_update', at, detail: `一括編集: ${fields.join(',')}` })
    }
    const ids = tasks.map(task => task!.id)
    await db.commands.add({ key, hash, resultId: JSON.stringify(ids), at })
    return ids
  })
}
export async function updateTask(id: string, expectedRevision: number, input: TaskInput, key: string = uid()) {
  return receipt(key, { operation: 'update', id, expectedRevision, input }, async () => {
    validateTaskInput(input)
    await validateLabelsForOwner(input.labels)
    for (const [name, value] of [['予定日', input.scheduledDate], ['締め切り', input.dueDate], ['目標日', input.targetDate], ['見直し日', input.reviewDate], ['開始可能日', input.availableFrom], ['延期終了日', input.deferredUntil ?? null]] as const) validateDate(value, name)
    const old = await db.tasks.get(id)
    if (!old || old.deletedAt) throw new Error('タスクが見つかりません')
    if (old.revision !== expectedRevision) throw new ConflictError()
    const scoreChanged = JSON.stringify(old.score) !== JSON.stringify(input.score)
    if (scoreChanged) assertTripTaskScoreChangeAllowed(id, old.score, input.score, await db.tripBundles.toArray())
    const result = calculateScore(input.score)
    const project = await resolvedProject(input)
    const assessmentId = scoreChanged ? uid() : old.assessmentId
    if (scoreChanged) await db.assessments.add({ id: assessmentId, taskId: id, score: { ...input.score }, result, createdAt: now(), origin: 'human', ruleVersion: 'v1' })
    await db.tasks.put({ ...old, ...input, project, firstScheduledDate: old.firstScheduledDate ?? old.scheduledDate ?? input.scheduledDate, title: input.title.trim(), labels: [...input.labels], score: { ...input.score }, assessmentId, effectivePoints: result.effective, revision: old.revision + 1, updatedAt: now() })
    await cancelCoachNotificationTarget(id)
    await db.audits.add({ id: uid(), taskId: id, operation: 'update', at: now(), detail: '本人が編集' })
    return id
  }, true)
}
export async function setTaskFlag(id: string, expectedRevision: number, flag: 'pinned' | 'backburner' | 'orbit', value: boolean, key: string = uid()) {
  return receipt(key, { operation: 'set_flag', id, expectedRevision, flag, value }, async () => {
    if (typeof value !== 'boolean') throw new Error('状態の値が不正です')
    const task = await db.tasks.get(id)
    if (!task || task.deletedAt) throw new Error('タスクが見つかりません')
    if (task.revision !== expectedRevision) throw new ConflictError()
    const at = now()
    await db.tasks.put({ ...task, [flag]: value, revision: task.revision + 1, updatedAt: at })
    await db.audits.add({ id: uid(), taskId: id, operation: 'set_flag', at, detail: `${flag}=${value}` })
    return id
  })
}
export async function completeTask(id: string, expectedRevision: number, key: string = uid()) {
  return receipt(key, { operation: 'complete', id, expectedRevision }, async () => {
    const task = await db.tasks.get(id)
    if (!task || task.deletedAt) throw new Error('タスクが見つかりません')
    if (task.revision !== expectedRevision) throw new ConflictError()
    if (task.status === 'completed') return id
    const at = now(), existing = await db.completions.where('taskId').equals(id).first()
    for (const bundle of await db.tripBundles.toArray()) {
      if (bundle.members.some(member => member.taskId === id) && !bundle.frozenAt) await db.tripBundles.put(freezeTripBundle(bundle, id, at))
    }
    if (existing) {
      const points = existing.lastConfirmedPoints !== undefined ? existing.lastConfirmedPoints : task.effectivePoints
      await db.completions.put({ ...existing, currentAt: at, localDate: today(new Date(at)), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, netPoints: points, scoreState: points === null ? 'pending' : 'confirmed' })
      if (points !== null) await db.ledger.add({ id: uid(), completionId: existing.id, taskId: id, kind: 'restore', delta: points, at, reason: '完了を再確定' })
    } else {
      const completionId = uid(), points = task.effectivePoints
      await db.completions.add({ id: completionId, taskId: id, originalAt: at, currentAt: at, localDate: today(new Date(at)), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, originalPoints: points, netPoints: points, scoreState: points === null ? 'pending' : 'confirmed', title: task.title, project: task.project })
      if (points !== null) await db.ledger.add({ id: uid(), completionId, taskId: id, kind: 'award', delta: points, at, reason: '完了' })
    }
    await db.tasks.put({ ...task, status: 'completed', revision: task.revision + 1, updatedAt: at })
    await cancelCoachNotificationTarget(id, at)
    await db.audits.add({ id: uid(), taskId: id, operation: 'complete', at, detail: task.effectivePoints === null ? 'ポイント未設定で完了' : `${task.effectivePoints}ptで完了` })
    return id
  }, true)
}
export async function undoCompletion(id: string, expectedRevision: number, key: string = uid()) {
  return receipt(key, { operation: 'undo', id, expectedRevision }, async () => {
    const task = await db.tasks.get(id)
    if (!task) throw new Error('タスクが見つかりません')
    if (task.revision !== expectedRevision) throw new ConflictError()
    if (task.status !== 'completed') return id
    const completion = await db.completions.where('taskId').equals(id).first()
    if (!completion || !completion.currentAt) throw new Error('完了記録がありません')
    if (completion.netPoints !== null) await db.ledger.add({ id: uid(), completionId: completion.id, taskId: id, kind: 'reverse', delta: -completion.netPoints, at: now(), reason: '完了取消' })
    await db.completions.put({ ...completion, currentAt: null, netPoints: null, lastConfirmedPoints: completion.netPoints })
    await db.tasks.put({ ...task, status: 'open', revision: task.revision + 1, updatedAt: now() })
    await db.audits.add({ id: uid(), taskId: id, operation: 'undo', at: now(), detail: '完了を取消' })
    return id
  })
}
export async function correctCompletion(id: string, points: number, reason: string, key: string = uid()) {
  return receipt(key, { operation: 'correct', id, points, reason }, async () => {
    if (!Number.isInteger(points) || points < 0 || points > 100000) throw new Error('ポイントは0〜100000の整数で入力してください')
    if (!reason.trim()) throw new Error('訂正理由を入力してください')
    const completion = await db.completions.where('taskId').equals(id).first()
    if (!completion?.currentAt) throw new Error('有効な完了記録がありません')
    const delta = points - (completion.netPoints ?? 0)
    await db.ledger.add({ id: uid(), completionId: completion.id, taskId: id, kind: 'adjust', delta, at: now(), reason: reason.trim() })
    await db.completions.put({ ...completion, netPoints: points, scoreState: 'confirmed' })
    await db.audits.add({ id: uid(), taskId: id, operation: 'correct_points', at: now(), detail: `${points}pt: ${reason.trim()}` })
    return id
  })
}
export async function trashTask(id: string, expectedRevision: number, key: string = uid()) {
  return receipt(key, { operation: 'trash', id, expectedRevision }, async () => {
    const task = await db.tasks.get(id)
    if (!task) throw new Error('タスクが見つかりません')
    if (task.revision !== expectedRevision) throw new ConflictError()
    await db.tasks.put({ ...task, deletedAt: now(), revision: task.revision + 1, updatedAt: now() })
    await cancelCoachNotificationTarget(id)
    await db.audits.add({ id: uid(), taskId: id, operation: 'trash', at: now(), detail: '表示上の削除。実績は維持' })
    return id
  })
}
export async function restoreTask(id: string, expectedRevision: number, key: string = uid()) {
  return receipt(key, { operation: 'restore_task', id, expectedRevision }, async () => {
    const task = await db.tasks.get(id)
    if (!task) throw new Error('タスクが見つかりません')
    if (task.revision !== expectedRevision) throw new ConflictError()
    await db.tasks.put({ ...task, deletedAt: null, revision: task.revision + 1, updatedAt: now() })
    return id
  })
}

export async function createRoutine(input: Omit<Routine, 'id' | 'revision' | 'createdAt'>, key: string = uid()) {
  return receipt(key, { operation: 'routine_create', input }, async () => {
    if (!input.title.trim()) throw new Error('ルーティン名を入力してください')
    if (!Number.isInteger(input.interval) || input.interval < 1 || input.interval > 365) throw new Error('間隔は1〜365で入力してください')
    validateDate(input.startDate, '開始日'); validateDate(input.endDate, '終了日')
    if (input.endDate && input.endDate < input.startDate) throw new Error('終了日は開始日以降にしてください')
    if (!Number.isInteger(input.monthDay) || input.monthDay < 1 || input.monthDay > 31) throw new Error('月の日は1〜31で指定してください')
    if (input.weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('曜日が不正です')
    if (input.excludedDates && (input.excludedDates.length > 366 || new Set(input.excludedDates).size !== input.excludedDates.length)) throw new Error('除外日が不正です')
    for (const date of input.excludedDates ?? []) validateDate(date, '除外日')
    calculateScore(input.score)
    const id = uid()
    await db.routines.add({ ...input, title: input.title.trim(), id, revision: 1, createdAt: now() })
    return id
  })
}
function matchesRoutine(r: Routine, date: string) {
  if (date < r.startDate || (r.endDate && date > r.endDate) || r.excludedDates?.includes(date)) return false
  const start = new Date(`${r.startDate}T12:00:00`), current = new Date(`${date}T12:00:00`)
  const days = Math.round((current.getTime() - start.getTime()) / 86400000)
  if (r.cadence === 'daily') return days % r.interval === 0
  if (r.cadence === 'weekly') return Math.floor(days / 7) % r.interval === 0 && r.weekdays.includes(current.getDay())
  if (r.cadence === 'monthly') {
    const months = (current.getFullYear() - start.getFullYear()) * 12 + current.getMonth() - start.getMonth()
    const last = new Date(current.getFullYear(), current.getMonth() + 1, 0).getDate()
    return months >= 0 && months % r.interval === 0 && current.getDate() === Math.min(r.monthDay, last)
  }
  return false
}
export async function expandRoutines(from = addDays(today(), -30), days = 120) {
  const routines = await db.routines.filter(r => r.active).toArray()
  let count = 0
  for (const r of routines) {
    if (r.cadence === 'after_completion') {
      const occurrences = await db.tasks.where('routineId').equals(r.id).toArray()
      if (occurrences.length === 0) {
        const key = `${r.id}:${r.startDate}`
        if (!r.excludedDates?.includes(r.startDate)) await db.transaction('rw', [db.tasks, db.assessments, db.audits, db.containers, db.settings, db.labelGroups, db.labelDefinitions], async () => { if (!(await db.tasks.where('generationKey').equals(key).first())) { await addTask({ ...newTaskInput(), title: r.title, project: r.project, scheduledDate: r.startDate, score: r.score }, key, r.id); count++ } })
      } else {
        const latest = occurrences.sort((a, b) => (b.scheduledDate ?? '').localeCompare(a.scheduledDate ?? ''))[0]
        const completed = await db.completions.where('taskId').equals(latest.id).first()
        if (completed?.currentAt) {
          const date = addDays(today(new Date(completed.currentAt)), r.interval), key = `${r.id}:${date}`
          if (!r.excludedDates?.includes(date)) await db.transaction('rw', [db.tasks, db.assessments, db.audits, db.containers, db.settings, db.labelGroups, db.labelDefinitions], async () => { if (!(await db.tasks.where('generationKey').equals(key).first())) { await addTask({ ...newTaskInput(), title: r.title, project: r.project, scheduledDate: date, score: r.score }, key, r.id); count++ } })
        }
      }
      continue
    }
    for (let i = 0; i < days; i++) {
      const date = addDays(from, i)
      if (!matchesRoutine(r, date)) continue
      const key = `${r.id}:${date}`
      await db.transaction('rw', [db.tasks, db.assessments, db.audits, db.containers, db.settings, db.labelGroups, db.labelDefinitions], async () => {
        if (!(await db.tasks.where('generationKey').equals(key).first())) { await addTask({ ...newTaskInput(), title: r.title, project: r.project, scheduledDate: date, score: r.score }, key, r.id); count++ }
      })
    }
  }
  return count
}
export async function logSession(taskId: string, startedAt: string, endedAt: string, sessionId: string = uid()) {
  const start = Date.parse(startedAt), end = Date.parse(endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || new Date(start).toISOString() !== startedAt || new Date(end).toISOString() !== endedAt || end < start) throw new Error('作業時間の日時が不正です')
  if (!sessionId || sessionId.length > 500) throw new Error('作業区間のIDが不正です')
  const minutes = Math.round((end - start) / 60000)
  if (minutes > 10080) throw new Error('記録時間が長すぎます')
  await db.transaction('rw', [db.tasks, db.sessions], async () => {
    const prior = await db.sessions.get(sessionId)
    if (prior) {
      if (prior.taskId !== taskId || prior.startedAt !== startedAt) throw new Error('作業区間のIDが重複しています')
      return
    }
    if (!(await db.tasks.get(taskId))) throw new Error('作業対象のタスクがありません')
    await db.sessions.add({ id: sessionId, taskId, startedAt, endedAt, minutes, revision: 1, corrections: [] })
  })
}
