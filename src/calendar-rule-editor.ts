import { emptyScore, validateScore, type ScoreInput } from './domain'
import type { CalendarRule, CalendarRuleStep } from './calendar-resolver'

export function calendarRuleEditorDefinition(rule: CalendarRule) {
  return structuredClone(rule.editions?.at(-1)?.definition ?? { title: rule.title, enabled: rule.enabled, trigger: rule.trigger, steps: rule.steps })
}

/** A blank formula display is unchanged; clearing a displayed manual value is explicit. */
export function calendarRuleEditorScore(previous: ScoreInput | null | undefined, pointText: string): ScoreInput {
  const score = structuredClone(previous ?? emptyScore()), points = pointText.trim()
  if (points === '') {
    if (score.mode === 'manual') { score.mode = 'unset'; score.manualPoints = null }
    return score
  }
  const manualPoints = Number(points)
  const next = { ...score, mode: 'manual' as const, manualPoints }
  validateScore(next)
  return next
}

export function calendarRuleEditorSteps(rule: CalendarRule | undefined, first: Omit<CalendarRuleStep, 'key' | 'score'>, pointText: string): CalendarRuleStep[] {
  const previous = rule ? calendarRuleEditorDefinition(rule).steps : []
  const edited: CalendarRuleStep = { ...first, key: previous[0]?.key ?? 'main', score: first.kind === 'task' ? calendarRuleEditorScore(previous[0]?.score, pointText) : null }
  return [edited, ...previous.slice(1)]
}
