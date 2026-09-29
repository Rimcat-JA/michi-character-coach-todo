import { db, ensureSettings } from './db'
import { uid, validateDate, type PlanningBucket, type Task } from './domain'

const iso = (date: Date) => date.toISOString().slice(0, 10)
export function periodRange(kind: PlanningBucket['kind'], date: string) {
  validateDate(date, '計画日')
  const d = new Date(`${date}T12:00:00Z`)
  let start: Date, end: Date
  if (kind === 'week') {
    start = new Date(d); start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7))
    end = new Date(start); end.setUTCDate(end.getUTCDate() + 6)
  } else if (kind === 'month') {
    start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 12))
    end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12))
  } else if (kind === 'quarter') {
    const month = Math.floor(d.getUTCMonth() / 3) * 3
    start = new Date(Date.UTC(d.getUTCFullYear(), month, 1, 12))
    end = new Date(Date.UTC(d.getUTCFullYear(), month + 3, 0, 12))
  } else throw new Error('計画枠の種類が不正です')
  return { startDate: iso(start), endDate: iso(end) }
}

export function validatePlanningBuckets(buckets: PlanningBucket[]) {
  const byId = new Map(buckets.map(bucket => [bucket.id, bucket]))
  for (const bucket of buckets) {
    const expected = periodRange(bucket.kind, bucket.startDate)
    if (bucket.startDate !== expected.startDate || bucket.endDate !== expected.endDate || !Number.isInteger(bucket.revision) || bucket.revision < 1) throw new Error('計画枠の期間が不正です')
    const seen = new Set<string>(), rootOwner = bucket.ownerId
    let current: PlanningBucket | undefined = bucket
    while (current) {
      if (seen.has(current.id) || !current.ownerId || current.ownerId !== rootOwner) throw new Error('計画枠の階層が不正です')
      seen.add(current.id)
      if (!current.parentId) break
      const parent: PlanningBucket | undefined = byId.get(current.parentId)
      if (!parent || current.startDate < parent.startDate || current.endDate > parent.endDate || (current.kind === 'quarter') || (current.kind === 'month' && parent.kind !== 'quarter') || (current.kind === 'week' && parent.kind === 'week')) throw new Error('計画枠の親が不正です')
      current = parent
    }
  }
}

export async function createPlanningBucket(kind: PlanningBucket['kind'], date: string, parentId: string | null = null) {
  const settings = await ensureSettings(), range = periodRange(kind, date)
  return db.transaction('rw', db.planningBuckets, async () => {
    const all = await db.planningBuckets.toArray(), parent = parentId ? all.find(bucket => bucket.id === parentId) : null
    if (parentId && (!parent || parent.ownerId !== settings.profileId)) throw new Error('計画枠にアクセスできません')
    if (all.some(bucket => bucket.ownerId === settings.profileId && bucket.kind === kind && bucket.startDate === range.startDate && bucket.parentId === parentId)) throw new Error('同じ計画枠があります')
    const bucket: PlanningBucket = { id: uid(), ownerId: settings.profileId, kind, ...range, parentId, revision: 1, createdAt: new Date().toISOString() }
    validatePlanningBuckets([...all, bucket])
    await db.planningBuckets.add(bucket)
    return bucket.id
  })
}

export async function assignTaskToBucket(taskId: string, expectedRevision: number, bucketId: string | null) {
  const settings = await ensureSettings()
  await db.transaction('rw', db.tasks, db.planningBuckets, db.audits, async () => {
    const task = await db.tasks.get(taskId), bucket = bucketId ? await db.planningBuckets.get(bucketId) : null
    if (!task || task.deletedAt) throw new Error('タスクが見つかりません')
    if (task.revision !== expectedRevision) throw new Error('別の画面で更新されました')
    if (bucketId && (!bucket || bucket.ownerId !== settings.profileId)) throw new Error('計画枠にアクセスできません')
    const at = new Date().toISOString()
    await db.tasks.put({ ...task, planBucketId: bucketId, revision: task.revision + 1, updatedAt: at })
    await db.audits.add({ id: uid(), taskId, operation: 'assign_period', at, detail: bucketId ?? '解除' })
  })
}

export function periodPointTotals(buckets: PlanningBucket[], tasks: Task[]) {
  const byId = new Map(buckets.map(bucket => [bucket.id, bucket])), totals = new Map<string, { tasks: number; points: number }>()
  for (const task of tasks) {
    if (task.deletedAt || !task.planBucketId) continue
    let id: string | null = task.planBucketId
    const seen = new Set<string>()
    while (id && !seen.has(id)) {
      seen.add(id)
      const bucket: PlanningBucket | undefined = byId.get(id)
      if (!bucket) break
      const total = totals.get(id) ?? { tasks: 0, points: 0 }
      total.tasks++; total.points += task.effectivePoints ?? 0
      totals.set(id, total)
      id = bucket.parentId
    }
  }
  return totals
}
