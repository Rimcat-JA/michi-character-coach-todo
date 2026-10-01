import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { db, ensureSettings } from './db'
import { defaultSourcePermissions, importLocalSource } from './source-library'
import { createCoachConversation, setConversationRetention } from './chat-history'
import { importSelectedExternalMessagesFromUI, prepareExternalMessageImport } from './external-message-import'
import { makeWebCaptureCapsule, prepareWebCaptureImport, saveCaptureImportFromUI } from './web-capture-import'
import { clearDetectionAuthority, detectObligationsForSource, prepareDetectionFromUI } from './detection-run'
import { purgeExpiredCoachContext } from './context-retention'
import { migrateLegacyDetectionNotes } from './task-source-evidence'
import { retentionDefaults, retentionDraft, retentionFromDateInput, retentionValue } from './retention-defaults'
import RetentionChoice from './RetentionChoice'
import { unlimitedRetentionNotice } from './retention-notice'
import { adoptDetectedTask, enableSyntheticAI, humanClick, importWorkSlack, syntheticTransport } from './source-quote-fixtures'

const now = '2026-10-01T03:00:00.000Z', plus = (days: number) => new Date(Date.parse(now) + days * 86400000).toISOString()
beforeEach(async () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now)); await db.delete(); await db.open(); await ensureSettings(); clearDetectionAuthority() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const line = '[LINE] 友人とのトーク履歴\n保存日時：2026/10/01 12:00\n\n2026/10/01(木)\n09:01\t友人\t資料を明日までに送ってください\n'
const source = (provider: 'slack' | 'local', retentionUntil?: string | null) => importLocalSource({ title: `${provider}の資料`, provider, externalId: `${provider}-${crypto.randomUUID()}`, conversation: null, author: null, sourceUrl: null, date: '2026-10-01', fromDate: '2026-10-01', toDate: '2026-10-01', text: '本文', permissions: defaultSourcePermissions(), allowedModels: [], ...(retentionUntil === undefined ? {} : { retentionUntil }) })

describe('K11 設計23.2の既定保持期間', () => {
  it('取込会話は90日・ローカル文書は本人選択（既定なし）、明示的なnullは長期保存として保存する', async () => {
    expect(retentionDefaults).toEqual({ importedConversationDays: 90, coachConversationDays: 180, rejectedCandidateDays: 30 })
    expect((await db.contextSources.get(await source('slack')))!.retentionUntil).toBe(plus(90))
    expect((await db.contextSources.get(await source('local')))!.retentionUntil).toBeNull()
    expect((await db.contextSources.get(await source('slack', null)))!.retentionUntil).toBeNull()
  })
  it('LINE・Web引用の取込も既定で90日、画面で『期限なし』を選ぶとnullで保存する', async () => {
    let preview = await prepareExternalMessageImport({ provider: 'line', filename: '選んだLINE.txt', raw: line, timezone: 'Asia/Tokyo', fromDate: '2026-10-01', toDate: '2026-10-01' })
    let result = await importSelectedExternalMessagesFromUI(preview, preview.messages.map(message => message.id), humanClick())
    expect((await db.contextSources.get(result.sourceIds[0]))!.retentionUntil).toBe(plus(90))
    await db.contextSources.clear(); await db.contextSnapshots.clear(); await db.commands.clear()
    preview = await prepareExternalMessageImport({ provider: 'line', filename: '選んだLINE.txt', raw: line, timezone: 'Asia/Tokyo', fromDate: '2026-10-01', toDate: '2026-10-01' })
    result = await importSelectedExternalMessagesFromUI(preview, preview.messages.map(message => message.id), humanClick(), retentionValue({ date: '', unlimited: true }))
    expect((await db.contextSources.get(result.sourceIds[0]))!.retentionUntil).toBeNull()
    const capsule = makeWebCaptureCapsule({ title: 'Web引用', url: 'https://example.invalid/page', quote: '選んだ一文', timezone: 'Asia/Tokyo' })
    const web = await prepareWebCaptureImport(capsule)
    expect(web.retentionUntil).toBe(plus(90))
    expect((await db.contextSources.get((await saveCaptureImportFromUI(web, humanClick())).sourceId))!.retentionUntil).toBe(plus(90))
    expect((await prepareWebCaptureImport(makeWebCaptureCapsule({ ...capsule, quote: '別の一文' }), null)).retentionUntil).toBeNull()
    await expect(prepareWebCaptureImport(capsule, '2026-09-30T00:00:00.000Z')).rejects.toThrow('保持期限')
  })
  it('コーチ会話は既定180日、本人が期限なしを明示すればnullで保存できる', async () => {
    const id = await createCoachConversation('既定の会話', 'Asia/Tokyo')
    expect((await db.coachConversations.get(id))!.retentionUntil).toBe(plus(180))
    await setConversationRetention(id, 1, null)
    expect((await db.coachConversations.get(id))!.retentionUntil).toBeNull()
    expect((await db.coachConversations.get(await createCoachConversation('長期保存の会話', 'Asia/Tokyo', null)))!.retentionUntil).toBeNull()
  })
  it('30日を過ぎた未採用の検出候補だけを消し、採用タスク・資料の根拠・承認監査は残す', async () => {
    await enableSyntheticAI()
    const sourceId = await importWorkSlack(), adopted = await adoptDetectedTask(sourceId)
    vi.setSystemTime(new Date(plus(20)))
    const row = (await db.contextSources.get(sourceId))!, settings = (await db.settings.get('main'))!
    const prepared = await prepareDetectionFromUI(sourceId, row.revision, settings.aiModel!, { confirmedAliases: [], authorIsOwner: false, existingTaskIds: [] }, humanClick())
    const newer = await detectObligationsForSource(prepared, syntheticTransport(prepared, '別の未採用候補'))
    vi.setSystemTime(new Date(plus(30)))
    await purgeExpiredCoachContext()
    expect((await db.sourceArtifacts.toArray()).map(item => item.id)).toEqual([`detection:${newer.id}`])
    expect(await db.tasks.get(adopted.taskId)).toMatchObject({ title: '非公開見積を送る' })
    expect(await db.taskSourceEvidence.where('taskId').equals(adopted.taskId).count()).toBe(1)
    expect((await db.audits.toArray()).filter(audit => audit.operation === 'detection.approved')).toHaveLength(1)
    vi.setSystemTime(new Date(plus(50)))
    await purgeExpiredCoachContext()
    expect(await db.sourceArtifacts.count()).toBe(0)
  })
  it('既存データの期限は書き換えず、画面の期限なしは明示選択だけを受け付ける', async () => {
    const legacy = await source('slack', null), conversation = await createCoachConversation('既存の長期保存', 'Asia/Tokyo', null)
    await purgeExpiredCoachContext(); await migrateLegacyDetectionNotes()
    expect((await db.contextSources.get(legacy))!.retentionUntil).toBeNull(); expect((await db.coachConversations.get(conversation))!.retentionUntil).toBeNull()
    const store = new Map<string, string>(), storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } }
    await source('local', null); await source('slack')
    expect(await unlimitedRetentionNotice(storage)).toContain('既存の期限なし：取込会話1件・コーチ会話1件は変更していません')
    expect(await unlimitedRetentionNotice(storage)).toBeNull()
    expect((await db.contextSources.get(legacy))!.retentionUntil).toBeNull()
    expect(() => retentionFromDateInput('', false)).toThrow('期限なし（長期保存）')
    expect(retentionFromDateInput('', true)).toBeNull()
    const localDate = new Date(plus(90)).toLocaleDateString('sv-SE')
    expect(retentionDraft(plus(90))).toEqual({ date: localDate, unlimited: false })
    const markup = renderToStaticMarkup(<RetentionChoice label="取り込む発言の保持期限" value={retentionDraft(plus(90))} onChange={() => {}} defaultNote="既定は90日" />)
    expect(markup).toContain(`value="${localDate}"`); expect(markup).toContain('期限なし（長期保存）を本人が選ぶ'); expect(markup).not.toContain('checked')
  })
})
