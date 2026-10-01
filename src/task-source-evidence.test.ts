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
import { adoptDetectedTask, enableSyntheticAI, humanClick, importWorkSlack, quoteModel, secretQuote, syntheticTransport } from './source-quote-fixtures'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { changePolicyFor } from './change-set'
import { loadTaskEgress } from './egress-policy'
import { applyDetectionCreateFromUI, detectObligationsForSource, prepareDetectionCreate, prepareDetectionFromUI } from './detection-run'
import { DeletionReport } from './SourceLibraryView'
import type { Snapshot } from './backup-validation'

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
    expect(await migrateLegacyDetectionNotes()).toEqual({ migrated: 2, movedQuotes: 1, erasedQuotes: 1, review: 1, scrubbedReceipts: 0 })
    for (const id of [moved, erased]) { const task = (await db.tasks.get(id))!; expect(task.notes).toContain('資料から検出し本人が採用した候補'); expect(task.notes).not.toContain(quoteFragment); expect(task.revision).toBe(revisions[id]) }
    expect(await db.taskSourceEvidence.toArray()).toEqual([expect.objectContaining({ taskId: moved, sourceId: live, quote: secretQuote, spanId: `${live}:1:1` })])
    expect((await db.tasks.get(edited))!.notes).toBe(`${legacyNotes(live)}\n本人の追記`); expect(legacyNotesState((await db.tasks.get(edited))!.notes)).toBe('edited')
    const copies = JSON.stringify([(await db.commands.toArray()).filter(row => !row.resultId.includes(edited)), (await db.audits.toArray()).filter(row => row.taskId !== edited)])
    expect(copies).not.toContain(quoteFragment)
    expect((await db.audits.toArray()).filter(row => row.operation === 'task.source_quote_migrated').map(row => JSON.parse(row.detail))).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: live, movedToEvidence: 1, erased: 0 }), expect.objectContaining({ sourceId: deleted, movedToEvidence: 0, erased: 1 })]))
    expect(await migrateLegacyDetectionNotes()).toEqual({ migrated: 0, movedQuotes: 0, erasedQuotes: 0, review: 1, scrubbedReceipts: 0 })
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

// Synthetic fake-indexeddb regressions only: no real device, account, network or model.
const sourceTables = async (sourceId: string) => ({ snapshots: await db.contextSnapshots.where('sourceId').equals(sourceId).count(), summaries: await db.sourceSummaries.where('sourceId').equals(sourceId).count(), evidence: await db.taskSourceEvidence.where('sourceId').equals(sourceId).count(), aiReplies: (await db.coachMessages.toArray()).filter(message => message.role === 'assistant' && message.selectedSources.some(ref => ref.kind === 'library' && ref.id === sourceId)).length })
async function chatWithSource(sourceId: string, reply = '合成AI返信: 顧客ZETAの件ですね') {
  const conversationId = await createCoachConversation('資料を使う会話', 'Asia/Tokyo'), conversation = (await db.coachConversations.get(conversationId))!
  const turn = await beginCoachTurn(conversationId, conversation.revision, { text: '選んだ資料を確認したい', mode: 'ai', sourceIds: [sourceId] })
  await appendCoachReply(turn, reply, 'live_ai')
}
async function detectOnly(sourceId: string) {
  const row = (await db.contextSources.get(sourceId))!, prepared = await prepareDetectionFromUI(sourceId, row.revision, quoteModel, { confirmedAliases: [], authorIsOwner: false, existingTaskIds: [] }, humanClick())
  return detectObligationsForSource(prepared, syntheticTransport(prepared))
}

describe('K11 復元はこの端末の削除・許可取消・期限短縮を書込み前に適用する', () => {
  it('削除前のB0と削除後のB1を交互に復元しても、削除記録・伏せた題名を保ち、原文・引用はどの表にも戻らない', async () => {
    const beforeImport = await captureSnapshot()
    const { sourceId, taskId } = await adoptDetectedTask(), before = await scoredCompletion(taskId), b0 = await captureSnapshot()
    await deleteSource(sourceId, (await db.contextSources.get(sourceId))!.revision)
    const tombstone = (await db.contextSources.get(sourceId))!
    await restoreBackup(b0)
    const b1 = await captureSnapshot()
    expect(b1.contextSources).toEqual(expect.arrayContaining([tombstone]))
    for (const saved of [b0, b1, b0, beforeImport, b0]) {
      await restoreBackup(saved)
      expect(await db.contextSources.get(sourceId)).toEqual(tombstone)
      expect(await sourceTables(sourceId)).toEqual({ snapshots: 0, summaries: 0, evidence: 0, aiReplies: 0 })
      await expect(readSource(sourceId)).rejects.toThrow()
      expect(await everyTable()).not.toContain(quoteFragment)
    }
    // The B0 restore keeps the owner's 40→35→取消→再完了 record: 35pt net, ledger and assessments as backed up.
    expect(await db.tasks.get(taskId)).toEqual(before.task); expect(await db.completions.toArray()).toEqual(before.completions); expect(await db.ledger.toArray()).toEqual(before.ledger); expect(await db.assessments.toArray()).toEqual(before.assessments)
    expect(before.ledger.reduce((sum, row) => sum + row.delta, 0)).toBe(35)
  })
  it('復元の書込み中にも削除済み資料の原文・要約・AI返信・引用を一度も書かず、削除記録を保ったまま書く', async () => {
    const { sourceId } = await adoptDetectedTask()
    await summarizeSelectedSource(sourceId, (await db.contextSources.get(sourceId))!.revision, quoteModel, async () => '合成要約: 顧客ZETAの見積')
    await chatWithSource(sourceId)
    const saved = await captureSnapshot(), policy = changePolicyFor(saved.settings[0])
    await deleteSource(sourceId, (await db.contextSources.get(sourceId))!.revision)
    const written: string[] = []
    const watch = (name: string) => (_key: unknown, row: unknown) => { const text = JSON.stringify(row); if (text.includes(quoteFragment) || text.includes(sourceId) && name === 'contextSources' && !(row as { deletedAt: string | null }).deletedAt) written.push(`${name}:${text.slice(0, 80)}`) }
    const hooked = [db.contextSources, db.contextSnapshots, db.sourceSummaries, db.sourceArtifacts, db.coachMessages, db.taskSourceEvidence, db.coachMemories] as const
    const handlers = hooked.map(table => { const handler = watch(table.name); table.hook('creating', handler); return [table, handler] as const })
    try { await restoreBackup(saved) } finally { for (const [table, handler] of handlers) table.hook('creating').unsubscribe(handler) }
    expect(written).toEqual([])
    const restored = (await db.settings.get('main'))!
    expect(changePolicyFor(restored).epoch).toBeGreaterThan(policy.epoch); expect(changePolicyFor(restored).sourcePermissionRevision).toBeGreaterThan(policy.sourcePermissionRevision)
  })
  it.each([['retain', ['retain']], ['index', ['index']], ['retain+index', ['retain', 'index']]] as const)('バックアップ後に%sを取り消した資料は、古いバックアップを復元しても原文・引用を戻さない', async (_label, keys) => {
    const { sourceId, taskId } = await adoptDetectedTask(), before = await scoredCompletion(taskId), saved = await captureSnapshot()
    expect(saved.taskSourceEvidence).toHaveLength(1)
    const source = (await db.contextSources.get(sourceId))!
    await setSourcePermissions(sourceId, source.revision, { ...source.permissions, ...Object.fromEntries(keys.map(key => [key, false])) }, source.allowedModels, source.retentionUntil)
    const local = (await db.contextSources.get(sourceId))!
    await restoreBackup(saved)
    expect(await db.contextSources.get(sourceId)).toMatchObject({ permissions: local.permissions, permissionRevision: local.permissionRevision, revision: local.revision, deletedAt: null })
    expect(await db.taskSourceEvidence.count()).toBe(0)
    expect(await db.contextSnapshots.where('sourceId').equals(sourceId).count()).toBe(keys.includes('retain' as never) ? 0 : 1)
    expect((await taskEvidenceDisplay((await db.tasks.get(taskId))!)).quotes).toEqual([])
    expect(await db.tasks.get(taskId)).toEqual(before.task); expect(await db.completions.toArray()).toEqual(before.completions); expect(await db.ledger.toArray()).toEqual(before.ledger)
    if (keys.includes('retain' as never)) expect(await everyTable()).not.toContain(quoteFragment)
    else expect(JSON.stringify([await db.taskSourceEvidence.toArray(), await db.sourceArtifacts.toArray(), await db.sourceSummaries.toArray(), await db.coachMessages.toArray()])).not.toContain(quoteFragment)
  })
  it('この端末の許可版以上のバックアップは、その許可と引用を保ち、新しい再許可を上書きしない', async () => {
    const { sourceId, taskId } = await adoptDetectedTask()
    let source = (await db.contextSources.get(sourceId))!
    await setSourcePermissions(sourceId, source.revision, { ...source.permissions, aiEgress: false }, [], source.retentionUntil)
    const older = await captureSnapshot()
    source = (await db.contextSources.get(sourceId))!
    await setSourcePermissions(sourceId, source.revision, { ...source.permissions, aiEgress: true }, [quoteModel], source.retentionUntil)
    const newer = await captureSnapshot(), granted = (await db.contextSources.get(sourceId))!
    await restoreBackup(newer)
    expect(await db.contextSources.get(sourceId)).toEqual(granted); expect(await db.taskSourceEvidence.where('taskId').equals(taskId).count()).toBe(1)
    await restoreBackup(older)
    expect(await db.contextSources.get(sourceId)).toMatchObject({ permissions: { aiEgress: false }, allowedModels: [], permissionRevision: granted.permissionRevision })
    await restoreBackup(newer)
    expect(await db.contextSources.get(sourceId)).toMatchObject({ permissions: granted.permissions, allowedModels: [quoteModel], permissionRevision: granted.permissionRevision })
    expect(await db.taskSourceEvidence.where('taskId').equals(taskId).count()).toBe(1)
  })
  it('バックアップ後のAI送信・許可モデルの取消と保持期限の短縮は、古いバックアップの復元で戻らない', async () => {
    const { sourceId, taskId } = await adoptDetectedTask()
    await summarizeSelectedSource(sourceId, (await db.contextSources.get(sourceId))!.revision, quoteModel, async () => '合成要約: 顧客ZETAの見積')
    await chatWithSource(sourceId)
    const saved = await captureSnapshot(), policy = changePolicyFor(saved.settings[0]), source = (await db.contextSources.get(sourceId))!, shortened = '2026-10-03T00:00:00.000Z'
    expect(saved.sourceSummaries).toHaveLength(1)
    await setSourcePermissions(sourceId, source.revision, { ...source.permissions, aiEgress: false }, [], shortened)
    await restoreBackup(saved)
    expect(await db.contextSources.get(sourceId)).toMatchObject({ permissions: { acquire: true, retain: true, index: true, aiEgress: false }, allowedModels: [], retentionUntil: shortened, permissionRevision: source.permissionRevision + 1, revision: source.revision + 1 })
    expect(await sourceTables(sourceId)).toEqual({ snapshots: 1, summaries: 0, evidence: 1, aiReplies: 0 })
    expect(changePolicyFor((await db.settings.get('main'))!).epoch).toBeGreaterThan(policy.epoch)
    const egress = await loadTaskEgress((await db.tasks.get(taskId))!, { kind: 'ai-model', route: 'coach-chat', model: quoteModel })
    expect(egress).toMatchObject({ evidence: [], withheldQuotes: 1 })
    vi.setSystemTime(new Date(shortened)); await purgeExpiredCoachContext()
    await expect(readSource(sourceId)).rejects.toThrow()
    expect(await db.contextSources.get(sourceId)).toMatchObject({ deletedAt: expect.any(String) }); expect(await sourceTables(sourceId)).toEqual({ snapshots: 0, summaries: 0, evidence: 0, aiReplies: 0 })
    expect(await everyTable()).not.toContain(quoteFragment)
  })
})

describe('K11 削除結果の外部AI送信記録は派生物の消去後も残る', () => {
  const sentAudits = async () => (await db.audits.toArray()).filter(row => row.operation === 'source.sent')
  it('要約後に保持期限だけを変えて削除しても、送信先モデルを表示する', async () => {
    const sourceId = await importWorkSlack()
    await summarizeSelectedSource(sourceId, 1, quoteModel, async () => '合成要約')
    const source = (await db.contextSources.get(sourceId))!
    await setSourcePermissions(sourceId, source.revision, source.permissions, source.allowedModels, '2026-12-01T00:00:00.000Z')
    expect(await db.sourceSummaries.count()).toBe(0)
    expect((await deleteSource(sourceId, (await db.contextSources.get(sourceId))!.revision)).sentModels).toEqual([quoteModel])
  })
  it('合成AI返信の会話で送った資料も、保持期限の変更・削除の後に送信先モデルを表示する', async () => {
    const sourceId = await importWorkSlack()
    await chatWithSource(sourceId)
    const source = (await db.contextSources.get(sourceId))!
    await setSourcePermissions(sourceId, source.revision, source.permissions, source.allowedModels, '2026-12-01T00:00:00.000Z')
    expect((await db.coachMessages.toArray()).filter(message => message.role === 'assistant')).toEqual([])
    expect((await deleteSource(sourceId, (await db.contextSources.get(sourceId))!.revision)).sentModels).toEqual([quoteModel])
  })
  it.each([['AI送信の取消', 'revoke'], ['30日後の候補整理', 'expire']] as const)('要約・検出の後に%sで派生物が消えても、削除結果に送信先モデルを出し、記録に本文を入れない', async (_label, path) => {
    const sourceId = await importWorkSlack()
    if (path === 'revoke') await summarizeSelectedSource(sourceId, 1, quoteModel, async () => '合成要約')
    await detectOnly(sourceId)
    if (path === 'revoke') { const source = (await db.contextSources.get(sourceId))!; await setSourcePermissions(sourceId, source.revision, { ...source.permissions, aiEgress: false }, [], null) }
    else { vi.setSystemTime(new Date('2026-11-01T03:00:00.000Z')); await purgeExpiredCoachContext() }
    expect(await db.sourceArtifacts.count()).toBe(0); expect(await db.sourceSummaries.count()).toBe(0)
    const report = await deleteSource(sourceId, (await db.contextSources.get(sourceId))!.revision)
    expect(report.sentModels).toEqual([quoteModel])
    const audits = await sentAudits()
    expect(audits.map(row => JSON.parse(row.detail)).sort((left, right) => left.route.localeCompare(right.route))).toEqual([expect.objectContaining({ sourceId, model: quoteModel, route: 'source-detection' }), ...(path === 'revoke' ? [expect.objectContaining({ sourceId, model: quoteModel, route: 'source-summary' })] : [])])
    expect(JSON.stringify(audits)).not.toContain(quoteFragment); expect(JSON.stringify(audits)).not.toContain('上司')
  })
  it('送信記録がない資料の削除結果は「送っていない」と断定しない', () => {
    const markup = renderToStaticMarkup(createElement(DeletionReport, { report: { sourceId: 's', alreadyDeleted: false, erased: { original: 1, summaries: 0, caches: 0, embeddings: 0, candidates: 0, memories: 0, aiReplies: 0, taskQuotes: 0, legacyCopies: 0 }, reviewTaskIds: ['a', 'b'], reviewTasks: [{ id: 'a', state: 'exact' }, { id: 'b', state: 'edited' }], sentModels: [] }, onClose: () => {} }))
    expect(markup).toContain('外部AI送信記録は見つかりませんでした'); expect(markup).not.toContain('送った履歴はありません')
    expect(markup).toContain('旧形式の機械生成メモ（未移行）1件'); expect(markup).toContain('本人が編集したメモのタスク1件')
  })
})

describe('K11 旧形式メモの受領記録・監査の複写', () => {
  const rewritten = `資料から検出し本人が確認する候補。検出=${quoteModel} / 検証=${quoteModel}（同じモデル、独立評価未通過）\n本人が書き直した要点`
  it.each([['本人が旧形式を消したメモ（none）', '本人が書いたメモ', 'none'], ['本人が書き直したメモ（edited）', rewritten, 'edited']] as const)('%sでも、アプリが作った受領記録・監査の複写を消し、本人のメモ・版・実績は変えない', async (_label, notes, state) => {
    const sourceId = await importWorkSlack({ permissions: { aiEgress: false }, allowedModels: [] }), taskId = await legacyTask(sourceId), task = (await db.tasks.get(taskId))!
    await updateTask(taskId, task.revision, { ...newTaskInput(), title: task.title, notes, dueDate: task.dueDate })
    expect(legacyNotesState(notes)).toBe(state)
    const before = await scoredCompletion(taskId), copies = async () => JSON.stringify([await db.commands.toArray(), await db.audits.toArray()])
    expect(await copies()).toContain(quoteFragment)
    expect(await migrateLegacyDetectionNotes()).toEqual({ migrated: 0, movedQuotes: 0, erasedQuotes: 0, review: state === 'edited' ? 1 : 0, scrubbedReceipts: 1 })
    expect(await copies()).not.toContain(quoteFragment)
    expect(await migrateLegacyDetectionNotes()).toMatchObject({ migrated: 0, scrubbedReceipts: 0 })
    const report = await deleteSource(sourceId, (await db.contextSources.get(sourceId))!.revision)
    expect(report.reviewTasks).toEqual([])
    expect(JSON.stringify(await captureSnapshot())).not.toContain(quoteFragment)
    expect(await db.tasks.get(taskId)).toEqual(before.task); expect((await db.tasks.get(taskId))!.notes).toBe(notes)
    expect(await db.completions.toArray()).toEqual(before.completions); expect(await db.ledger.toArray()).toEqual(before.ledger)
  })
  it('移行前に資料を削除しても、削除の処理で受領記録・監査の複写を消して件数を報告する', async () => {
    const sourceId = await importWorkSlack({ permissions: { aiEgress: false }, allowedModels: [] }), taskId = await legacyTask(sourceId), task = (await db.tasks.get(taskId))!
    await updateTask(taskId, task.revision, { ...newTaskInput(), title: task.title, notes: '', dueDate: task.dueDate })
    const report = await deleteSource(sourceId, (await db.contextSources.get(sourceId))!.revision)
    expect(report.erased.legacyCopies).toBeGreaterThan(0); expect(report.reviewTasks).toEqual([])
    expect(JSON.stringify(await captureSnapshot())).not.toContain(quoteFragment)
  })
  it('未移行の完全一致メモは削除結果で本人の編集メモと分けて示す', async () => {
    const sourceId = await importWorkSlack({ permissions: { aiEgress: false }, allowedModels: [] }), exact = await legacyTask(sourceId), edited = await legacyTask(sourceId, `${legacyNotes(sourceId)}\n本人の追記`)
    const report = await deleteSource(sourceId, (await db.contextSources.get(sourceId))!.revision)
    expect(report.reviewTasks).toEqual(expect.arrayContaining([{ id: exact, state: 'exact' }, { id: edited, state: 'edited' }]))
  })
  it('旧形式の期限の原文と同じ語を含む本人の訂正理由・受領記録・台帳は、移行で書き換えない', async () => {
    const sourceId = await importWorkSlack({ permissions: { aiEgress: false }, allowedModels: [] }), taskId = await legacyTask(sourceId, legacyNotes(sourceId).replace(`期限の原文: ${secretQuote}`, '期限の原文: 10月2日'))
    const task = (await db.tasks.get(taskId))!, reason = '10月2日の打合せ分は別タスクなので除いた'
    await updateTask(taskId, task.revision, { ...newTaskInput(), title: task.title, notes: task.notes, dueDate: task.dueDate, score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
    await completeTask(taskId, task.revision + 1); await correctCompletion(taskId, 35, reason)
    const completions = await db.completions.toArray(), ledger = await db.ledger.toArray(), receipts = (await db.commands.toArray()).filter(row => row.hash.includes(reason))
    expect(completions[0]).toMatchObject({ originalPoints: 40, netPoints: 35 }); expect(receipts).toHaveLength(1)
    expect(await migrateLegacyDetectionNotes()).toMatchObject({ migrated: 1 })
    expect((await db.audits.toArray()).find(row => row.operation === 'correct_points')!.detail).toBe(`35pt: ${reason}`)
    expect((await db.commands.toArray()).filter(row => row.hash.includes(reason))).toEqual(receipts)
    expect(await db.completions.toArray()).toEqual(completions); expect(await db.ledger.toArray()).toEqual(ledger)
    const notes = (await db.tasks.get(taskId))!.notes
    expect(notes).toContain('資料から検出し本人が採用した候補'); expect(notes).not.toContain('期限の原文'); expect(notes).not.toContain(quoteFragment)
  })
})

describe('K11 空白だけの補助引用もバックアップできる', () => {
  it.each([[' ', '上司: 次の件をお願いします'], ['　', '上司:　次の件をお願いします']])('補助引用%jを採用してもcaptureSnapshotと復元が通る', async (quote, firstLine) => {
    const sourceId = await importWorkSlack({ text: `${firstLine}\n${secretQuote}` }), row = (await db.contextSources.get(sourceId))!, settings = (await db.settings.get('main'))!
    const prepared = await prepareDetectionFromUI(sourceId, row.revision, settings.aiModel!, { confirmedAliases: [], authorIsOwner: false, existingTaskIds: [] }, humanClick())
    const base = syntheticTransport(prepared), span = prepared.request.sources[0].spans[0]
    const transport = { ...base, detect: async (payload: Parameters<typeof base.detect>[0]) => { const output = JSON.parse(await base.detect(payload)); output.changes[0].evidence.push({ source_id: sourceId, revision: 1, span_id: span.span_id, quote, supports: ['active'] }); return JSON.stringify(output) } }
    const run = await detectObligationsForSource(prepared, transport), confirmation = await prepareDetectionCreate(run, run.candidates[0].id)
    await applyDetectionCreateFromUI(run, confirmation, confirmation.digest, humanClick())
    expect((await db.taskSourceEvidence.toArray()).map(item => item.quote)).toEqual(expect.arrayContaining([quote]))
    const saved: Snapshot = await captureSnapshot()
    expect(saved.taskSourceEvidence).toHaveLength(2)
    await restoreBackup(saved)
    expect((await db.taskSourceEvidence.toArray()).map(item => item.quote).sort()).toEqual(saved.taskSourceEvidence!.map(item => item.quote).sort())
  })
})
