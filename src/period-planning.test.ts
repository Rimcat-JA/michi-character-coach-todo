import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput } from './commands'
import { emptyScore } from './domain'
import { assignTaskToBucket, createPlanningBucket, periodPointTotals, periodRange } from './period-planning'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('週・月・四半期の計画', () => {
  it('四半期から月へ配分しても同じタスクと20ptを一回だけ集計する', async () => {
    const quarter = await createPlanningBucket('quarter', '2026-10-15')
    const month = await createPlanningBucket('month', '2026-10-15', quarter)
    const id = await createTask({ ...newTaskInput(), title: '資格準備', score: { ...emptyScore(), mode: 'manual', manualPoints: 20 } })
    await assignTaskToBucket(id, 1, quarter)
    let totals = periodPointTotals(await db.planningBuckets.toArray(), await db.tasks.toArray())
    expect(totals.get(quarter)).toEqual({ tasks: 1, points: 20 })
    expect(totals.get(month)).toBeUndefined()
    await assignTaskToBucket(id, 2, month)
    totals = periodPointTotals(await db.planningBuckets.toArray(), await db.tasks.toArray())
    expect(totals.get(quarter)).toEqual({ tasks: 1, points: 20 })
    expect(totals.get(month)).toEqual({ tasks: 1, points: 20 })
    expect(await db.tasks.count()).toBe(1)
    expect((await db.tasks.get(id))?.scheduledDate).toBeNull()
  })
  it('週・月・四半期の範囲を正規化し、期間外の親を拒否する', async () => {
    expect(periodRange('week', '2026-10-01')).toEqual({ startDate: '2026-09-28', endDate: '2026-10-04' })
    const quarter = await createPlanningBucket('quarter', '2026-10-01')
    await expect(createPlanningBucket('month', '2027-01-01', quarter)).rejects.toThrow('親')
  })
})
