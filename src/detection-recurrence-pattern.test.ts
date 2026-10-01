import { describe, expect, it } from 'vitest'
import { verifiedRecurrenceTrigger } from './detection-recurrence-pattern'

describe('検証済み原文からの限定的な周期対応', () => {
  it('毎週の明示曜日だけを読み、時刻は本人の選択を使う', () => {
    expect(verifiedRecurrenceTrigger('毎週月曜日と水曜日に週報を提出してください。', '10:30')).toEqual({ kind: 'weekly', weekdays: [1, 3], time: '10:30' })
    expect(verifiedRecurrenceTrigger('毎週月・水曜に週報を提出してください。', '10:30')).toEqual({ kind: 'weekly', weekdays: [1, 3], time: '10:30' })
    expect(verifiedRecurrenceTrigger('Send the report every Friday.', '09:00')).toEqual({ kind: 'weekly', weekdays: [5], time: '09:00' })
  })
  it('第N営業日と月末からの第N営業日を区別する', () => {
    expect(verifiedRecurrenceTrigger('毎月第２営業日に勤怠を提出。', '17:00')).toEqual({ kind: 'monthly_business', ordinal: 2, from: 'start', time: '17:00' })
    expect(verifiedRecurrenceTrigger('毎月月末から第2営業日に提出。', '17:00')).toEqual({ kind: 'monthly_business', ordinal: 2, from: 'end', time: '17:00' })
    expect(verifiedRecurrenceTrigger('毎月最終営業日に提出。', '17:00')).toEqual({ kind: 'monthly_business', ordinal: 1, from: 'end', time: '17:00' })
  })
  it('未確定・複数の異なる周期・上限超過・時刻不正から定義を作らない', () => {
    for (const raw of ['そのうち提出', '毎週月曜か水曜', 'every Monday or Wednesday', '毎週月曜日または毎週金曜日', '毎週月曜日と毎月第2営業日', '毎週月曜と毎月15日', '毎週月曜か隔週金曜', '毎週月曜日と毎日金曜', '毎月第32営業日', '毎月2営業日', '毎月第2営業日と第3営業日', '毎月第2営業日か月末', '毎月第2営業日の3日後', '毎月第2営業日以降', '毎週月曜日以外に提出', '毎月第2営業日を除く', 'every Monday except holidays', 'FREQ=WEEKLY;BYDAY=MO']) expect(() => verifiedRecurrenceTrigger(raw, '09:00')).toThrow('安全に定義')
    expect(() => verifiedRecurrenceTrigger('毎週月曜日', '24:00')).toThrow('本人が選んだ時刻')
  })
  it('原文の時刻を置き換えず、曖昧な時刻や時刻付き期限を手動確認へ残す', () => {
    expect(() => verifiedRecurrenceTrigger('毎週月曜日10:00', '09:00')).toThrow('一致しません')
    expect(verifiedRecurrenceTrigger('毎週月曜日10:00', '10:00')).toEqual({ kind: 'weekly', weekdays: [1], time: '10:00' })
    expect(verifiedRecurrenceTrigger('毎週月曜日午後1時30分', '13:30')).toEqual({ kind: 'weekly', weekdays: [1], time: '13:30' })
    for (const raw of ['毎週月曜日17:00までに提出', '毎週月曜日の期限は17時', '毎週月曜日10時半', '毎週月曜日10:00頃', 'every Monday at 10', 'every Monday 10am', '毎週月曜日10:00〜12:00', '毎週月曜9:0', '毎週月曜9時5', '毎週月曜午前9時半', '毎週月曜九時', 'every Monday noon', '毎週月曜129:00', '毎週月曜09:001', '毎週月曜9h30']) expect(() => verifiedRecurrenceTrigger(raw, '10:00')).toThrow()
  })
})
