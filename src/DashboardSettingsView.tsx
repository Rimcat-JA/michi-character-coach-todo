import type { DashboardWidgetId, Settings } from './domain'
import { DASHBOARD_WIDGETS, DEFAULT_DASHBOARD_WIDGETS, saveDashboardWidgets } from './dashboard'

const labels: Record<DashboardWidgetId, string> = { today: '今日の予定', capacity: '予定時間', points: '必要ポイント', completed: '今日の実績', sync: '保存・同期状態' }

export default function DashboardSettingsView({ settings, run }: { settings: Settings; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const selected = settings.dashboardWidgets ?? DEFAULT_DASHBOARD_WIDGETS
  function toggle(id: DashboardWidgetId, enabled: boolean) { const next = enabled ? [...selected, id] : selected.filter(value => value !== id); void run(() => saveDashboardWidgets(next), 'ダッシュボードを保存しました') }
  function move(id: DashboardWidgetId, delta: number) { const next = [...selected], index = next.indexOf(id), target = index + delta; if (target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; void run(() => saveDashboardWidgets(next), 'ダッシュボードを保存しました') }
  return <section className="card setting-section dashboard-settings"><div className="setting-heading"><div><h2>ダッシュボード</h2><p>今日のカードを選び、並び順を変えます。保存・同期状態は単独端末として表示します。</p></div></div><div className="dashboard-widget-settings">{DASHBOARD_WIDGETS.map(id => <div className="setting-line" key={id}><label><input type="checkbox" checked={selected.includes(id)} onChange={event => toggle(id, event.target.checked)} /> {labels[id]}</label><div className="export-buttons"><button className="secondary-button" disabled={!selected.includes(id) || selected.indexOf(id) === 0} onClick={() => move(id, -1)} aria-label={`${labels[id]}を前へ`}>↑</button><button className="secondary-button" disabled={!selected.includes(id) || selected.indexOf(id) === selected.length - 1} onClick={() => move(id, 1)} aria-label={`${labels[id]}を後へ`}>↓</button></div></div>)}</div></section>
}
