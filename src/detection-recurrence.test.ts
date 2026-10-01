import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput } from './commands'
import { defaultChangePolicy } from './change-set'
import { calendarFixture } from './calendar-test-fixtures'
import { applyCalendarProposalFromUI, clearCalendarRulesAuthority, prepareCalendarGeneration } from './calendar-rules-save'
import { emptyScore } from './domain'
import { defaultSourcePermissions, importLocalSource, setSourcePermissions, sourceSpans } from './source-library'
import { requiredDetectionClaims, type DetectionChange, type DetectionOutput } from './detection-contract'
import { applyDetectionRecurrenceFromUI, clearDetectionAuthority, detectObligationsForSource, detectionRecurrenceMessage, discardDetectionRun, prepareDetectionFromUI, prepareDetectionRecurrenceFromUI, savedDetectionRuns, type DetectionRun, type PreparedDetection } from './detection-run'
import type { RoutineAssistInput } from './routine-assist'

const model = 'synthetic/model'
function humanClick() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
beforeEach(async () => {
  vi.restoreAllMocks(); clearDetectionAuthority(); clearCalendarRulesAuthority(); await db.delete(); await db.open(); await ensureSettings()
  await db.settings.update('main', { aiEnabled: true, aiModel: model, changePolicy: defaultChangePolicy() })
  const settings = (await db.settings.get('main'))!, state = calendarFixture()
  state.ownerId = settings.profileId; state.datasetId = settings.datasetId; state.bindings.forEach(binding => { binding.personId = settings.profileId })
  state.activities = []; state.bindings.forEach(binding => { binding.activityIds = [] })
  await db.calendarRules.put(state)
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); clearDetectionAuthority(); clearCalendarRulesAuthority() })
async function source(text = 'Karinさん、毎週月曜日に週報を提出してください。', title = '周期の合成資料') {
  return importLocalSource({ title, provider: 'local', externalId: null, conversation: null, author: '依頼者', sourceUrl: null, date: '2026-10-01', fromDate: '2026-10-01', toDate: '2026-10-01', timezone: 'Asia/Tokyo', text, permissions: { ...defaultSourcePermissions(), aiEgress: true }, allowedModels: [model], retentionUntil: null })
}
function output(prepared: PreparedDetection): DetectionOutput {
  const source = prepared.request.sources[0], span = source.spans[0]
  const change: DetectionChange = { action: 'define_recurrence', target_task_id: null, expected_revision: null, title: '週報を提出', assignee_id: prepared.ownerId, basis: 'explicit_request', obligation_state: 'requested', change_fields: ['title', 'assignee', 'recurrence'], due: { kind: 'none', value: null, timezone: null, raw: null }, recurrence: { expression: 'model expression is not used', timezone: 'Asia/Tokyo', calendar_ref: 'do-not-trust-model-calendar', raw: span.text }, applicability_ref: null, rule_ref: null, evidence: [{ source_id: source.source_id, revision: source.revision, span_id: span.span_id, quote: span.text, supports: ['action', 'assignee', 'active', 'recurrence'] }] }
  return { schema_version: '1', changes: [change], review_items: [], ignored: [] }
}
async function run(sourceId?: string, mutate?: (raw: DetectionOutput) => void, rejectVerification = false): Promise<DetectionRun> {
  const id = sourceId ?? await source(), row = (await db.contextSources.get(id))!
  const prepared = await prepareDetectionFromUI(id, row.revision, model, { confirmedAliases: ['Karinさん'], authorIsOwner: false, existingTaskIds: [] }, humanClick())
  const raw = output(prepared); mutate?.(raw)
  return detectObligationsForSource(prepared, { detect: async () => JSON.stringify(raw), verify: async ({ change }) => JSON.stringify({ verdict: rejectVerification ? 'unknown' : 'entailed', checks: requiredDetectionClaims(change).map(field => ({ field, verdict: rejectVerification ? 'unknown' : 'entailed', source_refs: [`${prepared.request.sources[0].source_id}:${prepared.request.sources[0].spans[0].span_id}`], reason: '合成の原文と担当と周期を照合' })) }) })
}
function input(run: DetectionRun): RoutineAssistInput {
  return { message: detectionRecurrenceMessage(run, run.candidates[0].id), referenceDate: '2026-10-01', targetRuleId: null, expectedRuleRevision: null, selection: { contextId: 'company', bindingId: 'self', calendarId: 'business', activityId: null, timezone: 'Asia/Tokyo', validFrom: '2026-10-01', validTo: '2026-10-31', time: '09:00', stepKind: 'task', durationMinutes: null, scheduledOffsetDays: 0, dueOffsetDays: null }, scope: { kind: 'all_uncompleted' } }
}
async function prepare(value: DetectionRun, changes?: Partial<RoutineAssistInput['selection']>) {
  const chosen = input(value); Object.assign(chosen.selection, changes)
  return prepareDetectionRecurrenceFromUI(value, value.candidates[0].id, chosen, humanClick())
}
async function storage() { return { calendar: await db.calendarRules.toArray(), tasks: await db.tasks.toArray(), assessments: await db.assessments.toArray(), completions: await db.completions.toArray(), ledger: await db.ledger.toArray(), commands: await db.commands.toArray(), audits: await db.audits.toArray() } }

describe('検証済み周期候補の本人採用と共通カレンダー境界', () => {
  it('native確認までは保存せず、原文の周期と本人指定暦だけを設定し、発生回は別確認する', async () => {
    const value = await run(), chosen = input(value), before = await storage()
    await expect(prepareDetectionRecurrenceFromUI(value, value.candidates[0].id, chosen, new Event('click'))).rejects.toThrow('本人')
    const prepared = await prepare(value)
    expect(await storage()).toEqual(before)
    await expect(applyDetectionRecurrenceFromUI(value, value.candidates[0].id, prepared, prepared.digest, new Event('click'))).rejects.toThrow('本人')
    const ruleId = await applyDetectionRecurrenceFromUI(value, value.candidates[0].id, prepared, prepared.digest, humanClick()), saved = await storage()
    expect(saved.calendar[0].rules).toHaveLength(1)
    expect(saved.calendar[0].rules[0]).toMatchObject({ id: ruleId, contextId: 'company', bindingId: 'self', calendarId: 'business', originBasis: 'user_approved_rule', title: '週報を提出', trigger: { kind: 'weekly', weekdays: [1], time: '09:00' }, steps: [{ title: '週報を提出', dueOffsetDays: null, score: { mode: 'unset', manualPoints: null, minutes: null } }] })
    expect(saved.tasks).toHaveLength(0); expect(saved.assessments).toHaveLength(0); expect(saved.completions).toHaveLength(0); expect(saved.ledger).toHaveLength(0)
    const generation = await prepareCalendarGeneration('2026-10-01', '2026-10-15')
    expect(generation.plan.creates).toHaveLength(2); expect(await db.tasks.count()).toBe(0)
    await applyCalendarProposalFromUI(generation, humanClick())
    expect((await db.tasks.toArray()).every(task => task.dueDate === null && task.score.mode === 'unset' && task.effectivePoints === null)).toBe(true)
    expect(await db.ledger.count()).toBe(0)
  })
  it('同じ確認案と新しい検出runの同じ業務キーを一度だけ採用する', async () => {
    const value = await run(), prepared = await prepare(value)
    const id = await applyDetectionRecurrenceFromUI(value, value.candidates[0].id, prepared, prepared.digest, humanClick()), first = await storage()
    expect(await applyDetectionRecurrenceFromUI(value, value.candidates[0].id, prepared, prepared.digest, humanClick())).toBe(id)
    expect(await storage()).toEqual(first)
    const fresh = await run(value.source.sourceId), repeated = await prepare(fresh)
    expect(await applyDetectionRecurrenceFromUI(fresh, fresh.candidates[0].id, repeated, repeated.digest, humanClick())).toBe(id)
    expect((await db.calendarRules.get('main'))!.rules).toHaveLength(1)
    expect((await db.calendarRules.get('main'))!.revision).toBe(first.calendar[0].revision)
  })
  it('同じ候補の時刻を変えて別系列へ再送しても候補の受領を一回に保つ', async () => {
    const value = await run(), first = await prepare(value), changed = await prepare(value, { time: '10:00' })
    await applyDetectionRecurrenceFromUI(value, value.candidates[0].id, first, first.digest, humanClick())
    await expect(applyDetectionRecurrenceFromUI(value, value.candidates[0].id, changed, changed.digest, humanClick())).rejects.toThrow()
    expect((await db.calendarRules.get('main'))!.rules).toHaveLength(1)
  })
  it('別runで同じ根拠の時刻・期間を変えても二重系列を作らず通常編集へ案内する', async () => {
    const value = await run(), first = await prepare(value)
    await applyDetectionRecurrenceFromUI(value, value.candidates[0].id, first, first.digest, humanClick())
    for (const change of [{ time: '10:00' }, { validFrom: '2026-10-02', validTo: '2026-10-15' }]) {
      const fresh = await run(value.source.sourceId), changed = await prepare(fresh, change)
      await expect(applyDetectionRecurrenceFromUI(fresh, fresh.candidates[0].id, changed, changed.digest, humanClick())).rejects.toThrow()
    }
    expect((await db.calendarRules.get('main'))!.rules).toHaveLength(1)
  })
  it('無関係な本文改訂と同じ証拠の別名再取込みでも系列の業務identityを維持する', async () => {
    const value = await run(), first = await prepare(value)
    const ruleId = await applyDetectionRecurrenceFromUI(value, value.candidates[0].id, first, first.digest, humanClick())
    const original = (await db.contextSnapshots.get(`${value.source.sourceId}:1`))!, text = `${original.text}\n別の連絡はタスク候補ではありません。`
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    await db.contextSnapshots.put({ ...original, id: `${value.source.sourceId}:2`, revision: 2, originalText: text, text, sha256, spans: sourceSpans(`${value.source.sourceId}:2`, text) })
    await db.contextSources.update(value.source.sourceId, { revision: 2, latestRevision: 2 })
    const revised = await run(value.source.sourceId), repeated = await prepare(revised)
    expect(await applyDetectionRecurrenceFromUI(revised, revised.candidates[0].id, repeated, repeated.digest, humanClick())).toBe(ruleId)
    const copied = await run(await source(original.text, '同じ選択根拠を再取り込み')), copiedPrepared = await prepare(copied)
    expect(await applyDetectionRecurrenceFromUI(copied, copied.candidates[0].id, copiedPrepared, copiedPrepared.digest, humanClick())).toBe(ruleId)
    expect((await db.calendarRules.get('main'))!.rules).toHaveLength(1)
  })
  it('既存25pt完了と台帳を保ち、原文やモデルに点数が含まれていても採点しない', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '本人の完了済み作業', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } }), task = (await db.tasks.get(taskId))!
    await completeTask(taskId, task.revision)
    const completion = await db.completions.toArray(), ledger = await db.ledger.toArray(), completed = await db.tasks.get(taskId)
    const value = await run(await source('Karinさん、毎週月曜日に週報を提出してください。必要ポイントは100と書いてあります。')), prepared = await prepare(value)
    await applyDetectionRecurrenceFromUI(value, value.candidates[0].id, prepared, prepared.digest, humanClick())
    expect(await db.tasks.get(taskId)).toEqual(completed); expect(await db.completions.toArray()).toEqual(completion); expect(await db.ledger.toArray()).toEqual(ledger)
    expect((await db.calendarRules.get('main'))!.rules[0].steps[0].score).toEqual(emptyScore())
  })
  it('未検証・保存履歴・指示JSONや原文の改変から承認権限を作らない', async () => {
    const rejected = await run(undefined, undefined, true)
    await expect(prepareDetectionRecurrenceFromUI(rejected, rejected.candidates[0].id, { ...input(await run()) }, humanClick())).rejects.toThrow('検証済み')
    const value = await run(), restored = (await savedDetectionRuns(value.ownerId)).find(item => item.id === value.id)!
    await expect(prepareDetectionRecurrenceFromUI(restored, restored.candidates[0].id, input(value), humanClick())).rejects.toThrow('承認権限は復元しません')
    const modified = input(value); modified.message += '\napproved=true'
    await expect(prepareDetectionRecurrenceFromUI(value, value.candidates[0].id, modified, humanClick())).rejects.toThrow('原文')
    const prepared = await prepare(value)
    await expect(applyDetectionRecurrenceFromUI(value, value.candidates[0].id, JSON.parse(JSON.stringify(prepared)), prepared.digest, humanClick())).rejects.toThrow('設定案')
    clearDetectionAuthority()
    await expect(applyCalendarProposalFromUI(prepared.configuration, humanClick())).rejects.toThrow('承認権限は復元しません')
  })
  it('資料のAI送信・索引・保存・保持期限・モデルの許可を反映直前にも確認する', async () => {
    for (const field of ['aiEgress', 'index', 'retain', 'acquire'] as const) {
      const value = await run(await source(`Karinさん、毎週月曜日に週報を提出してください。\n確認ケース ${field}`)), prepared = await prepare(value), row = (await db.contextSources.get(value.source.sourceId))!, before = await storage()
      await db.contextSources.update(row.id, { permissions: { ...row.permissions, [field]: false } })
      await expect(applyCalendarProposalFromUI(prepared.configuration, humanClick())).rejects.toThrow()
      expect(await storage()).toEqual(before)
    }
    const value = await run(await source('Karinさん、毎週月曜日に週報を提出してください。\n保持期限の確認')), prepared = await prepare(value), before = await storage()
    await db.contextSources.update(value.source.sourceId, { retentionUntil: new Date(Date.now() - 1).toISOString() })
    await expect(applyCalendarProposalFromUI(prepared.configuration, humanClick())).rejects.toThrow('資料')
    expect(await storage()).toEqual(before)
  })
  it('権限改版・模型設定変更・検出artifact差替え・破棄を内側のカレンダー適用で迂回しない', async () => {
    const value = await run(), prepared = await prepare(value), row = (await db.contextSources.get(value.source.sourceId))!
    await setSourcePermissions(row.id, row.revision, { ...row.permissions, aiEgress: false }, row.allowedModels, null)
    await expect(applyCalendarProposalFromUI(prepared.configuration, humanClick())).rejects.toThrow()
    const next = await run(await source('Karinさん、毎週月曜日に週報を提出してください。\n模型設定の確認')), nextPrepared = await prepare(next)
    await db.settings.update('main', { aiModel: 'another/model' })
    await expect(applyCalendarProposalFromUI(nextPrepared.configuration, humanClick())).rejects.toThrow('変わりました')
    await db.settings.update('main', { aiModel: model })
    await db.sourceArtifacts.update(`detection:${next.id}`, { payload: '{}' })
    await expect(applyCalendarProposalFromUI(nextPrepared.configuration, humanClick())).rejects.toThrow('破棄または変更')
    const final = await run(await source('Karinさん、毎週月曜日に週報を提出してください。\n候補破棄の確認')), finalPrepared = await prepare(final)
    await discardDetectionRun(final)
    await expect(applyCalendarProposalFromUI(finalPrepared.configuration, humanClick())).rejects.toThrow('承認権限は復元しません')
    expect((await db.calendarRules.get('main'))!.rules).toHaveLength(0)
  })
  it('保存直前の本文・span・許可モデルの差替えを拒否し、実際のSHAと引用を再照合する', async () => {
    for (const change of ['body', 'span', 'model'] as const) {
      const value = await run(await source(`Karinさん、毎週月曜日に週報を提出してください。\n差替え確認 ${change}`)), prepared = await prepare(value), before = await storage()
      const snapshot = (await db.contextSnapshots.get(`${value.source.sourceId}:1`))!
      if (change === 'body') await db.contextSnapshots.update(snapshot.id, { text: `${snapshot.text}\n差替え` })
      if (change === 'span') await db.contextSnapshots.update(snapshot.id, { spans: snapshot.spans.map(span => ({ ...span, text: '毎週金曜日に異なる作業' })) })
      if (change === 'model') await db.contextSources.update(value.source.sourceId, { allowedModels: [] })
      await expect(applyCalendarProposalFromUI(prepared.configuration, humanClick())).rejects.toThrow('ハッシュ')
      expect(await storage()).toEqual(before)
    }
  })
  it('検証済みという自己申告だけでは原文にない周期を作れない', async () => {
    const value = await run(undefined, raw => { raw.changes[0].recurrence!.raw = '毎週金曜日' })
    await expect(prepareDetectionRecurrenceFromUI(value, value.candidates[0].id, { ...input(await run()) }, humanClick())).rejects.toThrow('証拠引用')
    expect((await db.calendarRules.get('main'))!.rules).toHaveLength(0)
  })
  it('周期引用を短くして代替曜日・明示時刻・開始日を取り除いても採用しない', async () => {
    for (const text of ['Karinさん、毎週月曜か水曜に提出してください。', 'Karinさん、毎週月曜9:0に提出してください。', 'Karinさん、毎週月曜10:00に提出してください。', '開始は2026年10月5日。Karinさん、毎週月曜に提出してください。', '明日からKarinさん、毎週月曜に提出してください。']) {
      const value = await run(await source(text), raw => { raw.changes[0].recurrence!.raw = '毎週月曜' }), chosen = input(value)
      await expect(prepareDetectionRecurrenceFromUI(value, value.candidates[0].id, chosen, humanClick())).rejects.toThrow()
    }
    expect((await db.calendarRules.get('main'))!.rules).toHaveLength(0)
  })
  it('本人の選択を原文の明示期間内へ限定し、後から始める限定期間は承認できる', async () => {
    const value = await run(await source('2026年10月5日から2026年10月20日まで、Karinさん、毎週月曜日に週報を提出してください。'))
    await expect(prepare(value)).rejects.toThrow('有効期間')
    const prepared = await prepare(value, { validFrom: '2026-10-10', validTo: '2026-10-20' })
    await applyDetectionRecurrenceFromUI(value, value.candidates[0].id, prepared, prepared.digest, humanClick())
    expect((await db.calendarRules.get('main'))!.rules[0]).toMatchObject({ validFrom: '2026-10-10', validTo: '2026-10-20' })
  })
  it('17:00までという時刻付き本当の期限を予定時刻や日付へ落とさない', async () => {
    const value = await run(await source('Karinさん、毎週月曜日17:00までに週報を提出してください。'), raw => {
      raw.changes[0].due = { kind: 'datetime', value: '2026-10-05T17:00:00+09:00', timezone: 'Asia/Tokyo', raw: raw.changes[0].evidence[0].quote }
      raw.changes[0].change_fields.push('due'); raw.changes[0].evidence[0].supports.push('due')
    })
    await expect(prepareDetectionRecurrenceFromUI(value, value.candidates[0].id, { ...input(await run()) }, humanClick())).rejects.toThrow('時刻付き期限')
    expect((await db.calendarRules.get('main'))!.rules).toHaveLength(0); expect(await db.tasks.count()).toBe(0)
  })
  it('本人の暦・参加条件・期間が未選択なら最初の暦や国の平日を採用しない', async () => {
    const value = await run(), chosen = input(value)
    chosen.selection.calendarId = ''
    await expect(prepareDetectionRecurrenceFromUI(value, value.candidates[0].id, chosen, humanClick())).rejects.toThrow('明示選択')
    chosen.selection.calendarId = 'business'; chosen.selection.validTo = '2027-01-01'
    await expect(prepareDetectionRecurrenceFromUI(value, value.candidates[0].id, chosen, humanClick())).rejects.toThrow('範囲外')
    expect((await db.calendarRules.get('main'))!.rules).toHaveLength(0)
  })
  it('設定・候補受領・業務受領・監査を一つのtxにし、失敗時は部分保存しない', async () => {
    const value = await run(), prepared = await prepare(value), before = await storage()
    const failing = vi.spyOn(db.audits, 'add').mockRejectedValueOnce(new Error('disk-full'))
    await expect(applyDetectionRecurrenceFromUI(value, value.candidates[0].id, prepared, prepared.digest, humanClick())).rejects.toThrow('disk-full')
    failing.mockRestore(); expect(await storage()).toEqual(before)
    await applyDetectionRecurrenceFromUI(value, value.candidates[0].id, prepared, prepared.digest, humanClick())
    expect((await db.calendarRules.get('main'))!.rules).toHaveLength(1)
  })
})
