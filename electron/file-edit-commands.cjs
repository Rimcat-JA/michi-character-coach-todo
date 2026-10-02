const crypto = require('node:crypto')
const LIMIT = 256 * 1024
const keys = ['task_id', 'base_revision', 'snapshot_id', 'view_sha256', 'title', 'scheduled_date', 'due', 'score', 'enabled_fields']
function fail(code) { const error = new Error(code); error.code = code; throw error }
function scalar(text) {
  if (text === 'null') return null
  if (/^(0|[1-9]\d*)$/.test(text)) { const value = Number(text); if (!Number.isSafeInteger(value)) fail('EDIT_SCALAR'); return value }
  if (text.startsWith('"')) { try { const value = JSON.parse(text); if (typeof value === 'string') return value } catch {} ; fail('EDIT_SCALAR') }
  if (text.startsWith("'")) { if (!/^'(?:[^']|'')*'$/.test(text)) fail('EDIT_SCALAR'); return text.slice(1, -1).replace(/''/g, "'") }
  // Deliberately no general YAML interpreter: plain tokens, never tags, anchors or structures.
  if (!/^[a-zA-Z0-9_./ -]+$/.test(text) || !text.trim() || /^(true|false|yes|no|on|off|~)$/i.test(text)) fail('EDIT_SCALAR')
  return text
}
function parseTaskEdit(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')
  if (bytes.length > LIMIT) fail('EDIT_TOO_LARGE')
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('EDIT_UTF8') }
  text = text.replace(/^\uFEFF/, '')
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) fail('EDIT_HEADER')
  const closing = /\r?\n---(?:\r?\n|$)/g; closing.lastIndex = text.indexOf('\n') + 1
  const match = closing.exec(text)
  if (!match) fail('EDIT_HEADER')
  const header = text.slice(text.indexOf('\n') + 1, match.index).replace(/\r\n/g, '\n'), fields = {}
  for (const line of header.split('\n')) {
    const pair = /^([a-z_][a-z_0-9]*): ([^\r\n]*)$/.exec(line)
    if (!pair || !keys.includes(pair[1]) || Object.hasOwn(fields, pair[1])) fail('EDIT_HEADER_FIELD')
    fields[pair[1]] = scalar(pair[2])
  }
  const body = text.slice(closing.lastIndex)
  if (/^(?:---|\.\.\.)\s*$/m.test(body)) fail('EDIT_MULTIPLE_DOCUMENTS')
  return { fields, body }
}
function renderTaskEdit(task, manifest, grant) {
  const fields = { task_id: task.id, base_revision: task.revision, snapshot_id: manifest.snapshot_id, view_sha256: manifest.view_sha256 }
  for (const [name, source] of [['title', 'title'], ['scheduled_date', 'scheduled_date'], ['due', 'due_date'], ['score', 'manual_points']]) {
    if (Object.hasOwn(task, source)) fields[name] = task[source]
  }
  fields.enabled_fields = grant.fields.filter(field => ['title', 'notes', 'scheduled_date'].includes(field)).join(' ')
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n${task.notes ?? ''}`
}
function taskEditProposal(edit, task, manifest, grant) {
  const f = edit.fields
  if (f.task_id !== task.id || f.base_revision !== task.revision || f.snapshot_id !== manifest.snapshot_id || f.view_sha256 !== manifest.view_sha256) fail('EDIT_SNAPSHOT_MISMATCH')
  const expectedFields = grant.fields.filter(field => ['title', 'notes', 'scheduled_date'].includes(field)).join(' ')
  if (f.enabled_fields !== expectedFields) fail('EDIT_PROTECTED_FIELD')
  const payload = {}
  for (const [name, source] of [['title', 'title'], ['scheduled_date', 'scheduled_date'], ['due', 'due_date'], ['score', 'manual_points']]) {
    if (!Object.hasOwn(f, name)) continue // Omitted fields never clear saved data.
    if (!Object.hasOwn(task, source)) fail('EDIT_FIELD_NOT_DISCLOSED')
    if (f[name] === task[source]) continue
    if (['due', 'score'].includes(name) || !grant.fields.includes(source)) fail('EDIT_PROTECTED_FIELD')
    if (f[name] === null && name !== 'scheduled_date') fail('EDIT_NULL_FIELD')
    payload[source] = f[name]
  }
  if (edit.body !== (task.notes ?? '')) {
    if (!grant.fields.includes('notes')) fail('EDIT_PROTECTED_FIELD')
    payload.notes = edit.body
  }
  if (!Object.keys(payload).length) return null
  const hash = crypto.createHash('sha256').update(JSON.stringify([manifest.client_id, task.id, manifest.snapshot_id, task.revision, payload])).digest('hex')
  // Stable content-derived UUID, used only as a replay key, never as an approval token.
  const commandId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  return { commandId, snapshotId: manifest.snapshot_id, targetId: task.id, expectedRevision: task.revision, payload }
}
module.exports = { parseTaskEdit, renderTaskEdit, taskEditProposal }
