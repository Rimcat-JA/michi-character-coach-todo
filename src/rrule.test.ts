import { describe, expect, it } from 'vitest'
import { canonicalRRule, describeRRule, expandRRule, parseRRule } from './rrule'
import { resolveZonedLocalTime } from './zoned-time'

const days = (dtstart: string, rrule: string, from: string, to: string, extra: { rdates?: string[]; exdates?: string[]; timezone?: string } = {}) => expandRRule({ dtstart, rrule, from, to, ...extra }).occurrences.map(value => value.slice(0, 10))

// Static fixtures copied from RFC 5545 section 3.8.5.3 (expected dates from the RFC text), plus computed 2026 cases.
describe('RFC 5545 RRULE 例の展開', () => {
  it('毎日10回、10日ごと5回', () => {
    expect(days('1997-09-02T09:00', 'FREQ=DAILY;COUNT=10', '1997-09-01', '1997-12-31')).toEqual(['1997-09-02', '1997-09-03', '1997-09-04', '1997-09-05', '1997-09-06', '1997-09-07', '1997-09-08', '1997-09-09', '1997-09-10', '1997-09-11'])
    expect(days('1997-09-02T09:00', 'FREQ=DAILY;INTERVAL=10;COUNT=5', '1997-09-01', '1997-12-31')).toEqual(['1997-09-02', '1997-09-12', '1997-09-22', '1997-10-02', '1997-10-12'])
  })
  it('1月の毎日を3年（UTCのUNTILを本人のタイムゾーンで比較）', () => {
    const result = days('1998-01-01T09:00', 'FREQ=DAILY;UNTIL=20000131T140000Z;BYMONTH=1', '1998-01-01', '2000-12-31', { timezone: 'America/New_York' })
    expect(result).toHaveLength(93); expect(result[0]).toBe('1998-01-01'); expect(result.at(-1)).toBe('2000-01-31')
    expect(() => days('1998-01-01T09:00', 'FREQ=DAILY;UNTIL=20000131T140000Z;BYMONTH=1', '1998-01-01', '2000-12-31')).toThrow('タイムゾーン')
  })
  it('毎週10回と、隔週の月・水・金（WKST=SU, UNTIL）', () => {
    expect(days('1997-09-02T09:00', 'FREQ=WEEKLY;COUNT=10', '1997-09-01', '1997-12-31')).toEqual(['1997-09-02', '1997-09-09', '1997-09-16', '1997-09-23', '1997-09-30', '1997-10-07', '1997-10-14', '1997-10-21', '1997-10-28', '1997-11-04'])
    expect(days('1997-09-01T09:00', 'FREQ=WEEKLY;INTERVAL=2;UNTIL=19971224T000000Z;WKST=SU;BYDAY=MO,WE,FR', '1997-09-01', '1997-12-31', { timezone: 'America/New_York' })).toEqual(['1997-09-01', '1997-09-03', '1997-09-05', '1997-09-15', '1997-09-17', '1997-09-19', '1997-09-29', '1997-10-01', '1997-10-03', '1997-10-13', '1997-10-15', '1997-10-17', '1997-10-27', '1997-10-29', '1997-10-31', '1997-11-10', '1997-11-12', '1997-11-14', '1997-11-24', '1997-11-26', '1997-11-28', '1997-12-08', '1997-12-10', '1997-12-12', '1997-12-22'])
  })
  it('WKSTの違いで隔週の回が変わる', () => {
    expect(days('1997-08-05T09:00', 'FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO', '1997-08-01', '1997-12-31')).toEqual(['1997-08-05', '1997-08-10', '1997-08-19', '1997-08-24'])
    expect(days('1997-08-05T09:00', 'FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU', '1997-08-01', '1997-12-31')).toEqual(['1997-08-05', '1997-08-17', '1997-08-19', '1997-08-31'])
  })
  it('毎月第1金曜（1FR）と最終金曜（-1FR）、第1・最終日曜、最後から2番目の月曜', () => {
    expect(days('1997-09-05T09:00', 'FREQ=MONTHLY;COUNT=10;BYDAY=1FR', '1997-09-01', '1998-12-31')).toEqual(['1997-09-05', '1997-10-03', '1997-11-07', '1997-12-05', '1998-01-02', '1998-02-06', '1998-03-06', '1998-04-03', '1998-05-01', '1998-06-05'])
    expect(days('2026-01-30T09:00', 'FREQ=MONTHLY;COUNT=4;BYDAY=-1FR', '2026-01-01', '2026-12-31')).toEqual(['2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24'])
    expect(days('1997-10-05T09:00', 'FREQ=MONTHLY;COUNT=10;BYDAY=1SU,-1SU', '1997-10-01', '1998-12-31')).toEqual(['1997-10-05', '1997-10-26', '1997-11-02', '1997-11-30', '1997-12-07', '1997-12-28', '1998-01-04', '1998-01-25', '1998-02-01', '1998-02-22'])
    expect(days('1997-09-22T09:00', 'FREQ=MONTHLY;COUNT=6;BYDAY=-2MO', '1997-09-01', '1998-12-31')).toEqual(['1997-09-22', '1997-10-20', '1997-11-17', '1997-12-22', '1998-01-19', '1998-02-16'])
  })
  it('最終平日（BYDAY=MO..FR;BYSETPOS=-1）、最後から2番目の平日、第3の火水木', () => {
    expect(days('2026-01-01T18:00', 'FREQ=MONTHLY;COUNT=5;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', '2026-01-01', '2026-12-31')).toEqual(['2026-01-30', '2026-02-27', '2026-03-31', '2026-04-30', '2026-05-29'])
    expect(days('1997-09-29T09:00', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2', '1997-09-01', '1998-03-31')).toEqual(['1997-09-29', '1997-10-30', '1997-11-27', '1997-12-30', '1998-01-29', '1998-02-26', '1998-03-30'])
    expect(days('1997-09-04T09:00', 'FREQ=MONTHLY;COUNT=3;BYDAY=TU,WE,TH;BYSETPOS=3', '1997-09-01', '1997-12-31')).toEqual(['1997-09-04', '1997-10-07', '1997-11-06'])
  })
  it('毎年1月の日曜（隔年）、3月の木曜、年の第20月曜', () => {
    expect(days('1997-01-05T08:30', 'FREQ=YEARLY;INTERVAL=2;BYMONTH=1;BYDAY=SU', '1997-01-01', '2001-12-31')).toEqual(['1997-01-05', '1997-01-12', '1997-01-19', '1997-01-26', '1999-01-03', '1999-01-10', '1999-01-17', '1999-01-24', '1999-01-31', '2001-01-07', '2001-01-14', '2001-01-21', '2001-01-28'])
    expect(days('1997-03-13T09:00', 'FREQ=YEARLY;BYMONTH=3;BYDAY=TH', '1997-01-01', '1999-12-31')).toEqual(['1997-03-13', '1997-03-20', '1997-03-27', '1998-03-05', '1998-03-12', '1998-03-19', '1998-03-26', '1999-03-04', '1999-03-11', '1999-03-18', '1999-03-25'])
    expect(days('1997-05-19T09:00', 'FREQ=YEARLY;BYDAY=20MO', '1997-01-01', '1999-12-31')).toEqual(['1997-05-19', '1998-05-18', '1999-05-17'])
  })
  it('13日の金曜（EXDATEでDTSTARTを除外）と米国選挙日', () => {
    expect(days('1997-09-02T09:00', 'FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13', '1997-09-01', '2000-12-31', { exdates: ['1997-09-02T09:00'] })).toEqual(['1998-02-13', '1998-03-13', '1998-11-13', '1999-08-13', '2000-10-13'])
    expect(days('1996-11-05T09:00', 'FREQ=YEARLY;INTERVAL=4;BYMONTH=11;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8', '1996-01-01', '2004-12-31')).toEqual(['1996-11-05', '2000-11-07', '2004-11-02'])
  })
  it('BYMONTHDAY=31は短い月を作らず、月末プリセット(-1)は毎月最終日、存在しない2月30日は無視', () => {
    expect(days('2026-01-31T09:00', 'FREQ=MONTHLY;BYMONTHDAY=31', '2026-01-01', '2026-12-31')).toEqual(['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31', '2026-08-31', '2026-10-31', '2026-12-31'])
    expect(days('2026-01-31T09:00', 'FREQ=MONTHLY;BYMONTHDAY=-1', '2026-01-01', '2026-12-31')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31'])
    expect(days('2007-01-15T09:00', 'FREQ=MONTHLY;BYMONTHDAY=15,30;COUNT=5', '2007-01-01', '2007-12-31')).toEqual(['2007-01-15', '2007-01-30', '2007-02-15', '2007-03-15', '2007-03-30'])
  })
  it('毎年2月29日はうるう年だけ', () => {
    expect(days('2024-02-29T09:00', 'FREQ=YEARLY', '2024-01-01', '2032-12-31')).toEqual(['2024-02-29', '2028-02-29', '2032-02-29'])
    expect(days('2026-10-01T09:00', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', '2026-01-01', '2032-12-31')).toEqual(['2028-02-29', '2032-02-29'])
  })
  it('UNTILは当日・同時刻を含み、DTSTART前と期間外を出さない', () => {
    expect(days('1997-12-20T09:00', 'FREQ=DAILY;UNTIL=19971224', '1997-12-01', '1997-12-31')).toEqual(['1997-12-20', '1997-12-21', '1997-12-22', '1997-12-23', '1997-12-24'])
    expect(days('1997-12-20T09:00', 'FREQ=DAILY;UNTIL=19971224T090000', '1997-12-01', '1997-12-31').at(-1)).toBe('1997-12-24')
    expect(days('1997-12-20T09:00', 'FREQ=DAILY;UNTIL=19971224T085900', '1997-12-01', '1997-12-31').at(-1)).toBe('1997-12-23')
    expect(days('1997-12-20T09:00', 'FREQ=DAILY;UNTIL=19971224', '1997-12-22', '1997-12-23')).toEqual(['1997-12-22', '1997-12-23'])
  })
  it('EXDATEはCOUNTの後で除外し、RDATEは別に追加する', () => {
    const result = expandRRule({ dtstart: '2026-10-05T09:00', rrule: 'FREQ=WEEKLY;COUNT=4', exdates: ['2026-10-12T09:00'], rdates: ['2026-10-14T15:00'], from: '2026-10-01', to: '2026-12-31' })
    expect(result.occurrences).toEqual(['2026-10-05T09:00', '2026-10-14T15:00', '2026-10-19T09:00', '2026-10-26T09:00'])
  })
  it('期間の先から展開してもCOUNTはDTSTARTから数える', () => {
    expect(days('2026-01-01T09:00', 'FREQ=DAILY;COUNT=40', '2026-02-01', '2026-02-28')).toEqual(['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05', '2026-02-06', '2026-02-07', '2026-02-08', '2026-02-09'])
    expect(days('2020-01-06T09:00', 'FREQ=WEEKLY;INTERVAL=3;BYDAY=MO', '2026-10-01', '2026-10-31')).toEqual(days('2020-01-06T09:00', 'FREQ=WEEKLY;INTERVAL=3;BYDAY=MO', '2020-01-01', '2026-12-31').filter(day => day >= '2026-10-01' && day <= '2026-10-31'))
  })
  it('上限を超えた展開は黙って捨てず切り詰めを示す', () => {
    const result = expandRRule({ dtstart: '2026-01-01T09:00', rrule: 'FREQ=DAILY', from: '2026-01-01', to: '2026-12-31', limit: 100 })
    expect(result.occurrences).toHaveLength(100); expect(result.truncated).toBe(true)
    expect(expandRRule({ dtstart: '2026-01-01T09:00', rrule: 'FREQ=DAILY', from: '2026-01-01', to: '2026-03-31' }).truncated).toBe(false)
  })
})

describe('RRULEの検証と正規化', () => {
  it.each(['FREQ=DAILY;COUNT=3;UNTIL=20261231', 'FREQ=WEEKLY;BYDAY=1MO', 'FREQ=DAILY;BYDAY=-1FR', 'FREQ=MONTHLY;BYSETPOS=1', 'FREQ=WEEKLY;BYMONTHDAY=1', 'FREQ=DAILY;BYHOUR=9', 'FREQ=HOURLY', 'FREQ=MONTHLY;BYMONTHDAY=0', 'FREQ=MONTHLY;BYMONTH=13', 'FREQ=MONTHLY;BYDAY=6MO', 'FREQ=MONTHLY;BYDAY=MO,MO', 'FREQ=DAILY;FREQ=WEEKLY', 'FREQ=DAILY;INTERVAL=0', 'FREQ=DAILY;UNTIL=20260230', 'BYDAY=MO', 'FREQ=YEARLY;BYWEEKNO=1', ''])('RFCの組合せ・未対応を拒否: %s', text => {
    expect(() => parseRRule(text)).toThrow()
  })
  it('同じ規則を一つの綴りへ正規化する', () => {
    expect(canonicalRRule('freq=weekly;byday=fr,mo,we;interval=2')).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR')
    expect(canonicalRRule('RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=2TU;WKST=MO')).toBe('FREQ=MONTHLY;BYDAY=2TU')
    expect(canonicalRRule('FREQ=YEARLY;BYMONTHDAY=29;BYMONTH=2')).toBe('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29')
  })
  it('本人向けの説明を作る', () => {
    expect(describeRRule('FREQ=MONTHLY;BYDAY=2TU', '2026-10-13T10:00')).toBe('毎月 第2火曜 10:00')
    expect(describeRRule('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-10-31T09:00')).toBe('毎月 月末 09:00')
    expect(describeRRule('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', '2028-02-29T09:00')).toBe('毎年 2月 29日 09:00')
    expect(describeRRule('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1')).toBe('毎月 最終平日')
    expect(describeRRule('FREQ=WEEKLY;INTERVAL=2;COUNT=5;BYDAY=MO', '2026-10-05T09:00')).toBe('2週ごと 月曜 09:00 / 5回まで')
  })
  it('年ごとで月の指定がない日付・順位は、毎月・年内の順位として説明する', () => {
    expect(describeRRule('FREQ=YEARLY;BYMONTHDAY=15')).toBe('毎年 各月 15日')
    expect(describeRRule('FREQ=YEARLY;BYMONTHDAY=-1')).toBe('毎年 各月 月末')
    expect(expandRRule({ dtstart: '2026-01-15T09:00', rrule: 'FREQ=YEARLY;BYMONTHDAY=15', from: '2026-01-01', to: '2026-12-31' }).occurrences).toHaveLength(12)
    expect(describeRRule('FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=15')).toBe('毎年 10月 15日')
    expect(describeRRule('FREQ=YEARLY;BYDAY=20MO')).toBe('毎年 年内の第20月曜')
    expect(describeRRule('FREQ=YEARLY;BYMONTH=11;BYDAY=4TH')).toBe('毎年 11月 第4木曜')
  })
  it('年ごとのBYSETPOSは年内の候補全体に掛かることを示し、1つの月なら補足しない', () => {
    expect(describeRRule('FREQ=YEARLY;BYMONTH=3,9;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1')).toBe('毎年 3月・9月 最終平日（年内の候補全体で）')
    expect(days('2026-01-01T09:00', 'FREQ=YEARLY;BYMONTH=3,9;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', '2026-01-01', '2027-12-31')).toEqual(['2026-09-30', '2027-09-30'])
    expect(describeRRule('FREQ=YEARLY;BYMONTH=3;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1')).toBe('毎年 3月 最終平日')
    expect(describeRRule('FREQ=MONTHLY;BYMONTH=3,9;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1')).toBe('毎月 3月・9月 最終平日')
  })
})

describe('夏時間の存在しない・二重の現地時刻', () => {
  it('America/New_York 02:30（春）は除外か、RFC 5545どおり時差前のoffsetで03:30へ', () => {
    expect(resolveZonedLocalTime('2026-03-08', '02:30', 'America/New_York', { nonexistent: 'skip', ambiguous: 'earlier' })).toMatchObject({ at: null, kind: 'nonexistent', adjusted: 'skipped' })
    expect(resolveZonedLocalTime('2026-03-08', '02:30', 'America/New_York', { nonexistent: 'next_valid', ambiguous: 'earlier' })).toMatchObject({ at: '2026-03-08T07:30:00.000Z', adjusted: 'shifted' })
    expect(resolveZonedLocalTime('2026-03-08', '02:30', 'America/New_York')).toMatchObject({ at: null, adjusted: 'unresolved' })
  })
  it('America/New_York 01:30（秋）は前の回か後の回を本人が選ぶ', () => {
    expect(resolveZonedLocalTime('2026-11-01', '01:30', 'America/New_York', { nonexistent: 'skip', ambiguous: 'earlier' }).at).toBe('2026-11-01T05:30:00.000Z')
    expect(resolveZonedLocalTime('2026-11-01', '01:30', 'America/New_York', { nonexistent: 'skip', ambiguous: 'later' }).at).toBe('2026-11-01T06:30:00.000Z')
    expect(resolveZonedLocalTime('2026-11-01', '01:30', 'America/New_York').at).toBeNull()
  })
  it('Asia/Tokyoには切替がない', () => {
    for (const [date, time] of [['2026-03-08', '02:30'], ['2026-11-01', '01:30']]) expect(resolveZonedLocalTime(date, time, 'Asia/Tokyo')).toMatchObject({ kind: 'exact', adjusted: 'none' })
    expect(resolveZonedLocalTime('2026-03-08', '02:30', 'Asia/Tokyo').at).toBe('2026-03-07T17:30:00.000Z')
  })
})
