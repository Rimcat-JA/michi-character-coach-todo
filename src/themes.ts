import { db } from './db'
import { uid, validateDate, type Task, type ThemeRule } from './domain'

export function validateThemeRule(rule: Pick<ThemeRule, 'category' | 'weekdays' | 'startDate' | 'endDate' | 'strength'>) {
  if (!rule.category.trim() || rule.category.length > 100) throw new Error('重点カテゴリが不正です')
  if (!Array.isArray(rule.weekdays) || rule.weekdays.length > 7 || new Set(rule.weekdays).size !== rule.weekdays.length || rule.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('曜日が不正です')
  validateDate(rule.startDate, '開始日')
  validateDate(rule.endDate, '終了日')
  if (rule.startDate && rule.endDate && rule.startDate > rule.endDate) throw new Error('期間が不正です')
  if (!Number.isInteger(rule.strength) || rule.strength < 1 || rule.strength > 3) throw new Error('強度は1〜3で指定してください')
}

export async function createThemeRule(input: Pick<ThemeRule, 'category' | 'weekdays' | 'startDate' | 'endDate' | 'strength'>) {
  validateThemeRule(input)
  const settings = await db.settings.get('main')
  if (!settings) throw new Error('設定がありません')
  const rule: ThemeRule = { ...input, id: uid(), ownerId: settings.profileId, category: input.category.trim(), weekdays: [...input.weekdays], createdAt: new Date().toISOString() }
  await db.themeRules.add(rule)
  return rule.id
}

export async function removeThemeRule(id: string) {
  const settings = await db.settings.get('main')
  const rule = await db.themeRules.get(id)
  if (!settings || !rule || rule.ownerId !== settings.profileId) throw new Error('重点テーマにアクセスできません')
  await db.themeRules.delete(id)
}

export function themeStrength(task: Task, date: string, rules: ThemeRule[]) {
  const weekday = new Date(`${date}T12:00:00`).getDay()
  return rules.reduce((strength, rule) => {
    if ((rule.startDate && date < rule.startDate) || (rule.endDate && date > rule.endDate)) return strength
    if (rule.weekdays.length && !rule.weekdays.includes(weekday)) return strength
    if (task.project !== rule.category && !task.project.startsWith(`${rule.category} / `)) return strength
    return Math.max(strength, rule.strength)
  }, 0)
}

export function rankTasksByTheme(tasks: Task[], date: string, rules: ThemeRule[]) {
  return [...tasks].sort((a, b) => {
    const aHard = a.dueDate !== null && a.dueDate <= date ? 1 : 0
    const bHard = b.dueDate !== null && b.dueDate <= date ? 1 : 0
    return bHard - aHard || themeStrength(b, date, rules) - themeStrength(a, date, rules) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || b.importance - a.importance
  })
}
