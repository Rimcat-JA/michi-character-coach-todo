import { useLiveQuery } from 'dexie-react-hooks'
import type { Task } from './domain'
import { legacyNotesState, taskEvidenceDisplay } from './task-source-evidence'

/** Quotes are shown only while their source may still be read; erased sources leave a body-free marker. */
export default function TaskSourceEvidenceView({ task, notes }: { task: Task | null; notes: string }) {
  const display = useLiveQuery(() => task ? taskEvidenceDisplay(task) : Promise.resolve(null), [task?.id, task?.revision])
  const legacy = legacyNotesState(notes)
  if (!display?.quotes.length && !display?.erasedSourceIds.length && legacy !== 'edited') return null
  return <section className="task-source-evidence" aria-label="資料の根拠">
    <h3>資料の根拠</h3>
    {display && display.quotes.length > 0 && <><p className="muted">検出候補の採用時に保存した資料の引用です。メモとは別に保存し、資料の削除・期限切れ・保存/索引許可の取消で消去します。外部AIへは、資料の許可があるコーチ会話だけで送ります。</p>
      {display.quotes.map(row => <blockquote key={row.id} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><p>{row.quote}</p><small>{row.sourceTitle} · 内容版{row.snapshotRevision} · {row.spanId}</small></blockquote>)}</>}
    {display?.erasedSourceIds.map(id => <p key={id} className="status-tag">出典削除済み（引用消去済み） · 資料 {id.slice(0, 12)}</p>)}
    {legacy === 'edited' && <p role="note">資料由来の可能性：メモに旧形式の検出引用が編集された状態で残っています。本人の文は消していません。外部AI・外部エージェントへはこのメモを送りません。引用を確認・削除し、先頭の『資料から検出し本人が確認する候補。』の行と『[資料ID 内容版N …]』の行を消すと送信対象に戻ります。</p>}
  </section>
}
