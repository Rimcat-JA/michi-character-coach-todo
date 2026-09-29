import { db } from './db'
import { validateDate, type FocusProjectSelection, type Task, type ThemeRule } from './domain'
import { themeStrength } from './themes'

export function recommendFocusProjects(tasks: Task[], date: string, limit = 3) {
  const ordered = [...tasks].filter(task => !task.deletedAt && task.status === 'open' && task.project)
    .sort((a, b) => Number(b.dueDate !== null && b.dueDate <= date) - Number(a.dueDate !== null && a.dueDate <= date) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || b.importance - a.importance)
  return [...new Set(ordered.map(task => task.project))].slice(0, limit)
}

export async function setFocusProjects(date: string, projects: string[], source: FocusProjectSelection['source']) {
  validateDate(date, '重点日')
  if (!Array.isArray(projects) || projects.length > 5 || new Set(projects).size !== projects.length || projects.some(project => typeof project !== 'string' || !project.trim() || project.length > 300)) throw new Error('重点プロジェクトが不正です')
  if (source !== 'user' && source !== 'coach') throw new Error('選択元が不正です')
  return db.transaction('rw', db.settings, db.tasks, db.focusSelections, async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('設定がありません')
    const known = new Set((await db.tasks.toArray()).filter(task => !task.deletedAt && task.status === 'open').map(task => task.project))
    if (projects.some(project => !known.has(project))) throw new Error('存在しないプロジェクトです')
    const id = `${settings.profileId}:${date}`
    const old = await db.focusSelections.get(id)
    if (old?.source === 'user' && source === 'coach') return old
    const selection: FocusProjectSelection = { id, ownerId: settings.profileId, date, projects: [...projects], source, revision: (old?.revision ?? 0) + 1, updatedAt: new Date().toISOString() }
    await db.focusSelections.put(selection)
    return selection
  })
}

export function rankTasksForFocus(tasks: Task[], date: string, focusProjects: string[], themes: ThemeRule[]) {
  const chosen = new Set(focusProjects)
  return [...tasks].sort((a, b) => {
    const hardA = Number(a.dueDate !== null && a.dueDate <= date), hardB = Number(b.dueDate !== null && b.dueDate <= date)
    return hardB - hardA || Number(chosen.has(b.project)) - Number(chosen.has(a.project)) || themeStrength(b, date, themes) - themeStrength(a, date, themes) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || b.importance - a.importance
  })
}
