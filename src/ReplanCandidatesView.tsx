import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import ChangeSetPreview from './ChangeSetPreview'
import { changePolicyFor, type ChangeContext, type ChangeReceipt, type PreparedChangeSet } from './change-set'
import { prepareReplanChangeSet, replanCandidates, type ReplanSituation } from './replan-candidates'
import { today, type Settings } from './domain'

const situationLabel: Record<ReplanSituation, string> = { slipped: '予定日を過ぎた', overload: '今日の容量超過', selfReport: '本人申告' }
/** K05: situation-based options only. Nothing is pre-selected and nothing changes before the approval click. */
export default function ReplanCandidatesView({ settings, selfReport = false, compact = false, onClose }: { settings: Settings; selfReport?: boolean; compact?: boolean; onClose?: () => void }) {
  // All tasks (not only open ones) so completed prerequisites are recognised.
  const tasks = useLiveQuery(() => db.tasks.toArray(), []) ?? []
  const dependencies = useLiveQuery(() => db.taskDependencies.toArray(), []) ?? []
  const blocks = useLiveQuery(() => db.timeBlocks.toArray(), []) ?? []
  const [selected, setSelected] = useState<string[]>([]), [preview, setPreview] = useState<PreparedChangeSet | null>(null), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const summary = replanCandidates({ tasks, dependencies, blocks: blocks.filter(block => block.ownerId === settings.profileId), settings, today: today(), selfReport })
  const policy = changePolicyFor(settings), human: ChangeContext = { principal: { id: settings.profileId, kind: 'human' }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: ['scheduledDate'], sourceRevisions: [] }
  if (compact && !summary.candidates.length && !preview && !notice) return null
  async function prepare() {
    setBusy(true); setNotice('')
    try { setPreview(await prepareReplanChangeSet(summary.candidates, selected, settings)) }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  function applied(receipt: ChangeReceipt) { setPreview(null); setSelected([]); setNotice(`予定日を${receipt.taskIds.length}件変更しました。本当の締め切り・ポイント・完了記録は変えていません。`) }
  return <section className="card setting-section replan-candidates" aria-label="再計画の候補">
    <div className="setting-heading"><div><h2>{selfReport ? '今日の予定から選んで移す' : '再計画の候補'}</h2><p>予定日を過ぎた未完了 {summary.slipped}件 · 今日の予定 {summary.todayCount}件（{summary.plannedMinutes}/{summary.minutesLimit}分 · {summary.plannedPoints}/{summary.pointsLimit}pt{summary.overloaded ? ' · 容量超過' : ''}）</p></div>{onClose && <button className="text-button" onClick={onClose}>閉じる</button>}</div>
    {summary.candidates.length ? <div className="reminder-items">{summary.candidates.map(item => <label key={item.taskId} className="setting-line"><span><input type="checkbox" aria-label={`${item.title}を移す`} checked={selected.includes(item.taskId)} disabled={!item.to || busy || Boolean(preview)} onChange={event => setSelected(ids => event.target.checked ? [...ids, item.taskId] : ids.filter(id => id !== item.taskId))} /> <strong>{item.title}</strong></span><small>{item.situations.map(value => situationLabel[value]).join('・')} · 予定 {item.from ?? '未設定'} → {item.to ?? '移動先なし'}{item.dueDate ? ` · 期限 ${item.dueDate}${item.dueTime ? ` ${item.dueTime}` : ''}（変更しません）` : ''}{item.reason ? ` · ${item.reason}` : ''}</small></label>)}</div> : <p className="muted">いま移す候補はありません。</p>}
    <p className="muted">候補は予定日だけです。期限・ポイント・完了記録は変えず、休憩タスクなどの新しいタスクも作りません。選んだ行だけを一つの差分にまとめ、承認後に一括で適用します（途中で他の変更があれば何も適用しません）。</p>
    <button className="secondary-button" disabled={!selected.length || busy || Boolean(preview)} onClick={prepare}>選んだ予定日の差分を作る</button>
    {notice && <p role="status">{notice}</p>}
    {preview && <ChangeSetPreview key={preview.id} prepared={preview} policy={policy} actorContext={human} humanContext={human} onApplied={applied} onCancel={() => { setPreview(null); setNotice('差分を取り消しました。予定は変わっていません。') }} />}
  </section>
}
