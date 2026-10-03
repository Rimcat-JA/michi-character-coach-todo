import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { externalAIFor } from './external-authority'
import { acceptHandoffDraft, listHandoffDrafts, rejectHandoffDraft } from './external-handoffs'
import { listContextSharePackages, revokeContextSharePackage, shareContextPackage } from './context-share'
import type { Settings, Task } from './domain'

/** S25 owner review: external handoff drafts (labeled unconfirmed) and recipient-bound shares. */
export default function HandoffsView({ settings, tasks }: { settings: Settings; tasks: Task[] }) {
  const external = externalAIFor(settings)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [recipient, setRecipient] = useState('')
  const [shareTasks, setShareTasks] = useState<string[]>([])
  const drafts = useLiveQuery(() => listHandoffDrafts(), []) ?? []
  const packages = useLiveQuery(() => listContextSharePackages(), []) ?? []
  const titleOf = (id: string) => tasks.find((task) => task.id === id)?.title ?? '(削除されたタスク)'
  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setNotice('')
    try { await action() } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  const activeClients = external.clients.filter((client) => client.status === 'active')
  return (
    <section className="card" aria-label="外部AIの引継ぎと共有">
      <h3>外部AIの引継ぎと共有</h3>
      <p>外部AIの下書きは未確認として扱い、本人の受入・却下でのみ確定します。共有は選んだ接続先だけが期限内に取得できます。</p>
      {drafts.filter((row) => row.state === 'draft').map((draft) => (
        <article key={draft.id}>
          <p>外部AI（未確認）・{new Date(draft.createdAt).toLocaleString('ja-JP')}</p>
          <p>{draft.summary}</p>
          <p>{draft.targetTaskIds.map(titleOf).join('・')}</p>
          <label className="field"><span>受入時の要約（任意編集）</span>
            <textarea value={edits[draft.id] ?? ''} disabled={busy} onChange={(event) => setEdits({ ...edits, [draft.id]: event.target.value })} />
          </label>
          <button type="button" className="primary-button" disabled={busy} onClick={(event) => { const native = event.nativeEvent; void run(async () => { await acceptHandoffDraft(draft.id, draft.revision, edits[draft.id]?.trim() ? edits[draft.id] : null, native); setNotice('引継ぎをメモに保存しました。') }) }}>受入れてメモにする</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={(event) => { const native = event.nativeEvent; void run(async () => { await rejectHandoffDraft(draft.id, draft.revision, native); setNotice('引継ぎを却下しました。') }) }}>却下する</button>
        </article>
      ))}
      {activeClients.length ? (
        <div>
          <h4>文脈パッケージを共有</h4>
          <label className="field"><span>共有先の接続</span>
            <select value={recipient} disabled={busy} onChange={(event) => setRecipient(event.target.value)}>
              <option value="">選択してください</option>
              {activeClients.map((client) => <option key={client.registration.client.id} value={client.registration.client.id}>{client.registration.client.intended_host} / {client.registration.client.id.slice(0, 8)}{client.registration.client.grant.allow_handoffs ? '' : '（受取未許可）'}</option>)}
            </select>
          </label>
          <fieldset disabled={busy}><legend>共有するタスク（最大50件）</legend>
            {tasks.filter((task) => !task.deletedAt && task.status === 'open').map((task) => (
              <label key={task.id} className="field"><span><input type="checkbox" checked={shareTasks.includes(task.id)} onChange={(event) => setShareTasks(event.target.checked ? [...shareTasks, task.id] : shareTasks.filter((id) => id !== task.id))} /> {task.title}</span></label>
            ))}
          </fieldset>
          <button type="button" className="primary-button" disabled={busy || !recipient} onClick={(event) => { const native = event.nativeEvent; void run(async () => { await shareContextPackage({ recipientClientId: recipient, taskIds: shareTasks, sourceQuotes: [] }, native); setShareTasks([]); setNotice('共有を作成しました。24時間で失効します。') }) }}>共有を作成</button>
          {packages.map((record) => (
            <article key={record.id}>
              <p>{record.recipientClientId.slice(0, 8)}宛・{record.refs.length}件・期限{new Date(record.expiresAt).toLocaleString('ja-JP')}{record.revokedAt ? '・取消済み' : ''}</p>
              {!record.revokedAt ? <button type="button" className="secondary-button" disabled={busy} onClick={(event) => { const native = event.nativeEvent; void run(async () => { await revokeContextSharePackage(record.id, native); setNotice('共有を取り消しました。') }) }}>取り消す</button> : null}
            </article>
          ))}
        </div>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  )
}
