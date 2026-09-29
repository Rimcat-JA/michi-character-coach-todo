import { db } from './db'
import { uid, validateDate, type SmartList, type SmartListAst, type SmartListField, type Task } from './domain'

const fields = new Set<SmartListField>(['status', 'title', 'project', 'labels', 'scheduledDate', 'dueDate', 'importance', 'effectivePoints', 'minutes', 'energyNeed', 'focusNeed'])
const textFields = new Set<SmartListField>(['title', 'project', 'labels'])
const dateFields = new Set<SmartListField>(['scheduledDate', 'dueDate'])
const numberFields = new Set<SmartListField>(['importance', 'effectivePoints', 'minutes', 'energyNeed', 'focusNeed'])
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function validateSmartListAst(input: unknown): asserts input is SmartListAst {
  let conditions = 0
  function walk(node: unknown, depth: number) {
    if (!record(node) || depth > 5) throw new Error('Smart Listの深さは5段以内です')
    if (node.type === 'all' || node.type === 'any') {
      if (Object.keys(node).some(key => !['type', 'children'].includes(key)) || !Array.isArray(node.children) || node.children.length < 1 || node.children.length > 50) throw new Error('Smart Listの組み合わせが不正です')
      for (const child of node.children) walk(child, depth + 1)
      return
    }
    if (node.type === 'not') {
      if (Object.keys(node).some(key => !['type', 'child'].includes(key))) throw new Error('Smart Listの否定が不正です')
      walk(node.child, depth + 1)
      return
    }
    if (node.type !== 'condition' || Object.keys(node).some(key => !['type', 'field', 'operator', 'value'].includes(key)) || !fields.has(node.field as SmartListField)) throw new Error('Smart Listの条件が不正です')
    conditions++
    if (conditions > 50) throw new Error('Smart Listの条件は50個以内です')
    const field = node.field as SmartListField
    if (node.operator === 'is_unknown') {
      if (node.value !== undefined) throw new Error('未知値条件に値は指定できません')
      return
    }
    if (node.operator === 'contains') {
      if (!textFields.has(field) || typeof node.value !== 'string' || !node.value.trim() || node.value.length > 300) throw new Error('文字列条件が不正です')
      return
    }
    if (node.operator === 'lte' || node.operator === 'gte') {
      if (numberFields.has(field) && typeof node.value === 'number' && Number.isFinite(node.value)) return
      if (dateFields.has(field) && typeof node.value === 'string') { validateDate(node.value, 'Smart Listの日付'); return }
      throw new Error('大小比較の条件が不正です')
    }
    if (node.operator !== 'eq' && node.operator !== 'neq') throw new Error('演算子が不正です')
    if (numberFields.has(field) && typeof node.value === 'number' && Number.isFinite(node.value)) return
    if (dateFields.has(field) && typeof node.value === 'string') { validateDate(node.value, 'Smart Listの日付'); return }
    if (field === 'status' && ['open', 'completed'].includes(node.value as string)) return
    if (textFields.has(field) && typeof node.value === 'string' && node.value.trim() && node.value.length <= 300) return
    throw new Error('比較値が不正です')
  }
  walk(input, 1)
}

function taskValue(task: Task, field: SmartListField): string | number | string[] | null | undefined {
  if (field === 'minutes') return task.score.minutes
  return task[field]
}

export function matchesSmartList(task: Task, ast: SmartListAst): boolean {
  if (ast.type === 'all' || ast.type === 'any') return ast.type === 'all' ? ast.children.every(child => matchesSmartList(task, child)) : ast.children.some(child => matchesSmartList(task, child))
  if (ast.type === 'not') return !matchesSmartList(task, ast.child)
  if (ast.type !== 'condition') return false
  const value = taskValue(task, ast.field)
  if (ast.operator === 'is_unknown') return value === null || value === undefined
  if (value === null || value === undefined) return false
  if (ast.operator === 'contains') return Array.isArray(value) ? value.some(item => item.toLocaleLowerCase('ja-JP').includes(String(ast.value).toLocaleLowerCase('ja-JP'))) : String(value).toLocaleLowerCase('ja-JP').includes(String(ast.value).toLocaleLowerCase('ja-JP'))
  if (ast.operator === 'eq') return Array.isArray(value) ? value.includes(String(ast.value)) : value === ast.value
  if (ast.operator === 'neq') return Array.isArray(value) ? !value.includes(String(ast.value)) : value !== ast.value
  if (typeof value === 'number' && typeof ast.value === 'number') return ast.operator === 'lte' ? value <= ast.value : value >= ast.value
  if (typeof value === 'string' && typeof ast.value === 'string') return ast.operator === 'lte' ? value <= ast.value : value >= ast.value
  return false
}

export function querySmartList(list: SmartList, tasks: Task[], ownerId: string) {
  if (list.ownerId !== ownerId) throw new Error('Smart Listにアクセスできません')
  validateSmartListAst(list.ast)
  return tasks.filter(task => !task.deletedAt && matchesSmartList(task, list.ast))
}

function validateName(name: string) {
  if (!name.trim() || name.trim().length > 100) throw new Error('Smart List名は1〜100文字で入力してください')
  return name.trim()
}

export async function createSmartList(name: string, ast: SmartListAst) {
  validateSmartListAst(ast)
  const settings = await db.settings.get('main')
  if (!settings) throw new Error('設定がありません')
  const at = new Date().toISOString(), id = uid()
  await db.smartLists.add({ id, ownerId: settings.profileId, name: validateName(name), ast, revision: 1, createdAt: at, updatedAt: at })
  return id
}

export async function updateSmartList(id: string, expectedRevision: number, name: string, ast: SmartListAst) {
  validateSmartListAst(ast)
  const clean = validateName(name)
  await db.transaction('rw', db.smartLists, db.settings, async () => {
    const settings = await db.settings.get('main'), list = await db.smartLists.get(id)
    if (!settings || !list || list.ownerId !== settings.profileId) throw new Error('Smart Listにアクセスできません')
    if (list.revision !== expectedRevision) throw new Error('別の画面で更新されました')
    await db.smartLists.put({ ...list, name: clean, ast, revision: list.revision + 1, updatedAt: new Date().toISOString() })
  })
}

export async function removeSmartList(id: string) {
  await db.transaction('rw', db.smartLists, db.settings, async () => {
    const settings = await db.settings.get('main'), list = await db.smartLists.get(id)
    if (!settings || !list || list.ownerId !== settings.profileId) throw new Error('Smart Listにアクセスできません')
    if (settings.customScreen) await db.settings.update('main', { customScreen: Object.fromEntries(Object.entries(settings.customScreen).map(([key, value]) => [key, value === id ? null : value])) as typeof settings.customScreen })
    if (settings.reminderState) await db.settings.update('main', { reminderState: { ...settings.reminderState, rules: settings.reminderState.rules.map(rule => rule.kind === 'smart-daily' && rule.targetId === id ? { ...rule, enabled: false, updatedAt: new Date().toISOString() } : rule) } })
    await db.smartLists.delete(id)
  })
}
