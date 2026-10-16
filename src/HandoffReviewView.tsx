import { useEffect, useRef, useState } from 'react'
import type { Snapshot } from './backup-validation'
import { adoptHandoffFields, adoptHandoffTask, inspectHandoff, keepLocalForHandoff, replaceAfterExport, replaceWithHandoff, type AdoptableField, type HandoffField, type HandoffFieldDiff, type HandoffPreview, type HandoffTaskComparison, type HandoffTaskState } from './handoff'
import { acceptMoveBundle } from './dataset-mode'
import './HandoffSharing.css'

const STATE_LABEL: Record<HandoffTaskState, string> = { identical: '同じ', incoming_only: '取込ファイルだけ変更', local_only: 'この端末だけ変更', both_changed: '両方で変更', created_local: 'この端末だけにある', created_incoming: '取込ファイルだけにある', deleted: '片方で削除', needs_review: '要確認（基準が不明）' }
const FIELD_LABEL: Record<HandoffField, string> = { title: 'タイトル', notes: 'メモ', project: 'プロジェクト', labels: 'ラベル', scoreMode: 'ポイント方式', manualPoints: '手動ポイント', scheduledDate: '予定日', dueDate: '締め切り', dueAt: '締め切り時刻', status: '状態', completed: '完了', completionNetPoints: '完了の実績pt', deletedAt: '削除' }
const ROW_LABEL: Record<string, string> = { tasks: 'タスクの詳細', assessments: '評価履歴', completions: '完了記録', ledger: 'ポイント台帳', sessions: '作業時間', routines: 'ルーティン', containers: 'カテゴリ・プロジェクト', checklistItems: 'チェック項目', taskNotes: 'ノート', taskComments: 'コメント', taskAttachments: '添付', taskDependencies: '依存関係', rollovers: '繰越履歴', habits: '習慣', habitLogs: '習慣の記録', goals: '目標', goalCheckIns: '目標の振り返り', trackerEntries: '記録値', dayNotes: '日記', pomodoroCycles: 'ポモドーロ', reviewRecords: '振り返り', labelGroups: 'ラベルグループ', labelDefinitions: 'ラベル定義', savedTemplates: 'テンプレート', planningBuckets: '計画期間', timeBlocks: '時間枠', calendarEvents: '予定', themeRules: '重点テーマ', smartLists: '保存した検索条件', focusSelections: '集中するプロジェクト', trackerDefinitions: '記録項目', tripBundles: '外出のまとまり', calendarRules: '予定資料の規則', achievementPolicies: '実績公開の規則', achievementEvidence: '実績の証拠', achievementExports: '実績の公開記録', taskSourceEvidence: 'タスクの出典' }
const ADOPT: Partial<Record<HandoffField, AdoptableField>> = { title: 'title', notes: 'notes', scoreMode: 'score', manualPoints: 'score', scheduledDate: 'scheduledDate', dueDate: 'dueDate', dueAt: 'dueDate' }
const MANUAL_ONLY: HandoffField[] = ['status', 'completed', 'completionNetPoints', 'deletedAt']
const show = (value: unknown) => value === null || value === undefined || value === '' ? '—' : Array.isArray(value) ? value.join(', ') || '—' : typeof value === 'boolean' ? value ? 'はい' : 'いいえ' : String(value).length > 80 ? `${String(value).slice(0, 80)}…` : String(value)

/** S19-equivalent review table: base / この端末 / 取込ファイル per field, manual points highlighted, completion differences only as 要手動対応. */
export function HandoffReviewTable({ preview, selected, onToggle, onAdopt, onAdoptTask, busy }: { preview: HandoffPreview; selected: Record<string, AdoptableField[]>; onToggle: (taskId: string, field: AdoptableField) => void; onAdopt: (task: HandoffTaskComparison, event: Event) => void; onAdoptTask: (task: HandoffTaskComparison, event: Event) => void; busy: boolean }) {
  const rows = preview.comparison.tasks.filter(task => task.state !== 'identical')
  if (!rows.length) return <p className="muted">タスクの内容に違いはありません。</p>
  return <div className="handoff-table-wrap"><table className="handoff-table"><thead><tr><th>タスク</th><th>項目</th><th>基準{preview.comparison.baseKnown ? '' : '（不明）'}</th><th>この端末</th><th>取込ファイル</th><th>取り込む</th></tr></thead><tbody>
    {rows.map(task => {
      const diffs: (HandoffFieldDiff | null)[] = task.diffs.length ? task.diffs : [null]
      return diffs.map((diff, index) => {
        const adopt = diff && ADOPT[diff.field], local = task.localRevision !== null
        return <tr key={`${task.taskId}:${diff?.field ?? 'row'}`} className={diff && (diff.field === 'manualPoints' || diff.field === 'scoreMode') && task.manualConflict ? 'handoff-manual' : undefined}>
          {index === 0 && <td rowSpan={diffs.length}><strong>{task.title}</strong><small className="handoff-state">{STATE_LABEL[task.state]}</small>{task.completionConflict && <small className="handoff-attention">完了・実績の違いは要手動対応（台帳は統合しません）</small>}
            {task.state === 'created_incoming' || !local && task.state === 'needs_review' ? <button type="button" className="secondary-button" disabled={busy} onClick={event => onAdoptTask(task, event.nativeEvent)}>このタスクを取り込む</button> : local && task.diffs.some(item => ADOPT[item.field]) && <button type="button" className="secondary-button" disabled={busy || !(selected[task.taskId] ?? []).length} onClick={event => onAdopt(task, event.nativeEvent)}>選んだ項目を取り込む</button>}</td>}
          {diff ? <><td>{FIELD_LABEL[diff.field]}{(diff.field === 'manualPoints' || diff.field === 'scoreMode') && task.manualConflict && <span className="status-tag">手動</span>}</td><td>{preview.comparison.baseKnown ? show(diff.base) : '—'}</td><td>{show(diff.local)}</td><td>{show(diff.incoming)}</td>
            <td>{MANUAL_ONLY.includes(diff.field) ? <span className="handoff-attention">要手動対応</span> : adopt && local ? <label><input type="checkbox" aria-label={`${task.title}の${FIELD_LABEL[diff.field]}を取り込む`} checked={(selected[task.taskId] ?? []).includes(adopt)} onChange={() => onToggle(task.taskId, adopt)} />取込</label> : 'この端末の値を維持'}</td></> : <td colSpan={5}>{STATE_LABEL[task.state]}</td>}
        </tr>
      })
    })}
  </tbody></table></div>
}
export function LocalOnlyRows({ preview }: { preview: HandoffPreview }) {
  const entries = Object.entries(preview.comparison.localOnlyRows)
  const conflicts = preview.comparison.rowConflicts ?? []
  const changed = Object.entries(conflicts.reduce<Record<string, number>>((counts, row) => { counts[row.table] = (counts[row.table] ?? 0) + 1; return counts }, {}))
  if (!entries.length && !changed.length) return null
  return <div className="handoff-attention">
    {entries.length > 0 && <p>この端末だけにある記録: {entries.map(([table, count]) => `${ROW_LABEL[table] ?? table}${count}件`).join('、')}。置き換えると失われるため、直接の置き換えはできません。</p>}
    {changed.length > 0 && <p>内容の変更・削除に確認が必要な記録: {changed.map(([table, count]) => `${ROW_LABEL[table] ?? table}${count}件`).join('、')}。この端末を維持するか、先に書き出してから置き換えてください。</p>}
  </div>
}

type Props = { snapshot: Snapshot; password: string; onClose: () => void; onDone: (message: string) => void; onError: (error: unknown) => void }
export default function HandoffReviewView({ snapshot, password, onClose, onDone, onError }: Props) {
  const [preview, setPreview] = useState<HandoffPreview | null>(null), [selected, setSelected] = useState<Record<string, AdoptableField[]>>({}), [busy, setBusy] = useState(false), [code, setCode] = useState('')
  async function refresh() { setPreview(await inspectHandoff(snapshot)) }
  const reportError = useRef(onError)
  useEffect(() => { reportError.current = onError }, [onError])
  useEffect(() => { let live = true; inspectHandoff(snapshot).then(value => { if (live) setPreview(value) }, error => reportError.current(error)); return () => { live = false } }, [snapshot])
  async function act(fn: () => Promise<unknown>, message: string, close = true) {
    if (busy) return
    setBusy(true)
    try { await fn(); onDone(message); if (close) onClose(); else { setSelected({}); await refresh() } } catch (error) { onError(error) } finally { setBusy(false) }
  }
  if (!preview) return <div className="restore-preview handoff-review" aria-busy="true"><strong>手動の引継ぎ確認</strong><p>差分を確認しています…</p></div>
  const { counts, comparison } = preview, kind = preview.manifest?.kind ?? null
  const countLine = `この端末: タスク${counts.localTasks}件・完了${counts.localCompletions}件・台帳${counts.localLedger}件 ／ 取込ファイル: タスク${counts.incomingTasks}件・完了${counts.incomingCompletions}件・台帳${counts.incomingLedger}件`
  const confirmDifferent = () => confirm(`別データセットで置き換えます。\n${countLine}\nこの端末の現在のデータは置き換わります。続けますか？`)
  if (code) return <div className="restore-preview handoff-review"><strong>移行を受け入れました</strong><p>移行元の端末で次の完了コードを入力すると、移行元は読み取り専用になります。</p><p className="handoff-code" aria-label="移行の完了コード">{code}</p><button type="button" className="secondary-button" onClick={onClose}>閉じる</button></div>
  return <div className="restore-preview handoff-review" role="group" aria-label="手動の引継ぎ確認">
    <strong>手動の引継ぎ確認{kind === 'move' ? '（移行ファイル）' : kind === 'fork' ? '（複製ファイル）' : ''}</strong>
    <p className="muted">{countLine}</p>
    {!preview.manifest && <p className="handoff-attention">引継ぎ情報のない旧形式のファイルです。どちらで変更したか判断できないため、違いはすべて要確認として扱います。</p>}
    {preview.alreadyImported && <p className="muted">このファイルは以前にも確認済みです。</p>}
    {!preview.sameDataset ? <>
      <p>別データセットのファイルです{kind === 'fork' ? '（元データセットから複製された独立コピー）' : ''}。この端末のデータと照合せず、全体を置き換えます。</p>
      <div className="change-set-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>キャンセル</button>
        {kind === 'move' ? <button type="button" className="primary-button" disabled={busy} onClick={event => { const native = event.nativeEvent; if (confirmDifferent()) void act(async () => setCode(await acceptMoveBundle(snapshot, native, { confirmDifferentDataset: true })), '移行を受け入れました', false) }}>移行を受け入れる（別データセットで置き換え）</button>
          : <button type="button" className="primary-button" disabled={busy} onClick={() => { if (confirmDifferent()) void act(() => replaceWithHandoff(snapshot, { confirmDifferentDataset: true }), '別データセットで置き換えました') }}>別データセットで置き換え</button>}</div>
    </> : <>
      <HandoffReviewTable preview={preview} selected={selected} busy={busy} onToggle={(taskId, field) => setSelected(current => { const list = current[taskId] ?? []; return { ...current, [taskId]: list.includes(field) ? list.filter(item => item !== field) : [...list, field] } })}
        onAdopt={(task, event) => void act(() => adoptHandoffFields(snapshot, task.taskId, selected[task.taskId] ?? [], task.localRevision!, event), '選んだ項目を取り込みました（履歴は残しています）', false)}
        onAdoptTask={(task, event) => void act(() => adoptHandoffTask(snapshot, task.taskId, event), 'タスクを取り込みました', false)} />
      <LocalOnlyRows preview={preview} />
      {comparison.blocking ? <p className="muted">この端末だけの変更があるため、そのまま置き換えることはできません。選択肢: 取り込まない／この端末を正本として維持／書き出してから置き換え／個別に取り込む。</p> : <p className="muted">この端末だけの変更はありません。</p>}
      <div className="change-set-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>キャンセル</button>
        {kind !== 'move' && <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(() => keepLocalForHandoff(snapshot), 'この端末を正本として維持しました')}>この端末を正本として維持</button>}
        {kind === 'move' ? <button type="button" className="primary-button" disabled={busy || comparison.blocking && password.length < 10} onClick={event => { const native = event.nativeEvent; if (confirm(comparison.blocking ? 'この端末を先に書き出してから、移行ファイルで置き換えます。続けますか？' : '移行ファイルでこの端末を置き換え、有効にします。続けますか？')) void act(async () => setCode(await acceptMoveBundle(snapshot, native, comparison.blocking ? { exportFirst: { password } } : {})), '移行を受け入れました', false) }}>{comparison.blocking ? 'この端末を書き出してから移行を受け入れる' : '移行を受け入れる'}</button>
          : comparison.blocking ? <button type="button" className="primary-button" disabled={busy || password.length < 10} title={password.length < 10 ? '上のバックアップ用パスワード（10文字以上）を入力してください' : undefined} onClick={() => { if (confirm('この端末のデータを暗号化バックアップとして書き出してから、取込ファイルで置き換えます。続けますか？')) void act(() => replaceAfterExport(snapshot, password), '書き出してから置き換えました') }}>この端末を書き出してから置き換え</button>
          : <button type="button" className="primary-button" disabled={busy} onClick={() => { if (confirm(`取込ファイルで置き換えます。${counts.incomingTasks}件のタスクになります。続けますか？`)) void act(() => replaceWithHandoff(snapshot), '取込ファイルで置き換えました') }}>このファイルで置き換え</button>}
      </div>
    </>}
  </div>
}
