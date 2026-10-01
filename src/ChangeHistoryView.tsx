import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import type { Settings, Task } from './domain'
import ChangeSetPreview from './ChangeSetPreview'
import { changePolicyFor, prepareUndoFromAudit, taskChangeFields, taskChangeValueText, type ChangeContext, type TaskChangeField, type UndoPreparation } from './change-set'
import { agentChangeHistory, undoneAuditIds } from './change-history'

const labels: Record<TaskChangeField, string> = { title: 'タイトル', notes: 'メモ', scheduledDate: '予定日', dueDate: '本当の締め切り', dueAt: '締め切り時刻', manualPoints: '本人指定ポイント' }
const shown = (value: unknown) => value === null || value === undefined || value === '' ? '未設定' : typeof value === 'object' ? taskChangeValueText(value as Parameters<typeof taskChangeValueText>[0]) : String(value)
/** S21 history of agent changes with an owner-approved undo. A later edit is shown as a re-diff, never overwritten. */
export default function ChangeHistoryView({ settings, tasks, latestOnly = false, initial = null }: { settings: Settings; tasks: Task[]; latestOnly?: boolean; initial?: UndoPreparation | null }) {
  const audits = useLiveQuery(() => db.audits.toArray(), [])
  const entries = agentChangeHistory(audits ?? [], latestOnly ? 1 : 30), undone = undoneAuditIds(audits ?? [])
  const human: ChangeContext = { principal: { id: settings.profileId, kind: 'human' }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: [...taskChangeFields], sourceRevisions: [] }
  const [result, setResult] = useState<UndoPreparation | null>(initial), [notice, setNotice] = useState(initial?.status === 'already_undone' ? 'この変更は取り消し済みです。' : ''), [busy, setBusy] = useState(false)
  async function prepare(auditId: string) {
    setBusy(true); setNotice('')
    try { const prepared = await prepareUndoFromAudit(auditId, human); setResult(prepared); if (prepared.status === 'already_undone') setNotice('この変更は取り消し済みです。') }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  if (audits === undefined) return null
  return <section className="card setting-section change-history" aria-label="AI・外部エージェントによる変更の履歴">
    <h2>{latestOnly ? '直前の代理変更の取り消し' : 'AI・外部エージェントによる変更の履歴'}</h2>
    <p className="muted">自動適用と本人承認の変更を区別して表示します。取り消しは保存された元の値へ戻す新しい変更として本人が確認します。完了記録・実績台帳は変わりません。</p>
    {!entries.length && <p>代理変更の記録はありません。</p>}
    {entries.map(entry => <article key={entry.auditId} className="change-history-entry"><h4>{tasks.find(task => task.id === entry.taskId)?.title ?? '削除済みタスク'}</h4>
      <small>{new Date(entry.at).toLocaleString('ja-JP')} · {entry.principal.kind === 'coach' ? 'アプリ内コーチ' : '外部エージェント'}{entry.principal.model ? `（${entry.principal.model}）` : ''} · <strong>{entry.decision === 'auto' ? '設定範囲内で自動適用' : '本人が承認'}</strong>{undone.has(entry.auditId) ? ' · 取り消し済み' : ''}</small>
      {entry.fields.map(field => <p key={field}>{labels[field]}：{shown(entry.before[field])} → {shown(entry.after[field])}</p>)}
      <button type="button" className="secondary-button" disabled={busy || undone.has(entry.auditId) || !entry.undo} onClick={() => void prepare(entry.auditId)}>取り消し案を作る</button>
    </article>)}
    {result?.status === 'conflict' && <div role="alert"><p>その後にタスクが更新されているため、上書きせず差分を表示します。必要ならタスク編集で本人が直してください。</p>{result.rediff.map(item => <p key={item.field}>{labels[item.field]}：代理変更後 {shown(item.recorded)} / 現在 {shown(item.current)} / 取り消し先 {shown(item.restore)}</p>)}</div>}
    {result?.status === 'prepared' && <ChangeSetPreview key={result.prepared.id} prepared={result.prepared} policy={changePolicyFor(settings)} actorContext={human} humanContext={human} onApplied={() => { setResult(null); setNotice('代理変更を取り消しました。取り消しも履歴に残ります。') }} onCancel={() => { setResult(null); setNotice('取り消し案を閉じました。タスクは変更していません。') }} />}
    {notice && <p role="status">{notice}</p>}
  </section>
}
