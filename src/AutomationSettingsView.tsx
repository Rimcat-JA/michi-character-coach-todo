import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Settings } from './domain'
import { changePolicyFor, type ChangeContext, type ChangePolicy } from './change-set'
import { automationRulesFor, automationStopsFor, AUTOMATION_PRESETS, increasedPolicyItems, increaseLabel, matchingPreset, OPERATION_INFO, overriddenOperations, presetRules, STOP_LABELS, type AutomationPreset, type AutomationRule, type OperationGroup, type OperationMode, type StopScope } from './automation-policy'
import { candidatePolicy, emergencyStop, previewAutomationPolicy, previewResume, reduceAuthority, resumeAuthorityFromUI, setAutomationPolicyFromUI, type AutomationPolicyInput, type AutomationPolicyPreview, type ResumePreview } from './automation-control'
import { lastAutomaticChange } from './change-history'
import type { FileBridgeStatus, FileBridgeWindow } from './file-bridge-types'
import type { LocalActionStatus, LocalActionWindow } from './local-action-types'

const presetLabels: Record<AutomationPreset, string> = { A0: 'A0 AI停止', A1: 'A1 確認中心（既定）', A2: 'A2 限定自動', A3: 'A3 個別委任', custom: '個別設定' }
const presetNotes: Record<AutomationPreset, string> = {
  A0: '新しいAI呼び出しと代理変更を止めます。保存するとAI処理も停止します。手動ToDo・本人が設定した繰り返し・事実の通知は続きます。',
  A1: 'AIによる変更はすべて差分を確認してから適用します。通知は設定した範囲で送ります。',
  A2: '保護していないメモ・予定日の変更を、件数・日数・時間帯の範囲内で自動適用します。',
  A3: '本人が個別に許可した範囲を広げます。全権ではありません。締め切り・点数・完了・公開・PC操作・権限拡張は自動になりません。',
  custom: 'プリセットから上書きした操作があります。上書きした行を強調しています。',
}
const modeLabels: Record<OperationMode, string> = { deny: '停止', require_approval: '毎回確認', auto_within_bounds: '範囲内で自動' }
const stopScopes: StopScope[] = ['aiProcessing', 'aiChanges', 'notifications', 'routines']
function draftFrom(settings: Settings): AutomationPolicyInput {
  const policy = changePolicyFor(settings), rules = automationRulesFor(policy)
  return { preset: matchingPreset(rules), rules, allowedHours: structuredClone(policy.allowedHours ?? {}), titleRule: policy.fieldRules?.title ?? 'require_approval', bounds: structuredClone(policy.bounds), locks: structuredClone(policy.locks) }
}
/** S20 /settings/automation: presets, per-operation overrides, bounds, stop switches and emergency stop. */
export default function AutomationSettingsView({ settings }: { settings: Settings }) {
  const policy = changePolicyFor(settings), saved = automationRulesFor(policy), stops = automationStopsFor(settings, policy)
  const [draft, setDraft] = useState(() => draftFrom(settings)), [base, setBase] = useState<Exclude<AutomationPreset, 'custom'>>(() => { const found = matchingPreset(saved); return found === 'custom' ? 'A1' : found })
  const [preview, setPreview] = useState<{ key: string; value: AutomationPolicyPreview } | null>(null), [resume, setResume] = useState<ResumePreview | null>(null)
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [agents, setAgents] = useState<{ bridge: FileBridgeStatus | null; actions: LocalActionStatus | null }>({ bridge: null, actions: null })
  const last = useLiveQuery(() => lastAutomaticChange(), [settings.changePolicy?.epoch])
  const context: ChangeContext = { principal: { id: settings.profileId, kind: 'human' }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: ['title', 'notes', 'scheduledDate', 'dueDate', 'manualPoints'], sourceRevisions: [] }
  const key = JSON.stringify(draft), previewed = preview?.key === key ? preview.value : null, label = matchingPreset(draft.rules), overridden = overriddenOperations(draft.rules, label === 'custom' ? base : label)
  // Same comparison as the save: rows, locks, bounds and title rule. An invalid draft is refused by the save itself.
  const increases = (() => { try { return increasedPolicyItems(policy, candidatePolicy(policy, draft)) } catch { return [] } })()
  useEffect(() => {
    let alive = true
    const host = typeof window === 'undefined' ? undefined : window as FileBridgeWindow & LocalActionWindow
    void Promise.allSettled([host?.michiFileBridge?.status(), host?.michiLocalActions?.status()]).then(([bridge, actions]) => { if (alive) setAgents({ bridge: bridge.status === 'fulfilled' ? bridge.value ?? null : null, actions: actions.status === 'fulfilled' ? actions.value ?? null : null }) })
    return () => { alive = false }
  }, [settings.changePolicy?.epoch])
  async function act(action: () => Promise<unknown>, success = '') {
    if (busy) return
    setBusy(true); setNotice('')
    try { await action(); if (success) setNotice(success) } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  function setRule(operation: OperationGroup, patch: Partial<AutomationRule>) { setDraft(current => { const rules = current.rules.map(rule => rule.operation === operation ? { ...rule, ...patch } : rule); return { ...current, rules, preset: matchingPreset(rules) } }) }
  function setHours(operation: OperationGroup, hours: { start: string; end: string } | null) { setDraft(current => { const allowedHours = { ...current.allowedHours }; if (hours) allowedHours[operation] = hours; else delete allowedHours[operation]; return { ...current, allowedHours } }) }
  function choosePreset(preset: Exclude<AutomationPreset, 'custom'>) { setBase(preset); setDraft(current => ({ ...current, preset, rules: presetRules(preset), allowedHours: {} })) }
  const bridge = agents.bridge?.registration
  return <section className="card setting-section automation-settings" aria-label="自動化と承認の設定">
    <h2>自動化と承認（S20）</h2>
    <p className="muted">権限は操作ごとの「停止・毎回確認・範囲内で自動」で決まります。プリセットは初期値だけで、上書きした行を強調します。一つでも停止なら上位の設定で緩めず、確認が必要な変更は自動化レベルが高くても確認します。</p>
    <label className="field">プリセット（初期値）<select aria-label="自動化プリセット" value={label} disabled={busy} onChange={event => { if (event.target.value !== 'custom') choosePreset(event.target.value as Exclude<AutomationPreset, 'custom'>) }}>{AUTOMATION_PRESETS.map(preset => <option key={preset} value={preset}>{presetLabels[preset]}</option>)}<option value="custom" disabled>個別設定</option></select></label>
    <p className="muted">{presetNotes[label]}</p>
    <div className="automation-rows">{draft.rules.map(rule => { const info = OPERATION_INFO[rule.operation], over = overridden.includes(rule.operation), hours = draft.allowedHours[rule.operation]; return <div key={rule.operation} className={`automation-row${over ? ' override' : ''}`}>
      <div className="automation-row-title"><strong>{info.label}</strong>{over && <span className="status-tag">上書き</span>}{info.fixed && <small>{info.fixed}</small>}</div>
      <select aria-label={`${info.label}の扱い`} value={rule.mode} disabled={busy || info.allowed.length === 1} onChange={event => setRule(rule.operation, { mode: event.target.value as OperationMode })}>{info.allowed.map(mode => <option key={mode} value={mode}>{modeLabels[mode]}</option>)}</select>
      {rule.operation === 'task.text' && <label className="field">タイトルの代理変更<select aria-label="タイトルの代理変更" value={draft.titleRule} disabled={busy} onChange={event => setDraft(current => ({ ...current, titleRule: event.target.value as 'deny' | 'require_approval' }))}><option value="require_approval">本人指示と毎回の承認が必要</option><option value="deny">代理変更を禁止</option></select></label>}
      {rule.mode === 'auto_within_bounds' && rule.operation === 'notification.send' && <small>回数・静かな時間・休みの日は「通知」の設定に従います。</small>}
      {rule.mode === 'auto_within_bounds' && rule.operation !== 'notification.send' && <div className="form-grid">
        <label className="field">1日の自動件数（全入口の合計）<input type="number" min={0} max={1000} step={1} value={rule.max_daily_count} disabled={busy} onChange={event => setRule(rule.operation, { max_daily_count: Number(event.target.value) })} /></label>
        {rule.operation === 'task.schedule' && <label className="field">予定日を動かせる日数<input type="number" min={0} max={3650} step={1} value={rule.max_schedule_days_delta ?? 0} disabled={busy} onChange={event => setRule(rule.operation, { max_schedule_days_delta: Number(event.target.value) })} /></label>}
        <label className="field"><span><input type="checkbox" checked={Boolean(hours)} disabled={busy} onChange={event => setHours(rule.operation, event.target.checked ? { start: '09:00', end: '18:00' } : null)} /> 自動にする時間帯を限定</span></label>
        {hours && <><label className="field">開始<input type="time" value={hours.start} disabled={busy} onChange={event => setHours(rule.operation, { ...hours, start: event.target.value })} /></label><label className="field">終了<input type="time" value={hours.end} disabled={busy} onChange={event => setHours(rule.operation, { ...hours, end: event.target.value })} /></label></>}
      </div>}
    </div> })}</div>
    <details><summary>件数・メモの変更量・保護する項目</summary>
      <div className="form-grid">{([['maxTasks', '一度に自動変更する件数', 1, 100], ['maxNotesCharacters', '自動で変えられるメモの文字数', 0, 50000]] as const).map(([field, text, min, max]) => <label className="field" key={field}>{text}<input type="number" min={min} max={max} step={1} value={draft.bounds[field]} disabled={busy} onChange={event => setDraft(current => ({ ...current, bounds: { ...current.bounds, [field]: Number(event.target.value) } }))} /></label>)}</div>
      <div className="form-grid">{([['notes', 'メモ'], ['scheduledDate', '予定日'], ['title', 'タイトル']] as const).map(([field, text]) => <label className="field" key={field}>{text}の保護<select aria-label={`${text}の保護`} value={draft.locks[field] ?? 'unlocked'} disabled={busy} onChange={event => setDraft(current => ({ ...current, locks: { ...current.locks, [field]: event.target.value as NonNullable<ChangePolicy['locks'][typeof field]> } }))}><option value="unlocked">上の操作別設定に従う</option><option value="protect_from_autonomous">自動変更を禁止し、個別承認する</option><option value="locked_until_human_approval">個別確認で今回だけ解除する</option></select></label>)}</div>
      <p className="muted">本当の締め切りと本人指定ポイントは、毎回個別に保護を確認します。点数を自動で変える設定はありません。</p>
    </details>
    {increases.length > 0 && <p role="status">権限を増やす変更：{increases.map(increaseLabel).join('・')}。保存前に過去7日の試算を確認します。</p>}
    <div className="change-set-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => void act(async () => setPreview({ key, value: await previewAutomationPolicy(draft) }))}>この設定を試算（過去7日・保存しません）</button>
      <button type="button" className="primary-button" disabled={busy || increases.length > 0 && !previewed} onClick={event => { const native = event.nativeEvent; void act(async () => { await setAutomationPolicyFromUI(context, native, draft, previewed?.token ?? null); setPreview(null) }, '自動化の設定を保存しました。以前に確認した変更案は無効になります。') }}>自動化の設定を保存</button></div>
    {previewed && <div className="dry-run" aria-label="自動化設定の試算"><p>過去7日の代理変更 {previewed.dryRun.total}件をこの設定で判定すると：範囲内で自動 {previewed.dryRun.auto}件 / 毎回確認 {previewed.dryRun.approval}件 / 停止 {previewed.dryRun.denied}件（{presetLabels[previewed.preset]}）</p>
      {previewed.dryRun.entries.slice(-10).map(entry => <p key={entry.changeSetId}><small>{new Date(entry.at).toLocaleString('ja-JP')} · 実際：{entry.actual === 'auto' ? '自動' : '本人承認'} → この設定：{modeLabels[entry.wouldBe === 'auto' ? 'auto_within_bounds' : entry.wouldBe === 'denied' ? 'deny' : 'require_approval']} · {entry.reason}</small></p>)}
      <p className="muted">試算は記録を読むだけで、タスク・設定・履歴は変更しません。</p></div>}
    <h3>停止スイッチ</h3>
    {stopScopes.map(scope => <div className="setting-line" key={scope}><div><strong>{STOP_LABELS[scope]}</strong><small>{stops[scope] ? '停止中' : '動作中'}</small></div>{stops[scope] ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(async () => setResume(await previewResume(scope)))}>再開内容を確認</button> : <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(async () => { const result = await reduceAuthority(scope, 'button'); if (result.errors.length) throw new Error(`${STOP_LABELS[scope]}を停止しました。一部の外部接続の停止を確認できませんでした。`) }, `${STOP_LABELS[scope]}を停止しました。`)}>停止</button>}</div>)}
    {resume && <div role="group" aria-label="再開の確認"><p>{STOP_LABELS[resume.scope]}を再開すると：</p><ul>{resume.effects.map(effect => <li key={effect}>{effect}</li>)}</ul><div className="change-set-actions"><button type="button" className="text-button" disabled={busy} onClick={() => setResume(null)}>やめる</button><button type="button" className="primary-button" disabled={busy} onClick={event => { const native = event.nativeEvent; void act(async () => { await resumeAuthorityFromUI(context, native, resume.scope, resume.token); setResume(null) }, `${STOP_LABELS[resume.scope]}を再開しました。`) }}>本人として再開する</button></div></div>}
    <button type="button" className="primary-button emergency-stop" disabled={busy} onClick={() => void act(async () => { const result = await emergencyStop('button'); if (result.errors.length) throw new Error('緊急停止を記録しました。一部の外部接続の停止を確認できませんでした。接続状態を確認してください。') }, '緊急停止しました。手動のタスク追加と完了は使えます。')}>緊急停止</button>
    <p className="muted">緊急停止はAI処理・AIによる変更・通知・ルーティン生成をまとめて止め、確認待ちの変更案、ファイル接続/MCPの受信、PC操作の承認、通知の予約を無効にします。外部へ送信済みの依頼は取り消せない場合があります。再開はここで内容を確認し、本人のクリックで行います。</p>
    <h3>現在の代理エージェント</h3>
    <p>アプリ内コーチ：{settings.aiEnabled ? settings.aiModel ?? 'モデル未設定' : 'AI停止中'}</p>
    <p>ファイル接続/MCP：{bridge ? `${bridge.client.intended_host} · ${bridge.client.grant.mutation_mode === 'auto_within_bounds' ? '範囲内自動を委任' : '毎回本人承認'} · 期限 ${new Date(bridge.client.grant.expires_at).toLocaleString('ja-JP')}` : '接続なし'}</p>
    <p>PC操作：{agents.actions ? `登録 ${agents.actions.definitions.length}件（${agents.actions.enabled ? '有効' : '停止'}）` : 'なし'}</p>
    <h3>最終自動変更</h3>
    <p>{last ? `${new Date(last.at).toLocaleString('ja-JP')} · ${last.principal.kind === 'coach' ? 'アプリ内コーチ' : '外部エージェント'} · ${last.operations.map(operation => OPERATION_INFO[operation].label).join('・')}` : 'まだありません'}</p>
    <p className="muted">資料からの検出は、独立評価（N04）を通過するまでA1・A2・A3のどれでも同じ候補を本人が確認します。エージェントやファイル・MCPの内容からこの設定を読み書き・承認することはできません。</p>
    {notice && <p role="status">{notice}</p>}
  </section>
}
