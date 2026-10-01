import { describe, expect, it } from 'vitest'
import { deadlineClock, groundRecurrencePhrase } from './recurrence-phrase'

const rrule = (value: string) => ({ kind: 'rrule', rrule: value })
describe('本人・原文の周期表現の決定的な読取り', () => {
  it.each([
    ['毎日植物に水をやる', rrule('FREQ=DAILY')],
    ['3日ごとにフィルター確認', rrule('FREQ=DAILY;INTERVAL=3')],
    ['2日に1回ゴミ出し', rrule('FREQ=DAILY;INTERVAL=2')],
    ['隔週月曜に定例資料', rrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO')],
    ['隔週の月・木曜に面談', rrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH')],
    ['3週間ごとに金曜の振り返り', rrule('FREQ=WEEKLY;INTERVAL=3;BYDAY=FR')],
    ['毎月15日に経費精算', rrule('FREQ=MONTHLY;BYMONTHDAY=15')],
    ['毎月1日と15日に記帳', rrule('FREQ=MONTHLY;BYMONTHDAY=1,15')],
    ['月末に家計簿を締める', rrule('FREQ=MONTHLY;BYMONTHDAY=-1')],
    ['毎月末に請求書確認', rrule('FREQ=MONTHLY;BYMONTHDAY=-1')],
    ['毎月31日にバックアップ', rrule('FREQ=MONTHLY;BYMONTHDAY=31')],
    ['第3水曜に町内会の資料確認', rrule('FREQ=MONTHLY;BYDAY=3WE')],
    ['毎月第3水曜 19:00に町内会の資料確認', rrule('FREQ=MONTHLY;BYDAY=3WE')],
    ['毎月第2・第4火曜に回覧', rrule('FREQ=MONTHLY;BYDAY=2TU,4TU')],
    ['最終金曜に週次まとめ', rrule('FREQ=MONTHLY;BYDAY=-1FR')],
    ['毎月最後の金曜日に棚卸し', rrule('FREQ=MONTHLY;BYDAY=-1FR')],
    ['毎月最終平日に締め処理', rrule('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1')],
    ['隔月の10日に点検', rrule('FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=10')],
    ['3か月ごとの1日に棚卸し', rrule('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1')],
    ['毎年4月1日に保険の更新', rrule('FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=1')],
    ['毎年2月29日に記念日', rrule('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29')],
    ['毎年11月第4木曜に準備', rrule('FREQ=YEARLY;BYMONTH=11;BYDAY=4TH')],
    ['前回完了から14日後に植物の水やり、10pt', { kind: 'completion_relative', afterDays: 14 }],
    ['完了して2週間後にシーツ交換', { kind: 'completion_relative', afterDays: 14 }],
    ['前回の完了から3日後にもう一度', { kind: 'completion_relative', afterDays: 3 }],
    ['毎週月・水曜に週報', { kind: 'weekly', weekdays: [1, 3] }],
    ['毎月曜に会議資料', { kind: 'weekly', weekdays: [1] }],
    ['毎日曜日に買い出し', { kind: 'weekly', weekdays: [0] }],
    ['毎月第2営業日に勤怠提出', { kind: 'monthly_business', ordinal: 2, from: 'start' }],
    ['会社の最終営業日に勤怠提出', { kind: 'monthly_business', ordinal: 1, from: 'end' }],
    ['毎月月末から第3営業日に提出', { kind: 'monthly_business', ordinal: 3, from: 'end' }],
    ['Water the plants every day', rrule('FREQ=DAILY')],
    ['Review every 2 weeks on Monday', rrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO')],
    ['Pay rent on the 15th of every month', rrule('FREQ=MONTHLY;BYMONTHDAY=15')],
    ['Stocktake on the last Friday of every month', rrule('FREQ=MONTHLY;BYDAY=-1FR')],
    ['Renew every year on April 1', rrule('FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=1')],
    ['Change the filter 14 days after the last completion', { kind: 'completion_relative', afterDays: 14 }],
    ['Send the report every Monday and Wednesday', { kind: 'weekly', weekdays: [1, 3] }],
  ])('%s', (text, expected) => { expect(groundRecurrencePhrase(text)).toEqual(expected) })

  it.each([
    '2日おきにゴミ出し', '2週間くらいおきに掃除', '毎週月曜か水曜に提出', '毎日（土日を除く）に確認', '毎週月曜と毎月15日に提出', 'たまに掃除する', 'ときどき実家に電話',
    '月に1回の点検', '週1回ジム', '毎月第二火曜に回覧', '毎月第2営業日の3日後に提出', '完了から1か月後に交換', '毎週の振り返り', 'every Monday or Tuesday', 'every few days',
    'FREQ=WEEKLY;BYDAY=MO', '毎月第6火曜に回覧', '毎年2月30日に記念日', '毎日と毎週金曜に確認', '毎月15日以降に精算', 'そのうち片付ける', '前回完了から2週間くらい後', '毎週月曜日と毎日金曜',
  ])('拒否: %s', text => { expect(() => groundRecurrencePhrase(text)).toThrow() })

  // Qualifiers the grammar does not read must not disappear and leave a different, clean rule.
  it.each([
    '平日は毎日メール確認', '毎日（土日は休み）ストレッチ', '毎週末に掃除', '毎月25日（土日祝の場合は前営業日）に振込', '毎月第2営業日（土日は休み）に提出', '毎月25日、休日なら翌営業日に振込',
    '月末か15日に精算', '15日か月末に精算', '毎月1日〜5日に棚卸し', '毎月1日～5日に棚卸し', '毎月1日から5日までに提出', '翌週の月曜に振り返り', '毎月15日近くに精算', '毎月15日あたりに精算',
    '毎週月曜に3回ストレッチ', '前回完了の3日前に予約', '完了の3日前に連絡', 'Water the plants every day except weekends', 'every day on weekdays', 'Pay rent on the 15th of every month unless it is a holiday', 'every Monday, 3 times',
  ])('条件・範囲・振替を省略しない: %s', text => { expect(() => groundRecurrencePhrase(text)).toThrow() })
  it('日付の開始・終了や営業日・平日の読取りは条件の語として拒否しない', () => {
    expect(groundRecurrencePhrase('2026年10月5日から2026年10月20日まで、毎週月曜日に週報を提出')).toEqual({ kind: 'weekly', weekdays: [1] })
    expect(groundRecurrencePhrase('2026-10-05から毎週月曜に勤怠提出')).toEqual({ kind: 'weekly', weekdays: [1] })
    expect(groundRecurrencePhrase('毎月最初の平日に計画')).toEqual(rrule('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1'))
    expect(groundRecurrencePhrase('2日に1回ゴミ出し')).toEqual(rrule('FREQ=DAILY;INTERVAL=2'))
  })
})

describe('時刻付きの締め切りの読取り', () => {
  it.each([['会社の最終営業日に勤怠提出、締め切りは17時、10pt', '17:00'], ['毎週金曜17:00までに日報', '17:00'], ['締切 午後5時', '17:00'], ['期限は9時30分', '09:30'], ['毎週月曜10:00に会議', null]] as const)('%s → %s', (text, time) => {
    expect(deadlineClock(text).time).toBe(time)
  })
  it('「N時間」は時刻として読まず、午前12時・午後12時は推測しない', () => {
    expect(deadlineClock('返信の期限は12時間以内').time).toBeNull()
    expect(deadlineClock('締め切りは3時間後').time).toBeNull()
    expect(deadlineClock('提出は12時間まで').time).toBeNull()
    expect(() => deadlineClock('午後12時まで')).toThrow('午前・午後')
    expect(() => deadlineClock('締め切りは午前12時')).toThrow('午前・午後')
    expect(deadlineClock('締め切りは午後5時').time).toBe('17:00')
    expect(deadlineClock('締め切りは12時').time).toBe('12:00')
    expect(deadlineClock('午前11時30分まで').time).toBe('11:30')
  })
  it('二つの締め切り時刻や不正な時刻を一つにまとめない', () => {
    expect(() => deadlineClock('締め切りは17時、提出は18時まで')).toThrow('一つ')
    expect(() => deadlineClock('締め切りは25時')).toThrow()
    expect(deadlineClock('毎週月曜10:00の会議、締め切りは17時').rest).toContain('10:00')
    expect(deadlineClock('毎週月曜10:00の会議、締め切りは17時').rest).not.toContain('17')
  })
})
