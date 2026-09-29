import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput } from './commands'
import { emptyScore } from './domain'
import { applyBreakdownProposal, suggestBreakdown } from './breakdown'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('困っているときの分割案', () => {
  it('未採用案は保存せず、40ptを採用して親子を順次完了しても40pt', async () => {
    const parentId = await createTask({ ...newTaskInput(), title: 'レポート', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
    const parent = (await db.tasks.get(parentId))!
    const proposal = suggestBreakdown(parent, 'large')
    expect(proposal.steps.map(step => step.points)).toEqual([13, 13, 14])
    expect(await db.tasks.count()).toBe(1)
    expect(await db.checklistItems.count()).toBe(0)
    const ids = await applyBreakdownProposal(proposal)
    expect(ids).toHaveLength(3)
    expect(await applyBreakdownProposal(proposal)).toEqual(ids)
    expect(await db.tasks.count()).toBe(4)
    expect((await db.tasks.get(parentId))?.effectivePoints).toBe(0)
    expect((await db.tasks.toArray()).reduce((total, task) => total + (task.effectivePoints ?? 0), 0)).toBe(40)
    expect((await db.checklistItems.toArray()).every(item => !!item.convertedTaskId)).toBe(true)
    await completeTask(parentId, 2)
    for (const id of ids) await completeTask(id, 1)
    expect((await db.ledger.toArray()).reduce((total, entry) => total + entry.delta, 0)).toBe(40)
  })

  it('予算不一致と古いrevisionでは一件も作らない', async () => {
    const parentId = await createTask({ ...newTaskInput(), title: '準備', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
    const proposal = suggestBreakdown((await db.tasks.get(parentId))!, 'unclear')
    proposal.steps[0].points = 14
    await expect(applyBreakdownProposal(proposal)).rejects.toThrow('配分合計')
    expect(await db.tasks.count()).toBe(1)
    proposal.steps[0].points = 13
    proposal.parentRevision = 0
    await expect(applyBreakdownProposal(proposal)).rejects.toThrow('別の画面')
    expect(await db.tasks.count()).toBe(1)
    expect((await db.tasks.get(parentId))?.effectivePoints).toBe(40)
  })
})
