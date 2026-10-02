import { useEffect, useState } from 'react'
import { today, type Settings } from './domain'
import { db } from './db'
import { addSourceRevision, importLocalSource, defaultSourcePermissions, type SnapshotDocument } from './source-library'
type Root = { id: string; name: string; error: string | null; pending: { id: string; name: string; state: 'changed' | 'missing'; sha256: string | null }[] }
type Extracted = { text: string; name: string; sha256: string; document?: SnapshotDocument }
export type FolderWatchBridge = {
  (input: { action: 'list' }): Promise<Root[]>
  (input: { action: 'start' }): Promise<string | null>
  (input: { action: 'stop'; id: string }): Promise<boolean>
  (input: { action: 'read'; id: string; candidateId: string }): Promise<Extracted>
  (input: { action: 'accept'; id: string; candidateId: string; sha256: string }): Promise<boolean>
}
export default function FolderWatchView({ settings }: { settings: Settings }) {
  const bridge = window.michiAI?.folderWatch
  const [roots, setRoots] = useState<Root[]>([]), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ rootId: string; candidateId: string; content: Extracted } | null>(null)
  async function refresh() { if (bridge) setRoots(await bridge({ action: 'list' })) }
  useEffect(() => { let alive = true; const update = async () => { if (bridge) { const value = await bridge({ action: 'list' }); if (alive) setRoots(value) } }; const timer = setInterval(() => void update().catch(() => {}), 3000), initial = setTimeout(() => void update().catch(() => {}), 0); return () => { alive = false; clearInterval(timer); clearTimeout(initial) } }, [bridge, settings.datasetId])
  async function act(fn: () => Promise<unknown>) { setBusy(true); setNotice(''); try { await fn(); await refresh() } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) } }
  if (!bridge) return <p className="muted">フォルダー監視はWindows版で使えます。</p>
  return <details><summary>選んだ資料フォルダーの更新確認</summary><p>起動中だけ監視します。新規・変更を保留し、本人が本文を確認して保存します。欠落・削除からタスクを取り消しません。AI呼出と検出は別の本人操作です。</p>
    <button className="secondary-button" disabled={busy} onClick={() => void act(() => bridge({ action: 'start' }))}>監視フォルダーを選ぶ</button>
    {roots.map(root => <article key={root.id}><strong>{root.name}</strong><button className="text-button" disabled={busy} onClick={() => void act(async () => { await bridge({ action: 'stop', id: root.id }); setPreview(null) })}>監視を停止</button>{root.error && <p role="alert">{root.error}</p>}{root.pending.map(item => <div key={item.id}><p>{item.name}：{item.state === 'missing' ? 'ファイルが見つかりません。取消根拠にはしません' : '新規または変更'}</p>{item.state === 'changed' && <button className="secondary-button" disabled={busy} onClick={() => void act(async () => setPreview({ rootId: root.id, candidateId: item.id, content: await bridge({ action: 'read', id: root.id, candidateId: item.id }) }))}>更新本文を確認</button>}</div>)}</article>)}
    {preview && <div><h3>{preview.content.name}の新しい版</h3><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{preview.content.text.slice(0, 3000)}</pre>{preview.content.document?.unread.map((item, i) => <p key={i}>{item.location}：{item.reason}</p>)}<p>日付は本日・AI送信はOFFで保存します。許可済み資料の更新では元の許可を保持します。</p><button className="secondary-button" disabled={busy} onClick={event => { if (!event.nativeEvent.isTrusted) return; void act(async () => {
      const checked = await bridge({ action: 'read', id: preview.rootId, candidateId: preview.candidateId })
      if (checked.sha256 !== preview.content.sha256) throw new Error('確認後にファイルが変わりました')
      const externalId = `watch:${preview.rootId}:${preview.candidateId}`
      const existing = (await db.contextSources.where('ownerId').equals(settings.profileId).toArray()).find(source => source.externalId === externalId)
      if (existing) await addSourceRevision(existing.id, existing.revision, checked)
      else await importLocalSource({ ...checked, title: checked.name.slice(0, 200), provider: 'local', externalId, conversation: null, author: null, sourceUrl: null, date: today(), fromDate: today(), toDate: today(), permissions: defaultSourcePermissions(), allowedModels: [], retentionUntil: null })
      await bridge({ action: 'accept', id: preview.rootId, candidateId: preview.candidateId, sha256: checked.sha256 }); setPreview(null); setNotice('本人が確認した新しい版を保存しました')
    }) }}>確認した新しい版を保存</button></div>}
    {notice && <p role="status">{notice}</p>}
  </details>
}
