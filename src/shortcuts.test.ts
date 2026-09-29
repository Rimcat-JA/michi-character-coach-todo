import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { DEFAULT_KEYBINDINGS, saveKeybinding, shortcutAction, taskDeepLink, taskIdFromHash } from './shortcuts'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })
const key = (overrides: Partial<Parameters<typeof shortcutAction>[0]> = {}) => ({ key: 'n', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, isComposing: false, keyCode: 78, ...overrides })

describe('キーボード操作', () => {
  it('日本語変換中と入力欄ではショートカットを発火しない', () => {
    expect(shortcutAction(key({ isComposing: true }), DEFAULT_KEYBINDINGS, false)).toBeNull()
    expect(shortcutAction(key({ keyCode: 229 }), DEFAULT_KEYBINDINGS, false)).toBeNull()
    expect(shortcutAction(key(), DEFAULT_KEYBINDINGS, true)).toBeNull()
    expect(shortcutAction(key(), DEFAULT_KEYBINDINGS, false)).toBe('newTask')
  })
  it('重複した割り当てを拒否し、元の設定を保つ', async () => {
    await saveKeybinding('newTask', 'Ctrl+Shift+N')
    await expect(saveKeybinding('quickJump', 'Ctrl+Shift+N')).rejects.toThrow('重複')
    expect((await db.settings.get('main'))?.keybindings).toMatchObject({ newTask: 'Ctrl+Shift+N', quickJump: 'Ctrl+Alt+K' })
  })
  it('タスクへのリンクを作り、対象IDを復元する', () => {
    const id = '031ed842-28f3-4582-b27e-c7b31a6b1311'
    const url = taskDeepLink('michi://app/index.html#today', id)
    expect(url).toBe(`michi://app/index.html#task/${id}`)
    expect(taskIdFromHash(new URL(url).hash)).toBe(id)
    expect(taskIdFromHash('#task/../../secret')).toBeNull()
  })
})
