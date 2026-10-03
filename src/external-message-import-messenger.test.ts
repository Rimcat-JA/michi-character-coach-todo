import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { confirmImportedSpeakerFromUI, importSelectedExternalMessagesFromUI, prepareExternalMessageImport, type ExternalImportInput } from './external-message-import'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })
function click() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
const base = (raw: string, patch: Partial<ExternalImportInput> = {}): ExternalImportInput => ({ provider: 'telegram', filename: '選択したTelegram.json', raw, timezone: 'Asia/Tokyo', fromDate: '2026-10-01', toDate: '2026-10-01', ...patch })
const telegram = {
  name: '本人とのDM', type: 'personal_chat', id: 111,
  messages: [
    { id: 1, type: 'message', date: '2026-10-01T09:00:00', from: '本人', from_id: 'user1', text: '見積書を送ります' },
    { id: 2, type: 'message', date: '2026-10-01T09:05:00', from: '相手', from_id: 'user2', text: [{ type: 'bold', text: '了解' }, 'です'] },
    { id: 3, type: 'service', date: '2026-10-01T09:06:00', action: 'invite', actor: 'user1' },
    { id: 4, type: 'message', date: '2026-10-01T09:10:00', from: '相手', from_id: 'user2', text: '', photo: 'photo-file' },
  ],
}
const slackDay = () => {
  const ts = (iso: string) => `${Date.parse(iso) / 1000}.000100`
  return [
    { ts: ts('2026-09-30T15:00:00.000Z'), user: 'U111', text: '今日の見積を共有します' },
    { ts: ts('2026-09-30T15:05:00.000Z'), user: 'U222', text: '確認しました', thread_ts: ts('2026-09-30T15:00:00.000Z') },
    { ts: ts('2026-09-30T15:10:00.000Z'), subtype: 'bot_message', bot_id: 'B999', text: 'リマインダー' },
  ]
}

describe('TelegramとSlackの厳格な手動取込', () => {
  it('Telegramの壁時刻・話者ID・装飾・service・添付を区別し、期間外を保存しない', async () => {
    const preview = await prepareExternalMessageImport(base(JSON.stringify(telegram)))
    expect(preview.conversation).toBe('本人とのDM')
    expect(preview.originalMessageCount).toBe(4)
    expect(preview.messages).toHaveLength(4)
    expect(preview.messages[0]).toMatchObject({ localDate: '2026-10-01', localTime: '09:00:00', sentAt: '2026-10-01T00:00:00.000Z', actorKey: 'telegram-id:user1', authorLabel: '本人' })
    expect(preview.messages[1].body).toBe('了解です')
    expect(preview.messages[1].warnings.some(w => w.includes('装飾'))).toBe(true)
    expect(preview.messages[2].kind).toBe('system')
    expect(preview.messages[3].kind).toBe('attachment-only')
    expect(preview.speakers).toEqual([
      { key: 'telegram-id:user1', label: '本人', idBased: true },
      { key: 'telegram-id:user2', label: '相手', idBased: true },
    ])
    await importSelectedExternalMessagesFromUI(preview, preview.messages.map(m => m.id), click())
    expect(await db.contextSources.count()).toBe(4)
    expect((await db.contextSources.toArray()).every(s => s.provider === 'telegram')).toBe(true)
    expect(await db.tasks.count()).toBe(0)
    // Same file re-import is a no-op per message.
    const again = await prepareExternalMessageImport(base(JSON.stringify(telegram)))
    const second = await importSelectedExternalMessagesFromUI(again, again.messages.map(m => m.id), click())
    expect(second).toMatchObject({ created: 0, duplicates: 4 })
  })

  it('Telegramの不正形式・重複・未来編集・空本文を拒否する', async () => {
    await expect(prepareExternalMessageImport(base(JSON.stringify({ name: 'x' })))).rejects.toThrow()
    await expect(prepareExternalMessageImport(base(JSON.stringify({ ...telegram, messages: 'nope' })))).rejects.toThrow()
    await expect(prepareExternalMessageImport(base(JSON.stringify({ name: 'x', type: 'personal_chat', messages: [{ id: 1, type: 'message', date: 'not-a-date', from: 'a', from_id: 'u', text: 'hi' }] })))).rejects.toThrow('日時')
    await expect(prepareExternalMessageImport(base('[{"__proto__":{}}]'))).rejects.toThrow()
    const empty = structuredClone(telegram)
    empty.messages = [{ id: 9, type: 'message', date: '2026-10-01T10:00:00', from: 'a', from_id: 'u', text: '   ' }]
    await expect(prepareExternalMessageImport(base(JSON.stringify(empty)))).rejects.toThrow('空です')
  })

  it('SlackのUTC時刻・話者ID・スレッド・botを保持し、period外を保存しない', async () => {
    const preview = await prepareExternalMessageImport({ ...base(JSON.stringify(slackDay()), { provider: 'slack', filename: 'Slack日次.json', conversation: '本人が選択したSlack会話' }) })
    expect(preview.messages).toHaveLength(3)
    expect(preview.messages[0]).toMatchObject({ localDate: '2026-10-01', localTime: '00:00:00', sentAt: '2026-09-30T15:00:00.000Z', actorKey: 'slack-id:U111' })
    expect(preview.messages[1].warnings.some(w => w.includes('スレッド'))).toBe(true)
    expect(preview.messages[2].kind).toBe('system')
    expect(preview.speakers).toEqual([{ key: 'slack-id:U111', label: 'U111', idBased: true }, { key: 'slack-id:U222', label: 'U222', idBased: true }])
    await importSelectedExternalMessagesFromUI(preview, [preview.messages[0].id], click())
    expect(await db.contextSources.count()).toBe(1)
    expect(JSON.stringify(await db.contextSources.toArray())).not.toContain('リマインダー')
    await expect(prepareExternalMessageImport({ ...base('[{"ts":"bad","user":"U1","text":"x"}]', { provider: 'slack', filename: 's.json' }) })).rejects.toThrow('ts')
    await expect(prepareExternalMessageImport({ ...base(JSON.stringify([{ ts: '1759276800.000100', user: 'U1', text: 'x', extra: 1 }]), { provider: 'slack', filename: 's.json' }) })).rejects.toThrow('対応外')
  })

  it('K02: 別providerの本人確認は統合されず、共有グループへ無条件に展開しない', async () => {
    const line = '﻿[LINE] 友人とのトーク履歴\r\n2026/10/01(木)\r\n09:00\t私\t了解しました\r\n'
    const linePreview = await prepareExternalMessageImport({ provider: 'line', filename: 'LINE.txt', raw: line, timezone: 'Asia/Tokyo', fromDate: '2026-10-01', toDate: '2026-10-01' })
    await confirmImportedSpeakerFromUI(linePreview, 'line-name:私', click())
    await importSelectedExternalMessagesFromUI(linePreview, linePreview.messages.map(m => m.id), click())
    const tgPreview = await prepareExternalMessageImport(base(JSON.stringify(telegram)))
    // Cross-provider keys are never confirmable here: each import confirms only its own speakers.
    await expect(confirmImportedSpeakerFromUI(tgPreview, 'line-name:私', click())).rejects.toThrow()
    await confirmImportedSpeakerFromUI(tgPreview, 'telegram-id:user1', click())
    await importSelectedExternalMessagesFromUI(tgPreview, [tgPreview.messages[0].id], click())
    const sources = await db.contextSources.toArray()
    expect(sources.map(s => s.provider).sort()).toEqual(['line', 'telegram'])
    expect(new Set(sources.map(s => s.conversation)).size).toBe(2)
    // A shared group import stays labeled and never merges into the personal DM.
    const group = await prepareExternalMessageImport(base(JSON.stringify({ ...telegram, name: '共有グループ', type: 'supergroup' })))
    expect(group.messages[0].warnings.some(w => w.includes('無条件に展開しません') || w.includes('共有グループ'))).toBe(true)
    expect(group.messages[0].actorKey).toBe('telegram-id:user1')
  })
})
