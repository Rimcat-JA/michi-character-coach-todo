import { useState } from 'react'
import type { Settings } from './domain'
import { changePolicyFor } from './change-set'
import RetentionChoice from './RetentionChoice'
import { defaultSourceRetention, retentionDefaults, retentionDraft, retentionValue } from './retention-defaults'
import { MAX_EMAIL_BYTES, makeWebCaptureCapsule, parseLocalEmailFile, parseWebCaptureFile, prepareEmailCaptureImport, prepareWebCaptureImport, saveCaptureImportFromUI } from './web-capture-import'
import { prepareCaptureTask, type CaptureTaskDraft } from './capture-task'
import type { CaptureImportPreview, CaptureImportReceipt, ParsedLocalEmail } from './web-capture-import'

type Props = { settings: Settings; onImported?: (receipt: CaptureImportReceipt) => void; onManualTask?: (draft:CaptureTaskDraft)=>void }
export function WebCaptureImportView(props: Props) {
  return <CapturePanel key={`${props.settings.profileId}:${props.settings.datasetId}`} {...props}/>
}
function CapturePanel({ settings, onImported, onManualTask }: Props) {
  const [mode, setMode] = useState<'web' | 'capsule' | 'email'>('web')
  const [form, setForm] = useState({ title: '', url: '', quote: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, capsule: '' })
  const [email, setEmail] = useState<ParsedLocalEmail | null>(null)
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [preview, setPreview] = useState<CaptureImportPreview | null>(null)
  const [receipt, setReceipt] = useState<CaptureImportReceipt | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [retention, setRetention] = useState(() => retentionDraft(defaultSourceRetention('other')))
  const policy = changePolicyFor(settings)
  const stale = !!preview && (preview.ownerId !== settings.profileId || preview.datasetId !== settings.datasetId || preview.policyEpoch !== policy.epoch || preview.sourcePermissionRevision !== policy.sourcePermissionRevision)
  function changed() { setPreview(null); setReceipt(null); setNotice('') }
  function field(name: keyof typeof form, value: string) { setForm(previous => ({ ...previous, [name]: value })); changed() }
  async function run(work: () => Promise<void>) { setBusy(true); setNotice(''); try { await work() } catch (error) { setNotice(error instanceof Error ? error.message : '取込を確認できませんでした。') } finally { setBusy(false) } }
  async function check() {
    const retentionUntil = retentionValue(retention), result = mode === 'email' ? await prepareEmailCaptureImport(email!, selection.start, selection.end, retentionUntil) : await prepareWebCaptureImport(mode === 'capsule' ? form.capsule : makeWebCaptureCapsule(form), retentionUntil)
    setPreview(result); setReceipt(null); setNotice('引用と出典を確認してください。まだ保存していません。')
  }
  return <section className="panel" aria-label="選んだWeb引用とローカルメールの取込">
    <h3>選んだWeb引用・メールを資料にする</h3>
    <p>選んだ本文だけを資料候補へ保存します。原文の確認データもこの端末に保存します。新規資料のAI送信・通知・外部書込・開示は無効です。タスクの作成や変更は資料の確認後に行います。</p>
    <p className="muted">Webページの取得、ブラウザの履歴・全ページ収集、メールボックスの同期、転送メールの受信サービスは未接続です。ローカルメールの送信者は未認証の出典情報です。</p>
    <div className="change-set-actions" role="group" aria-label="取込方法">
      {([['web', 'URLと引用を貼り付け'], ['capsule', '選択引用JSON'], ['email', '.emlファイル']] as const).map(([value, label]) => <button key={value} type="button" className={mode === value ? 'primary-button' : 'secondary-button'} disabled={busy} aria-pressed={mode === value} onClick={() => { setMode(value); changed() }}>{label}</button>)}
    </div>
    {mode==='capsule'?<label className="field">選択引用ファイルを開く（JSON・120KBまで）<input type="file" accept=".json,application/json" disabled={busy} onChange={event=>{const file=event.target.files?.[0];event.target.value='';changed();if(file)void run(async()=>{const capsule=await parseWebCaptureFile(file);setForm(previous=>({...previous,capsule:JSON.stringify(capsule)}));setNotice('選択引用を読みました。保存する引用を確認してください。')})}}/></label>:null}
    {mode === 'web' ? <div className="form-grid">
      <label>資料名<input value={form.title} maxLength={200} disabled={busy} onChange={event => field('title', event.target.value)}/></label>
      <label>本人が選んだ出典URL<input type="url" value={form.url} maxLength={2000} disabled={busy} onChange={event => field('url', event.target.value)} placeholder="https://example.org/article"/></label>
      <label>取得日時のタイムゾーン<input value={form.timezone} maxLength={100} disabled={busy} onChange={event => field('timezone', event.target.value)} placeholder="Asia/Tokyo"/></label>
      <label>選んでコピーした引用<textarea rows={6} value={form.quote} maxLength={50000} disabled={busy} onChange={event => field('quote', event.target.value)}/></label>
    </div> : null}
    {mode === 'capsule' ? <div><label>選択引用のJSON<textarea rows={8} value={form.capsule} maxLength={120000} disabled={busy} onChange={event => field('capsule', event.target.value)}/></label><p className="muted">version・kind・title・url・capturedAt・timezone・selection・coverage を持つ選択引用形式を受け付けます。ページの全文・履歴・許可指定は受け付けません。</p><details><summary>選択引用JSONの例</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({version:1,kind:'web-selection',title:'選んだ記事',url:'https://example.org/article',capturedAt:'2026-10-01T00:00:00.000Z',timezone:'Asia/Tokyo',selection:{quote:'選んだ引用',start:0,end:5,coordinate:'selected-fragment-utf16'},coverage:{complete:false,kind:'selected-quote'}},null,2)}</pre></details></div> : null}
    {mode === 'email' ? <div>
      <label>この端末のメールファイル（100KBまで）<input type="file" accept=".eml,message/rfc822" disabled={busy} onChange={event => {
        const file = event.target.files?.[0]; changed(); setEmail(null); setSelection({start:0,end:0})
        if (!file) return
        void run(async () => { if (!/\.eml$/i.test(file.name) || file.size > MAX_EMAIL_BYTES) throw new Error('.eml形式・100KB以下のファイルを選んでください。'); const parsed = await parseLocalEmailFile(await file.arrayBuffer(), file.name); setEmail(parsed); setNotice('解析した本文から保存する範囲を選択してください。') })
      }}/></label>
      <p className="muted">UTF-8・ASCII・ISO-8859-1のtext/plain、Base64・Quoted-Printable、対応する複合メールを解析します。HTMLは実行しません。暗号化メール、埋込メール、未対応の文字コードは取込できません。</p>
      {email ? <article aria-label="解析したメールの原文確認"><h4>{email.subject}</h4><p>送信者（未認証）：{email.sender}</p><p>元の日時：{email.date.raw}<br/>時差：{email.date.timezone}<br/>Message-ID：{email.messageId ?? 'なし'}</p><p className="muted">HTML {email.ignoredHtmlParts}パート・添付 {email.attachmentParts}パートを本文候補から除外しました。</p>
        <label>保存したい本文をドラッグして選択<textarea rows={10} readOnly value={email.text} disabled={busy} onSelect={event => { const target = event.currentTarget; const next = {start:target.selectionStart,end:target.selectionEnd}; if (next.start !== selection.start || next.end !== selection.end) { setSelection(next); changed() } }}/></label>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { setSelection({start:0,end:email.text.length}); changed() }}>このメールの本文全体を選択</button><p>選択範囲：{selection.start}〜{selection.end}（{selection.end-selection.start} UTF-16文字単位）</p>
        <p className="muted">元ファイルのSHA-256：{email.rawSha256}</p>
      </article> : null}
    </div> : null}
    <RetentionChoice label="保存する引用の保持期限" value={retention} onChange={next => { setRetention(next); changed() }} disabled={busy} defaultNote={`Web・メールの引用は第三者の会話として扱い、既定は取込から${retentionDefaults.importedConversationDays}日です。長期保存は本人が明示的に選んでください。`} />
    <button type="button" className="secondary-button" disabled={busy || mode === 'email' && (!email || selection.end <= selection.start)} onClick={() => void run(check)}>保存する引用を確認</button>
    {preview ? <article aria-label="保存する引用の確認"><h4>今回保存する資料</h4><p>{preview.title}<br/>{preview.sourceUrl ?? preview.author}<br/>{preview.date} / {preview.timezone}</p><p>保持期限：{preview.retentionUntil ? new Date(preview.retentionUntil).toLocaleString('ja-JP') : '期限なし（長期保存・本人が選択）'}</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{preview.quote}</pre><p>文字範囲：{preview.start}〜{preview.end} / {preview.positionVerified ? '解析したローカル本文と一致' : '貼り付けられた引用。元ページの位置は未検証'}</p><p className="muted">取得範囲は選択した引用だけです。全履歴・全会話を取得した扱いにはしません。確認内容 {preview.digest.slice(0,12)}</p>
      {!receipt ? <button type="button" className="primary-button" disabled={busy || stale} onClick={event => { const native = event.nativeEvent; void run(async () => { const saved = await saveCaptureImportFromUI(preview,native); setReceipt(saved); setNotice(saved.duplicate ? '同じ引用の資料を確認しました。' : '確認した引用を資料に保存しました。'); onImported?.(saved) }) }}>この引用と元データを資料に保存</button> : null}
      {stale && !receipt ? <p role="alert">権限が変わったため、引用をもう一度確認してください。</p> : null}
    </article> : null}
    {receipt ? <p role="status">{receipt.duplicate ? '保存済み資料を利用します。既存の本人設定を維持しました。' : '資料として保存しました。'} {receipt.permissions.aiEgress ? 'この既存資料には本人が設定したAI送信許可があります。' : 'AI送信は無効です。'} 資料ID：{receipt.sourceId}</p> : null}
    {receipt&&onManualTask?<button type="button" disabled={busy} onClick={()=>void run(async()=>onManualTask(await prepareCaptureTask(receipt)))}>この引用を見ながらタスクを手動作成</button>:null}
    <p role="status">{notice || (busy ? '取込内容を確認しています…' : '')}</p>
  </section>
}
