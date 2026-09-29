import type { Settings } from './domain'
import { DEFAULT_KEYBINDINGS, SHORTCUT_CHOICES, saveKeybinding, type ShortcutAction } from './shortcuts'

export default function ShortcutSettingsView({ settings, run }: { settings: Settings; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const bindings = settings.keybindings ?? DEFAULT_KEYBINDINGS
  const labels: Record<ShortcutAction, string> = { newTask: '新しいタスク', quickJump: 'クイックジャンプ', settings: '設定を開く' }
  return <section className="card setting-section shortcut-settings"><div className="setting-heading"><div><h2>キーボード操作</h2><p>入力欄と日本語変換中は画面操作のショートカットを実行しません。</p></div></div><div className="form-grid">{(Object.keys(labels) as ShortcutAction[]).map(action => <label key={action} className="field">{labels[action]}<select value={bindings[action]} onChange={event => run(() => saveKeybinding(action, event.target.value), 'キー設定を保存しました')}>{SHORTCUT_CHOICES.map(choice => <option key={choice} value={choice} disabled={Object.entries(bindings).some(([other, selected]) => other !== action && selected === choice)}>{choice}</option>)}</select></label>)}</div><p className="muted">タスク行の右クリックまたはShift+F10から、編集・完了・タスクへのリンクを使えます。</p></section>
}
