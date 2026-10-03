import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Share2 } from 'lucide-react'
import { db } from './db'
import { download } from './backup'
import type { Settings, Task } from './domain'
import { changePolicyFor, type ChangeContext, type PreparedChangeSet } from './change-set'
import ChangeSetPreview from './ChangeSetPreview'
import { fingerprintGroups } from './share-crypto'
import { ensureShareIdentity, exportShareCard, importShareCard, pinShareOwner, verifyShareContact } from './share-identity'
import { createShareGrant, issueShareBundle, previewSharePayload, revokeShareGrant, type GrantPayload } from './share-grants'
import { importShareBundle } from './share-inbox'
import { applyShareProposalFromUI, buildShareReply, dismissShareProposal, importShareReply, prepareShareProposal } from './share-replies'
import { resolveSharedSourceLink } from './share-projection'
import { SHARE_FIELD_LABEL, SHARE_FIELDS, SHARE_ROLE_LABEL, SHARE_ROLES, type ShareCard, type ShareField, type SharedInbound, type ShareRole } from './share-types'
import { purgeExpiredSharedInbound, shareExpired, shareExpiry } from './share-lifetime'
import './HandoffSharing.css'

type Run = (fn: () => Promise<unknown>, success?: string) => Promise<boolean>
const stamp = () => new Date().toISOString().slice(0, 10)
async function readFile(event: React.ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return null; if (file.size > 5 * 1024 * 1024) throw new Error('5MBを超えるファイルは読み込めません'); return file.text() }

/** A received item: read-only, outside own tasks, points and today. */
export function SharedItemCard({ item, onSource, reply }: { item: SharedInbound; onSource: (message: string) => void; reply?: React.ReactNode }) {
  if (!item.projection || item.revokedAt || shareExpired(item)) return null
  const projection = item.projection!
  return <div className="shared-item"><strong>{projection.title ?? '（タイトルは共有されていません）'}</strong>
    <ul>{'status' in projection && <li>状態: {projection.status === 'completed' ? '完了' : '未完了'}</li>}{'scheduled_date' in projection && <li>予定日: {projection.scheduled_date ?? 'なし'}</li>}{'due_date' in projection && <li>締め切り: {projection.due_date ?? 'なし'}</li>}{'effective_points' in projection && <li>ポイント: {projection.effective_points ?? '未設定'}</li>}</ul>
    {item.shareNote && <p>共有メモ: {item.shareNote}</p>}
    <small className="muted">共有元: {item.ownerLabel}・権限: {SHARE_ROLE_LABEL[item.role]}・受信 {new Date(item.receivedAt).toLocaleString('ja-JP')}</small>
    {item.expiresAt && <p className="muted">共有の有効期限: {new Date(item.expiresAt).toLocaleString('ja-JP')}</p>}
    <div className="share-actions"><button type="button" className="ghost-action" onClick={() => onSource(resolveSharedSourceLink(projection.share_task_id))}>出典を開く</button></div>
    {reply}
  </div>
}

export default function SharingView({ settings, tasks, run }: { settings: Settings; tasks: Task[]; run: Run }) {
  const identity = useLiveQuery(() => db.shareIdentity.get('main'), [])
  const contacts = useLiveQuery(() => db.shareContacts.toArray(), [], [])
  const grants = useLiveQuery(async () => (await db.resourceGrants.toArray()).filter(row => row.datasetId === settings.datasetId && row.ownerId === settings.profileId), [settings.datasetId, settings.profileId], [])
  const inbound = useLiveQuery(() => db.sharedInbound.toArray(), [], [])
  const proposals = useLiveQuery(() => db.shareProposals.where('state').equals('pending').toArray(), [], [])
  const [name, setName] = useState(''), [notice, setNotice] = useState('')
  const [pendingOwner, setPendingOwner] = useState<{ card: ShareCard; raw: string } | null>(null)
  const [taskId, setTaskId] = useState(''), [recipientId, setRecipientId] = useState(''), [role, setRole] = useState<ShareRole>('viewer'), [fields, setFields] = useState<ShareField[]>(['title', 'scheduled_date', 'due_date']), [note, setNote] = useState('')
  const [preview, setPreview] = useState<GrantPayload | null>(null)
  const [shareDays, setShareDays] = useState(7)
  useEffect(() => {
    const purge = () => { void purgeExpiredSharedInbound().catch(() => setNotice('期限切れの共有の片付けに失敗しました。もう一度開いてください')) }
    purge()
    const timer = setInterval(purge, 30000)
    return () => clearInterval(timer)
  }, [])
  const [replies, setReplies] = useState<Record<string, { comment: string; title: string; scheduled: string }>>({})
  const [review, setReview] = useState<{ prepared: PreparedChangeSet; context: ChangeContext; proposalId: string } | null>(null)
  const open = tasks.filter(task => !task.deletedAt), verified = contacts.filter(contact => contact.verifiedAt), titleOf = (id: string) => tasks.find(task => task.id === id)?.title ?? '（削除済みのタスク）'
  const contactName = (id: string) => contacts.find(contact => contact.id === id)?.displayName ?? '不明な相手'
  const resetPreview = () => setPreview(null)
  async function receive(raw: string) {
    const result = await importShareBundle(raw)
    if (result.status === 'needs_owner_confirmation') { setPendingOwner({ card: result.card, raw }); return '共有元の指紋を確認してください' }
    setPendingOwner(null)
    return result.status === 'revoked' ? '共有元が取り消したため、この項目を表示しません' : result.status === 'expired' ? '共有の有効期限が切れているため、この項目を表示しません' : '共有された項目を受け取りました'
  }
  return <section className="card setting-section sharing-view" aria-label="タスクの共有">
    <div className="setting-heading"><Share2 size={20} /><div><h2>タスクの共有（ファイルでの共有スナップショット）</h2><p>選んだタスクの選んだ項目だけを、指紋を確認した相手に暗号化ファイルで渡します。リアルタイム共有やアカウントは使いません（接続型の共有はこのバージョンでは未提供）。</p></div></div>
    {notice && <p role="status" className="muted">{notice}</p>}
    <h3>この端末の共有用名刺</h3>
    {identity ? <><p className="fingerprint" aria-label="自分の指紋">{identity.displayName}: {fingerprintGroups(identity.card.fingerprint)}</p><button type="button" className="secondary-button" onClick={() => void run(async () => download(await exportShareCard(), `michi-share-card-${stamp()}.json`, 'application/json'), '名刺を書き出しました')}>名刺を書き出す</button></>
      : <div className="share-actions"><label className="field">表示名<input value={name} onChange={event => setName(event.target.value)} maxLength={100} /></label><button type="button" className="secondary-button" disabled={!name.trim()} onClick={event => void run(() => ensureShareIdentity(name, event.nativeEvent), '共有用の名刺を作成しました')}>共有用の名刺を作成</button></div>}
    <p className="muted">秘密鍵はこの端末の外へ出しません。バックアップにも入らないため、別の端末では新しい名刺になります。</p>
    <h3>相手</h3>
    <label className="field">相手の名刺を読み込む<input type="file" accept=".json,application/json" onChange={event => void run(async () => { const raw = await readFile(event); if (raw) await importShareCard(raw) }, '名刺を読み込みました。指紋を相手と別の方法で照合してください')} /></label>
    <ul>{contacts.map(contact => <li key={contact.id}><strong>{contact.displayName}</strong> <span className="fingerprint">{fingerprintGroups(contact.id)}</span> {contact.verifiedAt ? <span className="status-tag">指紋確認済み</span> : <button type="button" className="ghost-action" onClick={event => void run(() => verifyShareContact(contact.id, event.nativeEvent), '指紋を確認済みにしました')}>指紋を照合した</button>}</li>)}</ul>
    <h3>共有する</h3>
    <div className="share-actions">
      <label className="field">タスク<select value={taskId} onChange={event => { setTaskId(event.target.value); resetPreview() }}><option value="">選んでください</option>{open.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
      <label className="field">相手<select value={recipientId} onChange={event => { setRecipientId(event.target.value); resetPreview() }}><option value="">選んでください</option>{verified.map(contact => <option key={contact.id} value={contact.id}>{contact.displayName}</option>)}</select></label>
      <label className="field">権限<select value={role} onChange={event => { setRole(event.target.value as ShareRole); resetPreview() }}>{SHARE_ROLES.map(item => <option key={item} value={item}>{SHARE_ROLE_LABEL[item]}</option>)}</select></label>
      <label className="field">共有の有効期間<select value={shareDays} onChange={event => { setShareDays(Number(event.target.value)); resetPreview() }}>{[1, 7, 30, 90].map(days => <option key={days} value={days}>{days}日</option>)}</select></label>
    </div>
    <fieldset className="share-fields"><legend>共有する項目（メモ・コメント・添付・履歴・出典は共有しません）</legend>{SHARE_FIELDS.map(field => <label key={field}><input type="checkbox" checked={fields.includes(field)} onChange={event => { setFields(current => event.target.checked ? [...current, field] : current.filter(item => item !== field)); resetPreview() }} />{SHARE_FIELD_LABEL[field]}</label>)}</fieldset>
    <label className="field">相手へのメモ（任意・2000文字まで。資料の原文や出典は入れられません）<textarea value={note} maxLength={2000} onChange={event => { setNote(event.target.value); resetPreview() }} /></label>
    <div className="share-actions"><button type="button" className="secondary-button" disabled={!taskId || !recipientId || !fields.length} onClick={() => void run(async () => setPreview(await previewSharePayload({ taskId, role, sharedFields: fields, shareNote: note, expiresAt: shareExpiry(shareDays) })), '送る内容を表示しました')}>送る内容を確認</button>
      <button type="button" className="primary-button" disabled={!preview} onClick={event => { const native = event.nativeEvent; void run(async () => { const grant = await createShareGrant({ taskId, recipientId, role, sharedFields: fields, shareNote: note, expiresAt: preview?.expires_at ?? undefined }, native, preview ?? undefined); download(await issueShareBundle(grant.id, native, preview ?? undefined), `michi-share-${stamp()}.michishare`, 'application/json'); setPreview(null) }, '共有ファイルを書き出しました') }}>この内容で共有ファイルを書き出す</button></div>
    {preview && <pre aria-label="送る内容（暗号化前の全文）">{JSON.stringify(preview, null, 2)}</pre>}
    <h3>共有中</h3>
    <p className="muted">取り消すと権限の版が上がり、取り消しファイルを渡した相手の端末から表示が消えます。相手の端末にあるコピーは遠隔削除できません。</p>
    <ul>{grants.map(grant => <li key={grant.id}>{titleOf(grant.resource.id)} → {contactName(grant.recipientId)}（{SHARE_ROLE_LABEL[grant.role]}・版{grant.authorizationEpoch}）{grant.expiresAt && <>・有効期限 {new Date(grant.expiresAt).toLocaleString('ja-JP')}{shareExpired(grant) && <span className="status-tag">期限切れ</span>}</>}{grant.revokedAt ? <> <span className="status-tag">取り消し済み</span> <button type="button" className="ghost-action" onClick={event => void run(async () => download(await revokeShareGrant(grant.id, event.nativeEvent), `michi-share-revoke-${stamp()}.michishare`, 'application/json'), '取り消しファイルを書き出しました')}>取り消しファイルを再出力</button></> : <> <button type="button" className="ghost-action" disabled={shareExpired(grant)} onClick={event => void run(async () => download(await issueShareBundle(grant.id, event.nativeEvent), `michi-share-${stamp()}.michishare`, 'application/json'), '最新の内容で書き出しました')}>最新の内容で書き出す</button> <button type="button" className="ghost-action" onClick={event => { const native = event.nativeEvent; if (confirm('この共有を取り消します。相手の端末にあるコピーは遠隔削除できません。取り消しファイルを相手に渡してください。続けますか？')) void run(async () => download(await revokeShareGrant(grant.id, native), `michi-share-revoke-${stamp()}.michishare`, 'application/json'), '共有を取り消し、取り消しファイルを書き出しました') }}>取り消す</button></>}</li>)}</ul>
    <label className="field">相手からの返信ファイル（.michireply）を読み込む<input type="file" accept=".michireply,application/json" onChange={event => void run(async () => { const raw = await readFile(event); if (!raw) return; const result = await importShareReply(raw); setNotice(`コメント${result.added}件を追加${result.duplicates ? `（取込済み${result.duplicates}件は追加しません）` : ''}${result.proposalId ? '・編集の提案を受け取りました' : ''}`) }, '返信を確認しました')} /></label>
    {proposals.map(proposal => <div key={proposal.id} className="shared-item"><strong>{proposal.authorLabel}からの編集提案: {titleOf(proposal.taskId)}</strong><ul>{Object.entries(proposal.fields).map(([field, value]) => <li key={field}>{field === 'title' ? 'タイトル' : '予定日'} → {value ?? '未設定'}</li>)}</ul>
      <div className="share-actions"><button type="button" className="secondary-button" onClick={event => void run(async () => { const result = await prepareShareProposal(proposal.id, event.nativeEvent); setReview({ prepared: result.prepared, context: result.context, proposalId: proposal.id }) }, '提案を変更案として表示しました。承認するまで何も変わりません')}>提案を確認する</button><button type="button" className="ghost-action" onClick={event => void run(() => dismissShareProposal(proposal.id, event.nativeEvent), '提案を見送りました')}>見送る</button></div>
      {review?.proposalId === proposal.id && <ChangeSetPreview key={review.prepared.id} prepared={review.prepared} policy={changePolicyFor(settings)} actorContext={review.context} humanContext={review.context} trace={{ entrance: 'file', basis: 'external_request', commandId: proposal.id, label: proposal.authorLabel }} onApprove={async (event, checked) => { await applyShareProposalFromUI(proposal.id, review.prepared, review.context, event, checked); setReview(null); setNotice('提案を本人承認で反映しました') }} onApplied={() => setReview(null)} onCancel={() => setReview(null)} />}
    </div>)}
    <h3>共有された項目</h3>
    <label className="field">受け取った共有ファイル（.michishare）を読み込む<input type="file" accept=".michishare,application/json" onChange={event => void run(async () => { const raw = await readFile(event); if (raw) setNotice(await receive(raw)) }, '共有ファイルを確認しました')} /></label>
    {pendingOwner && <div className="shared-item" role="group" aria-label="共有元の確認"><p>初めての共有元です: <strong>{pendingOwner.card.display_name}</strong></p><p className="fingerprint">{fingerprintGroups(pendingOwner.card.fingerprint)}</p><p className="muted">この指紋を共有元と別の方法（対面・電話など）で照合してから受け取ってください。</p><button type="button" className="primary-button" onClick={event => void run(async () => { await pinShareOwner(pendingOwner.card, event.nativeEvent); setNotice(await receive(pendingOwner.raw)) }, '共有元を確認しました')}>指紋を照合して受け取る</button></div>}
    {inbound.filter(item => item.projection && !item.revokedAt && !shareExpired(item)).map(item => <SharedItemCard key={item.id} item={item} onSource={setNotice} reply={item.role !== 'viewer' && <div className="share-actions">
      <label className="field">コメント<textarea value={replies[item.id]?.comment ?? ''} maxLength={10000} onChange={event => setReplies(current => ({ ...current, [item.id]: { comment: event.target.value, title: current[item.id]?.title ?? '', scheduled: current[item.id]?.scheduled ?? '' } }))} /></label>
      {item.role === 'editor' && <><label className="field">提案するタイトル<input value={replies[item.id]?.title ?? ''} onChange={event => setReplies(current => ({ ...current, [item.id]: { comment: current[item.id]?.comment ?? '', title: event.target.value, scheduled: current[item.id]?.scheduled ?? '' } }))} /></label><label className="field">提案する予定日<input type="date" value={replies[item.id]?.scheduled ?? ''} onChange={event => setReplies(current => ({ ...current, [item.id]: { comment: current[item.id]?.comment ?? '', title: current[item.id]?.title ?? '', scheduled: event.target.value } }))} /></label></>}
      <button type="button" className="secondary-button" onClick={event => { const native = event.nativeEvent, value = replies[item.id], proposal = { ...(value?.title.trim() ? { title: value.title.trim() } : {}), ...(value?.scheduled ? { scheduled_date: value.scheduled } : {}) }; void run(async () => { download(await buildShareReply(item.id, { comments: value?.comment ? [value.comment] : [], ...(Object.keys(proposal).length ? { proposal } : {}) }, native), `michi-reply-${stamp()}.michireply`, 'application/json'); setReplies(current => ({ ...current, [item.id]: { comment: '', title: '', scheduled: '' } })) }, '返信ファイルを書き出しました') }}>返信ファイルを書き出す</button>
      <small className="muted">手動ポイントと締め切りは提案できません。共有元が承認するまで何も変わりません。</small>
    </div>} />)}
    <p className="muted">共有された項目は自分のタスク・今日の予定・ポイント・台帳・資料検索には入りません。</p>
  </section>
}
