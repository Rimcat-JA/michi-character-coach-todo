import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { addTask, completeTask, createRoutine, expandRoutines, newTaskInput } from './commands'
import { addDays, emptyScore, today, type Routine } from './domain'
import { acknowledgeCatchupSummary, catchUpRoutines, catchupNotice, CATCHUP_RUN_CAP, CATCHUP_SERIES_CAP } from './routine-catchup'
import { previewResume, reduceAuthority, resumeAuthorityFromUI } from './automation-control'
import type { ChangeContext } from './change-set'
import { dispatchDueReminders } from './reminders'
import { captureSnapshot } from './backup'
import { validateSnapshot } from './backup-validation'

// Synthetic clock jumps with vi.setSystemTime on fake-indexeddb; no device was left switched off.
const T0 = new Date(2026, 9, 1, 9, 0)
const later = (days: number) => new Date(T0.getTime() + days * 86400000)
const routineInput = (title: string, startDate: string, patch: Partial<Routine> = {}) => ({ title, cadence: 'daily' as const, interval: 1, weekdays: [], monthDay: 1, startDate, endDate: null, afterTaskId: null, score: { ...emptyScore(), mode: 'manual' as const, manualPoints: 5 }, project: '', excludedDates: [], active: true, ...patch })
function humanClick() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
async function owner(): Promise<ChangeContext> { const settings = (await db.settings.get('main'))!; return { ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: [], sourceRevisions: [], principal: { id: settings.profileId, kind: 'human' } } }
const stored = async () => (await db.settings.get('main'))!.routineCatchup!
async function keys(routineId: string) { return (await db.tasks.where('routineId').equals(routineId).toArray()).map(task => task.generationKey).sort() }
beforeEach(async () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0); await db.delete(); await db.open(); await ensureSettings() })
afterEach(() => { vi.useRealTimers() })

describe('AT-N10-09 長期未起動後の繰り返し', () => {
  it('繰り返し起動しても同じ回を重複作成しない', async () => {
    const id = await createRoutine(routineInput('毎日の点検', addDays(today(T0), -10)))
    const first = await catchUpRoutines(T0)
    expect(first.created).toBe(100)
    const second = await catchUpRoutines(T0), third = await catchUpRoutines(T0)
    expect([second.created, third.created]).toEqual([0, 0])
    const all = await keys(id)
    expect(all).toHaveLength(100)
    expect(new Set(all).size).toBe(100)
    expect((await db.settings.get('main'))!.routineCatchup!.checkpoints[id]).toBe(addDays(today(T0), 89))
  })
  it('200日ぶりの起動はcheckpointから必要回を作り、件数を正しく要約する', async () => {
    const id = await createRoutine(routineInput('毎日の点検', addDays(today(T0), -10)))
    await catchUpRoutines(T0)
    vi.setSystemTime(later(200))
    const summary = await catchUpRoutines(later(200))
    expect(summary).toMatchObject({ days: 200, created: 200, unexpanded: 0, truncatedRoutineIds: [] })
    const all = await keys(id)
    expect(all).toHaveLength(300)
    expect(new Set(all).size).toBe(300)
    expect(all[0]).toBe(`${id}:${addDays(today(T0), -10)}`)
    expect(all.at(-1)).toBe(`${id}:${addDays(today(later(200)), 89)}`)
    expect(catchupNotice((await db.settings.get('main'))!.routineCatchup!.summary)).toBe('前回起動から 200 日：作成 200 回／未展開 0 回')
    // A quiet foreground run keeps the launch report until the owner acknowledges it.
    await catchUpRoutines(later(200))
    expect(catchupNotice((await db.settings.get('main'))!.routineCatchup!.summary)).toContain('作成 200 回')
    await acknowledgeCatchupSummary()
    expect(catchupNotice((await db.settings.get('main'))!.routineCatchup!.summary)).toBeNull()
    const snapshot = await captureSnapshot()
    expect(() => validateSnapshot(snapshot)).not.toThrow()
  })
  it('1系列1,000回を超える古い回は作らず「未展開」として明示する', async () => {
    const id = await createRoutine(routineInput('毎日の記録', today(T0)))
    await catchUpRoutines(T0)
    const before = (await keys(id)).length
    vi.setSystemTime(later(1500))
    const summary = await catchUpRoutines(later(1500))
    const gap = 1500 - 30 - 90, window = 120
    expect(summary.created).toBe(CATCHUP_SERIES_CAP)
    expect(summary.unexpanded).toBe(gap + window - CATCHUP_SERIES_CAP)
    expect(summary.truncatedRoutineIds).toEqual([id])
    const all = await keys(id)
    expect(all).toHaveLength(before + CATCHUP_SERIES_CAP)
    // The newest occurrences are kept; the oldest gap dates are the unexpanded ones.
    expect(all).toContain(`${id}:${addDays(today(later(1500)), -31)}`)
    expect(all).not.toContain(`${id}:${addDays(today(T0), 90)}`)
    const again = await catchUpRoutines(later(1500))
    expect(again).toMatchObject({ created: 0, unexpanded: 0 })
  }, 30000)
  it('既存のgeneration keyと完了済みの回・ポイントを変えない', async () => {
    const id = await createRoutine(routineInput('週の点検', addDays(today(T0), -40)))
    await catchUpRoutines(T0)
    const routine = (await db.routines.get(id))!, gapDate = addDays(today(T0), 120)
    // A hand-made occurrence for a future gap date already uses the routine's key.
    const manual = await addTask({ ...newTaskInput(), title: '先に作った回', scheduledDate: gapDate, score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } }, `${routine.id}:${gapDate}`, routine.id)
    await completeTask(manual, 1)
    const completedTask = await db.tasks.get(manual), ledger = await db.ledger.toArray()
    vi.setSystemTime(later(200))
    await catchUpRoutines(later(200))
    expect(await db.tasks.where('generationKey').equals(`${routine.id}:${gapDate}`).count()).toBe(1)
    expect(await db.tasks.get(manual)).toEqual(completedTask)
    expect(await db.ledger.toArray()).toEqual(ledger)
    expect(await db.completions.count()).toBe(1)
  })
  it('checkpointのない既存系列は従来の窓だけを展開し、過去を大量に具現化しない', async () => {
    const id = await createRoutine(routineInput('古い系列', addDays(today(T0), -300)))
    await expandRoutines(addDays(today(T0), -30), 120)
    const legacy = await keys(id)
    const summary = await catchUpRoutines(T0)
    expect(summary.created).toBe(0)
    expect(await keys(id)).toEqual(legacy)
    expect(legacy[0]).toBe(`${id}:${addDays(today(T0), -30)}`)
  })
  it('週次の通常活動は曜日指定のまま、weekdays=[]の系列は回を作らない', async () => {
    const weekly = await createRoutine(routineInput('週次レビュー', today(T0), { cadence: 'weekly', weekdays: [T0.getDay()] }))
    const roster = await createRoutine(routineInput('勤務表の活動', today(T0), { cadence: 'weekly', weekdays: [] }))
    const before = await db.routines.get(weekly)
    await catchUpRoutines(T0)
    vi.setSystemTime(later(400))
    await catchUpRoutines(later(400))
    expect(await db.routines.get(weekly)).toEqual(before)
    expect(await keys(roster)).toEqual([])
    const dates = (await db.tasks.where('routineId').equals(weekly).toArray()).map(task => new Date(`${task.scheduledDate}T12:00:00`).getDay())
    expect(new Set(dates)).toEqual(new Set([T0.getDay()]))
  })
  it('過去の回は行だけを作り、通知予約や通知を発生させない', async () => {
    await createRoutine(routineInput('毎日の点検', today(T0)))
    await db.settings.update('main', { notifications: true })
    await catchUpRoutines(T0)
    vi.setSystemTime(later(200))
    await catchUpRoutines(later(200))
    expect(await dispatchDueReminders(later(200))).toEqual([])
    const settings = (await db.settings.get('main'))!
    expect(settings.notificationState?.intents ?? []).toEqual([])
    expect(settings.reminderState?.events ?? []).toEqual([])
  })
  it('N09のルーティン停止中は長期未起動でも回を作らず、展開位置と報告を動かさない。再開後に停止中の分を一度だけ作る', async () => {
    const id = await createRoutine(routineInput('毎日の点検', addDays(today(T0), -10)))
    await catchUpRoutines(T0)
    await reduceAuthority('routines', 'button')
    const before = await stored()
    vi.setSystemTime(later(200))
    expect(await catchUpRoutines(later(200))).toMatchObject({ created: 0, unexpanded: 0, truncatedRoutineIds: [] })
    expect(await keys(id)).toHaveLength(100)
    expect(await stored()).toEqual(before)
    expect((await stored()).checkpoints[id]).toBe(addDays(today(T0), 89))
    expect(catchupNotice((await stored()).summary)).toBeNull()
    await resumeAuthorityFromUI(await owner(), humanClick(), 'routines', (await previewResume('routines')).token)
    expect(await catchUpRoutines(later(200))).toMatchObject({ days: 200, created: 200, unexpanded: 0 })
    const all = await keys(id)
    expect(all).toHaveLength(300)
    expect(new Set(all).size).toBe(300)
  })
  it('前回の展開後に保存した系列は、保存時の窓から続きを作り、長期未起動でも間を飛ばさない', async () => {
    await createRoutine(routineInput('先にある系列', today(T0)))
    await catchUpRoutines(T0)
    vi.setSystemTime(new Date(T0.getTime() + 60000))
    const id = await createRoutine(routineInput('同じ日に保存した系列', today(T0)))
    await expandRoutines()
    vi.setSystemTime(later(200))
    const summary = await catchUpRoutines(later(200))
    expect(summary.unexpanded).toBe(0)
    const all = await keys(id), expected = Array.from({ length: 290 }, (_, index) => `${id}:${addDays(today(T0), index)}`)
    expect(all).toEqual(expected)
    expect((await catchUpRoutines(later(200))).created).toBe(0)
  })
  it('未確認の「未展開」報告は、後の実行で作成があっても消えずに積み上がる', async () => {
    const id = await createRoutine(routineInput('毎日の記録', today(T0)))
    await catchUpRoutines(T0)
    vi.setSystemTime(later(1500)); await catchUpRoutines(later(1500))
    vi.setSystemTime(later(1501)); expect((await catchUpRoutines(later(1501))).created).toBe(1)
    const summary = (await stored()).summary!
    expect(summary).toMatchObject({ created: 1001, unexpanded: 500, days: 1501 })
    expect(summary.truncatedRoutineIds).toContain(id)
    expect(catchupNotice(summary)).toContain('未展開 500 回')
    await acknowledgeCatchupSummary()
    vi.setSystemTime(later(1502)); await catchUpRoutines(later(1502))
    expect(catchupNotice((await stored()).summary)).toBe('前回起動から 1 日：作成 1 回／未展開 0 回')
  }, 60000)
  it('時計が先へ進んだ後に戻っても、未来の記録で報告を隠さず、戻った後の日付を飛ばさない', async () => {
    const id = await createRoutine(routineInput('毎日の点検', today(T0)))
    await catchUpRoutines(T0)
    vi.setSystemTime(later(3000)); await catchUpRoutines(later(3000))
    const future = (await keys(id)).length
    vi.setSystemTime(later(1)); await catchUpRoutines(later(1))
    expect((await stored()).lastRunAt).toBe(later(1).toISOString())
    const audit = (await db.audits.toArray()).find(row => row.operation === 'routine.catchup.clock')!
    expect(JSON.parse(audit.detail)).toMatchObject({ previousRunAt: later(3000).toISOString(), futureOccurrences: 1000, series: 1 })
    expect(JSON.parse(audit.detail).message).toContain('端末の時計が前回記録')
    vi.setSystemTime(later(200))
    const summary = await catchUpRoutines(later(200))
    expect((await stored()).lastRunAt).toBe(later(200).toISOString())
    expect(summary.days).toBe(199)
    const all = await keys(id)
    expect(new Set(all).size).toBe(all.length)
    for (let day = 91; day <= 169; day++) expect(all).toContain(`${id}:${addDays(today(T0), day)}`)
    // Rows made while the clock was ahead are kept for the owner to review.
    expect(all.length).toBe(future + 1 + 79 + 120)
    expect(catchupNotice((await stored()).summary)).not.toBeNull()
  }, 60000)
  it('1回の実行は全系列で5,000回まで。超えた古い回は「未展開」として明示し、再実行で重複しない', async () => {
    const ids: string[] = []
    for (let index = 0; index < 8; index++) ids.push(await createRoutine(routineInput(`毎日の系列${index}`, today(T0))))
    await catchUpRoutines(T0)
    vi.setSystemTime(later(1500))
    const summary = await catchUpRoutines(later(1500))
    expect(summary.created).toBe(CATCHUP_RUN_CAP)
    expect(summary.created + summary.unexpanded).toBe(8 * 1500)
    expect(new Set(summary.truncatedRoutineIds)).toEqual(new Set(ids))
    expect(await catchUpRoutines(later(1500))).toMatchObject({ created: 0, unexpanded: 0 })
    for (const id of ids) { const all = await keys(id); expect(new Set(all).size).toBe(all.length); expect(all).toContain(`${id}:${addDays(today(later(1500)), 89)}`) }
  }, 300000)
  it('窓だけで5,000回を超えるときは遠い先の回を次の実行へ回し、窓から外れても黙って飛ばさず未展開として数える', async () => {
    const ids: string[] = []
    for (let index = 0; index < 43; index++) ids.push(await createRoutine(routineInput(`窓の系列${index}`, addDays(today(T0), -30))))
    const first = await catchUpRoutines(T0)
    expect(first).toMatchObject({ created: CATCHUP_RUN_CAP, unexpanded: 0 })
    const deferred = async () => (await db.audits.toArray()).filter(row => row.operation === 'routine.catchup.deferred').map(row => JSON.parse(row.detail).deferred as number)
    expect(await deferred()).toEqual([43 * 120 - CATCHUP_RUN_CAP])
    vi.setSystemTime(later(150))
    const second = await catchUpRoutines(later(150))
    expect(second.created).toBe(CATCHUP_RUN_CAP)
    // Dates deferred by the first run fell out of the window: they are reported once as unexpanded, never skipped silently.
    expect(second.unexpanded).toBe(43 * 30 + 160)
    expect(first.created + second.created + second.unexpanded + (await deferred()).at(-1)!).toBe(43 * 270)
    expect(await db.tasks.count()).toBe(2 * CATCHUP_RUN_CAP)
    for (const id of ids) { const all = await keys(id); expect(new Set(all).size).toBe(all.length) }
  }, 300000)
})
