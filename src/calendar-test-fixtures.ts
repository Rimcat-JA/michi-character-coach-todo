import { emptyScore } from './domain'
import type { CalendarRule, CalendarRulesState } from './calendar-resolver'
import { emptyCalendarRulesState } from './calendar-rules-validation'

export function calendarFixture(): CalendarRulesState {
  const period = { validFrom: '2026-01-01', validTo: '2026-12-31', revision: 1 }
  return { ...emptyCalendarRulesState('owner', 'dataset'), contexts: [{ id: 'company', name: '本人の会社暦', domain: 'work', timezone: 'Asia/Tokyo', ...period }], bindings: [{ id: 'self', contextId: 'company', personId: 'owner', personRef: 'staff-001', activityIds: ['work'], weekdays: [1, 2, 3, 4, 5], confirmed: true, ...period }], calendars: [{ id: 'business', contextId: 'company', name: '会社営業日', weekdays: [1, 2, 3, 4, 5], ...period }], activities: [{ id: 'work', contextId: 'company', bindingId: 'self', calendarId: 'business', title: '出勤', eventKind: 'other', weekdays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00', endDayOffset: 0, ...period }], sources: ['calendar', 'activity', 'roster'].map(authorityScope => ({ id: authorityScope, contextId: 'company', title: authorityScope, authorityScope: authorityScope as 'calendar' | 'activity' | 'roster', coverageFrom: '2026-01-01', coverageTo: '2026-12-31', status: 'current', revision: 1, importedAt: '2026-10-01T00:00:00.000Z', bodyHash: 'a'.repeat(64) })) }
}
export function monthlyRule(patch: Partial<CalendarRule> = {}): CalendarRule {
  return { id: 'payroll', contextId: 'company', bindingId: 'self', calendarId: 'business', title: '月次提出', originBasis: 'user_instruction', enabled: true, validFrom: '2026-01-01', validTo: '2026-12-31', revision: 1, trigger: { kind: 'monthly_business', ordinal: 2, from: 'start', time: '17:00' }, steps: [{ key: 'submit', title: '勤怠を提出', kind: 'task', scheduledOffsetDays: 0, dueOffsetDays: 0, score: { ...emptyScore(), mode: 'manual', manualPoints: 10 }, durationMinutes: null }], ...patch }
}
