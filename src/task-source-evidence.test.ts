import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, correctCompletion, createTasksAtomic, newTaskInput, undoCompletion, updateTask } from './commands'
import { emptyScore, uid } from './domain'
import { deleteSource, readSource, searchSources, setSourcePermissions, sourceDerivedCounts, summarizeSelectedSource } from './source-library'
import { purgeExpiredCoachContext } from './context-retention'
import { appendCoachReply, beginCoachTurn, clearCoachTurnAuthority, createCoachConversation } from './chat-history'
import { createCoachMemory, memorySourceFromOption } from './coach-memory'
import { clearDetectionAuthority } from './detection-run'
import { makeWebCaptureCapsule, prepareWebCaptureImport, saveCaptureImportFromUI } from './web-capture-import'
import { captureSnapshot, restoreBackup } from './backup'
import { legacyNotesState, migrateLegacyDetectionNotes, taskEvidenceDisplay } from './task-source-evidence'
import { adoptDetectedTask, enableSyntheticAI, humanClick, importWorkSlack, quoteModel, secretQuote } from './source-quote-fixtures'

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T03:00:00.000Z'))
  await db.delete(); await db.open(); await ensureSettings(); await enableSyntheticAI(); clearDetectionAuthority(); clearCoachTurnAuthority()
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

const quoteFragment = '顧客ZETA'
async function everyTable() { return JSON.stringify(await Promise.all(db.tables.map(table => table.toArray()))) }
async function scoredCompletion(taskId: string) {
  const task = (await db.tasks.get(taskId))!
  await updateTask(taskId, task.revision, { ...newTaskInput(), title: task.title, notes: task.notes, dueDate: task.dueDate, score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
  await completeTask(taskId, task.revision + 1); await correctCompletion(taskId, 35, '本人が実績を訂正')
  const completed = (await db.tasks.get(taskId))!
  await undoCompletion(taskId, completed.revision); await completeTask(taskId, completed.revision + 1)
  return { task: (await db.tasks.get(taskId))!, completions: await db.completions.toArray(), ledger: await db.ledger.toArray(), assessments: await db.assessments.toArray() }
}
const legacyNotes = (sourceId: string) => `資料から検出し本人が確認する候補。検出=${quoteModel} / 検証=${quoteModel}（同じモデル、独立評価未通過）\n根拠: explicit_request / requested\n[${sourceId} 内容版1 ${sourceId}:1:1] ${secretQuote}\n期限の原文: ${secretQuote}`
async function legacyTask(sourceId: string, notes = legacyNotes(sourceId)) {
  const assistedId = uid(), [taskId] = await createTasksAtomic([{ ...newTaskInput(), title: `旧形式の採用タスク${assistedId.slice(0, 4)}`, notes, dueDate: '2026-10-02' }], `assist:${assistedId}`)
  await db.audits.add({ id: `detection-approval:${assistedId}`, taskId, operation: 'detection.approved', at: new Date().toISOString(), detail: JSON.stringify({ runId: 'legacy-run', candidateId: 'legacy-candidate', digest: 'd'.repeat(64), source: { sourceId, sourceRevision: 1, snapshotRevision: 1, permissionRevision: 1, sha256: 'a'.repeat(64) }, detectorModel: quoteModel, verifierModel: quoteModel, independentModelHoldout: false, taskIds: [taskId] }) })
  await db.audits.add({ id: uid(), taskId, operation: 'score.ai_attributes', at: new Date().toISOString(), detail: JSON.stringify({ sourceText: `旧形式の採用タスク\n${notes}`, model: quoteModel }) })
  return taskId
}

describe('K11 タスク内の資料引用は資料の削除・期限・保存許可の取消に従う', () => {
  it('採用した検出タスクのメモには引用を書かず、資料削除でevidenceだけを消してタスク・点数・台帳は変えない', async () => {
    const { sourceId, taskId } = await adoptDetectedTask()
    expect((await db.tasks.get(taskId))!.notes).not.toContain(quoteFragment)
    expect(await db.taskSourceEvidence.where('taskId').equals(taskId).toArray()).toEqual([expect.objectContaining({ sourceId, quote: secretQuote, snapshotRevision: 1, supports: ['action', 'assignee', 'active', 'due'] })])
    expect((await taskEvidenceDisplay((await db.tasks.get(taskId))!)).quotes.map(row => row.quote)).toEqual([secretQuote])
    const before = await scoredCompletion(taskId)
    expect(before.task.effectivePoints).toBe(40); expect(before.completions[0]).toMatchObject({ originalPoints: 40, netPoints: 35, currentAt: expect.any(String) }); expect(before.ledger.reduce((sum, row) => sum + row.delta, 0)).toBe(35)
    const report = await deleteSource(sourceId, (await db.contextSources.get(sourceId))!.revision)
    expect(report).toMatchObject({ alreadyDeleted: false, erased: { original: 1, candidates: 1, taskQuotes: 1 }, reviewTaskIds: [], sentModels: [quoteModel] })
    expect(await db.tasks.get(taskId)).toEqual(before.task)
    expect(await db.completions.toArray()).toEqual(before.completions); expect(await db.ledger.toArray()).toEqual(before.ledger); expect(await db.assessments.toArray()).toEqual(before.assessments)
    expect(await db.taskSourceEvidence.count()).toBe(0)
    expect(await taskEvidenceDisplay((await db.tasks.get(taskId))!)).toMatchObject({ quotes: [], erasedSourceIds: [sourceId], deletedSourceIds: [sourceId], legacy: 'none' })
    expect(await everyTable()).not.toContain(quoteFragment)
  })
  it.each([
    ['期限切れ（purgeExpiredCoachContext）', 'expire'], ['保存の取消（retain=false）', 'retain'], ['索引の取消（index=false）', 'index']
  ] as const)('%sでもタスク内引用を消し、タスクは残す', async (_label, path) => {
    const sourceId = await importWorkSlack({ retentionUntil: '2026-10-05T00:00:00.000Z' }), { taskId } = await adoptDetectedTask(sourceId)
    const source = (await db.contextSources.get(sourceId))!
    if (path === 'expire') { vi.setSystemTime(new Date('2026-10-05T00:00:00.000Z')); await purgeExpiredCoachContext() }
    else await setSourcePermissions(sourceId, source.revision, { ...source.permissions, [path]: false }, source.allowedModels, source.retentionUntil)
    expect(await db.taskSourceEvidence.count()).toBe(0)
    expect(await db.tasks.get(taskId)).toMatchObject({ title: '非公開見積を送る', dueDate: '2026-10-02', status: 'open' })
    expect(await taskEvidenceDisplay((await db.tasks.get(taskId))!)).toMatchObject({ quotes: [], erasedSourceIds: [sourceId], deletedSourceIds: path === 'expire' ? [sourceId] : [] })
    // index=false keeps the owner's retained original; only derived copies must be gone.
    if (path === 'index') expect(JSON.stringify([await db.tasks.toArray(), await db.commands.toArray(), await db.audits.toArray(), await db.sourceArtifacts.toArray()])).not.toContain(quoteFragment)
    else expect(await everyTable()).not.toContain(quoteFragment)
  })
  it('AI送信だけを取り消した資料の引用は端末内に残し、送信判定は別に行う', async () => {
    const { sourceId, taskId } = await adoptDetectedTask(), source = (await db.contextSources.get(sourceId))!
    await setSourcePermissions(sourceId, source.revision, { ...source.permissions, aiEgress: false }, [], null)
    expect((await taskEvidenceDisplay((await db.tasks.get(taskId))!)).quotes).toHaveLength(1)
  })
})

describe('K11 実際のコード経路で作った派生物を、削除・期限・index取消・retain取消のすべてで消す', () => {
  it.each(['delete', 'expire', 'index', 'retain'] as const)('%s', async path => {
    const retentionUntil = '2026-10-05T00:00:00.000Z', sourceId = await importWorkSlack({ retentionUntil }), owner = (await db.settings.get('main'))!.profileId
    await summarizeSelectedSource(sourceId, 1, quoteModel, async text => `合成要約: ${text.includes(quoteFragment) ? '顧客ZETAの見積' : ''}`)
    const memoryRef = await memorySourceFromOption({ kind: 'library', refId: sourceId, summary: true, label: '資料の要約' }, owner)
    await createCoachMemory({ kind: 'inferred', text: '顧客ZETAの見積が必要らしい', sources: [memoryRef] })
    const { taskId } = await adoptDetectedTask(sourceId)
    const conversationId = await createCoachConversation('資料を使う会話', 'Asia/Tokyo'), conversation = (await db.coachConversations.get(conversationId))!
    const turn = await beginCoachTurn(conversationId, conversation.revision, { text: '選んだ資料を確認したい', mode: 'ai', sourceIds: [sourceId] })
    await appendCoachReply(turn, '合成AI返信: 顧客ZETAの件ですね', 'live_ai')
    const capture = await saveCaptureImportFromUI(await prepareWebCaptureImport(makeWebCaptureCapsule({ title: '選んだWeb引用', url: 'https://example.invalid/a', quote: '顧客ZETAのWeb引用', timezone: 'Asia/Tokyo' }), retentionUntil), humanClick())
    // Embeddings: this build has no embedding generator (K03 hybrid is separate), so one row is inserted directly.
    await db.sourceArtifacts.add({ id: 'manual-embedding', ownerId: owner, sourceId, sourceRevision: 1, permissionRevision: 3, kind: 'embedding', payload: '[0.1,0.2]', createdAt: new Date().toISOString() })
    const counts = await sourceDerivedCounts(owner)
    expect(counts.get(sourceId)).toEqual({ summaries: 1, caches: 0, embeddings: 1, candidates: 1, taskQuotes: 1, memories: 1 })
    expect(counts.get(capture.sourceId)).toMatchObject({ caches: 1 })
    for (const id of [sourceId, capture.sourceId]) {
      const source = (await db.contextSources.get(id))!
      if (path === 'delete') await deleteSource(id, source.revision)
      else if (path !== 'expire') await setSourcePermissions(id, source.revision, { ...source.permissions, [path]: false }, source.allowedModels, source.retentionUntil)
    }
    if (path === 'expire') { vi.setSystemTime(new Date(retentionUntil)); await purgeExpiredCoachContext() }
    const after = await sourceDerivedCounts(owner)
    for (const id of [sourceId, capture.sourceId]) expect(after.get(id) ?? { summaries: 0, caches: 0, embeddings: 0, candidates: 0, taskQuotes: 0, memories: 0 }).toEqual({ summaries: 0, caches: 0, embeddings: 0, candidates: 0, taskQuotes: 0, memories: 0 })
    expect(await db.sourceSummaries.count()).toBe(0); expect(await db.sourceArtifacts.count()).toBe(0); expect(await db.taskSourceEvidence.count()).toBe(0)
    expect((await db.coachMessages.toArray()).filter(message => message.role === 'assistant')).toEqual([])
    expect((await searchSources('顧客ZETA', '2026-01-01', '2026-12-31')).hits).toEqual([])
    if (path !== 'index') await expect(readSource(sourceId)).rejects.toThrow()
    expect(await db.tasks.get(taskId)).toMatchObject({ title: '非公開見積を送る', status: 'open' })
    if (path !== 'index') expect(await everyTable()).not.toContain(quoteFragment)
    else expect(JSON.stringify([await db.sourceSummaries.toArray(), await db.sourceArtifacts.toArray(), await db.taskSourceEvidence.toArray(), await db.coachMessages.toArray(), await db.coachMemories.toArray()])).not.toContain(quoteFragment)
  })
})

describe('K11 旧形式メモの一度だけの移行', () => {
  it('完全一致の機械生成メモだけを移し、受領記録と監査の複写も消す。編集済みメモは残して印を付ける', async () => {
    const live = await importWorkSlack({ permissions: { aiEgress: false }, allowedModels: [] }), deleted = await importWorkSlack({ permissions: { aiEgress: false }, allowedModels: [] })
    const moved = await legacyTask(live), erased = await legacyTask(deleted), edited = await legacyTask(live, `${legacyNotes(live)}\n本人の追記`)
    await deleteSource(deleted, (await db.contextSources.get(deleted))!.revision)
    const revisions = Object.fromEntries((await db.tasks.toArray()).map(task => [task.id, task.revision]))
    expect(await migrateLegacyDetectionNotes()).toEqual({ migrated: 2, movedQuotes: 1, erasedQuotes: 1, review: 1 })
    for (const id of [moved, erased]) { const task = (await db.tasks.get(id))!; expect(task.notes).toContain('資料から検出し本人が採用した候補'); expect(task.notes).not.toContain(quoteFragment); expect(task.revision).toBe(revisions[id]) }
    expect(await db.taskSourceEvidence.toArray()).toEqual([expect.objectContaining({ taskId: moved, sourceId: live, quote: secretQuote, spanId: `${live}:1:1` })])
    expect((await db.tasks.get(edited))!.notes).toBe(`${legacyNotes(live)}\n本人の追記`); expect(legacyNotesState((await db.tasks.get(edited))!.notes)).toBe('edited')
    const copies = JSON.stringify([(await db.commands.toArray()).filter(row => !row.resultId.includes(edited)), (await db.audits.toArray()).filter(row => row.taskId !== edited)])
    expect(copies).not.toContain(quoteFragment)
    expect((await db.audits.toArray()).filter(row => row.operation === 'task.source_quote_migrated').map(row => JSON.parse(row.detail))).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: live, movedToEvidence: 1, erased: 0 }), expect.objectContaining({ sourceId: deleted, movedToEvidence: 0, erased: 1 })]))
    expect(await migrateLegacyDetectionNotes()).toEqual({ migrated: 0, movedQuotes: 0, erasedQuotes: 0, review: 1 })
    const report = await deleteSource(live, (await db.contextSources.get(live))!.revision)
    expect(report.reviewTaskIds).toEqual([edited]); expect(report.erased.taskQuotes).toBe(1)
    expect((await db.tasks.get(edited))!.notes).toContain('本人の追記')
  })
})

describe('K11 バックアップでも削除済み資料の引用を復活させない', () => {
  it('削除前のバックアップを復元しても、この端末の削除記録を再適用して引用を戻さない', async () => {
    const { sourceId, taskId } = await adoptDetectedTask(), saved = await captureSnapshot()
    expect(saved.taskSourceEvidence).toHaveLength(1)
    await deleteSource(sourceId, (await db.contextSources.get(sourceId))!.revision)
    await restoreBackup(saved)
    expect(await db.contextSources.get(sourceId)).toMatchObject({ deletedAt: expect.any(String), title: '削除した資料' })
    expect(await db.taskSourceEvidence.count()).toBe(0); expect(await db.tasks.get(taskId)).toMatchObject({ title: '非公開見積を送る' })
    expect(JSON.stringify(await captureSnapshot())).not.toContain(quoteFragment)
  })
  it('削除済み資料のevidenceを含むバックアップは取込時に捨て、改ざんしたhashは既存データを残して拒否する', async () => {
    const { sourceId, taskId } = await adoptDetectedTask(), saved = await captureSnapshot(), evidence = saved.taskSourceEvidence![0]
    const tampered = structuredClone(saved); tampered.taskSourceEvidence = [{ ...evidence, quote: '差し替えた引用' }]
    await expect(restoreBackup(tampered)).rejects.toThrow('ハッシュ')
    expect(await db.taskSourceEvidence.toArray()).toEqual([evidence])
    await restoreBackup(saved)
    expect(await db.taskSourceEvidence.toArray()).toEqual([evidence])
    const crafted = structuredClone(saved), source = crafted.contextSources!.find(row => row.id === sourceId)!
    Object.assign(source, { title: '削除した資料', externalId: null, conversation: null, author: null, sourceUrl: null, permissions: { acquire: false, retain: false, index: false, aiEgress: false, notify: false, externalWrite: false, disclose: false }, revision: source.revision + 1, permissionRevision: source.permissionRevision + 1, deletedAt: source.updatedAt })
    crafted.contextSnapshots = []; crafted.sourceSummaries = []; crafted.sourceArtifacts = []
    await restoreBackup(crafted)
    expect(await db.taskSourceEvidence.count()).toBe(0); expect(await db.tasks.get(taskId)).toBeDefined()
    // The crafted tombstone is now this device's erasure record, so the older live copy cannot bring the quote back.
    await restoreBackup(saved)
    expect(await db.taskSourceEvidence.count()).toBe(0); expect(await db.contextSources.get(sourceId)).toMatchObject({ deletedAt: expect.any(String) })
  })
  it('旧形式メモを含む古いバックアップは復元後に移行する', async () => {
    const sourceId = await importWorkSlack({ permissions: { aiEgress: false }, allowedModels: [] }), taskId = await legacyTask(sourceId), saved = await captureSnapshot()
    delete saved.taskSourceEvidence
    await restoreBackup(saved)
    expect((await db.tasks.get(taskId))!.notes).not.toContain(quoteFragment)
    expect(await db.taskSourceEvidence.toArray()).toEqual([expect.objectContaining({ taskId, quote: secretQuote })])
  })
})
