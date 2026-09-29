import { db } from './db'
import type { Appearance } from './domain'

export const DEFAULT_APPEARANCE: Appearance = { theme: 'light', accent: 'violet', fontScale: 100, iconStyle: 'outline' }
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function validateAppearance(value: unknown): asserts value is Appearance {
  if (!isRecord(value) || Object.keys(value).length !== 4 || !['theme', 'accent', 'fontScale', 'iconStyle'].every(key => key in value)
    || !['light', 'soft', 'high-contrast'].includes(value.theme as string)
    || !['violet', 'blue', 'green', 'rose'].includes(value.accent as string)
    || ![90, 100, 110, 120].includes(value.fontScale as number)
    || !['outline', 'bold'].includes(value.iconStyle as string)) throw new Error('見た目の設定が不正です')
}

export function applyAppearance(value: Appearance | undefined): void {
  const selected = value ?? DEFAULT_APPEARANCE
  document.documentElement.dataset.theme = selected.theme
  document.documentElement.dataset.accent = selected.accent
  document.documentElement.dataset.iconStyle = selected.iconStyle
  document.documentElement.style.setProperty('--michi-scale', String(selected.fontScale / 100))
}

export async function saveAppearance(value: Appearance): Promise<void> {
  validateAppearance(value)
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('設定がありません')
    await db.settings.put({ ...settings, appearance: value })
  })
}

export async function updateAppearance(patch: Partial<Appearance>): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('設定がありません')
    const next = { ...(settings.appearance ?? DEFAULT_APPEARANCE), ...patch }
    validateAppearance(next)
    await db.settings.put({ ...settings, appearance: next })
  })
}
