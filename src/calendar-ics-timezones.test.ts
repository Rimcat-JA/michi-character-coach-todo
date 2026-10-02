import { describe, expect, it } from 'vitest'
import { parseCalendarImport } from './calendar-import'
import { windowsTimezones } from './windows-timezones'
const options = { timezone: 'Asia/Tokyo', fromDate: '2026-01-01', toDate: '2026-12-31' }
function document(zone = 'Asia/Tokyo', offset = '+0900', alarm = '', extra = '') {
  return `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:fixture\nBEGIN:VTIMEZONE\nTZID:${zone}\nBEGIN:STANDARD\nDTSTART:19700101T000000\nTZOFFSETFROM:${offset}\nTZOFFSETTO:${offset}\nEND:STANDARD\nEND:VTIMEZONE\nBEGIN:VEVENT\nUID:example\nDTSTAMP:20261002T000000Z\nDTSTART;TZID=${zone}:20261005T090000\nDTEND;TZID=${zone}:20261005T100000\nSUMMARY:Test\n${alarm}${extra}END:VEVENT\nEND:VCALENDAR`
}
describe('known ICS timezone definitions', () => {
  it('accepts Google IANA and Outlook CLDR Tokyo with bounded ignored alarms', () => {
    expect(parseCalendarImport(document(), options).occurrences[0].startAt).toBe('2026-10-05T00:00:00.000Z')
    const result = parseCalendarImport(document('Tokyo Standard Time', '+0900', 'BEGIN:VALARM\nACTION:DISPLAY\nTRIGGER:-PT10M\nDESCRIPTION:Reminder\nEND:VALARM\n'), options)
    expect(result.occurrences[0].timezone).toBe('Asia/Tokyo')
    expect(result.warnings).toContain('アラームは取り込みません')
    expect(result.warnings.some(row => row.includes('CLDR 48'))).toBe(true)
    expect(Object.keys(windowsTimezones)).toHaveLength(139)
  })
  it('holds mismatched and unknown zones, malformed nesting, unrelated components', () => {
    expect(() => parseCalendarImport(document('Asia/Tokyo', '+0800'), options)).toThrow('TZOFFSETTO')
    expect(() => parseCalendarImport(document('Unrecognized Standard Time'), options)).toThrow('未対応')
    expect(() => parseCalendarImport(document().replace('END:STANDARD', 'END:DAYLIGHT'), options)).toThrow('閉じて')
    expect(() => parseCalendarImport(document('Asia/Tokyo', '+0900', 'BEGIN:VALARM\nBEGIN:VEVENT\nEND:VEVENT\nEND:VALARM\n'), options)).toThrow('入れ子')
    expect(() => parseCalendarImport(document('Asia/Tokyo', '+0900', '', 'BEGIN:VTODO\nEND:VTODO\n'), options)).toThrow('未対応')
  })
  it('checks yearly DST transitions and every expanded end/reference against Intl', () => {
    const zone = 'America/New_York'
    const definition = `BEGIN:VTIMEZONE\nTZID:${zone}\nBEGIN:STANDARD\nDTSTART:20071104T020000\nTZOFFSETFROM:-0400\nTZOFFSETTO:-0500\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\nEND:STANDARD\nBEGIN:DAYLIGHT\nDTSTART:20070311T020000\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0400\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\nEND:DAYLIGHT\nEND:VTIMEZONE`
    const input = document(zone, '-0500').replace(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE/, definition).replace('20261005T090000', '20260105T090000').replace('20261005T100000', '20260105T100000').replace('SUMMARY:Test', 'SUMMARY:Test\nRRULE:FREQ=MONTHLY;COUNT=12')
    expect(parseCalendarImport(input, options).occurrences).toHaveLength(12)
    expect(() => parseCalendarImport(input.replace('BYMONTH=3', 'BYMONTH=5'), options)).toThrow('TZOFFSETTO')
    expect(() => parseCalendarImport(input.replace('BYDAY=2SU', 'BYDAY=SU'), options)).toThrow('VTIMEZONE')
  })
})
