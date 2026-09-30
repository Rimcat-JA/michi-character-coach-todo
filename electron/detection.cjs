const fs = require('node:fs')
const path = require('node:path')
const detectorPrompt = fs.readFileSync(path.join(__dirname, 'prompts', 'detect_obligations.system.txt'), 'utf8')
const verifierPrompt = fs.readFileSync(path.join(__dirname, 'prompts', 'verify_obligations.system.txt'), 'utf8')
const schema = fs.readFileSync(path.join(__dirname, 'prompts', 'detection-output.schema.json'), 'utf8')
const object = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const string = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max
const strings = (value, max = 100) => Array.isArray(value) && value.length <= max && value.every(item => string(item)) && new Set(value).size === value.length
function assertDetectionRequest(value) {
  const fail = () => { throw new Error('選択資料と本人の確認情報が不正です') }
  if (!exact(value, ['trusted_context', 'sources']) || JSON.stringify(value).length > 220000) fail()
  const context = value.trusted_context
  if (!exact(context, ['user_id', 'verified_actor_ids', 'source_access', 'ai_egress_allowed', 'coverage', 'participation_bindings', 'approved_rules', 'existing_tasks', 'verified_reference_aliases', 'alias_scope']) || !string(context.user_id) || !strings(context.verified_actor_ids) || !strings(context.source_access, 20) || context.ai_egress_allowed !== true || !['complete', 'incomplete'].includes(context.coverage) || !string(context.alias_scope)) fail()
  for (const [list, booleanKey] of [[context.participation_bindings, 'confirmed'], [context.approved_rules, 'active']]) {
    if (!Array.isArray(list) || list.length > 100 || list.some(item => !object(item) || Object.keys(item).some(key => !['id', booleanKey, 'description'].includes(key)) || !string(item.id) || typeof item[booleanKey] !== 'boolean' || item.description !== undefined && !string(item.description, 3000))) fail()
  }
  if (!object(context.verified_reference_aliases) || Object.keys(context.verified_reference_aliases).length > 100 || Object.entries(context.verified_reference_aliases).some(([alias, id]) => !string(alias) || !string(id))) fail()
  if (!Array.isArray(context.existing_tasks) || context.existing_tasks.length > 100 || context.existing_tasks.some(task => !object(task) || Object.keys(task).some(key => !['id', 'revision', 'title', 'dueDate', 'assignee_id'].includes(key)) || !string(task.id) || !string(task.title, 300) || !Number.isSafeInteger(task.revision) || task.revision < 1 || task.assignee_id !== undefined && !string(task.assignee_id) || task.dueDate !== undefined && task.dueDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate))) fail()
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 20 || new Set(value.sources.map(source => source.source_id)).size !== value.sources.length) fail()
  let totalSpans = 0
  for (const source of value.sources) {
    if (!exact(source, ['source_id', 'revision', 'author_id', 'sent_at', 'timezone', 'kind', 'spans']) || !string(source.source_id) || !context.source_access.includes(source.source_id) || !Number.isSafeInteger(source.revision) || source.revision < 1 || !string(source.author_id) || !string(source.kind) || source.sent_at !== null && (!string(source.sent_at, 100) || !Number.isFinite(Date.parse(source.sent_at))) || source.timezone !== null && !string(source.timezone, 100) || !Array.isArray(source.spans) || !source.spans.length || source.spans.length > 10000) fail()
    for (const span of source.spans) if (!exact(span, ['span_id', 'text']) || !string(span.span_id, 300) || typeof span.text !== 'string' || span.text.length > 200000) fail()
    if (new Set(source.spans.map(span => span.span_id)).size !== source.spans.length) fail()
    totalSpans += source.spans.length
  }
  if (totalSpans > 10000) fail()
}
function detectionMessages(request, change) {
  assertDetectionRequest(request)
  if (change !== undefined && (!exact(change, ['action', 'target_task_id', 'expected_revision', 'title', 'assignee_id', 'basis', 'obligation_state', 'change_fields', 'due', 'recurrence', 'applicability_ref', 'rule_ref', 'evidence']) || JSON.stringify(change).length > 50000)) throw new Error('検証対象が不正です')
  const checks = change === undefined ? [] : ['action', 'assignee', 'active', ...(Array.isArray(change.change_fields) && change.change_fields.includes('due') && ['date', 'datetime'].includes(change.due?.kind) ? ['due'] : []), ...(change.action === 'define_recurrence' ? ['recurrence'] : []), ...(['update', 'cancel', 'report_completion'].includes(change.action) ? ['target'] : [])]
  return [
    { role: 'system', content: change === undefined ? `${detectorPrompt}\n行為と本人担当を支持する evidence を必ず含めます。実施予定の「明日やります」は締め切りではありません。「までに」「期限」「締め切り」「by」等が原文にある場合だけ due を確定し、予定日を期限に変換しないでください。\nJSON Schema:\n${schema}` : `${verifierPrompt}\n今回の checks は ${JSON.stringify(checks)} の項目を一つずつ検査して返し、これ以外の項目を含めません。create では既存対象がないため target は検査しません。source_refs は allowed_source_refs にある識別子だけを返します。実施日と本当の期限を区別し、期限という根拠がない due は unknown にします。全体 verdict が entailed なら必要な checks も全て entailed である必要があります。` },
    { role: 'user', content: JSON.stringify(change === undefined ? request : { request, change, allowed_source_refs: request.sources.flatMap(source => source.spans.map(span => `${source.source_id}:${span.span_id}`)) }) }
  ]
}
module.exports = { assertDetectionRequest, detectionMessages }
