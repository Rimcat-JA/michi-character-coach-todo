import { useState } from 'react'
import type { Settings, WorkflowConfig, WorkflowPreset } from './domain'
import { applyWorkflowConfig, applyWorkflowPreset, deleteWorkflowPreset, exportWorkflowPreset, importWorkflowPreset, saveWorkflowPreset } from './workflows'

type Run = (fn: () => Promise<unknown>, success?: string) => Promise<boolean>

const builtins: { name: string; config: WorkflowConfig }[] = [
  { name: 'シンプル', config: { navDesktop: ['today', 'tasks', 'coach', 'settings'], navMobile: ['today', 'tasks', 'coach'], hiddenFeatures: [], daySectionMode: 'halfday', taskListLimit: null, dailyMinutes: 180, dailyPoints: 80 } },
  { name: '集中', config: { navDesktop: ['today', 'tasks', 'plan', 'focus', 'history', 'settings'], navMobile: ['today', 'tasks', 'focus', 'history'], hiddenFeatures: [], daySectionMode: 'halfday', taskListLimit: 5, dailyMinutes: 180, dailyPoints: 80 } }
]

function downloadPreset(preset: WorkflowPreset) {
  const url = URL.createObjectURL(new Blob([exportWorkflowPreset(preset)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url; link.download = `michi-workflow-${preset.id}.json`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

export default function WorkflowPresetsView({ settings, run }: { settings: Settings; run: Run }) {
  const [name, setName] = useState(''), [file, setFile] = useState<File | null>(null)
  async function add() { if (await run(() => saveWorkflowPreset(name), 'プリセットを保存しました')) setName('') }
  async function importFile() {
    if (!file) return
    if (await run(async () => { if (file.size > 1024 * 1024) throw new Error('共有ファイルは1MB以内にしてください'); await importWorkflowPreset(await file.text()) }, 'プリセットを取り込みました')) setFile(null)
  }
  return <section className="card setting-section workflow-presets"><div className="setting-heading"><div><h2>Workflow Library</h2><p>表示・ナビゲーション・日々の目安を版付きで保存します。APIキー、AI送信許可、通知許可、自動化レベルは共有しません。</p></div></div>
    <div className="workflow-preset-row"><strong>用意された設定</strong>{builtins.map(item => <button key={item.name} className="secondary-button" onClick={() => run(() => applyWorkflowConfig(item.config), `${item.name}を適用しました`)}>{item.name}を適用</button>)}</div>
    <div className="workflow-preset-row"><label className="field">現在の設定を保存<input value={name} maxLength={100} onChange={event => setName(event.target.value)} placeholder="プリセット名" /></label><button className="primary-button" disabled={!name.trim()} onClick={add}>保存</button></div>
    {(settings.workflowPresets ?? []).map(preset => <div className="workflow-preset-row" key={preset.id}><strong>{preset.name} · 版 {preset.version}</strong><button className="secondary-button" onClick={() => run(() => applyWorkflowPreset(preset.id), 'プリセットを適用しました')}>適用</button><button className="text-button" onClick={() => run(() => saveWorkflowPreset(preset.name, preset.id), '新しい版を保存しました')}>現在の設定で更新</button><button className="text-button" onClick={() => downloadPreset(preset)}>共有JSON</button><button className="text-button" onClick={() => run(() => deleteWorkflowPreset(preset.id), 'プリセットを削除しました')}>削除</button></div>)}
    <div className="workflow-preset-row"><label className="field">共有プリセットを取り込む<input type="file" accept=".json,application/json" onChange={event => setFile(event.target.files?.[0] ?? null)} /></label><button className="secondary-button" disabled={!file} onClick={importFile}>取り込む</button></div>
  </section>
}
