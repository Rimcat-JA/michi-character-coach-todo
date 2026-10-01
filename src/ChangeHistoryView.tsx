import { useState, useSyncExternalStore } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import type { Settings, Task } from './domain'
import ChangeSetPreview from './ChangeSetPreview'
import TaskSplitPreview from './TaskSplitPreview'
import { changePolicyFor, prepareUndoFromAudits, taskChangeFields, taskChangeValueText, type ChangeContext, type TaskChangeField, type UndoPreparation } from './change-set'
import { changeTrace, latestCoachChange, undoneAuditIds, type ChangeTraceEntry } from './change-history'
import { changeContextFor, commandProtectedFields, ENTRANCE_LABELS as entranceLabels, commandsVersion, humanContextFor, pendingCommands, receivedCommands, subscribeCommands, type PreparedCommand, type ReceivedCommand } from './command-bus'
import { splitBody } from './task-split-change'

const labels: Record<TaskChangeField, string> = { title: 'タイトル', notes: 'メモ', scheduledDate: '予定日', dueDate: '本当の締め切り', dueAt: '締め切り時刻', manualPoints: '本人指定ポイント' }
const fieldLabel = (field: string) => (labels as Record<string, string>)[field] ?? ({ scheduled_date: '予定日', due_date: '本当の締め切り', manual_points: '本人指定ポイント', completionPoints: '完了時のポイント', status: '状態', deletedAt: '削除', children: '子タスク', scoreMode: 'ポイント方式', effectivePoints: '有効ポイント', project: 'プロジェクト', labels: 'ラベル', importance: '重要度' } as Record<string, string>)[field] ?? field
const clock = (value: unknown): value is { at: string; timezone: string } => Boolean(value && typeof value === 'object' && typeof (value as { at?: unknown }).at === 'string' && typeof (value as { timezone?: unknown }).timezone === 'string')
const shown = (value: unknown) => value === null || value === undefined || value === '' ? '未設定' : clock(value) ? taskChangeValueText(value) : typeof value === 'object' ? JSON.stringify(value).slice(0, 300) : String(value)
const operatorText = (operator: { kind: string; id: string | null; model?: string | null }) => `${operator.kind === 'human' ? '本人' : operator.kind === 'coach' ? 'アプリ内コーチ' : `外部エージェント ${operator.id?.slice(0, 8) ?? ''}`}${operator.model ? `（${operator.model}）` : ''}`
const decisionText = { auto: '自動', approved: '本人が承認', self: '本人の操作' } as const
const scrollTo = (label: string) => { document.querySelector(`[aria-label="${label}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }

/** Pending part of S21: proposals held in this app session from every entrance. Approval reuses the shared cards. */
export function PendingChangesList({ pending, received, settings, tasks, onApprove, onPolicy }: { pending: PreparedCommand[]; received: ReceivedCommand[]; settings: Settings; tasks: Task[]; onApprove: (command: PreparedCommand) => void; onPolicy: () => void }) {
  const title = (id: string | null) => id ? tasks.find(task => task.id === id)?.title ?? '選択外の対象' : '新規作成'
  return <div className="change-trace-pending"><h3>承認待ちの変更</h3>
    {!pending.length && !received.length && <p>承認待ちの変更はありません。</p>}
    {pending.map(command => {
      const principal = command.actor.principal, protectedFields = command.changeSet ? commandProtectedFields(command, settings) : command.envelope.type === 'task.split' ? ['manualPoints' as const] : []
      const split = command.envelope.type === 'task.split' ? splitBody(command) : null
      return <article key={command.id} className="change-history-entry" aria-label="承認待ちの変更"><h4>{title(command.envelope.target_id)}{command.envelope.expected_revision ? `（版 ${command.envelope.expected_revision}）` : ''}</h4>
        <small>{entranceLabels[command.actor.entrance]}{command.actor.label ? `・${command.actor.label}（自己申告）` : ''} · 操作者：{operatorText(principal)} · 種類：{command.envelope.type} · 確認期限 {new Date(command.expiresAt).toLocaleString('ja-JP')}</small>
        {command.changeSet?.changes.flatMap(change => change.fields.map(field => <p key={`${change.taskId}:${field}`}>{labels[field]}：{shown(field === 'manualPoints' ? change.scoreBefore.manualPoints : change.before[field])} → {shown(field === 'manualPoints' ? change.scoreAfter.manualPoints : change.after[field])}</p>))}
        {command.ownerValues?.flatMap(request => Object.entries(request.patch).map(([field, value]) => <p key={field}>{fieldLabel(field)}：→ {shown(value)}（本人の値確認待ち）</p>))}
        {split?.stage === 'owner_values' && <p>分割案：{split.proposed.map(child => `${child.title} ${child.points ?? '未設定'}pt`).join(' / ')}（本人の配分確認待ち）</p>}
        {split?.stage === 'review' && <p>分割：{split.split.children.map(child => `${child.title} ${child.points}pt`).join(' / ')}（合計 {split.split.total}pt）</p>}
        {protectedFields.length ? <p>保護された項目：{protectedFields.map(field => labels[field]).join('・')}（承認時に個別確認）</p> : null}
        <div className="change-set-actions"><button type="button" className="primary-button" onClick={() => onApprove(command)}>この変更だけ許可</button><button type="button" className="secondary-button" onClick={onPolicy}>今後の権限設定へ</button></div>
      </article>
    })}
    {received.map(item => <article key={item.commandId} className="change-history-entry" aria-label="受信した外部コマンド"><h4>{title(item.targetId)}{item.expectedRevision ? `（版 ${item.expectedRevision}）` : ''}</h4>
      <small>{entranceLabels[item.entrance]}{item.host ? `・${item.host}（自己申告）` : ''} · 操作者：外部エージェント {item.principalId.slice(0, 8)} · 種類：{item.type} · 項目：{item.fields.map(fieldLabel).join('・') || '—'} · 期限 {new Date(item.expiresAt).toLocaleString('ja-JP')}</small>
      <p className="muted">受信箱で内容を開くと差分を作ります。まだ何も適用していません。</p>
      <div className="change-set-actions"><button type="button" className="primary-button" onClick={() => scrollTo('ローカルエージェント接続')}>この変更だけ許可</button><button type="button" className="secondary-button" onClick={onPolicy}>今後の権限設定へ</button></div>
    </article>)}
  </div>
}
/** History part of S21: every entrance, auto vs approved, operator (not the creator), approver, epoch, digest and basis. */
export function ChangeTraceList({ entries, tasks, total, page, onPage, undone = new Set(), onUndo, busy = false }: { entries: ChangeTraceEntry[]; tasks: Task[]; total: number; page: number; onPage?: (page: number) => void; undone?: Set<string>; onUndo?: (auditId: string) => void; busy?: boolean }) {
  return <div className="change-trace-history"><h3>変更の履歴</h3>
    {!entries.length && <p>変更の記録はありません。</p>}
    {entries.map(entry => <article key={entry.auditId} className="change-history-entry" aria-label="変更の記録"><h4>{entry.label}：{entry.taskId ? tasks.find(task => task.id === entry.taskId)?.title ?? '削除済みタスク' : '設定'}</h4>
      <small>{new Date(entry.at).toLocaleString('ja-JP')} · {entranceLabels[entry.entrance]} · 操作者：{operatorText(entry.operator)} · <strong>{decisionText[entry.decision]}</strong>{entry.approver ? ` · 承認者 ${entry.approver}` : ''}{entry.policyEpoch !== null ? ` · 設定版 ${entry.policyEpoch}` : ''}{entry.basis ? ` · 根拠 ${entry.basis}` : ''}{entry.digest ? ` · 内容 ${entry.digest.slice(0, 12)}` : ''}{entry.legacy ? ' · 旧形式の記録' : ''}{undone.has(entry.auditId) ? ' · 取り消し済み' : ''}</small>
      {entry.fields.map(field => <p key={field}>{fieldLabel(field)}：{shown(entry.before[field])} → {shown(entry.after[field])}</p>)}
      {entry.summary && <p className="muted">{entry.summary}</p>}
      {onUndo && entry.operation === 'changeset.update' && entry.operator.kind !== 'human' && <button type="button" className="secondary-button" disabled={busy || undone.has(entry.auditId)} onClick={() => onUndo(entry.auditId)}>取り消し案を作る</button>}
    </article>)}
    {total > 50 && onPage && <div className="change-set-actions"><button type="button" className="secondary-button" disabled={page === 0} onClick={() => onPage(page - 1)}>新しい50件</button><span>{page * 50 + 1}〜{Math.min(total, page * 50 + 50)} / {total}件</span><button type="button" className="secondary-button" disabled={(page + 1) * 50 >= total} onClick={() => onPage(page + 1)}>古い50件</button></div>}
  </div>
}
/** S21: pending proposals and the change trace from every entrance, with an owner-approved undo for agent changes. A later edit is shown as a re-diff, never overwritten. */
export default function ChangeHistoryView({ settings, tasks, latestOnly = false, initial = null, onOpenPolicy }: { settings: Settings; tasks: Task[]; latestOnly?: boolean; initial?: UndoPreparation | null; onOpenPolicy?: () => void }) {
  const audits = useLiveQuery(() => db.audits.toArray(), [])
  useSyncExternalStore(subscribeCommands, commandsVersion)
  const undone = undoneAuditIds(audits ?? [])
  const human: ChangeContext = { principal: { id: settings.profileId, kind: 'human' }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: [...taskChangeFields], sourceRevisions: [] }
  const [result, setResult] = useState<UndoPreparation | null>(initial), [notice, setNotice] = useState(initial?.status === 'already_undone' ? 'この変更は取り消し済みです。' : ''), [busy, setBusy] = useState(false)
  const [page, setPage] = useState(0), [open, setOpen] = useState<PreparedCommand | null>(null)
  async function prepare(auditIds: string[]) {
    setBusy(true); setNotice('')
    try { const prepared = await prepareUndoFromAudits(auditIds, human); setResult(prepared); if (prepared.status === 'already_undone') setNotice('この変更は取り消し済みです。') }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  function approve(command: PreparedCommand) {
    // External commands keep their main-process lease, so they are approved in the local agent screen.
    if (command.actor.entrance === 'file' || command.actor.entrance === 'mcp') { scrollTo('ローカルエージェント接続'); setNotice('ローカルエージェント接続の画面で同じ承認カードから許可します。'); return }
    setOpen(command)
  }
  const policyLink = onOpenPolicy ?? (() => scrollTo('自動化と承認の設定'))
  if (audits === undefined) return null
  // latestOnly: every task row of the newest coach-made change (agent or owner-approved on a coach screen), undone together.
  if (latestOnly) {
    const entries = latestCoachChange(audits ?? [])
    return <section className="card setting-section change-history" aria-label="AI・外部エージェントによる変更の履歴">
      <h2>直前のコーチ経由・代理の変更の取り消し</h2>
      <p className="muted">自動適用と本人承認の変更を区別して表示します。取り消しは保存された元の値へ戻す新しい変更として本人が確認します。完了記録・実績台帳は変わりません。</p>
      {!entries.length && <p>取り消せるコーチ経由・代理の変更はありません（本人の通常の編集はタスク編集で戻します）。</p>}
      {entries.map(entry => <article key={entry.auditId} className="change-history-entry"><h4>{tasks.find(task => task.id === entry.taskId)?.title ?? '削除済みタスク'}</h4>
        <small>{new Date(entry.at).toLocaleString('ja-JP')} · {entry.principal.kind === 'human' ? 'コーチ画面で本人が選んだ変更' : entry.principal.kind === 'coach' ? 'アプリ内コーチ' : '外部エージェント'}{entry.principal.model ? `（${entry.principal.model}）` : ''} · <strong>{entry.decision === 'auto' ? '設定範囲内で自動適用' : '本人が承認'}</strong>{undone.has(entry.auditId) ? ' · 取り消し済み' : ''}</small>
        {entry.fields.map(field => <p key={field}>{labels[field]}：{shown(entry.before[field])} → {shown(entry.after[field])}</p>)}
        <button type="button" className="secondary-button" disabled={busy || undone.has(entry.auditId) || !entry.undo} onClick={() => void prepare(entries.filter(item => !undone.has(item.auditId)).map(item => item.auditId))}>{entries.length > 1 ? `この変更（${entries.length}件）の取り消し案を作る` : '取り消し案を作る'}</button>
      </article>)}
      {result?.status === 'conflict' && <div role="alert"><p>その後にタスクが更新されているため、上書きせず差分を表示します。必要ならタスク編集で本人が直してください。</p>{result.rediff.map(item => <p key={item.field}>{labels[item.field]}：代理変更後 {shown(item.recorded)} / 現在 {shown(item.current)} / 取り消し先 {shown(item.restore)}</p>)}</div>}
      {result?.status === 'prepared' && <ChangeSetPreview key={result.prepared.id} prepared={result.prepared} policy={changePolicyFor(settings)} actorContext={human} humanContext={human} onApplied={() => { setResult(null); setNotice('直前の変更を取り消しました。取り消しも履歴に残ります。') }} onCancel={() => { setResult(null); setNotice('取り消し案を閉じました。タスクは変更していません。') }} />}
      {notice && <p role="status">{notice}</p>}
    </section>
  }
  const trace = changeTrace(audits, page), pending = pendingCommands(), received = receivedCommands()
  return <section className="card setting-section change-history" aria-label="変更の確認と履歴">
    <h2>変更の確認と履歴</h2>
    <p className="muted">アプリ（本人・コーチ）、ファイル受信箱、ローカルMCPからの変更を一か所で表示します。表示されるのは操作者（作成者ではありません）です。自動適用と本人承認を区別します。取り消しは保存された元の値へ戻す新しい変更として本人が確認します。完了記録・実績台帳は変わりません。</p>
    <PendingChangesList pending={pending} received={received} settings={settings} tasks={tasks} onApprove={approve} onPolicy={policyLink} />
    {open && open.envelope.type === 'task.split' ? <TaskSplitPreview key={open.id} command={open} onApplied={() => { setOpen(null); setNotice('分割を保存しました。') }} onCancel={() => { setOpen(null); setNotice('分割案を取り消しました。') }} />
      : open?.changeSet ? <ChangeSetPreview key={open.id} prepared={open.changeSet} policy={changePolicyFor(settings)} actorContext={changeContextFor(open.actor)} humanContext={humanContextFor(open.actor)} command={open} onApplied={() => { setOpen(null); setNotice('変更を保存しました。') }} onCancel={() => { setOpen(null); setNotice('変更案を取り消しました。タスクは変更していません。') }} />
      : open ? <p role="status">この案は、作成した画面で本人の値を確認してから承認します。</p> : null}
    <ChangeTraceList entries={trace.entries} tasks={tasks} total={trace.total} page={page} onPage={setPage} undone={undone} onUndo={auditId => void prepare([auditId])} busy={busy} />
    {result?.status === 'conflict' && <div role="alert"><p>その後にタスクが更新されているため、上書きせず差分を表示します。必要ならタスク編集で本人が直してください。</p>{result.rediff.map(item => <p key={item.field}>{labels[item.field]}：代理変更後 {shown(item.recorded)} / 現在 {shown(item.current)} / 取り消し先 {shown(item.restore)}</p>)}</div>}
    {result?.status === 'prepared' && <ChangeSetPreview key={result.prepared.id} prepared={result.prepared} policy={changePolicyFor(settings)} actorContext={human} humanContext={human} onApplied={() => { setResult(null); setNotice('代理変更を取り消しました。取り消しも履歴に残ります。') }} onCancel={() => { setResult(null); setNotice('取り消し案を閉じました。タスクは変更していません。') }} />}
    {notice && <p role="status">{notice}</p>}
  </section>
}
