import 'fake-indexeddb/auto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput } from './commands'
import { createGoal, createGoalCheckIn } from './goals'
import { updateAIConnection } from './ai-connection'
import { defaultSourcePermissions, deleteSource, importLocalSource, setSourcePermissions } from './source-library'
import { appendCoachReply, beginCoachTurn, cancelCoachTurn, clearCoachTurnAuthority, createCoachConversation, deleteCoachConversation, readCoachConversation, saveCoachDraft, searchCoachHistory } from './chat-history'
import { validateChatHistoryRecords } from './chat-history-validation'

const model = 'deepseek/deepseek-v4.1-flash'
let ownerId: string
beforeEach(async () => { clearCoachTurnAuthority(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T03:00:00.000Z')); await db.delete(); await db.open(); ownerId = (await ensureSettings()).profileId })
afterEach(() => { vi.useRealTimers() })
const saved = async () => ({ conversations: await db.coachConversations.toArray(), messages: (await db.coachMessages.toArray()).sort((a, b) => a.conversationId.localeCompare(b.conversationId) || a.sequence - b.sequence) })
async function source(aiEgress = true) { return importLocalSource({ title: `選択資料${aiEgress}`, provider: 'slack', externalId: null, conversation: null, author: null, sourceUrl: null, date: '2026-10-01', fromDate: '2026-09-02', toDate: '2026-10-01', text: '選択した資料本文', permissions: { ...defaultSourcePermissions(), aiEgress }, allowedModels: aiEgress ? [model] : [], retentionUntil: null }) }

describe('ローカルのコーチ会話履歴', () => {
  it('AI OFFでも本人draftと会話を再読込でき、本人・定型応答の由来を分ける', async () => {
    const id = await createCoachConversation('本人の会話', 'Asia/Tokyo')
    expect(await saveCoachDraft(id, 1, '今日は疲れました\n少し休みます')).toBe(2)
    const { conversation: row } = await readCoachConversation(id)
    expect(row.draft).toContain('少し休みます')
    const turn = await beginCoachTurn(id, row.revision, { text: row.draft, mode: 'local' })
    await appendCoachReply(turn, '端末内の定型応答です', 'template')
    await db.close(); await db.open()
    const result = await readCoachConversation(id)
    expect(result.conversation.draft).toBe('')
    expect(result.messages.map(item => [item.role, item.origin, item.model, item.provider])).toEqual([['user', 'human', null, null], ['assistant', 'template', null, null]])
    expect(result.messages[0].text).toBe(row.draft)
    const snapshot = await saved(); expect(() => validateChatHistoryRecords(snapshot.conversations, snapshot.messages, ownerId)).not.toThrow()
  })

  it('楽観排他で古いdraft保存を拒否し、送信中の別のdraftを消さない', async () => {
    const id = await createCoachConversation()
    await saveCoachDraft(id, 1, 'まだ送らない新しい下書き')
    await expect(saveCoachDraft(id, 1, '古い画面の下書き')).rejects.toThrow('別の画面')
    const turn = await beginCoachTurn(id, 1, { text: '先に送った本文', mode: 'local' })
    await saveCoachDraft(id, 2, '応答待ちに書き足した下書き')
    await appendCoachReply(turn, '定型応答', 'template')
    expect((await readCoachConversation(id)).conversation.draft).toBe('応答待ちに書き足した下書き')
  })

  it('選択task/goal/checkinだけを一時contextへ入れ、ID・版・digestのみprovenance保存する', async () => {
    await updateAIConnection(true, model)
    const taskId = await createTask({ ...newTaskInput(), title: '送るタスク', notes: '選択したメモ' })
    await createTask({ ...newTaskInput(), title: '選択していない秘密タスク' })
    const goalId = await createGoal({ title: '本人の目標', description: '', parentId: null, dueDate: null, containerId: null, taskIds: [], habitIds: [], manualPercent: null, checkInCadence: null, checkInQuestion: '' })
    const checkInId = await createGoalCheckIn(goalId, '2026-10-01', '本人の回答', '現行要約')
    const id = await createCoachConversation(), turn = await beginCoachTurn(id, 1, { text: '選択分だけ相談', mode: 'ai', taskId, goalId })
    expect(turn.selectedContext).toContain('送るタスク'); expect(turn.selectedContext).toContain('本人の回答'); expect(turn.selectedContext).not.toContain('秘密タスク')
    expect(turn.selectedSources).toMatchObject([{ kind: 'task', id: taskId, revision: 1 }, { kind: 'goal', id: goalId }, { kind: 'goal-checkin', id: checkInId, digest: expect.stringMatching(/^[a-f0-9]{64}$/) }])
    await appendCoachReply(turn, '実際に受信したAI応答', 'live_ai')
    const snapshot = await saved()
    expect(JSON.stringify(snapshot)).not.toContain('選択したメモ')
    expect(snapshot.messages[1]).toMatchObject({ role: 'assistant', origin: 'live_ai', model, provider: 'openrouter', replyTo: turn.userMessageId })
    expect(() => validateChatHistoryRecords(snapshot.conversations, snapshot.messages, ownerId)).not.toThrow()
  })

  it('AI停止と選択task変更後の遅い応答を拒否し、失敗は本人本文と区別して残す', async () => {
    await updateAIConnection(true, model)
    const taskId = await createTask({ ...newTaskInput(), title: '当初のタスク' }), id = await createCoachConversation()
    const turn = await beginCoachTurn(id, 1, { text: '送信した本人本文', mode: 'ai', taskId })
    await updateAIConnection(false)
    await expect(appendCoachReply(turn, '停止後のAI応答', 'live_ai')).rejects.toThrow('別の画面')
    await expect(appendCoachReply(turn, 'AIを停止したため応答を保存しませんでした', 'notice')).rejects.toThrow('別の画面')
    await cancelCoachTurn(id, turn.userMessageId)
    const first = await readCoachConversation(id)
    expect(first.messages[0].text).toBe('送信した本人本文'); expect(first.messages).toHaveLength(1)
    await updateAIConnection(true, model)
    const next = await beginCoachTurn(id, first.conversation.revision, { text: '現在の内容を相談', mode: 'ai', taskId })
    await db.tasks.update(taskId, { title: '変更後のタスク', revision: 2 })
    await expect(appendCoachReply(next, '変更前の応答', 'live_ai')).rejects.toThrow('別の画面')
    await cancelCoachTurn(id, next.userMessageId)
    expect((await readCoachConversation(id)).conversation.pendingMessageId).toBeNull()
  })

  it('会話削除で本人本文・reply・draftを物理削除し、遅い応答と再検索を拒否する', async () => {
    const id = await createCoachConversation('削除対象')
    await saveCoachDraft(id, 1, '削除する秘密draft')
    const turn = await beginCoachTurn(id, 1, { text: '削除する秘密会話', mode: 'local' })
    await deleteCoachConversation(id, 2)
    expect(await db.coachMessages.count()).toBe(0)
    const snapshot = await saved()
    expect(JSON.stringify(snapshot)).not.toContain('秘密')
    expect(snapshot.conversations[0]).toMatchObject({ title: '削除した会話', draft: '', pendingMessageId: null, deletedAt: expect.any(String) })
    await expect(appendCoachReply(turn, '削除後の応答', 'template')).rejects.toThrow('別の画面')
    expect((await searchCoachHistory('秘密', '2026-01-01', '2026-10-01')).hits).toEqual([])
    expect(() => validateChatHistoryRecords(snapshot.conversations, snapshot.messages, ownerId)).not.toThrow()
  })

  it('owner/dataset・二重送信・turn改変を拒否し、キー/接続設定を保存しない', async () => {
    const id = await createCoachConversation(), turn = await beginCoachTurn(id, 1, { text: '本人だけの会話', mode: 'local' })
    await expect(beginCoachTurn(id, 2, { text: '並行送信', mode: 'local' })).rejects.toThrow('応答を待っています')
    await expect(appendCoachReply({ ...turn, selectedContext: '改変した送信context' }, '応答', 'template')).rejects.toThrow('別の画面')
    await db.settings.update('main', { profileId: 'other-owner' })
    await expect(readCoachConversation(id)).rejects.toThrow('本人の会話')
    expect((await searchCoachHistory('本人', '2026-01-01', '2026-10-01')).hits).toEqual([])
    await db.settings.update('main', { profileId: ownerId, datasetId: 'restored-dataset' })
    await expect(appendCoachReply(turn, '旧datasetの応答', 'template')).rejects.toThrow('別の画面')
    expect(JSON.stringify(await saved())).not.toMatch(/apiKey|keyInput|secureStorage|authorization|endpoint/)
  })

  it('source送信許可なしではAIを開始せず、取消は資料由来replyのみ消し本人会話を残す', async () => {
    await updateAIConnection(true, model)
    const deniedSourceId = await source(false), id = await createCoachConversation()
    await expect(beginCoachTurn(id, 1, { text: '送信しない', mode: 'ai', sourceIds: [deniedSourceId] })).rejects.toThrow('AI送信')
    expect(await db.coachMessages.count()).toBe(0)
    const sourceId = await source(true), turn = await beginCoachTurn(id, 1, { text: '本人の相談', mode: 'ai', sourceIds: [sourceId] })
    await appendCoachReply(turn, '資料から得た秘密の応答', 'live_ai')
    await setSourcePermissions(sourceId, 1, defaultSourcePermissions(), [], null)
    expect((await readCoachConversation(id)).messages.map(item => item.text)).toEqual(['本人の相談'])
    expect(JSON.stringify(await saved())).not.toContain('資料から得た秘密')
    const current = (await readCoachConversation(id)).conversation
    await setSourcePermissions(sourceId, 2, { ...defaultSourcePermissions(), aiEgress: true }, [model], null)
    const pending = await beginCoachTurn(id, current.revision, { text: '取消後の新しい相談', mode: 'ai', sourceIds: [sourceId] })
    await deleteSource(sourceId, 3)
    await expect(appendCoachReply(pending, '削除資料からの遅い応答', 'live_ai')).rejects.toThrow('別の画面')
    expect((await readCoachConversation(id)).conversation.pendingMessageId).toBeNull()
  })

  it('ローカルtimezoneの期間を検索し、引用offsetと未取得範囲を正直に返す', async () => {
    vi.setSystemTime(new Date('2026-09-30T15:30:00.000Z'))
    const id = await createCoachConversation('日本時間の会話', 'Asia/Tokyo'), turn = await beginCoachTurn(id, 1, { text: '資料の締め切りは来週です', mode: 'local' })
    await appendCoachReply(turn, '定型応答', 'template')
    const result = await searchCoachHistory('締め切り', '2026-10-01', '2026-10-01')
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].message.text.slice(result.hits[0].start, result.hits[0].end)).toBe(result.hits[0].quote)
    expect(result.coverage).toEqual({ fromDate: '2026-10-01', toDate: '2026-10-01', complete: false })
    const old = await searchCoachHistory('資料', '2026-03-01', '2026-03-31')
    expect(old.hits).toEqual([]); expect(old.notice).toContain('未取得期間'); expect(old.notice).not.toContain('全履歴確認済み')
  })

  it('restore/AI設定変更のauthority失効後も本人本文と新しいdraftを保存し、待機解除できる', async () => {
    const id = await createCoachConversation(), turn = await beginCoachTurn(id, 1, { text: '復元前からの本人本文', mode: 'local' })
    await saveCoachDraft(id, 1, '新しい本人draft')
    clearCoachTurnAuthority()
    await expect(appendCoachReply(turn, '失効後の遅い応答', 'template')).rejects.toThrow('別の画面')
    await cancelCoachTurn(id, turn.userMessageId)
    const result = await readCoachConversation(id)
    expect(result.conversation).toMatchObject({ pendingMessageId: null, draft: '新しい本人draft' })
    expect(result.messages.map(message => message.text)).toEqual(['復元前からの本人本文'])
  })

  it('旧backup省略を許し、不正owner/role/reply/sequence/日時/追加secret字段を拒否する', async () => {
    expect(() => validateChatHistoryRecords(undefined, undefined, ownerId)).not.toThrow()
    const id = await createCoachConversation(), turn = await beginCoachTurn(id, 1, { text: '検証する会話', mode: 'local' })
    await appendCoachReply(turn, '定型応答', 'template')
    const snapshot = await saved()
    const mutations = [
      (data: typeof snapshot) => { data.messages[0].ownerId = 'other' },
      (data: typeof snapshot) => { data.messages[0].role = 'assistant' },
      (data: typeof snapshot) => { data.messages[1].replyTo = 'missing' },
      (data: typeof snapshot) => { data.messages[1].sequence = data.messages[0].sequence },
      (data: typeof snapshot) => { data.messages[1].createdAt = '2026-02-30T00:00:00.000Z' },
      (data: typeof snapshot) => { Object.assign(data.messages[1], { apiKey: 'fixture-secret' }) },
      (data: typeof snapshot) => { data.conversations[0].pendingMessageId = data.messages[0].id },
    ]
    for (const mutate of mutations) { const data = structuredClone(snapshot); mutate(data); expect(() => validateChatHistoryRecords(data.conversations, data.messages, ownerId)).toThrow('不正') }
  })
})
