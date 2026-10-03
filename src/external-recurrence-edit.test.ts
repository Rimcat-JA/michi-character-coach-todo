import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { db } from './db'
import { calendarFixture, monthlyRule } from './calendar-test-fixtures'
import { calendarRuleEditorDefinition } from './calendar-rule-editor'
import { applyCalendarProposalFromUI, prepareCalendarGeneration } from './calendar-rules-save'
import { completeTask } from './commands'
import { bridgeHarness, click, resetApp } from './command-test-harness'
import { routineBody } from './routine-external-change'
import { assertFileBridgeCommand } from './file-bridge-contract'
import { canonicalRRule } from './rrule'
import type { CalendarRule } from './calendar-resolver'
const { parseEnvelope } = createRequire(import.meta.url)('../electron/local-file-bridge.cjs')

async function fixture(kind: 'rrule' | 'completion_relative') {
  const settings = await resetApp(), state = calendarFixture(), id = crypto.randomUUID()
  state.ownerId = settings.profileId; state.datasetId = settings.datasetId; state.bindings[0].personId = settings.profileId
  state.activities = []; state.bindings[0].activityIds = []
  const trigger: CalendarRule['trigger'] = kind === 'rrule'
    ? { kind, dtstart: '2026-10-01T09:00', rrule: canonicalRRule('FREQ=MONTHLY;BYDAY=3WE;COUNT=3'), rdates: ['2026-10-22T09:00'], exdates: ['2026-11-18T09:00'], nonexistentTime: 'next_valid', ambiguousTime: 'later' }
    : { kind, firstDate: '2026-10-01', time: '09:00', afterDays: 14, unfinishedPolicy: 'generate_after_completion' }
  state.rules = [monthlyRule({ id, validFrom: '2026-10-01', trigger })]
  await db.calendarRules.put(state)
  await applyCalendarProposalFromUI(await prepareCalendarGeneration('2026-10-01', '2026-12-31'), click())
  const first = (await db.tasks.toArray()).sort((a, b) => a.scheduledDate!.localeCompare(b.scheduledDate!))[0]
  expect(first).toBeDefined(); await completeTask(first.id, first.revision)
  return { id, trigger, firstId: first.id }
}

for (const kind of ['rrule', 'completion_relative'] as const) for (const entrance of ['file', 'mcp'] as const) it(`${entrance} edits ${kind} through native confirmation and the common engine, preserving completed work`, async () => {
  const f = await fixture(kind), h = await bridgeHarness({ taskIds: [], fields: [], ruleIds: [f.id] })
  try {
    const beforeRule = (await db.calendarRules.get('main'))!.rules[0]
    const beforeTasks = await db.tasks.toArray(), completed = await db.tasks.get(f.firstId), ledger = await db.ledger.toArray(), completions = await db.completions.toArray()
    const trigger = kind === 'rrule' ? { kind, rrule: 'FREQ=WEEKLY;BYDAY=MO' } : { kind, after_days: 7 }
    const scope = entrance === 'mcp' ? { kind: 'this_and_future', from_date: '2026-10-03' } : { kind: 'all_uncompleted' }
    const view = await h.mcpCall('michi_snapshot', {})
    expect(view.structuredContent?.routines).toEqual([expect.objectContaining({ id: f.id, trigger: expect.objectContaining({ kind }) })])
    if (entrance === 'file') await h.writeCommand({ type: 'routine.change', target_id: f.id, expected_revision: beforeRule.revision, payload: { scope, definition: { trigger } } })
    else expect((await h.mcpCall('michi_propose_routine_change', { commandId: crypto.randomUUID(), snapshotId: h.snapshotId(), ruleId: f.id, expectedRuleRevision: beforeRule.revision, scope, trigger })).isError).not.toBe(true)
    const entry = (await h.controller.scanInbox()).entries.find(entry => entry.state === 'awaiting_approval')!
    if (entry.state !== 'awaiting_approval') throw Error('Missing recurrence proposal')
    const prepared = await h.controller.prepare(entry.reference)
    expect(routineBody(prepared.command).stage).toBe('owner_values')
    await expect(h.controller.applyAutomatically(prepared)).rejects.toThrow()
    await expect(h.controller.confirmRoutineFromUI(prepared, new Event('click'))).rejects.toThrow()
    const review = await h.controller.confirmRoutineFromUI(prepared, click()), body = routineBody(review.command)
    if (body.stage !== 'review') throw Error('Missing owner-reviewed configuration')
    expect(body.assistance.configuration.preview.length).toBeGreaterThan(0)
    await h.controller.applyFromUI(review, click())
    const changed = calendarRuleEditorDefinition((await db.calendarRules.get('main'))!.rules[0])
    expect(changed.title).toBe(beforeRule.title); expect(changed.steps).toEqual(beforeRule.steps)
    if (kind === 'rrule') expect(changed.trigger).toEqual({ ...f.trigger, rrule: canonicalRRule('FREQ=WEEKLY;BYDAY=MO;COUNT=3') })
    else expect(changed.trigger).toEqual({ ...f.trigger, afterDays: 7 })
    expect(await db.tasks.toArray()).toEqual(beforeTasks)
    await applyCalendarProposalFromUI(await prepareCalendarGeneration('2026-10-01', '2026-12-31'), click())
    expect(await db.tasks.get(f.firstId)).toEqual(completed)
    expect(await db.ledger.toArray()).toEqual(ledger); expect(await db.completions.toArray()).toEqual(completions)
    expect((await db.tasks.toArray()).filter(task => task.status === 'open' && !task.deletedAt).length).toBeGreaterThan(0)
  } finally { await h.close() }
})

for (const trigger of [{ kind: 'rrule', rrule: '' }, { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-10-03T12:00' }, { kind: 'completion_relative', after_days: 0 }, { kind: 'completion_relative', after_days: 3651 }, { kind: 'completion_relative', after_days: 7, unfinishedPolicy: 'keep_latest' }]) it(`renderer/main refuse unauthorized recurrence fields ${JSON.stringify(trigger)}`, () => {
  const command = { schema_version: '1', command_id: crypto.randomUUID(), snapshot_id: crypto.randomUUID(), expires_at: new Date(Date.now() + 60000).toISOString(), type: 'routine.change', target_id: crypto.randomUUID(), expected_revision: 1, payload: { scope: { kind: 'all_uncompleted' }, definition: { trigger } } }
  expect(() => assertFileBridgeCommand(command)).toThrow()
  expect(() => parseEnvelope(JSON.stringify(command))).toThrowError(expect.objectContaining({ code: 'INVALID_PAYLOAD' }))
})

it('malformed RRULE semantics fail in the app engine before any native approval or save', async () => {
  const f = await fixture('rrule'), h = await bridgeHarness({ taskIds: [], fields: [], ruleIds: [f.id] })
  try {
    const before = await db.calendarRules.get('main'), tasks = await db.tasks.toArray()
    await h.writeCommand({ type: 'routine.change', target_id: f.id, expected_revision: 1, payload: { scope: { kind: 'all_uncompleted' }, definition: { trigger: { kind: 'rrule', rrule: 'FREQ=DAILY;BYMADEUP=1' } } } })
    const entry = (await h.controller.scanInbox()).entries.find(entry => entry.state === 'awaiting_approval')!
    if (entry.state !== 'awaiting_approval') throw Error('Missing proposal')
    await expect(h.controller.prepare(entry.reference)).rejects.toMatchObject({ code: 'ROUTINE_INVALID' })
    expect(await db.calendarRules.get('main')).toEqual(before); expect(await db.tasks.toArray()).toEqual(tasks)
  } finally { await h.close() }
})
