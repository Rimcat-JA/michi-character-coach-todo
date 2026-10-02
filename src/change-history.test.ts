import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { db } from './db'
import type { Audit, Task } from './domain'
import { changeTrace, changeTraceEntry } from './change-history'
import { ChangeTraceList, PendingChangesList } from './ChangeHistoryView'
import { createTask, newTaskInput } from './commands'
import { noteReceivedCommands, prepareCommand, uiCoachActor } from './command-bus'
import { resetApp } from './command-test-harness'

const audit = (id: string, operation: string, at: string, detail: unknown, taskId: string | null = 'task-1'): Audit => ({ id, taskId, operation, at, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) })
const ics = 'BEGIN:VCALENDAR\nSUMMARY:社外秘の会議\nEND:VCALENDAR', csv = '日付,種別\n2026-10-02,社内休日（社外秘）'
const fixtures: Audit[] = [
  audit('a1', 'changeset.update', '2026-10-01T01:00:00.000Z', { changeSetId: 'cs1', digest: 'd'.repeat(64), principal: { id: 'app-coach', kind: 'coach', model: 'synthetic/model-a' }, decision: 'auto', entrance: 'ui_coach', basis: 'app_instruction', commandId: 'cmd-1', approvedBy: null, policyEpoch: 3, before: { scheduledDate: '2026-10-01' }, after: { scheduledDate: '2026-10-02' }, fieldOrigins: { scheduledDate: 'agent_proposal' }, undo: { expectedRevision: 2, patch: { scheduledDate: '2026-10-01' } } }),
  audit('a2', 'changeset.update', '2026-10-01T02:00:00.000Z', { changeSetId: 'cs2', digest: 'e'.repeat(64), principal: { id: 'client-b', kind: 'external-agent' }, approvedBy: 'owner', policyEpoch: 2, before: { notes: '前' }, after: { notes: '後' }, fieldOrigins: { notes: 'agent_proposal' } }),
  audit('a3', 'update', '2026-10-01T03:00:00.000Z', '本人が編集'),
  audit('a4', 'update', '2026-10-01T04:00:00.000Z', { schema: 'command.audit/1', entrance: 'ui_human', principal: { kind: 'human', id: 'owner' }, decision: 'self', basis: 'app_instruction', operation: 'update', commandKey: 'k', revisionBefore: 3, revisionAfter: 4, fields: ['title'], before: { title: '旧' }, after: { title: '新' }, summary: '本人が編集' }),
  audit('a5', 'filebridge.approved', '2026-10-01T05:00:00.000Z', { commandId: 'c5', clientId: 'client-a', applicationDigest: 'f'.repeat(64), approvedBy: 'owner', entrance: 'file-bridge', policyEpoch: 1, operation: 'task.create' }),
  audit('a6', 'filebridge.auto', '2026-10-01T06:00:00.000Z', { commandId: 'c6', clientId: 'client-b', applicationDigest: 'a'.repeat(64), approvedBy: null, decision: 'auto', entrance: 'mcp', basis: 'external_request', policyEpoch: 4, operation: 'task.update' }),
  audit('a7', 'calendar.configuration', '2026-10-01T07:00:00.000Z', { proposalId: 'p', digest: 'b'.repeat(64), approvedBy: 'owner', policyEpoch: 4, fromRevision: 1, toRevision: 2, before: { sources: [{ body: ics }] }, after: { sources: [{ body: csv }] } }, null),
  audit('a8', 'calendar.csv.approved', '2026-10-01T08:00:00.000Z', { configurationId: 'x', digest: 'c'.repeat(64), sourceId: 's', approvedBy: 'owner', rows: [csv] }, null),
  audit('a9', 'routine.assistance.approved', '2026-10-01T09:00:00.000Z', { origin: 'external_request', model: null, digest: '1'.repeat(64), ruleId: 'r', approvedBy: 'owner', source: { entrance: 'mcp', basis: 'external_request', commandId: 'c9', actorId: 'client-b', host: 'codex' } }, null),
  audit('a10', 'assist.approved', '2026-10-01T10:00:00.000Z', `本人承認 ${'2'.repeat(64)}; origin=ai_accepted; tasks=t1`, null),
  audit('a11', 'detection.approved', '2026-10-01T11:00:00.000Z', { runId: 'r', digest: '3'.repeat(64), detectorModel: 'synthetic/detector', approvedBy: 'owner', policyEpoch: 4, quote: '資料の引用は表示しない' }),
  audit('a12', 'localaction.result', '2026-10-01T12:00:00.000Z', { requestId: 'q', digest: '4'.repeat(64), policyEpoch: 4, status: 'succeeded', output: 'PCの出力は表示しない' }, null),
  audit('a13', 'breakdown', '2026-10-01T13:00:00.000Z', { schema: 'command.audit/1', entrance: 'file', basis: 'external_request', commandId: 'c13', principal: { kind: 'external-agent', id: 'client-a', model: null }, decision: 'approved', approvedBy: 'owner', digest: '5'.repeat(64), policyEpoch: 4, operation: 'task.split', fields: ['manualPoints', 'children'], before: { manualPoints: 40, children: [] }, after: { manualPoints: 0, children: [{ title: '調査', points: 15 }] } }),
  audit('a14', 'breakdown', '2026-10-01T14:00:00.000Z', 'large: 30ptを3件へ配分'),
  audit('a15', 'session.started', '2026-10-01T15:00:00.000Z', 'ignored'),
  audit('a16', 'changeset.update', '2026-10-01T16:00:00.000Z', '{broken json'),
  audit('a17', 'automation.policy', '2026-10-01T17:00:00.000Z', { preset: 'A2' }, null),
  audit('a18', 'snooze', '2026-10-01T18:00:00.000Z', '2026-10-02T00:00:00.000Z'),
]
describe('S21 change trace from every entrance', () => {
  it('parses every audit type including legacy strings without throwing and skips unrelated rows', () => {
    expect(() => fixtures.map(changeTraceEntry)).not.toThrow()
    expect(changeTraceEntry(fixtures.find(row => row.id === 'a15')!)).toBeNull()
    expect(changeTraceEntry(fixtures.find(row => row.id === 'a16')!)).toBeNull()
    expect(changeTraceEntry(fixtures.find(row => row.id === 'a17')!)).toBeNull()
    expect(changeTraceEntry({ id: 'x', taskId: null, operation: 'changeset.update', at: 'bad', detail: null as unknown as string })).toBeNull()
    const { entries, total } = changeTrace(fixtures)
    expect(total).toBe(15)
    expect(entries.map(entry => entry.auditId)).toEqual(['a18', 'a14', 'a13', 'a12', 'a11', 'a10', 'a9', 'a8', 'a7', 'a6', 'a5', 'a4', 'a3', 'a2', 'a1'])
    // Legacy owner snoozes are shown as the owner's own operation, never guessed further.
    expect(entries[0]).toMatchObject({ label: 'スヌーズ', entrance: 'ui_human', operator: { kind: 'human' }, decision: 'self', summary: '2026-10-02T00:00:00.000Z', legacy: true })
  })
  it('shows the operator and entrance, distinguishes automatic from approved and self, and keeps legacy rows', () => {
    const byId = Object.fromEntries(changeTrace(fixtures).entries.map(entry => [entry.auditId, entry]))
    expect(byId.a1).toMatchObject({ entrance: 'ui_coach', operator: { kind: 'coach', model: 'synthetic/model-a' }, decision: 'auto', approver: null, policyEpoch: 3, basis: 'app_instruction', commandId: 'cmd-1', fields: ['scheduledDate'], before: { scheduledDate: '2026-10-01' }, after: { scheduledDate: '2026-10-02' }, legacy: false })
    expect(byId.a2).toMatchObject({ entrance: 'file', operator: { kind: 'external-agent', id: 'client-b' }, decision: 'approved', approver: 'owner', basis: 'external_request', legacy: true })
    expect(byId.a3).toMatchObject({ entrance: 'ui_human', operator: { kind: 'human' }, decision: 'self', summary: '本人が編集', legacy: true })
    expect(byId.a4).toMatchObject({ decision: 'self', fields: ['title'], before: { title: '旧' }, after: { title: '新' }, legacy: false })
    expect(byId.a5).toMatchObject({ entrance: 'file', operator: { kind: 'external-agent', id: 'client-a' }, decision: 'approved', legacy: true })
    expect(byId.a6).toMatchObject({ entrance: 'mcp', decision: 'auto', approver: null })
    expect(byId.a9).toMatchObject({ entrance: 'mcp', operator: { kind: 'external-agent', id: 'client-b' }, basis: 'external_request', commandId: 'c9' })
    expect(byId.a10).toMatchObject({ operator: { kind: 'coach' }, decision: 'approved', digest: '2'.repeat(64), legacy: true })
    expect(byId.a13).toMatchObject({ entrance: 'file', operator: { kind: 'external-agent' }, decision: 'approved', fields: ['manualPoints', 'children'], before: { manualPoints: 40 } })
    expect(byId.a14).toMatchObject({ decision: 'self', legacy: true })
  })
  it('never shows ICS/CSV bodies, quotes or local action output', () => {
    const text = JSON.stringify(changeTrace(fixtures)) + renderToStaticMarkup(createElement(ChangeTraceList, { entries: changeTrace(fixtures).entries, tasks: [], total: 15, page: 0 }))
    for (const secret of ['BEGIN:VCALENDAR', '社外秘', '資料の引用は表示しない', 'PCの出力は表示しない']) expect(text).not.toContain(secret)
    expect(text).toContain('設定版 1 → 2')
  })
  it('pages 50 at a time', () => {
    const many = Array.from({ length: 120 }, (_, index) => audit(`h${String(index).padStart(3, '0')}`, 'update', new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(), '本人が編集'))
    expect(changeTrace(many, 0).entries).toHaveLength(50); expect(changeTrace(many, 2).entries).toHaveLength(20); expect(changeTrace(many, 0).entries[0].auditId).toBe('h119')
    const markup = renderToStaticMarkup(createElement(ChangeTraceList, { entries: changeTrace(many, 1).entries, tasks: [], total: 120, page: 1, onPage: () => undefined }))
    expect(markup).toContain('51〜100 / 120件')
  })
})
describe('S21 pending proposals', () => {
  beforeEach(async () => { await resetApp() })
  it('lists in-app and received external proposals with operator, target, before/after and two separate buttons', async () => {
    const settings = (await db.settings.get('main'))!, taskId = await createTask({ ...newTaskInput(), title: '確認待ちのタスク', notes: '元のメモ' }), tasks = await db.tasks.toArray() as Task[]
    const { prepared } = await prepareCommand({ schema_version: '1', command_id: 'cmd-ui', type: 'task.update', target_id: taskId, expected_revision: 1, payload: { notes: 'コーチの提案' }, basis: { kind: 'app_instruction' } }, uiCoachActor(settings, 'synthetic/model-a'))
    noteReceivedCommands('external', [{ commandId: crypto.randomUUID(), entrance: 'mcp', type: 'task.update', targetId: taskId, expectedRevision: 1, principalId: 'client-b-1234', host: 'codex', fields: ['scheduled_date'], expiresAt: new Date(Date.now() + 3600000).toISOString() }])
    const { receivedCommands } = await import('./command-bus')
    const markup = renderToStaticMarkup(createElement(PendingChangesList, { pending: [prepared!], received: receivedCommands(), settings, tasks, onApprove: () => undefined, onPolicy: () => undefined }))
    expect(markup).toContain('確認待ちのタスク（版 1）'); expect(markup).toContain('アプリ内コーチ'); expect(markup).toContain('synthetic/model-a'); expect(markup).toContain('メモ：元のメモ → コーチの提案')
    expect(markup).toContain('ローカルMCP'); expect(markup).toContain('codex（自己申告）'); expect(markup).toContain('外部エージェント client-b')
    expect(markup.match(/<button[^>]*>この変更だけ許可<\/button>/g)).toHaveLength(2)
    expect(markup.match(/<button[^>]*>今後の権限設定へ<\/button>/g)).toHaveLength(2)
    expect(renderToStaticMarkup(createElement(PendingChangesList, { pending: [], received: [], settings, tasks, onApprove: () => undefined, onPolicy: () => undefined }))).toContain('承認待ちの変更はありません。')
  })
})
