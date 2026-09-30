import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { canonicalJSON } from './canonical'
import { changePolicyFor } from './change-set'
import { completeTask } from './commands'
import { captureSnapshot, restoreBackup } from './backup'
import { validateSnapshot } from './backup-validation'
import { calendarFixture, monthlyRule } from './calendar-test-fixtures'
import { applyCalendarProposalFromUI, clearCalendarRulesAuthority, loadCalendarRulesState, prepareCalendarConfiguration, prepareCalendarGeneration } from './calendar-rules-save'
import { prepareCalendarICSImport, verifyCalendarOriginalDigests, type ICSImportTarget } from './calendar-import'
import { purgeExpiredCalendarOriginals } from './calendar-import-retention'
import { redactExpiredICSRecords } from './calendar-import-redaction'

const from = '2026-10-01', to = '2026-10-31'
const raw = (sequence = 1, date = '20261002', title = '担当者との面談') => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//JP', 'BEGIN:VEVENT', 'UID:sensitive-person@example.test', `DTSTAMP:2026100${sequence}T000000Z`, `SEQUENCE:${sequence}`, `DTSTART:${date}T000000Z`, `DTEND:${date}T010000Z`, `SUMMARY:${title}`, 'DESCRIPTION:住所と個人情報', 'LOCATION:個人の自宅', 'ATTENDEE;CN=特定の人物:mailto:private@example.test', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
const humanClick = () => { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
let target: ICSImportTarget
beforeEach(async () => {
  clearCalendarRulesAuthority(); await db.delete(); await db.open(); await ensureSettings()
  const settings = (await db.settings.get('main'))!, state = calendarFixture(); state.ownerId = settings.profileId; state.datasetId = settings.datasetId; state.bindings[0].personId = settings.profileId; state.activities = []; state.sources = []; state.bindings[0].activityIds = []
  target = { contextId: 'company', bindingId: 'self', calendarId: 'business', feedId: 'fixed-feed', title: '選択した本人予定', retentionUntil: '2027-01-01T00:00:00.000Z' }
  const { contexts, bindings, calendars, activities, sources, facts, rules } = state
  await applyCalendarProposalFromUI(await prepareCalendarConfiguration({ contexts, bindings, calendars, activities, sources, facts, rules }, 1, from, to), humanClick())
})
afterEach(() => { vi.useRealTimers(); clearCalendarRulesAuthority() })
async function prepare(input = raw()) { return prepareCalendarICSImport(target, input, { fromDate: from, toDate: to }) }
async function save(input = raw()) { const prepared = await prepare(input); if (prepared.proposal) await applyCalendarProposalFromUI(prepared.proposal, humanClick()); return prepared }
async function generate() { const proposal = await prepareCalendarGeneration(from, to); await applyCalendarProposalFromUI(proposal, humanClick()); return proposal }

describe('ICS資料と本人確認の保存', () => {
  it('file preview/設定保存/発生回生成を分離し、native approval と再送を検証', async () => {
    const prepared = await prepare(); expect(await db.calendarEvents.count()).toBe(0); expect((await loadCalendarRulesState()).sources).toHaveLength(0)
    await expect(applyCalendarProposalFromUI(prepared.proposal!, new Event('click'))).rejects.toThrow('本人確認')
    const modified = structuredClone(prepared.proposal!); modified.next.sources[0].title = '無断変更'; await expect(applyCalendarProposalFromUI(modified, humanClick())).rejects.toThrow('登録済み')
    await applyCalendarProposalFromUI(prepared.proposal!, humanClick()); expect(await db.calendarEvents.count()).toBe(0); expect(await db.tasks.count()).toBe(0)
    const generation = await generate(), events = await db.calendarEvents.toArray(); expect(events).toHaveLength(1); expect(events[0].title).toBe('担当者との面談'); expect(await db.tasks.count()).toBe(0); expect(await db.ledger.count()).toBe(0)
    await applyCalendarProposalFromUI(generation, humanClick()); expect(await db.calendarEvents.count()).toBe(1); expect((await prepare()).proposal).toBeNull()
  })
  it('actual update はイベントID保持、本人編集済みなら全適用を拒否し台帳不変', async () => {
    await save(); await generate(); const first = (await db.calendarEvents.toArray())[0], ledger = await db.ledger.toArray()
    await save(raw(2, '20261003')); const moved = await generate(); expect(moved.plan.updates).toHaveLength(1); expect((await db.calendarEvents.toArray())[0].id).toBe(first.id)
    await db.calendarEvents.update(first.id, { title: '本人が直接編集' }); await save(raw(3, '20261004')); const proposal = await prepareCalendarGeneration(from, to); expect(proposal.plan.conflicts).toHaveLength(1)
    await expect(applyCalendarProposalFromUI(proposal, humanClick())).rejects.toThrow('本人編集'); expect((await db.calendarEvents.get(first.id))!.title).toBe('本人が直接編集'); expect(await db.ledger.toArray()).toEqual(ledger)
  })
  it('source permission epoch/owner と原本保持期限を保存直前に確認する', async () => {
    const prepared = await prepare(), settings = (await db.settings.get('main'))!, policy = changePolicyFor(settings); await db.settings.put({ ...settings, changePolicy: { ...policy, sourcePermissionRevision: policy.sourcePermissionRevision + 1 } })
    await expect(applyCalendarProposalFromUI(prepared.proposal!, humanClick())).rejects.toThrow('本人・データセット'); expect((await loadCalendarRulesState()).sources).toHaveLength(0)
    const fresh = await prepare(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2027-01-01T00:00:01.000Z'); await expect(applyCalendarProposalFromUI(fresh.proposal!, humanClick())).rejects.toThrow('期限'); expect(await db.calendarEvents.count()).toBe(0)
  })
  it('原文はcalendarRulesだけに保存しbefore/after auditとreceiptには複製しない', async () => {
    await save(); await save(raw(2, '20261003')); const audits = await db.audits.toArray(), commands = await db.commands.toArray(), state = await loadCalendarRulesState()
    expect(JSON.stringify(audits)).not.toContain('private@example.test'); expect(JSON.stringify(audits)).not.toContain('sensitive-person@example.test'); expect(JSON.stringify(audits)).not.toContain('住所と個人情報'); expect(commands.every(item => /^[a-f0-9]{64}$/.test(item.hash))).toBe(true)
    for (const audit of audits.filter(item => item.operation === 'calendar.configuration')) { const detail = JSON.parse(audit.detail); for (const config of [detail.before, detail.after]) for (const source of config.sources) for (const snapshot of source.ics?.snapshots ?? []) expect(snapshot.originalText).toBeNull() }
    expect(state.sources[0].ics!.snapshots[0].originalText).toBe(raw()); await verifyCalendarOriginalDigests([state])
    const tampered = structuredClone(state); tampered.sources[0].ics!.snapshots[0].originalText += ' '; await expect(verifyCalendarOriginalDigests([tampered])).rejects.toThrow('SHA-256')
  })
  it('明示event相対ruleの完了回はmove/cancel時も完了ポイント/台帳を保持', async () => {
    await save(); let state = await loadCalendarRulesState(); const activity = state.activities[0]; state.rules = [monthlyRule({ trigger: { kind: 'activity_relative', activityId: activity.id, edge: 'start', offsetDays: -1, offsetMinutes: 0 } })]
    const { contexts, bindings, calendars, activities, sources, facts, rules } = state; await applyCalendarProposalFromUI(await prepareCalendarConfiguration({ contexts, bindings, calendars, activities, sources, facts, rules }, state.revision, from, to), humanClick()); await generate()
    const task = (await db.tasks.toArray())[0]; await completeTask(task.id, task.revision); const ledger = await db.ledger.toArray(), completion = await db.completions.toArray(), taskBefore = await db.tasks.get(task.id)
    await save(raw(2, '20261003')); const preview = await generate(); expect(preview.plan.skippedCompleted).toBe(1); expect(await db.tasks.get(task.id)).toEqual(taskBefore); expect(await db.completions.toArray()).toEqual(completion); expect(await db.ledger.toArray()).toEqual(ledger)
  })
  it('保持期限は原本/表示名/legacy copiesを匿名化、日時/ID保持、承認失効、繰返purgeはnoOp', async () => {
    await save(); await generate(); const state = await loadCalendarRulesState(), events = await db.calendarEvents.toArray(), settings = (await db.settings.get('main'))!, beforePolicy = changePolicyFor(settings), pending = await prepareCalendarGeneration(from, to)
    await db.commands.add({ key: 'calendar:legacy', hash: canonicalJSON({ next: state }), resultId: 'legacy', at: '2026-10-01T00:00:00.000Z' }); await db.audits.add({ id: 'legacy', taskId: null, operation: 'calendar.configuration', at: '2026-10-01T00:00:00.000Z', detail: JSON.stringify({ before: state, after: state }) })
    await purgeExpiredCalendarOriginals('2027-01-01T00:00:01.000Z'); const after = await loadCalendarRulesState(), currentEvent = (await db.calendarEvents.toArray())[0]
    expect(after.sources[0].status).toBe('stale'); expect(after.sources[0].ics!.snapshots.every(item => item.originalText === null)).toBe(true); expect(currentEvent.title).toBe('保持期限に達した外部予定'); expect({ ...currentEvent, title: events[0].title }).toEqual(events[0]); expect(await db.ledger.count()).toBe(0)
    expect(JSON.stringify(await db.audits.toArray())).not.toContain('個人情報'); expect((await db.commands.get('calendar:legacy'))!.hash).toBe('redacted:calendar-receipt:legacy'); expect(changePolicyFor((await db.settings.get('main'))!).sourcePermissionRevision).toBe(beforePolicy.sourcePermissionRevision + 1)
    await expect(applyCalendarProposalFromUI(pending, humanClick())).rejects.toThrow('登録済み'); const revision = after.revision; await purgeExpiredCalendarOriginals('2027-01-01T00:00:02.000Z'); expect((await loadCalendarRulesState()).revision).toBe(revision)
    const plan = await prepareCalendarGeneration(from, to); expect(plan.plan.cancels).toHaveLength(0); expect(plan.plan.conflicts.length).toBeGreaterThan(0)
  })
  it('backup roundtripとrestore時の期限匿名化は旧空カレンダー互換を保つ', async () => {
    await save(); await generate(); const snapshot = await captureSnapshot(); validateSnapshot(snapshot); await restoreBackup(snapshot); expect(await db.calendarEvents.count()).toBe(1); await verifyCalendarOriginalDigests((await captureSnapshot()).calendarRules ?? [])
    const clean = redactExpiredICSRecords({ ...snapshot, calendarRules: snapshot.calendarRules ?? [], calendarEvents: snapshot.calendarEvents ?? [] }, '2027-01-01T00:00:01.000Z'); validateSnapshot(clean); expect(JSON.stringify(clean)).not.toContain('private@example.test'); expect(clean.calendarRules[0].sources[0].status).toBe('stale')
  })
  it('restore は1文字改ざん原本をDB変更前に拒否する', async () => {
    await save(); await generate(); const saved = await captureSnapshot(), changed = structuredClone(saved); changed.calendarRules![0].sources[0].ics!.snapshots[0].originalText += ' '
    const before = await captureSnapshot(); await expect(restoreBackup(changed)).rejects.toThrow('SHA-256'); const after = await captureSnapshot()
    expect({ ...after, exportedAt: before.exportedAt }).toEqual(before)
  })
  it('期限到達snapshotをrestoreすると原文/audit/receipt匿名化後だけwriteする', async () => {
    await save(); await generate(); const saved = await captureSnapshot(), source = saved.calendarRules![0].sources[0], expiry = new Date(Date.now() - 1000).toISOString(); source.ics!.retentionUntil = expiry
    saved.audits.push({ id: 'legacy-restore', taskId: null, operation: 'calendar.configuration', at: saved.exportedAt, detail: JSON.stringify({ before: saved.calendarRules![0], after: saved.calendarRules![0] }) }); saved.commands.push({ key: 'calendar:legacy-restore', hash: canonicalJSON({ next: saved.calendarRules![0] }), resultId: 'legacy-restore', at: saved.exportedAt })
    await restoreBackup(saved); const restored = await captureSnapshot(); expect(restored.calendarRules![0].sources[0].status).toBe('stale'); expect(restored.calendarRules![0].sources[0].ics!.snapshots[0].originalText).toBeNull(); expect(JSON.stringify(restored)).not.toContain('private@example.test'); expect(JSON.stringify(restored)).not.toContain('担当者との面談'); expect((await db.commands.get('calendar:legacy-restore'))!.hash).toBe('redacted:calendar-receipt:legacy-restore'); expect(restored.calendarEvents![0].startAt).toBe(saved.calendarEvents![0].startAt); expect(restored.calendarEvents![0].id).toBe(saved.calendarEvents![0].id)
  })
})
