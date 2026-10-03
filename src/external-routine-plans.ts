import Dexie from 'dexie'
import { db } from './db'
import { contentDigest } from './canonical'
import { uid } from './domain'
import { assertExternalToolAuthority, type ExternalToolContext } from './external-tools'
import { isTimeZone } from './zoned-time'
import { assertSchema } from '../electron/plugin-schema.mjs'
import catalog from '../electron/contracts/plugin-tools.resolved.json'
import type { ExternalChangeRequest } from './external-command-gate'

export type ExternalRoutinePlan = {
  version: 1; id: string; request: Record<string, unknown>; context: ExternalToolContext
  routineId: string | null; scope: string; createdAt: string; expiresAt: string
  fieldDiffs: { path: string; before: unknown; after: unknown }[]
}
function fail(code: string): never { throw Object.assign(Error(code), { code }) }
const routinePlanKey = (client: string, id: string) => `externalroutineplan:${client}:${id}`
const routinePrepareKey = (client: string, key: string) => `externalroutineprepare:${client}:${key}`

/** Bounded like task plans: capacity errors never evict old keys or remint commands. */
async function assertRoutinePlanCapacity(client: string, isNewPlan: boolean) {
  const rows = await db.commands.toCollection().filter((row) => /^externalroutine(plan|prepare):/.test(row.key)).toArray()
  const own = rows.filter((row) => row.key.split(':')[1] === client)
  if (rows.length >= (isNewPlan ? 14999 : 15000) || own.length >= (isNewPlan ? 2999 : 3000)) fail('TOO_MANY_PROPOSALS')
  if (isNewPlan) {
    const plans = rows.filter((row) => row.key.startsWith(`externalroutineplan:${client}:`))
    if (plans.length >= 1000) fail('TOO_MANY_PROPOSALS')
    let active = 0
    for (const row of plans) {
      let plan: ExternalRoutinePlan
      try { plan = JSON.parse(row.resultId) } catch { fail('PLAN_INVALID') }
      if (Date.parse(plan.expiresAt) > Date.now()) active++
    }
    if (active >= 100) fail('TOO_MANY_PROPOSALS')
  }
}

type RoutineDefinition = {
  title?: unknown; trigger_type?: unknown
  trigger_config?: { dtstart_date?: unknown; local_time?: unknown; rrule?: unknown; rdates?: unknown; exdates?: unknown }
  timezone?: unknown; basis?: unknown; evidence_refs?: unknown
  steps?: { step_key?: unknown; task_blueprint?: { title?: unknown } }[]
}

/** Shared definition bounds with the pure preview: titles, trigger, timezone and evidence sizes. */
export function assertRoutineDefinition(value: unknown): asserts value is RoutineDefinition & { title: string } {
  const definition = value as RoutineDefinition
  const title = typeof definition?.title === 'string' ? definition.title : ''
  if (!title.trim() || title.length > 300) fail('INVALID_ROUTINE_DEFINITION')
  const steps = Array.isArray(definition?.steps) ? definition.steps : []
  if (!steps.length || steps.length > 20) fail('INVALID_ROUTINE_DEFINITION')
  if (steps.some((step) => typeof step?.task_blueprint?.title !== 'string' || !step.task_blueprint.title.trim() || step.task_blueprint.title.length > 300)) fail('INVALID_ROUTINE_DEFINITION')
  const config = definition?.trigger_config
  const dtstart = typeof config?.dtstart_date === 'string' ? config.dtstart_date : ''
  const rruleText = typeof config?.rrule === 'string' ? config.rrule : ''
  const rdates = Array.isArray(config?.rdates) ? config.rdates : []
  const exdates = Array.isArray(config?.exdates) ? config.exdates : []
  const dateOk = (item: unknown): item is string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item) && new Date(`${item}T00:00:00Z`).toISOString().slice(0, 10) === item
  if (!dateOk(dtstart) || !rruleText.trim() || rruleText.length > 500 || rdates.length > 100 || exdates.length > 100 || ![...rdates, ...exdates].every(dateOk)) fail('INVALID_ROUTINE_DEFINITION')
  if (typeof definition?.timezone !== 'string' || !isTimeZone(definition.timezone)) fail('INVALID_TIMEZONE')
  const localTime = config?.local_time === null || config?.local_time === undefined ? null : String(config.local_time)
  if (localTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) fail('INVALID_LOCAL_TIME')
  if (!['user_instruction', 'documented_obligation', 'approved_rule'].includes(String(definition?.basis))) fail('INVALID_ROUTINE_DEFINITION')
  if (!Array.isArray(definition?.evidence_refs) || definition.evidence_refs.length > 100 || definition.evidence_refs.some((ref) => typeof ref !== 'string' || !ref.trim() || ref.length > 600)) fail('INVALID_ROUTINE_DEFINITION')
}

function summarize(title: string, rruleText: string, steps: { task_blueprint?: { title?: unknown } }[]) {
  return {
    title: title.slice(0, 300),
    rrule: rruleText.slice(0, 200),
    steps: steps.length,
    step_titles: steps.map((step) => String(step?.task_blueprint?.title ?? '').slice(0, 100)),
  }
}

/** Prepare-only: validates and records a descriptive proposal. Nothing is saved to routines;
 * application stays owner-driven through the existing routine screens. No inference is started. */
export async function dispatchExternalRoutineTool(name: string, args: Record<string, unknown>, rawContext: ExternalToolContext) {
  if (name !== 'coach_prepare_routine_change') fail('TOOL_NOT_FOUND')
  const tool = catalog.tools.find((item) => item.name === name)
  if (!tool) fail('TOOL_NOT_FOUND')
  assertSchema(tool.inputSchema, args)
  const context: ExternalToolContext = structuredClone(rawContext)
  const client = context.registration.client.id
  return db.transaction('rw', db.settings, db.datasetState, db.calendarRules, db.commands, async () => {
    const { registration } = await assertExternalToolAuthority(context)
    if (!registration.client.grant.keys.includes('routines:prepare')) fail('INSUFFICIENT_SCOPE')
    const request = structuredClone(args) as { request_key: string; basis: ExternalChangeRequest['basis']; routine_id: string | null; expected_revision: number | null; scope: string; definition: unknown }
    // Only caller-neutral external requests are issuable here. Instruction/detection/rule refs have no
    // routine-scoped issuance path yet; presenting one fails closed instead of minting authority.
    if (request.basis.kind !== 'external_request') fail('UNVERIFIED_REFERENCE')
    if (!['new', 'this_occurrence', 'future_uncompleted', 'all_uncompleted'].includes(request.scope)) fail('TOOL_SCHEMA')
    if (request.scope === 'new') {
      if (request.routine_id !== null || request.expected_revision !== null) fail('INVALID_ROUTINE_TARGET')
    } else {
      if (typeof request.routine_id !== 'string' || !registration.rule_ids?.includes(request.routine_id)) fail('NOT_FOUND')
      const state = await db.calendarRules.get('main')
      const rule = state?.rules.find((item) => item.id === request.routine_id)
      if (!state || state.ownerId !== context.ownerId || state.datasetId !== context.datasetId || !rule) fail('NOT_FOUND')
      if (rule.revision !== request.expected_revision) fail('REVISION_CONFLICT')
    }
    assertRoutineDefinition(request.definition)
    const definition = request.definition as Required<RoutineDefinition> & { title: string }
    const hash = await Dexie.waitFor(contentDigest(request))
    const key = routinePrepareKey(client, request.request_key)
    const prior = await db.commands.get(key)
    if (prior) {
      if (prior.hash !== hash) fail('IDEMPOTENCY_MISMATCH')
      const row = await db.commands.get(routinePlanKey(client, prior.resultId))
      if (!row) fail('PLAN_NOT_FOUND')
      const plan = JSON.parse(row.resultId) as ExternalRoutinePlan
      if (row.hash !== await Dexie.waitFor(contentDigest(plan)) || Date.parse(plan.expiresAt) <= Date.now()) fail('PLAN_EXPIRED')
      return publicRoutinePlan(plan, row.hash)
    }
    await assertRoutinePlanCapacity(client, true)
    const createdAt = new Date().toISOString()
    const expiresAt = new Date(Math.min(Date.now() + 300000, Date.parse(context.registration.client.grant.expires_at))).toISOString()
    let before: unknown = null
    if (request.scope !== 'new') {
      const state = await db.calendarRules.get('main')
      const rule = state?.rules.find((item) => item.id === request.routine_id)
      if (rule) before = summarize(rule.title, '', [])
    }
    const config = definition.trigger_config as { rrule: string }
    const plan: ExternalRoutinePlan = {
      version: 1, id: uid(), request, context, routineId: request.routine_id, scope: request.scope,
      createdAt, expiresAt,
      fieldDiffs: [{ path: 'definition', before, after: summarize(definition.title, String(config.rrule), definition.steps as { task_blueprint?: { title?: unknown } }[]) }],
    }
    const digest = await Dexie.waitFor(contentDigest(plan))
    // Stored plans describe a request; they never recreate approval or an apply capability.
    await db.commands.add({ key: routinePlanKey(client, plan.id), hash: digest, resultId: JSON.stringify(plan), at: createdAt })
    await db.commands.add({ key, hash, resultId: plan.id, at: createdAt })
    return publicRoutinePlan(plan, digest)
  })
}

function publicRoutinePlan(plan: ExternalRoutinePlan, digest: string) {
  return {
    change_set_id: plan.id, digest, state: 'awaiting_approval', approval_url: null,
    reasons: ['繰り返しの変更案を記録しました。保存はしません。繰り返し画面で内容を確認し、本人が設定してください。'],
    field_diffs: plan.fieldDiffs, command_id: plan.id,
  }
}
