import type { Settings, Appearance } from './domain'
import { DEFAULT_APPEARANCE, updateAppearance } from './appearance'

export default function AppearanceSettingsView({ settings, run }: { settings: Settings; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const current = settings.appearance ?? DEFAULT_APPEARANCE
  function update<K extends keyof Appearance>(key: K, value: Appearance[K]) { run(() => updateAppearance({ [key]: value }), '見た目を保存しました') }
  return <section className="card setting-section appearance-settings"><div className="setting-heading"><div><h2>見た目とマーカー</h2><p>色だけに頼らず、ポイントの手動・自動・未設定とエラーを文字でも表示します。</p></div></div><div className="form-grid">
    <label className="field">テーマ<select value={current.theme} onChange={event => update('theme', event.target.value as Appearance['theme'])}><option value="light">標準</option><option value="soft">やわらかい背景</option><option value="high-contrast">高コントラスト</option></select></label>
    <label className="field">アクセント色<select value={current.accent} onChange={event => update('accent', event.target.value as Appearance['accent'])}><option value="violet">紫</option><option value="blue">青</option><option value="green">緑</option><option value="rose">ローズ</option></select></label>
    <label className="field">文字と画面の大きさ<select value={current.fontScale} onChange={event => update('fontScale', Number(event.target.value) as Appearance['fontScale'])}>{[90, 100, 110, 120].map(value => <option key={value} value={value}>{value}%</option>)}</select></label>
    <label className="field">アイコンの線<select value={current.iconStyle} onChange={event => update('iconStyle', event.target.value as Appearance['iconStyle'])}><option value="outline">標準</option><option value="bold">太め</option></select></label>
  </div><p className="appearance-marker-preview"><span className="score-pill manual">25pt · 手動</span><span className="score-pill formula">25pt · 自動</span><span className="score-pill unset">未設定</span><span>エラー例: 入力を確認してください</span></p></section>
}
