import { db } from './db'
import type { CustomScreen, DashboardWidgetId, SmartList, Task } from './domain'
import { querySmartList } from './smart-lists'

export const DASHBOARD_WIDGETS: DashboardWidgetId[] = ['today', 'capacity', 'points', 'completed', 'sync']
export const DEFAULT_DASHBOARD_WIDGETS = [...DASHBOARD_WIDGETS]
export const DEFAULT_CUSTOM_SCREEN: CustomScreen = { leftListId: null, rightListId: null, topListId: null }

export function validateDashboardWidgets(value: DashboardWidgetId[]) {
  if (!Array.isArray(value) || value.length < 1 || value.length > DASHBOARD_WIDGETS.length || new Set(value).size !== value.length || value.some(id => !DASHBOARD_WIDGETS.includes(id))) throw new Error('ダッシュボードの項目が不正です')
}

export function validateCustomScreen(value: CustomScreen, lists: SmartList[], ownerId: string) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 3 || Object.keys(DEFAULT_CUSTOM_SCREEN).some(key => !Object.hasOwn(value, key))) throw new Error('カスタム画面が不正です')
  for (const key of ['leftListId', 'rightListId', 'topListId'] as const) if (value[key] !== null && (typeof value[key] !== 'string' || !lists.some(list => list.id === value[key] && list.ownerId === ownerId))) throw new Error('カスタム画面のSmart Listが不正です')
}

export async function saveDashboardWidgets(ids: DashboardWidgetId[]) {
  validateDashboardWidgets(ids)
  await db.settings.update('main', { dashboardWidgets: ids })
}

export async function saveCustomScreen(patch: Partial<CustomScreen>) {
  await db.transaction('rw', db.settings, db.smartLists, async () => {
    const settings = await db.settings.get('main'); if (!settings) throw new Error('設定がありません')
    const customScreen = { ...DEFAULT_CUSTOM_SCREEN, ...settings.customScreen, ...patch }
    validateCustomScreen(customScreen, await db.smartLists.toArray(), settings.profileId)
    await db.settings.update('main', { customScreen })
  })
}

export function customPanelTasks(listId: string | null, tasks: Task[], lists: SmartList[], ownerId: string) {
  const open = tasks.filter(task => !task.deletedAt && task.status === 'open')
  if (!listId) return open
  const list = lists.find(item => item.id === listId && item.ownerId === ownerId)
  return list ? querySmartList(list, open, ownerId) : []
}

/** File handoff is a manual review, never automatic sync: the card never claims 同期済み. */
export function dashboardSyncLabel(lastHandoffAt: string | null = null, mode: 'active' | 'frozen' | 'read_only' = 'active') {
  const value = mode === 'frozen' ? '移行のため凍結中' : mode === 'read_only' ? '移行済み（読み取り専用）' : '端末内'
  return { value, detail: lastHandoffAt ? `最終引継ぎ: ${new Date(lastHandoffAt).toLocaleString('ja-JP')}（手動の引継ぎ確認）` : '最終引継ぎ: なし（単独モード）' }
}
