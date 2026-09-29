import { db } from './db'
import type { Keybindings } from './domain'

export type ShortcutAction = keyof Keybindings
export const SHORTCUT_CHOICES = ['Ctrl+Alt+N', 'Ctrl+Alt+K', 'Ctrl+Alt+S', 'Ctrl+Shift+N', 'Ctrl+Shift+K', 'Ctrl+Shift+S'] as const
export const DEFAULT_KEYBINDINGS: Keybindings = { newTask: 'Ctrl+Alt+N', quickJump: 'Ctrl+Alt+K', settings: 'Ctrl+Alt+S' }

export function validateKeybindings(value: Keybindings) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 3 || Object.keys(DEFAULT_KEYBINDINGS).some(key => !Object.hasOwn(value, key))) throw new Error('キー設定が不正です')
  const selected = Object.values(value)
  if (selected.some(key => !SHORTCUT_CHOICES.includes(key as typeof SHORTCUT_CHOICES[number])) || new Set(selected).size !== selected.length) throw new Error('キーの重複または未対応の組み合わせです')
}

export async function saveKeybinding(action: ShortcutAction, shortcut: string) {
  if (!Object.hasOwn(DEFAULT_KEYBINDINGS, action)) throw new Error('操作が不正です')
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main'); if (!settings) throw new Error('設定がありません')
    const keybindings = { ...DEFAULT_KEYBINDINGS, ...settings.keybindings, [action]: shortcut }
    validateKeybindings(keybindings)
    await db.settings.update('main', { keybindings })
  })
}

export function isEditableTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null
  return !!element && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable || !!element.closest?.('[contenteditable="true"]'))
}

export function shortcutAction(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing' | 'keyCode'>, bindings: Keybindings, editing: boolean): ShortcutAction | null {
  if (editing || event.isComposing || event.keyCode === 229 || event.metaKey) return null
  const key = event.key.toUpperCase()
  if (key.length !== 1 || !/[A-Z]/.test(key)) return null
  const pressed = [event.ctrlKey ? 'Ctrl' : null, event.altKey ? 'Alt' : null, event.shiftKey ? 'Shift' : null, key].filter(Boolean).join('+')
  return (Object.keys(bindings) as ShortcutAction[]).find(action => bindings[action] === pressed) ?? null
}

export function taskDeepLink(base: string, taskId: string) {
  const url = new URL(base)
  url.hash = `task/${encodeURIComponent(taskId)}`
  return url.toString()
}

export function taskIdFromHash(hash: string) {
  if (!hash.startsWith('#task/')) return null
  try { const value = decodeURIComponent(hash.slice(6)); return /^[0-9a-f-]{36}$/i.test(value) ? value : null }
  catch { return null }
}
