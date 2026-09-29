export const NAV_FEATURE_IDS = ['today', 'tasks', 'wall', 'projects', 'labels', 'saved', 'plan', 'periods', 'calendar', 'coach', 'focus', 'history', 'routines', 'habits', 'goals', 'journal', 'settings'] as const
export type NavigationId = typeof NAV_FEATURE_IDS[number]
export const DEFAULT_MOBILE_NAV: NavigationId[] = ['today', 'tasks', 'coach', 'history']

export function visibleNavigation(configured: string[] | undefined, platform: 'desktop' | 'mobile'): NavigationId[] {
  const selected = new Set(configured ?? (platform === 'desktop' ? NAV_FEATURE_IDS : DEFAULT_MOBILE_NAV))
  return NAV_FEATURE_IDS.filter(id => selected.has(id))
}

export function findNavigation(items: { view: NavigationId; label: string }[], query: string): NavigationId | null {
  const text = query.trim().toLocaleLowerCase('ja-JP')
  if (!text) return null
  return items.find(item => item.label.toLocaleLowerCase('ja-JP') === text || item.view === text)?.view
    ?? items.find(item => item.label.toLocaleLowerCase('ja-JP').includes(text))?.view ?? null
}
