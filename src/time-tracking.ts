import type { WorkSession } from './domain'

export function unionSessionMinutes(sessions: Pick<WorkSession, 'startedAt' | 'endedAt'>[]): number {
  const intervals = sessions.map(session => [Date.parse(session.startedAt), Date.parse(session.endedAt)] as const)
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start)
    .sort((a, b) => a[0] - b[0])
  let total = 0, start = -1, end = -1
  for (const [nextStart, nextEnd] of intervals) {
    if (nextStart > end) {
      if (start >= 0) total += end - start
      start = nextStart; end = nextEnd
    } else end = Math.max(end, nextEnd)
  }
  if (start >= 0) total += end - start
  return Math.round(total / 60000)
}
