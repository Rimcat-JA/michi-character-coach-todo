import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { updateAIConnection } from './ai-connection'
import { captureSnapshot, restoreBackup } from './backup'
import { calendarFixture } from './calendar-test-fixtures'
import { applyCalendarProposalFromUI, clearCalendarRulesAuthority } from './calendar-rules-save'
import { parseRoutineAssistAnswer, type RoutineAssistInput } from './routine-assist'
import { confirmRoutineInstructionFromUI } from './routine-instruction'
import { applyRoutineAssistConfigurationFromUI, clearRoutineAssistanceAuthority, prepareRoutineAssistConfiguration } from './routine-assist-save'

const model = 'provider/model'
function click() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
beforeEach(async () => {
  clearCalendarRulesAuthority(); clearRoutineAssistanceAuthority()
  await db.delete(); await db.open(); await ensureSettings(); await updateAIConnection(true, model)
  const settings = (await db.settings.get('main'))!, state = calendarFixture()
  state.ownerId = settings.profileId; state.datasetId = settings.datasetId
  state.bindings.forEach(binding => { binding.personId = settings.profileId })
  await db.calendarRules.put(state)
})
afterEach(() => { clearCalendarRulesAuthority(); clearRoutineAssistanceAuthority() })
async function prepared() {
  const state = (await db.calendarRules.get('main'))!
  const input: RoutineAssistInput = {
    message: '毎週月曜日に提出を設定して', referenceDate: '2026-10-01', targetRuleId: null, expectedRuleRevision: null,
    selection: { contextId: 'company', bindingId: 'self', calendarId: 'business', activityId: null, timezone: 'Asia/Tokyo', validFrom: '2026-10-01', validTo: '2026-10-31', time: '09:00', stepKind: 'task', durationMinutes: null, scheduledOffsetDays: 0, dueOffsetDays: null }, scope: { kind: 'all_uncompleted' },
  }
  const candidate = parseRoutineAssistAnswer(JSON.stringify({ title_quote: '提出', recurrence_quote: '毎週月曜日', trigger: { kind: 'weekly', weekdays: [1], time: '09:00' }, manual_points: null, reason: '本人が指定した毎週月曜' }), input, state)
  return prepareRoutineAssistConfiguration(await confirmRoutineInstructionFromUI(input, candidate, model, click()))
}
async function records() { return { calendar: await db.calendarRules.toArray(), tasks: await db.tasks.toArray(), ledger: await db.ledger.toArray(), audits: await db.audits.toArray(), commands: await db.commands.toArray() } }

it('同じ内容のバックアップ復元でも、周期の承認と内側の設定案を再使用できない', async () => {
  const proposal = await prepared(), snapshot = await captureSnapshot()
  await restoreBackup(snapshot)
  const before = await records()
  await expect(applyRoutineAssistConfigurationFromUI(proposal, proposal.digest, click())).rejects.toThrow()
  await expect(applyCalendarProposalFromUI(proposal.configuration, click())).rejects.toThrow()
  expect(await records()).toEqual(before)
})

it('AIを停止して同じモデルで再接続しても、停止前の周期案を再使用できない', async () => {
  const proposal = await prepared()
  await updateAIConnection(false); await updateAIConnection(true, model)
  const before = await records()
  await expect(applyRoutineAssistConfigurationFromUI(proposal, proposal.digest, click())).rejects.toThrow()
  await expect(applyCalendarProposalFromUI(proposal.configuration, click())).rejects.toThrow()
  expect(await records()).toEqual(before)
})
