import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import { addTaskAttachment, addTaskComment, addTaskNote, downloadTaskAttachment } from './materials'
import type { Task, TaskComment, TaskNote } from './domain'

/** Pure comment list so the recipient label is unit-tested without IndexedDB. */
export function CommentList({ comments }: { comments: TaskComment[] }) {
  return <>{comments.map(comment => <div className="material-entry" key={comment.id}><span className="status-tag">{comment.authorKind === 'share_recipient' ? `共有相手 ${comment.authorLabel ?? ''}`.trim() : '本人'}</span><p>{comment.body}</p></div>)}</>
}

export default function TaskMaterials({ task, onError }: { task: Task | null; onError: (error: unknown) => void }) {
  const [noteText, setNoteText] = useState(''), [noteKind, setNoteKind] = useState<TaskNote['kind']>('self')
  const [commentText, setCommentText] = useState('')
  const notes = useLiveQuery(() => task ? db.taskNotes.where('taskId').equals(task.id).toArray() : [], [task?.id]) ?? []
  const comments = useLiveQuery(() => task ? db.taskComments.where('taskId').equals(task.id).toArray() : [], [task?.id]) ?? []
  const attachments = useLiveQuery(() => task ? db.taskAttachments.where('taskId').equals(task.id).toArray() : [], [task?.id]) ?? []
  if (!task) return <p className="muted">ノート・コメント・添付はタスク保存後に追加できます。</p>
  const addNote = async () => { try { await addTaskNote(task.id, noteText, noteKind); setNoteText('') } catch (error) { onError(error) } }
  const addComment = async () => { try { await addTaskComment(task.id, commentText); setCommentText('') } catch (error) { onError(error) } }
  return <section className="task-materials">
    <h3>ノート・コメント・添付</h3>
    <p className="muted">ノートのMarkdownは文字として安全に表示します。引用と本人の記述を分けて保存します。</p>
    <div className="material-block"><strong>ノート</strong>{notes.map(note => <div className="material-entry" key={note.id}><span className="status-tag">{note.kind === 'source' ? '出典・引用' : '本人の記述'}</span><p>{note.body}</p></div>)}<select aria-label="ノートの種類" value={noteKind} onChange={event => setNoteKind(event.target.value as TaskNote['kind'])}><option value="self">本人の記述</option><option value="source">出典・引用</option></select><textarea aria-label="新しいノート" rows={3} maxLength={50000} value={noteText} onChange={event => setNoteText(event.target.value)} placeholder="Markdownを入力" /><button className="secondary-button" disabled={!noteText.trim()} onClick={addNote}>ノートを追加</button></div>
    <div className="material-block"><strong>コメント</strong><CommentList comments={comments} /><textarea aria-label="新しいコメント" rows={2} maxLength={10000} value={commentText} onChange={event => setCommentText(event.target.value)} /><button className="secondary-button" disabled={!commentText.trim()} onClick={addComment}>コメントを追加</button></div>
    <div className="material-block"><strong>添付</strong>{attachments.map(attachment => <div className="material-entry" key={attachment.id}><button className="text-button" onClick={() => downloadTaskAttachment(attachment.id).catch(onError)}>{attachment.name} · {Math.ceil(attachment.size / 1024)}KB を保存</button></div>)}<label className="field">ファイルを追加（最大5MB）<input type="file" onChange={async event => { const file = event.target.files?.[0]; if (file) { try { await addTaskAttachment(task.id, file); event.target.value = '' } catch (error) { onError(error) } } }} /></label></div>
  </section>
}
