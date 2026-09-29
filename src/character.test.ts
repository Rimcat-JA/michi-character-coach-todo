import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { characterizeAnswer, DEFAULT_CHARACTER, saveCharacterProfile } from './character'
import { setReminderPolicy } from './reminders'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('キャラクターと権限の分離', () => {
  it('率直な口調に変更しても通知上限・公開/自動化設定は変わらない', async () => {
    await setReminderPolicy({ dailyCap: 2 })
    await db.settings.update('main', { notifications: false, automation: 'A1', aiEnabled: false })
    const before = await db.settings.get('main')
    await saveCharacterProfile({ tone: 'direct', coachingStyle: 'practical', pronoun: '僕' })
    const after = await db.settings.get('main')
    expect(after?.characterProfile).toMatchObject({ tone: 'direct', coachingStyle: 'practical', pronoun: '僕' })
    expect(after?.reminderState).toEqual(before?.reminderState)
    expect(after?.notifications).toBe(false)
    expect(after?.automation).toBe('A1')
    expect(after?.aiEnabled).toBe(false)
    expect(after?.profileId).toBe(before?.profileId)
  })
  it('避ける言い方を端末内の定型応答から除き、元の文は変更しない', () => {
    const source = '大丈夫です。まず一件進めましょう。'
    const result = characterizeAnswer(source, { ...DEFAULT_CHARACTER, tone: 'direct', avoidPhrases: ['大丈夫'] })
    expect(result).not.toContain('大丈夫')
    expect(result).toContain('要点から整理します')
    expect(source).toBe('大丈夫です。まず一件進めましょう。')
  })
})
