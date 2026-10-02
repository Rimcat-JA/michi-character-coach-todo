import { useState } from 'react'
import { applyCoachSplitFromUI, buildCoachSplitProposal, validateCoachSplit, type CoachSplitPart, type CoachSplitProposal } from './coach-split'
import type { Settings, Task } from './domain'

/** N08 split: preview parent N pt → 0 and allocated children; applied only by the native approval click. */
export default function CoachSplitView({ task, parts, instruction, settings, onDone }: { task: Task; parts: CoachSplitPart[]; instruction: string; settings: Settings; onDone?: (ids: string[]) => void }) {
  const [state] = useState(() => { try { return { proposal: buildCoachSplitProposal(task, parts, instruction), error: '' } } catch (error) { return { proposal: null, error: error instanceof Error ? error.message : String(error) } } })
  const [proposal, setProposal] = useState<CoachSplitProposal | null>(state.proposal), [notice, setNotice] = useState(state.error), [busy, setBusy] = useState(false), [reviewed, setReviewed] = useState(false), [doneIds, setDoneIds] = useState<string[] | null>(null)
  const names = parts.map(part => part.name), stale = Boolean(!doneIds && proposal && proposal.parentRevision !== task.revision)
  if (!proposal) return <section className="card coach-split" aria-label="分割の相談"><h3>分割の相談</h3><p role="alert">{notice}</p></section>
  const sum = proposal.parts.reduce((total, part) => total + part.points, 0)
  function update(index: number, patch: Partial<CoachSplitProposal['parts'][number]>) { setReviewed(false); setProposal(current => current ? { ...current, parts: current.parts.map((part, at) => at === index ? { ...part, ...patch } : part) } : current) }
  async function approve(event: Event) {
    if (!proposal || busy) return
    setBusy(true); setNotice('')
    try { const ids = await applyCoachSplitFromUI(proposal, names, { ownerId: settings.profileId, datasetId: settings.datasetId }, event); setDoneIds(ids); setNotice(`分割を保存しました。子タスク${ids.length}件（合計${proposal.parentPoints}pt）を作成し、親は0ptにしました。実績ポイントは完了時に記録します。`); onDone?.(ids) }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <section className="card coach-split" aria-label="分割の相談">
    <h3>「{task.title}」を分割（{proposal.parentPoints}pt）</h3>
    {stale && <p role="alert">分割案の作成後にタスクが更新されました。相談をやり直してください。</p>}
    {proposal.parts.map((part, index) => <div className="setting-line" key={part.name}><div><strong>{part.title}</strong><small>{part.origin === 'human' ? '本人指定の値' : part.origin === 'app_default' ? 'アプリの既定値（均等割り）・未確認' : 'アプリの既定値を本人が確認'}</small></div><input aria-label={`${part.name}のポイント`} type="number" min={0} max={100000} step={1} value={part.points} disabled={busy} onChange={event => update(index, { points: Number(event.target.value), origin: 'human' })} />{part.origin === 'app_default' && <button className="text-button" disabled={busy} onClick={() => update(index, { origin: 'app_default_confirmed' })}>この値で確認</button>}</div>)}
    <p className={sum === proposal.parentPoints ? 'muted' : ''} role={sum === proposal.parentPoints ? undefined : 'alert'}>配分合計 {sum}pt / 親 {proposal.parentPoints}pt。予定日・期限は親から引き継ぎます。</p>
    <button className="secondary-button" disabled={busy || stale || Boolean(doneIds)} onClick={() => { try { validateCoachSplit(proposal, names); setReviewed(true); setNotice('') } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } }}>分割の差分を確認</button>
    {reviewed && !doneIds && <div className="change-set-preview" aria-label="分割の差分"><p>親「{task.title}」 {proposal.parentPoints}pt → 0pt（未完了のまま残ります）</p><ul>{proposal.parts.map(part => <li key={part.name}>新しい子タスク「{part.title}」 {part.points}pt（配分）</li>)}</ul><p className="muted">完了済みの実績・台帳は変わりません。子タスクを完了したときに、その配分ポイントが記録されます。</p><button className="primary-button" disabled={busy || stale} onClick={event => void approve(event.nativeEvent)}>承認して分割する</button></div>}
    {notice && <p role="status">{notice}</p>}
    {doneIds && <p className="muted">この分割は保存済みです。さらに分ける場合は、新しい相談文でやり直してください。</p>}
  </section>
}
