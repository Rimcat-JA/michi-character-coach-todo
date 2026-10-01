import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { calendarFixture } from './calendar-test-fixtures'
import { parseRoutineAssistAnswer, type RoutineAssistInput } from './routine-assist'
import { assertRoutineInstruction, clearRoutineInstructionAuthority, confirmRoutineInstructionFromUI } from './routine-instruction'
import { changePolicyFor } from './change-set'

beforeEach(async () => { clearRoutineInstructionAuthority(); await db.delete(); await db.open(); await ensureSettings(); const settings = (await db.settings.get('main'))!; await db.settings.put({ ...settings, aiEnabled: true, aiModel: 'synthetic/model' }); const state = calendarFixture(); state.ownerId = settings.profileId; state.datasetId = settings.datasetId; state.bindings[0].personId = settings.profileId; await db.calendarRules.put(state) })
afterEach(() => { clearRoutineInstructionAuthority(); vi.useRealTimers() })
const humanClick = () => { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
function input(): RoutineAssistInput { return { message: '毎週月曜に勤怠提出を作って', referenceDate: '2026-10-01', targetRuleId: null, expectedRuleRevision: null, selection: { contextId: 'company', bindingId: 'self', calendarId: 'business', activityId: null, timezone: 'Asia/Tokyo', validFrom: '2026-01-01', validTo: '2026-12-31', time: '09:00', stepKind: 'task', durationMinutes: null, scheduledOffsetDays: 0, dueOffsetDays: null }, scope: { kind: 'all_uncompleted' } } }
async function candidate() { const selected = input(), state = (await db.calendarRules.get('main'))!; return parseRoutineAssistAnswer(JSON.stringify({ title_quote: '勤怠提出', recurrence_quote: '毎週月曜', trigger: { kind: 'weekly', weekdays: [1], time: '09:00' }, manual_points: null, reason: '本人の明示周期' }), selected, state) }

describe('周期の本人確認は揮発性の現在指示に限定する', () => {
  it('native操作を要求し、DOM偽clickと自称Eventを拒否する', async () => {
    const value = await candidate()
    await expect(confirmRoutineInstructionFromUI(value.input, value, 'synthetic/model', new Event('click'))).rejects.toThrow('本人')
    await expect(confirmRoutineInstructionFromUI(value.input, value, 'synthetic/model', { type: 'click', isTrusted: true } as Event)).rejects.toThrow('本人')
    const forged = Object.create(Event.prototype); Object.defineProperties(forged, { type: { value: 'click' }, isTrusted: { value: true } }); await expect(confirmRoutineInstructionFromUI(value.input, value, 'synthetic/model', forged)).rejects.toThrow('本人')
    const proof = await confirmRoutineInstructionFromUI(value.input, value, 'synthetic/model', humanClick())
    expect(proof).toMatchObject({ basis: 'owner_instruction', model: 'synthetic/model' }); expect(proof.messageDigest).toMatch(/^[a-f0-9]{64}$/); expect(Object.isFrozen(proof.candidate.definition)).toBe(true)
  })
  it('copiedJSON・失効・所有者やepoch・設定版変更を拒否する', async () => {
    const value = await candidate(), proof = await confirmRoutineInstructionFromUI(value.input, value, 'synthetic/model', humanClick()), settings = (await db.settings.get('main'))!, state = (await db.calendarRules.get('main'))!
    expect(() => assertRoutineInstruction(structuredClone(proof), settings, state)).toThrow('本人確認')
    expect(() => assertRoutineInstruction(proof, { ...settings, profileId: 'other' }, state)).toThrow('本人確認')
    expect(() => assertRoutineInstruction(proof, { ...settings, changePolicy: { ...changePolicyFor(settings), epoch: changePolicyFor(settings).epoch + 1 } }, state)).toThrow('本人確認')
    expect(() => assertRoutineInstruction(proof, settings, { ...state, revision: state.revision + 1 })).toThrow('設定版')
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(Date.now() + 86400001)); expect(() => assertRoutineInstruction(proof, settings, state)).toThrow('期限')
  })
  it('AI停止中もmodel nullの手動経路を確認でき、モデル付き旧指示は拒否する', async () => {
    const value = await candidate(), ai = await confirmRoutineInstructionFromUI(value.input, value, 'synthetic/model', humanClick()), before = (await db.settings.get('main'))!
    await db.settings.put({ ...before, aiEnabled: false }); const current = (await db.settings.get('main'))!, state = (await db.calendarRules.get('main'))!
    expect(() => assertRoutineInstruction(ai, current, state)).toThrow('AI設定')
    const manual = await confirmRoutineInstructionFromUI(value.input, value, null, humanClick()); expect(manual).toMatchObject({ basis: 'manual', model: null }); expect(() => assertRoutineInstruction(manual, current, state)).not.toThrow()
  })
  it('別入力を同じ確認候補として使わず、registry消去後に復元しない', async () => {
    const value = await candidate()
    await expect(confirmRoutineInstructionFromUI({ ...value.input, message: '毎週水曜へ' }, value, 'synthetic/model', humanClick())).rejects.toThrow('一致')
    const proof = await confirmRoutineInstructionFromUI(value.input, value, 'synthetic/model', humanClick()); clearRoutineInstructionAuthority()
    const settings = (await db.settings.get('main'))!, state = (await db.calendarRules.get('main'))!
    expect(() => assertRoutineInstruction(proof, settings, state)).toThrow('本人確認')
  })
  it('候補をnative確認へ直接渡しても、未指定の手動点数・周期・名称を本人指示に昇格しない', async () => {
    for (const mutate of [(value: Awaited<ReturnType<typeof candidate>>) => { value.definition.steps[0].score = { ...value.definition.steps[0].score!, mode: 'manual', manualPoints: 36 } }, (value: Awaited<ReturnType<typeof candidate>>) => { value.definition.trigger = { kind: 'weekly', weekdays: [3], time: '09:00' } }, (value: Awaited<ReturnType<typeof candidate>>) => { value.definition.title = '追加の営業'; value.definition.steps[0].title = '追加の営業' }]) {
      const value = await candidate(); mutate(value); await expect(confirmRoutineInstructionFromUI(value.input, value, 'synthetic/model', humanClick())).rejects.toThrow()
    }
  })
})
