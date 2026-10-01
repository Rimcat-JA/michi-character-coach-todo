import { describe, expect, it } from 'vitest'
import { calendarFixture, monthlyRule } from './calendar-test-fixtures'
import { createRoutineAssistRequest, parseRoutineAssistAnswer, validateRoutineAssistCandidate, type RoutineAssistInput } from './routine-assist'
import type { CalendarRule } from './calendar-resolver'

function input(message = '毎月第2営業日に勤怠提出を作って。10pt'): RoutineAssistInput {
  return { message, referenceDate: '2026-10-01', targetRuleId: null, expectedRuleRevision: null, selection: { contextId: 'company', bindingId: 'self', calendarId: 'business', activityId: null, timezone: 'Asia/Tokyo', validFrom: '2026-01-01', validTo: '2026-12-31', time: '09:00', stepKind: 'task', durationMinutes: null, scheduledOffsetDays: 0, dueOffsetDays: null }, scope: { kind: 'all_uncompleted' } }
}
function answer(trigger: CalendarRule['trigger'] = { kind: 'monthly_business', ordinal: 2, from: 'start', time: '09:00' }, overrides = {}) { return JSON.stringify({ title_quote: '勤怠提出', recurrence_quote: '毎月第2営業日', trigger, manual_points: 10, reason: '本人が指定した周期だけを構造化', ...overrides }) }

describe('根拠付きの限定した周期入力補助', () => {
  it('選択暦だけをrequestへ渡し、未指定の追加作業・採点属性を作らない', () => {
    const state = calendarFixture(); state.calendars.push({ ...state.calendars[0], id: 'another', name: '他の暦' })
    const selected = input(), request = createRoutineAssistRequest(selected, state, 'deepseek/deepseek-v4.1-flash')
    expect(request.selection.calendarId).toBe('business'); expect(request.selection.calendarName).toBe('会社営業日'); expect(JSON.stringify(request)).not.toContain('他の暦')
    const candidate = parseRoutineAssistAnswer(answer(), selected, state)
    expect(candidate.definition.steps).toHaveLength(1); expect(candidate.definition.steps[0].score).toMatchObject({ mode: 'manual', manualPoints: 10, minutes: null, travelMinutes: null })
    expect(candidate.definition.steps[0].dueOffsetDays).toBeNull()
  })
  it.each(['', 'not-registered'])('暦未選択・不明なら firstcalendar に置き換えない: %s', value => {
    const selected = input(); selected.selection.calendarId = value
    expect(() => createRoutineAssistRequest(selected, calendarFixture(), 'synthetic/model')).toThrow()
  })
  it('未確認の所属・他人の参加条件・違うtimezone・期間外を拒否', () => {
    for (const mutate of [(state: ReturnType<typeof calendarFixture>) => { state.bindings[0].confirmed = false }, (state: ReturnType<typeof calendarFixture>) => { state.bindings[0].personId = 'other' }]) {
      const state = calendarFixture(); mutate(state); expect(() => parseRoutineAssistAnswer(answer(), input(), state)).toThrow('本人')
    }
    const selected = input(); selected.selection.timezone = 'UTC'; expect(() => parseRoutineAssistAnswer(answer(), selected, calendarFixture())).toThrow('タイムゾーン')
    selected.selection.timezone = 'Asia/Tokyo'; selected.selection.validTo = '2027-01-01'; expect(() => parseRoutineAssistAnswer(answer(), selected, calendarFixture())).toThrow('範囲外')
  })
  it.each(['毎週月・水曜', '毎週月曜と水曜', '毎週月・水・金曜'])('複数曜日を引用と一致させる: %s', periodic => {
    const selected = input(`${periodic}に勤怠提出を作って`), weekdays = periodic.includes('金') ? [1, 3, 5] : [1, 3]
    const candidate = parseRoutineAssistAnswer(answer({ kind: 'weekly', weekdays, time: '09:00' }, { recurrence_quote: periodic, manual_points: null }), selected, calendarFixture())
    expect(candidate.definition.trigger).toMatchObject({ weekdays }); expect(candidate.definition.steps[0].score?.mode).toBe('unset')
    expect(() => parseRoutineAssistAnswer(answer({ kind: 'weekly', weekdays: [1, 2], time: '09:00' }, { recurrence_quote: periodic, manual_points: null }), selected, calendarFixture())).toThrow('曜日')
  })
  it('毎月最後から第2営業日と最終営業日を区別し、モデルの順位変更を拒否', () => {
    for (const [raw, ordinal] of [['毎月最後から第2営業日', 2], ['毎月最終営業日', 1]] as const) {
      const selected = input(`${raw}に勤怠提出を作って`)
      expect(parseRoutineAssistAnswer(answer({ kind: 'monthly_business', ordinal, from: 'end', time: '09:00' }, { recurrence_quote: raw, manual_points: null }), selected, calendarFixture()).definition.trigger).toMatchObject({ ordinal, from: 'end' })
      expect(() => parseRoutineAssistAnswer(answer({ kind: 'monthly_business', ordinal: ordinal + 1, from: 'end', time: '09:00' }, { recurrence_quote: raw, manual_points: null }), selected, calendarFixture())).toThrow('順位')
    }
  })
  it('選択と異なる時刻を拒否', () => {
    expect(() => parseRoutineAssistAnswer(answer({ kind: 'monthly_business', ordinal: 2, from: 'start', time: '10:00' }), input(), calendarFixture())).toThrow('時刻')
  })
  it.each(['毎週月曜日か水曜日に勤怠提出を作って', '毎週月曜と毎月第2営業日に勤怠提出を作って', '毎週月曜10:00に勤怠提出を作って', '毎週月曜と毎日に勤怠提出を作って', '毎週月曜と隔週水曜に勤怠提出を作って'])('引用を短くして曖昧な分岐・別周期・原文時刻を捨てない: %s', message => {
    expect(() => parseRoutineAssistAnswer(answer({ kind: 'weekly', weekdays: [1], time: '09:00' }, { recurrence_quote: '毎週月曜', manual_points: null }), input(message), calendarFixture())).toThrow()
  })
  it.each(['毎週月曜日以外に勤怠提出を作って', '毎週月曜日を除く日に勤怠提出を作って', '毎月第2営業日を除く日に勤怠提出を作って'])('引用を短くして周期の除外条件を捨てない: %s', message => {
    const weekly = message.includes('毎週')
    expect(() => parseRoutineAssistAnswer(answer(weekly ? { kind: 'weekly', weekdays: [1], time: '09:00' } : undefined, { recurrence_quote: weekly ? '毎週月曜日' : '毎月第2営業日', manual_points: null }), input(message), calendarFixture())).toThrow('除外条件')
  })
  it('原文の開始日を省略せず、有効期間と照合する', () => {
    const selected = input('2026-10-05から毎週月曜に勤怠提出を作って')
    const response = answer({ kind: 'weekly', weekdays: [1], time: '09:00' }, { recurrence_quote: '毎週月曜', manual_points: null })
    expect(() => parseRoutineAssistAnswer(response, selected, calendarFixture())).toThrow('有効期間')
    selected.selection.validFrom = '2026-10-05'; expect(parseRoutineAssistAnswer(response, selected, calendarFixture()).input.selection.validFrom).toBe('2026-10-05')
    selected.message = '来月から毎週月曜に勤怠提出を作って'; expect(() => parseRoutineAssistAnswer(response, selected, calendarFixture())).toThrow('曖昧')
  })
  it.each([['午後9時', '21:00'], ['午前12時', '00:00'], ['午後12時', '12:00'], ['9時5分', '09:05']] as const)('原文の%sを%sとして照合する', (clock, time) => {
    const selected = input(`毎週月曜${clock}に勤怠提出を作って`); selected.selection.time = time
    const response = answer({ kind: 'weekly', weekdays: [1], time }, { recurrence_quote: '毎週月曜', manual_points: null })
    expect(parseRoutineAssistAnswer(response, selected, calendarFixture()).definition.trigger).toMatchObject({ time })
    selected.selection.time = '10:00'; expect(() => parseRoutineAssistAnswer(response, selected, calendarFixture())).toThrow('時刻')
  })
  it.each(['9時半', '9:0', '9時5', '夜9時', '09:00頃'])('未対応/曖昧な原文時計%sを短い引用で捨てない', clock => {
    expect(() => parseRoutineAssistAnswer(answer({ kind: 'weekly', weekdays: [1], time: '09:00' }, { recurrence_quote: '毎週月曜', manual_points: null }), input(`毎週月曜${clock}に勤怠提出を作って`), calendarFixture())).toThrow('時刻')
  })
  it('履歴の100ptを将来の周期のmanual指定にしない', () => {
    expect(() => parseRoutineAssistAnswer(answer({ kind: 'weekly', weekdays: [1], time: '09:00' }, { recurrence_quote: '毎週月曜', manual_points: 100 }), input('過去は100ptだった。今後は毎週月曜に勤怠提出を設定して'), calendarFixture())).toThrow('履歴')
  })
  it('明示された活動の開始30分前だけを候補にし、別活動や相対値の創作を拒否', () => {
    const selected = input('出勤開始30分前に勤怠提出を作って'); selected.selection.activityId = 'work'
    const trigger: CalendarRule['trigger'] = { kind: 'activity_relative', activityId: 'work', edge: 'start', offsetDays: 0, offsetMinutes: -30 }
    const valid = answer(trigger, { recurrence_quote: '出勤開始30分前', manual_points: null })
    expect(parseRoutineAssistAnswer(valid, selected, calendarFixture()).definition.trigger).toEqual(trigger)
    expect(() => parseRoutineAssistAnswer(answer({ ...trigger, activityId: 'other' }, { recurrence_quote: '出勤開始30分前', manual_points: null }), selected, calendarFixture())).toThrow('活動')
    expect(() => parseRoutineAssistAnswer(answer({ ...trigger, offsetMinutes: -60 }, { recurrence_quote: '出勤開始30分前', manual_points: null }), selected, calendarFixture())).toThrow('分数')
  })
  it.each(['過去3回、毎月第2営業日に勤怠提出をしただけ', '毎月第2営業日に勤怠提出を設定しないで', '例えば毎月第2営業日に勤怠提出', '毎月第2営業日に勤怠提出。締切17時まで', '毎月第2営業日に勤怠提出。必要ポイントは半分にして'])('履歴・否定・例・時刻締切・曖昧な負荷を確定しない: %s', message => {
    expect(() => parseRoutineAssistAnswer(answer(undefined, { manual_points: null }), input(message), calendarFixture())).toThrow()
  })
  it('勝手な最終点数、引用創作、未知のapprovedを拒否', () => {
    const selected = input('毎月第2営業日に勤怠提出を作って')
    expect(() => parseRoutineAssistAnswer(answer(), selected, calendarFixture())).toThrow('点数')
    expect(() => parseRoutineAssistAnswer(answer(undefined, { recurrence_quote: '毎月第3営業日' }), input(), calendarFixture())).toThrow('引用')
    expect(() => parseRoutineAssistAnswer(answer(undefined, { approved: true }), input(), calendarFixture())).toThrow('項目')
  })
  it('既存25ptと全ステップの属性・keyを保持し、名称を勝手に変えない', () => {
    const state = calendarFixture(), old = monthlyRule(); old.steps[0].score!.manualPoints = 25; old.steps[0].score!.minutes = 60; old.steps.push({ ...old.steps[0], key: 'second', title: '既存の確認' }); state.rules = [old]
    const selected = input('毎月最後から第2営業日に変更して'); selected.targetRuleId = old.id; selected.expectedRuleRevision = old.revision
    const candidate = parseRoutineAssistAnswer(answer({ kind: 'monthly_business', ordinal: 2, from: 'end', time: '09:00' }, { title_quote: null, recurrence_quote: '毎月最後から第2営業日', manual_points: null }), selected, state)
    expect(candidate.definition.steps).toEqual(old.steps); expect(candidate.definition.title).toBe(old.title)
    const changed = structuredClone(candidate); changed.definition.steps[1].title = '追加仕事'; expect(() => validateRoutineAssistCandidate(changed, state)).toThrow('ステップ')
    expect(() => parseRoutineAssistAnswer(answer(undefined, { title_quote: '営業日', recurrence_quote: '毎月最後から第2営業日', trigger: candidate.definition.trigger, manual_points: null }), selected, state)).toThrow('名称')
  })
  it('確認待ちの応答を実行候補にしない', () => {
    expect(() => parseRoutineAssistAnswer(JSON.stringify({ status: 'needs_confirmation', reason: '第何営業日か確認してください' }), input(), calendarFixture())).toThrow('確認してください')
  })
})
