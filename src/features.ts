import { NAV_FEATURE_IDS, type NavigationId } from './navigation'
import { db } from './db'

export const OPTIONAL_FEATURE_IDS: NavigationId[] = NAV_FEATURE_IDS.filter(id => id !== 'settings')

export function featureEnabled(hidden: string[] | undefined, id: string): boolean {
  return id === 'settings' || !hidden?.includes(id)
}

export async function setFeatureVisible(id: NavigationId, visible: boolean): Promise<void> {
  if (!OPTIONAL_FEATURE_IDS.includes(id)) throw new Error('この機能は非表示にできません')
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('設定がありません')
    const current = settings.hiddenFeatures ?? []
    const hiddenFeatures = visible ? current.filter(value => value !== id) : [...new Set([...current, id])]
    await db.settings.put({ ...settings, hiddenFeatures })
  })
}
