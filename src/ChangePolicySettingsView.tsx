import { useState } from 'react'
import type { Settings } from './domain'
import { changePolicyFor, setChangePolicyFromUI, type ChangeContext, type ChangePolicy } from './change-set'

export default function ChangePolicySettingsView({ settings }: { settings: Settings }) {
  const [policy, setPolicy] = useState(() => changePolicyFor(settings))
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const context: ChangeContext = { principal: { id: settings.profileId, kind: 'human' }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: ['notes', 'scheduledDate'], sourceRevisions: [] }
  async function save(event: Event) {
    setBusy(true); setNotice('')
    try {
      const { epoch: _epoch, ...next } = policy
      setPolicy(await setChangePolicyFromUI(context, event, next))
      setNotice('変更の許可を保存しました。以前に確認した案は無効になります。')
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <section className="card setting-section change-policy-settings">
    <h2>コーチによる変更の許可</h2>
    <p className="muted">対象は選択した既存タスクのメモと予定日です。変更案は対象の版・保存先・現在の許可に結びつきます。</p>
    <label className="field">変更の扱い<select aria-label="変更の扱い" value={policy.taskUpdate} onChange={event => setPolicy(current => ({ ...current, taskUpdate: event.target.value as ChangePolicy['taskUpdate'] }))}>
      <option value="deny">変更を停止</option><option value="require_approval">毎回内容を確認して承認</option><option value="auto_within_bounds">設定範囲内は個別承認を省略</option>
    </select></label>
    <label className="field"><span><input type="checkbox" checked={policy.aiChangesEnabled} onChange={event => setPolicy(current => ({ ...current, aiChangesEnabled: event.target.checked }))} /> AIによる変更案を受け付ける</span></label>
    <div className="form-grid">{([['maxTasks', '一度に変更する件数', 1, 100], ['maxScheduledDayShift', '予定を動かせる日数', 0, 3650], ['maxNotesCharacters', '変更後のメモの文字数', 0, 50000]] as const).map(([field, label, min, max]) => <label className="field" key={field}>{label}<input type="number" min={min} max={max} step={1} value={policy.bounds[field]} onChange={event => setPolicy(current => ({ ...current, bounds: { ...current.bounds, [field]: Number(event.target.value) } }))} /></label>)}</div>
    <div className="form-grid">{([['notes', 'メモ'], ['scheduledDate', '予定日']] as const).map(([field, label]) => <label className="field" key={field}>{label}の保護<select aria-label={`${label}の保護`} value={policy.locks[field] ?? 'unlocked'} onChange={event => setPolicy(current => ({ ...current, locks: { ...current.locks, [field]: event.target.value as NonNullable<ChangePolicy['locks'][typeof field]> } }))}><option value="unlocked">上の変更設定に従う</option><option value="protect_from_autonomous">自動変更を禁止し、個別承認する</option><option value="locked_until_human_approval">個別確認で今回だけ解除する</option></select></label>)}</div>
    <p className="muted">AI接続をOFFにするとAIの案は適用できません。バックグラウンドでの変更は現在提供していません。</p>
    <button className="secondary-button" disabled={busy} onClick={event => save(event.nativeEvent)}>変更の許可を保存</button>
    {notice && <p role="status">{notice}</p>}
  </section>
}
