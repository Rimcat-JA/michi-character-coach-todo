import { useCallback, useEffect, useRef, useState } from 'react'

export type AIUsageKind = 'chat' | 'summarize' | 'assist' | 'score'
export type AIUsageLimits = {
  dailyRequests: number; dailyTokens: number; monthlyRequests: number; monthlyTokens: number
  kindDailyRequests: Record<AIUsageKind, number>; automaticDailyRequests?: number
}
export type AIUsageTotals = { requests: number; tokens: number; knownTokens: number; unknownRequests: number; pendingRequests: number }
export type AIUsageSnapshot = {
  provider: 'openrouter'; day: string; month: string; limits: AIUsageLimits
  daily: AIUsageTotals; monthly: AIUsageTotals; byKind: Record<AIUsageKind, AIUsageTotals>
  automaticBudget: { requests: number; used: number }; cost: null
}
export type AIUsageBridge = {
  usage: () => Promise<AIUsageSnapshot>
  setUsageLimits: (limits: AIUsageLimits) => Promise<AIUsageSnapshot>
}

const kindLabels: Record<AIUsageKind, string> = { chat: '相談', summarize: '要約', assist: 'タスク入力', score: '属性候補' }
const globalFields = [
  ['dailyRequests', '1日の回数上限', 100000], ['dailyTokens', '1日のトークン上限', 1000000000],
  ['monthlyRequests', '1か月の回数上限', 100000], ['monthlyTokens', '1か月のトークン上限', 1000000000]
] as const
type LimitDraft = Record<(typeof globalFields)[number][0] | AIUsageKind | 'automatic', string>
const initialDraft: LimitDraft = { dailyRequests: '100', dailyTokens: '200000', monthlyRequests: '1000', monthlyTokens: '2000000', chat: '100', summarize: '100', assist: '100', score: '100', automatic: '0' }
function draftOf(limits: AIUsageLimits): LimitDraft {
  return { dailyRequests: String(limits.dailyRequests), dailyTokens: String(limits.dailyTokens), monthlyRequests: String(limits.monthlyRequests), monthlyTokens: String(limits.monthlyTokens), ...Object.fromEntries(Object.entries(limits.kindDailyRequests).map(([key, value]) => [key, String(value)])), automatic: String(limits.automaticDailyRequests ?? 0) } as LimitDraft
}
function display(value: number) { return value.toLocaleString('ja-JP') }

export default function AIUsageView() {
  const [usage, setUsage] = useState<AIUsageSnapshot | null>(null)
  const [draft, setDraft] = useState<LimitDraft>(initialDraft)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const initialized = useRef(false)
  const bridge = window.michiAI as (Partial<AIUsageBridge> | undefined)
  const available = typeof bridge?.usage === 'function' && typeof bridge?.setUsageLimits === 'function'
  const refresh = useCallback(async () => {
    const currentBridge = window.michiAI as (Partial<AIUsageBridge> | undefined)
    if (!currentBridge?.usage) return
    try {
      const next = await currentBridge.usage()
      setUsage(next)
      if (!initialized.current) { setDraft(draftOf(next.limits)); initialized.current = true }
      setNotice('')
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }, [])
  useEffect(() => {
    const initialRefresh = window.setTimeout(refresh, 0)
    window.addEventListener('focus', refresh)
    return () => { window.clearTimeout(initialRefresh); window.removeEventListener('focus', refresh) }
  }, [refresh])
  async function save() {
    if (!bridge?.setUsageLimits) return
    if (Object.values(draft).some(value => !/^\d+$/.test(value))) { setNotice('利用上限は0以上の整数で入力してください。'); return }
    setBusy(true)
    try {
      const next = await bridge.setUsageLimits({
        dailyRequests: Number(draft.dailyRequests), dailyTokens: Number(draft.dailyTokens), monthlyRequests: Number(draft.monthlyRequests), monthlyTokens: Number(draft.monthlyTokens),
        kindDailyRequests: { chat: Number(draft.chat), summarize: Number(draft.summarize), assist: Number(draft.assist), score: Number(draft.score) }, automaticDailyRequests: Number(draft.automatic)
      })
      setUsage(next); setDraft(draftOf(next.limits)); initialized.current = true
      setNotice('AI利用上限をこの端末に保存しました。')
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <section className="card setting-section">
    <div className="setting-heading"><div><h2>OpenRouterの利用上限</h2><p>送信前に回数とトークンを予約し、上限に達するとAI処理を停止します。</p></div></div>
    {!available ? <p className="muted">利用記録と上限設定はWindowsアプリで使えます。</p> : <>
      {usage && <>
        <div className="setting-line"><div><strong>今日（{usage.day}）</strong><small>回数 {display(usage.daily.requests)} / {display(usage.limits.dailyRequests)}　トークン {display(usage.daily.tokens)} / {display(usage.limits.dailyTokens)}</small></div></div>
        <div className="setting-line"><div><strong>今月（{usage.month}）</strong><small>回数 {display(usage.monthly.requests)} / {display(usage.limits.monthlyRequests)}　トークン {display(usage.monthly.tokens)} / {display(usage.limits.monthlyTokens)}</small></div></div>
        <p className="muted">トークン表示には予約分を含みます。今日のAPI報告済みトークンは{display(usage.daily.knownTokens)}、結果不明は{usage.daily.unknownRequests}回、応答待ちは{usage.daily.pendingRequests}回です。通信失敗・タイムアウトは予約を保持します。</p>
        <p className="muted">API費用：不明。自動AI処理（通知文の作成など）の予算：今日 {usage.automaticBudget.used} / {usage.automaticBudget.requests}回。未設定は0回で、自動AI処理は送信しません。日付はこの端末の暦日で切り替わります。</p>
      </>}
      <div className="form-grid">{globalFields.map(([key, label, max]) => <label className="field" key={key}>{label}<input aria-label={label} type="number" min={0} max={max} step={1} value={draft[key]} disabled={busy} onChange={event => setDraft(current => ({ ...current, [key]: event.target.value }))} /></label>)}</div>
      <details><summary>処理別の1日回数上限</summary><div className="form-grid">{Object.entries(kindLabels).map(([kind, label]) => <label className="field" key={kind}>{label}<input aria-label={`${label}のAI回数上限`} type="number" min={0} max={100000} step={1} value={draft[kind as AIUsageKind]} disabled={busy} onChange={event => setDraft(current => ({ ...current, [kind]: event.target.value }))} /><small>今日 {usage?.byKind[kind as AIUsageKind].requests ?? 0}回</small></label>)}</div></details>
      <label className="field">自動AI処理の1日回数上限（通知文など）<input aria-label="自動AI処理の1日回数上限" type="number" min={0} max={1000} step={1} value={draft.automatic} disabled={busy} onChange={event => setDraft(current => ({ ...current, automatic: event.target.value }))} /><small>0のままなら本人が操作していないAI送信は行いません。通知は事実の定型文になります。</small></label>
      <p className="muted">上限を0にすると該当するAI送信を停止します。手動のタスク入力や編集は引き続き使えます。</p>
      <div className="export-buttons"><button className="secondary-button" disabled={busy || !usage} onClick={save}>利用上限を保存</button><button className="text-button" disabled={busy} onClick={refresh}>利用記録を更新</button></div>
    </>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
