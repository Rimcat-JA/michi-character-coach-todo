/** Wall-clock helpers for IANA zones. Local values are 'YYYY-MM-DD' and 'HH:mm'; instants are UTC ISO strings. */
export type NonexistentTimePolicy = 'skip' | 'next_valid'
export type AmbiguousTimePolicy = 'earlier' | 'later'
export type ZonedResolution = { at: string | null; kind: 'exact' | 'nonexistent' | 'ambiguous'; adjusted: 'none' | 'skipped' | 'shifted' | 'earlier' | 'later' | 'unresolved' }

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(timezone: string) {
  let value = formatters.get(timezone)
  if (!value) { value = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); formatters.set(timezone, value) }
  return value
}
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 100) return false
  try { formatter(value); return true } catch { return false }
}
export function zonedWallParts(at: number, timezone: string) {
  const p = Object.fromEntries(formatter(timezone).formatToParts(new Date(at)).map(item => [item.type, item.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, utc: Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) }
}
export const localDateAt = (at: string, timezone: string) => zonedWallParts(Date.parse(at), timezone).date
export const localTimeAt = (at: string, timezone: string) => zonedWallParts(Date.parse(at), timezone).time
export const validClock = (value: unknown): value is string => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
export const validLocalDateTime = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(value) && new Date(`${value.slice(0, 10)}T12:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10)
const offsetAt = (at: number, timezone: string) => zonedWallParts(at, timezone).utc - at

/** Maps a local wall time to UTC. A gap time follows RFC 5545 3.3.5 (the offset before the gap) only for next_valid. */
export function resolveZonedLocalTime(date: string, time: string, timezone: string, policy: { nonexistent: NonexistentTimePolicy | null; ambiguous: AmbiguousTimePolicy | null } = { nonexistent: null, ambiguous: null }): ZonedResolution {
  if (!validLocalDateTime(`${date}T${time}`)) throw new Error('現地日時が不正です')
  const naive = Date.parse(`${date}T${time}:00.000Z`), offsets = new Set<number>()
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) offsets.add(offsetAt(naive + hours * 3600000, timezone))
  const matches = [...new Set([...offsets].map(offset => naive - offset))].filter(at => { const p = zonedWallParts(at, timezone); return p.date === date && p.time === time }).sort((a, b) => a - b)
  if (matches.length === 1) return { at: new Date(matches[0]).toISOString(), kind: 'exact', adjusted: 'none' }
  if (matches.length > 1) {
    if (!policy.ambiguous) return { at: null, kind: 'ambiguous', adjusted: 'unresolved' }
    return { at: new Date(policy.ambiguous === 'earlier' ? matches[0] : matches[matches.length - 1]).toISOString(), kind: 'ambiguous', adjusted: policy.ambiguous }
  }
  if (policy.nonexistent === 'skip') return { at: null, kind: 'nonexistent', adjusted: 'skipped' }
  if (policy.nonexistent !== 'next_valid') return { at: null, kind: 'nonexistent', adjusted: 'unresolved' }
  // 26 hours earlier is safely before the transition that removed this wall time.
  return { at: new Date(naive - offsetAt(naive - 26 * 3600000, timezone)).toISOString(), kind: 'nonexistent', adjusted: 'shifted' }
}
