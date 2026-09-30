'use strict'
const fields = new Set(['status', 'title', 'project', 'labels', 'scheduledDate', 'dueDate', 'importance', 'effectivePoints', 'minutes', 'energyNeed', 'focusNeed'])
const texts = new Set(['title', 'project', 'labels'])
const dates = new Set(['scheduledDate', 'dueDate'])
const numbers = new Set(['importance', 'effectivePoints', 'minutes', 'energyNeed', 'focusNeed'])
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const keys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key))
function date(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value }
function validateAst(ast) {
  let conditions = 0
  function walk(node, depth) {
    if (!object(node) || depth > 5) return false
    if (node.type === 'all' || node.type === 'any') return keys(node, ['type', 'children']) && Array.isArray(node.children) && node.children.length > 0 && node.children.length <= 50 && node.children.every(child => walk(child, depth + 1))
    if (node.type === 'not') return keys(node, ['type', 'child']) && walk(node.child, depth + 1)
    if (node.type !== 'condition' || !keys(node, ['type', 'field', 'operator', 'value']) || !fields.has(node.field) || ++conditions > 50) return false
    if (node.operator === 'is_unknown') return node.value === undefined
    if (node.operator === 'contains') return texts.has(node.field) && typeof node.value === 'string' && node.value.trim().length > 0 && node.value.length <= 300
    if (!['eq', 'neq', 'lte', 'gte'].includes(node.operator)) return false
    if (numbers.has(node.field)) return typeof node.value === 'number' && Number.isFinite(node.value)
    if (dates.has(node.field)) return date(node.value)
    if (['lte', 'gte'].includes(node.operator)) return false
    return node.field === 'status' ? ['open', 'completed'].includes(node.value) : texts.has(node.field) && typeof node.value === 'string' && node.value.trim().length > 0 && node.value.length <= 300
  }
  try { return walk(ast, 1) } catch { return false }
}
function matches(task, ast) {
  if (ast.type === 'all') return ast.children.every(child => matches(task, child))
  if (ast.type === 'any') return ast.children.some(child => matches(task, child))
  if (ast.type === 'not') return !matches(task, ast.child)
  const value = ast.field === 'minutes' ? task.score?.minutes : task[ast.field]
  if (ast.operator === 'is_unknown') return value === null || value === undefined
  if (value === null || value === undefined) return false
  if (ast.operator === 'contains') return Array.isArray(value) ? value.some(item => typeof item === 'string' && item.toLocaleLowerCase('ja-JP').includes(String(ast.value).toLocaleLowerCase('ja-JP'))) : String(value).toLocaleLowerCase('ja-JP').includes(String(ast.value).toLocaleLowerCase('ja-JP'))
  if (ast.operator === 'eq') return Array.isArray(value) ? value.includes(String(ast.value)) : value === ast.value
  if (ast.operator === 'neq') return Array.isArray(value) ? !value.includes(String(ast.value)) : value !== ast.value
  if (typeof value === 'number' && typeof ast.value === 'number' || typeof value === 'string' && typeof ast.value === 'string') return ast.operator === 'lte' ? value <= ast.value : value >= ast.value
  return false
}
/** Same visibility/query semantics as querySmartList(...).some(status==='open'). */
function activeSmartList(list, tasks, ownerId, _now) {
  try { return Boolean(object(list) && list.ownerId === ownerId && typeof list.id === 'string' && Number.isInteger(list.revision) && list.revision > 0 && validateAst(list.ast) && Array.isArray(tasks) && tasks.some(task => object(task) && !task.deletedAt && task.status === 'open' && matches(task, list.ast))) } catch { return false }
}
module.exports = { activeSmartList, validateAst }
